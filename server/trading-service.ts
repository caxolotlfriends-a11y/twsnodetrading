import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AppState, Strategy, TradeOrder, Activity, NodeConfig } from '../shared/types.js';
import { SYMBOLS } from '../shared/types.js';
import { validateStrategy, evaluateStrategy } from '../shared/engine.js';
import { PaperBroker, validatePaperEndpoint } from './paper-broker.js';

const bases: Record<string, number> = {AAPL:227.55,MSFT:425.32,NVDA:142.87,TSLA:248.50,SPY:595.24,AMZN:208.73};
const cents = (x: number) => Math.round(x * 100) / 100;
const terminal = (o: TradeOrder) => ['Filled','Cancelled','ApiCancelled','Rejected','Inactive'].includes(o.status);
type ExecutableOrder = Required<Pick<NodeConfig,'symbol'|'side'|'quantity'|'orderType'>> & Pick<NodeConfig,'limitPrice'>;

export class TradingService extends EventEmitter {
  private state: AppState;
  private timer?: ReturnType<typeof setInterval>;
  private broker: PaperBroker | null = null;
  private strategy: Strategy | null = null;
  private previousSignals = new Set<string>();
  private simulationTicks = 0;
  private connecting = false;
  private paperOrdersSynced = false;
  private closePrices = new Map<string,number>();
  private accountValues: Record<string, number> = {};
  constructor(autoTick = true, private readonly brokerFactory = (host:string,port:number,clientId:number) => new PaperBroker(host,port,clientId)) {
    super();
    this.state = this.newSimulation();
    this.log('info','Simulationskonto bereit. Kurse und Ausführungen werden lokal simuliert.');
    if (autoTick) { this.timer = setInterval(() => this.tick(),1000); this.timer.unref(); }
  }
  private newSimulation(): AppState {
    return {
      connection:{mode:'simulation',connected:true,host:'127.0.0.1',port:7497,clientId:17,account:'SIM-LOCAL',armed:false,message:'Lokale Simulation · keine Broker-Verbindung'},
      quotes: SYMBOLS.map((symbol,i) => {
        const price = bases[symbol];
        const history = Array.from({length:60},(_,j)=>cents(price * (1 + Math.sin(j*.19+i)*.0025 + Math.cos(j*.48+i)*.0008)));
        history[59]=price;
        return {symbol,price,change:cents((price / history[0]-1)*100),history,updatedAt:new Date().toISOString(),source:'simulation' as const};
      }),
      positions:[],orders:[],activity:[],run:{running:false,strategyId:null,startedAt:null,values:{},errors:[],executions:0},balance:100000,equity:100000,accountCurrency:'USD',accountValuesReady:true
    };
  }
  snapshot(): AppState { return structuredClone(this.state); }
  private changed() { this.emit('change',this.snapshot()); }
  private log(level: Activity['level'],message:string) {
    this.state.activity.unshift({id:randomUUID(),time:new Date().toISOString(),level,message});
    this.state.activity = this.state.activity.slice(0,150);
  }
  async connect(config:{mode:'simulation'|'paper';host?:string;port?:number;clientId?:number}):Promise<AppState> {
    if (this.connecting) throw new Error('Eine Verbindung wird bereits aufgebaut.');
    if (config.mode !== 'simulation' && config.mode !== 'paper') throw new Error('Unbekannter Verbindungsmodus.');
    if (config.mode === 'paper') validatePaperEndpoint(config.host ?? '127.0.0.1',config.port ?? 7497,config.clientId ?? 17);
    const previous=this.state.connection;
    const samePaperSession=config.mode==='paper' && previous.mode==='paper' && previous.host===(config.host??'127.0.0.1') && previous.port===(config.port??7497) && previous.clientId===(config.clientId??17);
    const hasOpenOrders=this.state.orders.some(o=>!terminal(o));
    if(hasOpenOrders && !samePaperSession) throw new Error('Zuerst offene Orders stornieren. Ein Moduswechsel würde ihre Überwachung beenden.');
    const expectedAccount=samePaperSession ? previous.account : null;
    const retainedOrders=samePaperSession ? this.state.orders : [];
    const retainedActivity=samePaperSession ? this.state.activity : [];
    const awaitingOpenOrders=new Set(retainedOrders.filter(o=>!terminal(o)).map(o=>o.id));
    this.stop(false); this.broker?.removeAllListeners(); this.broker?.close(); this.broker = null;
    if (config.mode === 'simulation') {
      this.state = this.newSimulation(); this.log('success','Lokale Simulation verbunden. Startkapital: 100.000 USD.'); this.changed(); return this.snapshot();
    }
    this.connecting = true;this.paperOrdersSynced=false;
    const host=config.host ?? '127.0.0.1',port=config.port ?? 7497,clientId=config.clientId ?? 17;
    this.state = { ...this.newSimulation(), connection:{mode:'paper',connected:false,host,port,clientId,account:expectedAccount,armed:false,message:'Verbindung zur lokalen TWS wird aufgebaut …'},quotes:[],balance:0,equity:0,accountValuesReady:false,accountCurrency:undefined,orders:retainedOrders,activity:retainedActivity };
    this.accountValues = {}; this.closePrices.clear();
    const broker = this.brokerFactory(host,port,clientId); this.broker = broker;
    this.log('info',`Paper-Verbindung zu ${host}:${port}, Client ${clientId}.`);
    broker.on('notice',(message:string)=>{this.log('info',message);this.changed();});
    broker.on('fault',(message:string)=>this.brokerFault(message));
    broker.on('disconnected',()=>{this.state.connection.connected=false;this.brokerFault('TWS-Verbindung getrennt. Zum Fortfahren neu verbinden.');});
    broker.on('quote',(symbol:string,price:number)=>{
      const existing=this.state.quotes.find(q=>q.symbol===symbol);
      const close=this.closePrices.get(symbol);
      if (existing) {existing.price=price;existing.history=[...existing.history.slice(-119),price];existing.updatedAt=new Date().toISOString();existing.change=close?cents((price/close-1)*100):0;}
      else this.state.quotes.push({symbol,price,change:close?cents((price/close-1)*100):0,history:[price],updatedAt:new Date().toISOString(),source:'ibkr'});
      this.markPositions();this.changed();
    });
    broker.on('close',(symbol:string,price:number)=>{this.closePrices.set(symbol,price);});
    broker.on('position',(symbol:string,quantity:number,averageCost:number)=>{this.updatePosition(symbol,quantity,averageCost);this.changed();});
    broker.on('portfolio',(symbol:string,quantity:number,averageCost:number,marketPrice:number,unrealizedPnl:number)=>{this.updatePosition(symbol,quantity,averageCost,marketPrice,unrealizedPnl);this.changed();});
    broker.on('accountValue',(key:string,value:string,currency:string)=>{
      if (key==='Currency' && /^[A-Z]{3}$/.test(value)) this.state.accountCurrency=value;
      if ((currency==='BASE' || currency===this.state.accountCurrency) && ['TotalCashBalance','NetLiquidation','TotalCashValue'].includes(key) && Number.isFinite(Number(value))) {
        this.accountValues[key]=Number(value);
        this.state.balance=this.accountValues.TotalCashBalance ?? this.accountValues.TotalCashValue ?? 0;
        this.state.equity=this.accountValues.NetLiquidation ?? 0;
        }
      this.state.accountValuesReady=this.accountValues.NetLiquidation !== undefined && (this.accountValues.TotalCashBalance !== undefined || this.accountValues.TotalCashValue !== undefined) && !!this.state.accountCurrency;
      this.changed();
    });
    broker.on('openOrder',(order:TradeOrder)=>{
      awaitingOpenOrders.delete(order.id);
      const existing=this.state.orders.find(o=>o.id===order.id&&o.mode==='paper');
      if(existing) {
        const status=existing.filled>=order.quantity?'Filled':terminal(existing)?existing.status:order.status;
        Object.assign(existing,{symbol:order.symbol,side:order.side,quantity:order.quantity,orderType:order.orderType,limitPrice:order.limitPrice,status});
      }
      else {this.state.orders.unshift(order);this.log('info',`Offene Paper-Order #${order.id} von TWS übernommen.`);}
      this.trimOrderHistory();this.changed();
    });
    broker.on('openOrdersEnd',()=>{
      this.paperOrdersSynced=true;
      for(const id of awaitingOpenOrders){
        const order=this.state.orders.find(o=>o.id===id);
        if(order&&!terminal(order)){order.status='Unconfirmed';this.log('warning',`Order #${id} nicht mehr in offenen TWS-Orders. Status unbestätigt; in TWS prüfen. Neue Paper-Orders bleiben gesperrt.`);}
      }
      awaitingOpenOrders.clear();
      if(this.state.orders.some(o=>o.status==='Unconfirmed')){this.state.connection.armed=false;this.stop(false);}
      this.changed();
    });
    broker.on('orderStatus',(id:string,status:string,filled:number,averageFillPrice:number)=>{
      const order=this.state.orders.find(o=>o.id===id && o.mode==='paper');
      if (!order) return;
      const previous=order.status;
      if(filled>=order.filled && averageFillPrice>0)order.averageFillPrice=averageFillPrice;
      order.filled=Math.max(order.filled,filled);order.status=order.filled>=order.quantity?'Filled':status;
      if (order.status!==previous) this.log(order.status==='Filled'?'success':order.status==='Inactive'?'error':'info',`Paper-Order #${id}: ${order.status} · ${order.filled}/${order.quantity} ${order.symbol}`);
      this.trimOrderHistory();this.changed();
    });
    broker.on('execution',(id:string,filled:number,averageFillPrice:number)=>{
      const order=this.state.orders.find(o=>o.id===id&&o.mode==='paper');if(!order)return;
      if(filled<order.filled)return;
      const previous=order.filled;order.filled=filled;order.averageFillPrice=averageFillPrice;
      order.status=filled>=order.quantity?'Filled':terminal(order)||order.status==='Unconfirmed'?order.status:'PartiallyFilled';
      if(filled>previous)this.log('success',`Paper-Ausführung #${id}: ${filled}/${order.quantity} ${order.symbol} @ ${averageFillPrice.toFixed(2)} USD.`);
      this.trimOrderHistory();this.changed();
    });
    this.changed();
    try {
      const account=await broker.connect(expectedAccount??undefined);
      this.state.connection.connected=true;this.state.connection.account=account;
      this.state.connection.message='DU-Paper-Konto bestätigt · Orderfreigabe aus';
      this.log('success',`Paper-Konto ${account} bestätigt. Orders benötigen eine ausdrückliche Freigabe.`);
      broker.subscribe([...SYMBOLS]);this.changed();return this.snapshot();
    } catch(error) {
      this.state.connection.message=(error as Error).message;this.state.connection.connected=false;
      this.log('error',(error as Error).message);this.changed();throw error;
    } finally {this.connecting=false;}
  }
  private brokerFault(message:string) {
    this.state.connection.armed=false;this.state.connection.message=message;
    this.stop(false);this.log('error',message);this.changed();
  }
  arm(armed:boolean) {
    if (typeof armed!=='boolean') throw new Error('Freigabe muss ein boolescher Wert sein.');
    const c=this.state.connection;
    if (armed && c.mode==='paper' && !this.paperOrdersSynced) throw new Error('Offene TWS-Orders werden noch synchronisiert. Erst danach können Paper-Orders freigegeben werden.');
    if (armed && this.state.orders.some(o=>o.mode==='paper'&&o.status==='Unconfirmed')) throw new Error('Unbestätigte Orders in TWS prüfen und neu synchronisieren, bevor Paper-Orders freigegeben werden.');
    if (armed && (c.mode!=='paper'||!c.connected||!c.account||!/^DU\d+$/.test(c.account))) throw new Error('Zuerst ein bestätigtes DU-Paper-Konto verbinden.');
    c.armed=armed;
    if (!armed) this.stop(false);
    this.log(armed?'warning':'info',armed?'Paper-Orders freigegeben. Strategie kann jetzt Orders senden.':'Paper-Orderfreigabe aufgehoben.');
    this.changed();return this.snapshot();
  }
  start(strategy:Strategy) {
    const errors=validateStrategy(strategy);
    if (errors.length) throw new Error(errors.join(' '));
    if (this.state.run.running) throw new Error('Zuerst die laufende Strategie stoppen.');
    const c=this.state.connection;
    if (!c.connected) throw new Error('Keine Verbindung.');
    if(c.mode==='paper' && (!this.paperOrdersSynced || this.state.orders.some(o=>o.status==='Unconfirmed'))) throw new Error('Paper-Orderstatus noch nicht bestätigt. TWS-Orders zuerst synchronisieren.');
    if (c.mode==='paper' && (!c.armed || !c.account || !/^DU\d+$/.test(c.account))) throw new Error('Paper-Konto muss bestätigt und freigegeben sein.');
    this.strategy=structuredClone(strategy);this.previousSignals.clear();
    this.state.run={running:true,strategyId:strategy.id,startedAt:new Date().toISOString(),values:{},errors:[],executions:0};
    if (c.mode==='paper') this.broker?.subscribe(strategy.nodes.map(n=>n.config.symbol).filter((s):s is string=>!!s));
    else for(const symbol of new Set(strategy.nodes.map(n=>n.config.symbol).filter((s):s is string=>!!s))) {
      if (!this.state.quotes.some(q=>q.symbol===symbol)) {
        const price=bases[symbol]??100;this.state.quotes.push({symbol,price,change:0,history:[price],updatedAt:new Date().toISOString(),source:'simulation'});
      }
    }
    this.log('success',`Strategie „${strategy.name}“ gestartet · ${c.mode==='paper'?'IBKR Paper':'Simulation'}.`);
    this.evaluate();this.changed();return this.snapshot();
  }
  stop(announce=true) {
    const running=this.state.run.running;
    this.state.run.running=false;this.previousSignals.clear();
    if (running&&announce) this.log('info','Strategie gestoppt. Bereits gesendete Orders bleiben aktiv, bis sie ausgeführt oder storniert werden.');
    if (announce) this.changed();return this.snapshot();
  }
  tick() {
    if (this.state.connection.mode==='simulation') {
      this.simulationTicks++;
      this.state.quotes.forEach((q,i)=>{
        const base=bases[q.symbol]??100;
        q.price=cents(Math.max(.01,q.price+Math.sin(this.simulationTicks*.73+i)*base*.00055+(Math.random()-.5)*base*.0009));
        q.history=[...q.history.slice(-119),q.price];q.updatedAt=new Date().toISOString();q.change=cents((q.price/base-1)*100);
      });
      for(const order of this.state.orders) if(!terminal(order))this.tryFill(order);
      this.markPositions();
    }
    this.evaluate();this.changed();
  }
  private evaluate() {
    if (!this.state.run.running || !this.strategy) return;
    if (this.state.connection.mode==='paper' && (!this.state.connection.connected||!this.state.connection.armed)) {this.stop(false);return;}
    const result=evaluateStrategy(this.strategy,this.state.quotes,Date.now(),Date.parse(this.state.run.startedAt!));
    this.state.run.values=result.values;this.state.run.errors=result.errors;
    // A missing/stale input pauses the whole graph. Preserve edge memory so a
    // temporary data outage does not re-fire an already true order signal.
    if(result.errors.length) return;
    const active=new Set(result.orders.map(o=>o.nodeId));
    for(const order of result.orders) {
      if (this.previousSignals.has(order.nodeId)) continue;
      if (this.state.run.executions>=20) {this.log('warning','Limit erreicht: maximal 20 Orders pro Strategiestart. Strategie gestoppt.');this.stop(false);break;}
      try {
        this.submit(order);this.state.run.executions++;
      } catch(error) {this.state.run.errors.push((error as Error).message);this.log('error',(error as Error).message);this.stop(false);break;}
    }
    this.previousSignals=active;
  }
  private submit(config:ExecutableOrder) {
    if(!Number.isInteger(config.quantity)||config.quantity<1||config.quantity>1000)throw new Error('Maximal 1000 Aktien pro Order.');
    if(!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(config.symbol))throw new Error('Ungültiges Aktiensymbol.');
    const quote=this.state.quotes.find(q=>q.symbol===config.symbol);
    if(!quote || Date.now()-Date.parse(quote.updatedAt)>15000) throw new Error(`Kein aktueller Kurs für ${config.symbol}.`);
    let order:TradeOrder;
    if(this.state.connection.mode==='paper') {
      if(!this.state.connection.armed || !this.broker)throw new Error('Paper-Orders sind nicht freigegeben.');
      order=this.broker.place(config);
    } else {
      order={...config,id:randomUUID().slice(0,8),status:'Submitted',filled:0,averageFillPrice:0,createdAt:new Date().toISOString(),mode:'simulation'};
    }
    this.state.orders.unshift(order);this.trimOrderHistory();
    this.log('info',`${order.mode==='paper'?'Paper':'Simulation'}: ${config.side} ${config.quantity} ${config.symbol} · ${config.orderType}${config.limitPrice?` @ ${config.limitPrice}`:''}`);
    if(order.mode==='simulation')this.tryFill(order);
    this.trimOrderHistory();
  }
  private trimOrderHistory() {
    // Never evict an active order: it must remain visible and cancellable.
    let retainedTerminal=0;
    this.state.orders=this.state.orders.filter(order=>!terminal(order)||retainedTerminal++<250);
  }
  private tryFill(order:TradeOrder) {
    const price=this.state.quotes.find(q=>q.symbol===order.symbol)?.price;if(!price)return;
    if(order.orderType==='LMT' && (order.side==='BUY'?price>(order.limitPrice??0):price<(order.limitPrice??Infinity)))return;
    const held=this.state.positions.find(p=>p.symbol===order.symbol);
    if(order.side==='BUY' && price*order.quantity>this.state.balance) {order.status='Rejected';this.log('error','Simulationsorder abgelehnt: nicht genügend Guthaben.');return;}
    if(order.side==='SELL' && (!held||held.quantity<order.quantity)) {order.status='Rejected';this.log('error','Simulationsorder abgelehnt: nicht genügend Aktien. Leerverkäufe werden nicht simuliert.');return;}
    if(order.side==='BUY') {
      const oldQuantity=held?.quantity??0,oldCost=held?.averageCost??0,newQuantity=oldQuantity+order.quantity;
      this.updatePosition(order.symbol,newQuantity,(oldQuantity*oldCost+price*order.quantity)/newQuantity);
      this.state.balance=cents(this.state.balance-price*order.quantity);
    } else {this.updatePosition(order.symbol,held!.quantity-order.quantity,held!.averageCost);this.state.balance=cents(this.state.balance+price*order.quantity);}
    order.status='Filled';order.filled=order.quantity;order.averageFillPrice=price;
    this.log('success',`${order.quantity} ${order.symbol} ${order.side==='BUY'?'gekauft':'verkauft'} @ ${price.toFixed(2)} USD (Simulation).`);this.markPositions();
  }
  private updatePosition(symbol:string,quantity:number,averageCost:number,marketPrice?:number,unrealizedPnl?:number) {
    this.state.positions=this.state.positions.filter(p=>p.symbol!==symbol);
    if(quantity!==0) {
      const price=marketPrice??this.state.quotes.find(q=>q.symbol===symbol)?.price??averageCost;
      this.state.positions.push({symbol,quantity,averageCost,marketPrice:price,unrealizedPnl:unrealizedPnl??cents((price-averageCost)*quantity)});
    }
  }
  private markPositions() {
    this.state.positions.forEach(p=>{const quote=this.state.quotes.find(q=>q.symbol===p.symbol);if(quote){p.marketPrice=quote.price;p.unrealizedPnl=cents((quote.price-p.averageCost)*p.quantity);}});
    if(this.state.connection.mode==='simulation')this.state.equity=cents(this.state.balance+this.state.positions.reduce((sum,p)=>sum+p.marketPrice*p.quantity,0));
  }
  cancel(id:string) {
    const order=this.state.orders.find(o=>o.id===id);
    if(!order)throw new Error('Order nicht gefunden.');
    if(terminal(order))throw new Error('Order ist bereits abgeschlossen.');
    if(order.mode==='paper') {if(!this.broker)throw new Error('Keine Paper-Verbindung.');this.broker.cancel(id);order.status='PendingCancel';}
    else order.status='Cancelled';
    this.log('info',`Stornierung für Order #${id} ${order.mode==='paper'?'angefordert':'ausgeführt'}.`);this.trimOrderHistory();this.changed();return this.snapshot();
  }
  reset() {
    if(this.state.connection.mode!=='simulation')throw new Error('Nur Simulationskonten können zurückgesetzt werden.');
    this.state=this.newSimulation();this.strategy=null;this.previousSignals.clear();this.log('info','Simulation zurückgesetzt: Guthaben 100.000 USD, Orders und Positionen gelöscht.');this.changed();return this.snapshot();
  }
  close() {if(this.timer)clearInterval(this.timer);this.broker?.close();this.removeAllListeners();}
}
