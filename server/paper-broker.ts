import { EventEmitter } from 'node:events';
import { IBApi, EventName, SecType, OrderAction, OrderType, TimeInForce, type Contract, type Order, type IBApiCreationOptions } from '@stoqey/ib';
import { isIP } from 'node:net';
import type { NodeConfig, TradeOrder } from '../shared/types.js';

export function validatePaperEndpoint(host: string, port: number, clientId: number): void {
  const privateV4 = isIP(host) === 4 && (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  if (host !== 'localhost' && host !== '::1' && !privateV4) throw new Error('TWS muss auf localhost oder einer privaten IPv4-Adresse laufen.');
  if (![7497, 4002].includes(port)) throw new Error('Nur Paper-Ports 7497 (TWS) und 4002 (Gateway) sind erlaubt.');
  if (!Number.isInteger(clientId) || clientId < 1 || clientId > 999999) throw new Error('Client-ID muss zwischen 1 und 999999 liegen.');
}

/** Small, fail-closed adapter: account identity is verified before orders are possible. */
export class PaperBroker extends EventEmitter {
  private ib: IBApi;
  private nextOrderId: number | null = null;
  private account: string | null = null;
  private ready = false;
  private intentionalClose = false;
  private requestId = 1000;
  private subscriptions = new Map<number, string>();
  private subscribed = new Set<string>();
  private seenExecutionIds = new Set<string>();
  constructor(readonly host: string, readonly port: number, readonly clientId: number, apiFactory: (options: IBApiCreationOptions) => IBApi = options => new IBApi(options)) {
    super();
    validatePaperEndpoint(host, port, clientId);
    this.ib = apiFactory({host, port, maxReqPerSec: 30});
  }
  async connect(expectedAccount?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => fail(new Error('Keine bestätigte Paper-Verbindung nach 10 Sekunden. TWS-API und Port prüfen.')), 10000);
      const fail = (error: Error) => {
        if (!settled) { settled = true; clearTimeout(timeout); this.close(); reject(error); }
        else if (!this.intentionalClose) { this.ready = false; this.emit('fault', error.message); }
      };
      const finish = () => {
        if (settled || !this.account || this.nextOrderId === null) return;
        settled = true; clearTimeout(timeout); this.ready = true;
        this.ib.reqMarketDataType(3); // IB supplies live data where entitled, delayed otherwise.
        this.ib.reqAccountUpdates(true, this.account);
        this.ib.reqPositions();
        this.ib.reqOpenOrders();
        this.ib.reqExecutions(900, {clientId:String(this.clientId),acctCode:this.account,secType:SecType.STK});
        resolve(this.account);
      };
      this.ib.on(EventName.managedAccounts, (list) => {
        const accounts = list.split(',').map(x => x.trim()).filter(Boolean);
        if (!accounts.length || accounts.some(a => !/^DU\d+$/.test(a))) { fail(new Error('Verbindung abgelehnt: ausschließlich bestätigte DU-Paper-Konten sind erlaubt.')); return; }
        if(expectedAccount && !accounts.includes(expectedAccount)) {fail(new Error('Paper-Konto stimmt nicht mit der vorherigen Verbindung überein. Offene Orders bleiben gesperrt; ursprüngliches Konto in TWS verbinden.'));return;}
        this.account = expectedAccount ?? accounts[0]; finish();
      });
      this.ib.on(EventName.nextValidId, id => { this.nextOrderId = Math.max(this.nextOrderId ?? id, id); finish(); });
      this.ib.on(EventName.disconnected, () => {
        this.ready = false;
        if (!this.intentionalClose) { fail(new Error('TWS-Verbindung getrennt.')); this.emit('disconnected'); }
      });
      this.ib.on(EventName.error, (error: Error, code: number, reqId: number) => {
        if ([2104, 2106, 2107, 2108, 2158, 2119].includes(code)) { this.emit('notice', `IBKR ${code}: ${error.message}`); return; }
        // All other IB errors revoke order permission until the user reconnects.
        const message = `IBKR ${code ?? ''}${reqId >= 0 ? ` [${reqId}]` : ''}: ${error.message}`;
        fail(new Error(message));
      });
      this.ib.on(EventName.tickPrice, (id, field, price) => {
        const symbol = this.subscriptions.get(id);
        if (symbol && Number.isFinite(price) && price > 0 && [4, 68].includes(field)) this.emit('quote', symbol, price);
        if (symbol && Number.isFinite(price) && price > 0 && [9, 75].includes(field)) this.emit('close', symbol, price);
      });
      this.ib.on(EventName.updateAccountValue, (key, value, currency, account) => {
        if (account === this.account) this.emit('accountValue', key, value, currency);
      });
      this.ib.on(EventName.position, (account, contract, quantity, averageCost) => {
        if (account === this.account && contract.secType === SecType.STK && contract.currency === 'USD' && contract.symbol) {
          this.emit('position', contract.symbol, quantity, averageCost ?? 0);
        }
      });
      this.ib.on(EventName.updatePortfolio, (contract, quantity, marketPrice, _marketValue, averageCost, unrealizedPnl, _realized, account) => {
        if (account === this.account && contract.secType === SecType.STK && contract.currency === 'USD' && contract.symbol) {
          this.emit('portfolio', contract.symbol, quantity, averageCost ?? 0, marketPrice, unrealizedPnl ?? 0);
        }
      });
      this.ib.on(EventName.openOrder, (id, contract, order, orderState) => {
        if (!this.account || order.account !== this.account || !/^DU\d+$/.test(this.account)) return;
        this.nextOrderId = Math.max(this.nextOrderId ?? id + 1, id + 1);
        if (contract.secType !== SecType.STK || contract.currency !== 'USD' || !contract.symbol) return;
        if (![OrderType.MKT, OrderType.LMT].includes(order.orderType) || ![OrderAction.BUY, OrderAction.SELL].includes(order.action!)) {
          this.emit('notice', `Offene IBKR-Order #${id} verwendet einen nicht unterstützten Typ. In TWS verwalten.`); return;
        }
        this.emit('openOrder', {id:String(id), symbol:contract.symbol, side:order.action === OrderAction.BUY ? 'BUY' : 'SELL', quantity:order.totalQuantity ?? 0, orderType:order.orderType === OrderType.MKT ? 'MKT' : 'LMT', limitPrice:order.orderType === OrderType.LMT ? order.lmtPrice : undefined, status:orderState.status ?? 'Submitted', filled:0, averageFillPrice:0, createdAt:new Date().toISOString(), mode:'paper'} satisfies TradeOrder);
      });
      this.ib.on(EventName.openOrderEnd, () => this.emit('openOrdersEnd'));
      this.ib.on(EventName.execDetails, (_reqId, contract, execution) => {
        if (!this.account || execution.acctNumber !== this.account || execution.clientId !== this.clientId || contract.secType !== SecType.STK || contract.currency !== 'USD') return;
        if (!execution.execId || this.seenExecutionIds.has(execution.execId) || !Number.isInteger(execution.orderId)) return;
        if (!Number.isFinite(execution.cumQty) || execution.cumQty! <= 0 || !Number.isFinite(execution.avgPrice) || execution.avgPrice! <= 0) return;
        this.seenExecutionIds.add(execution.execId);
        this.emit('execution',String(execution.orderId),execution.cumQty,execution.avgPrice);
      });
      this.ib.on(EventName.orderStatus, (id, status, filled, _remaining, averageFillPrice) => this.emit('orderStatus', String(id), status, filled, averageFillPrice));
      this.ib.connect(this.clientId);
    });
  }
  subscribe(symbols: string[]) {
    if (!this.ready) return;
    for (const symbol of symbols) {
      if (this.subscribed.has(symbol) || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) continue;
      const id = this.requestId++; this.subscriptions.set(id, symbol); this.subscribed.add(symbol);
      this.ib.reqMktData(id, this.contract(symbol), '', false, false);
    }
  }
  private contract(symbol: string): Contract { return {symbol, secType: SecType.STK, exchange: 'SMART', currency: 'USD'}; }
  place(config: Required<Pick<NodeConfig,'symbol'|'side'|'quantity'|'orderType'>> & Pick<NodeConfig,'limitPrice'>): TradeOrder {
    if (!this.ready || !this.ib.isConnected || !this.account || !/^DU\d+$/.test(this.account) || this.nextOrderId === null) throw new Error('Kein bestätigtes Paper-Konto verbunden.');
    if (!Number.isInteger(config.quantity) || config.quantity < 1 || config.quantity > 1000) throw new Error('Ordermenge muss 1–1000 Aktien betragen.');
    const id = this.nextOrderId++;
    const order: Order = { action: config.side === 'BUY' ? OrderAction.BUY : OrderAction.SELL, orderType: config.orderType === 'LMT' ? OrderType.LMT : OrderType.MKT, totalQuantity: config.quantity, tif: TimeInForce.DAY, account: this.account, transmit: true, outsideRth: false, orderRef: 'NodeDesk-PAPER' };
    if (config.orderType === 'LMT') {
      if (!config.limitPrice || !Number.isFinite(config.limitPrice) || config.limitPrice <= 0) throw new Error('Ungültiger Limitpreis.');
      order.lmtPrice = config.limitPrice;
    }
    this.ib.placeOrder(id, this.contract(config.symbol), order);
    return {id: String(id), symbol: config.symbol, side: config.side, quantity: config.quantity, orderType: config.orderType, limitPrice: config.limitPrice, status: 'PendingSubmit', filled: 0, averageFillPrice: 0, createdAt: new Date().toISOString(), mode: 'paper'};
  }
  cancel(id: string) {
    if (!this.ib.isConnected || !this.account || !/^DU\d+$/.test(this.account) || !/^\d+$/.test(id)) throw new Error('Keine bestätigte Paper-Verbindung.');
    this.ib.cancelOrder(Number(id));
  }
  close() { this.intentionalClose = true; this.ready = false; this.ib.disconnect(); }
}
