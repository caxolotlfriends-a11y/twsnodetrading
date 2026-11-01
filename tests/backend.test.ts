import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IBApi } from '@stoqey/ib';
import { TradingService } from '../server/trading-service.js';
import { createApp } from '../server/app.js';
import { PaperBroker, validatePaperEndpoint } from '../server/paper-broker.js';
import type { Strategy } from '../shared/types.js';

function strategy(order: Partial<Strategy['nodes'][number]['config']> = {}): Strategy {
  return { id:'test',name:'Test',nodes:[
    {id:'m',kind:'market',position:{x:0,y:0},config:{symbol:'AAPL'}},
    {id:'c',kind:'compare',position:{x:100,y:0},config:{operator:'gt',value:1}},
    {id:'o',kind:'order',position:{x:200,y:0},config:{symbol:'AAPL',side:'BUY',quantity:2,orderType:'MKT',...order}}
  ],edges:[{id:'e1',source:'m',target:'c'},{id:'e2',source:'c',target:'o'}]};
}

test('simulation fills a market order, accounts for cash and deduplicates a held signal',()=>{
  const s=new TradingService(false);
  try {
    const before=s.snapshot();s.start(strategy());
    const first=s.snapshot();
    assert.equal(first.orders.length,1);assert.equal(first.orders[0].status,'Filled');
    assert.equal(first.positions[0].quantity,2);
    assert.equal(first.balance,100000-before.quotes.find(q=>q.symbol==='AAPL')!.price*2);
    assert.equal(first.equity,100000);
    for(let i=0;i<5;i++)s.tick();
    assert.equal(s.snapshot().orders.length,1,'a continuously true predicate must not repeat the order');
    assert.equal(s.snapshot().run.executions,1);
  }finally{s.close();}
});

test('simulation holds an unmarketable limit order and cancels it explicitly',()=>{
  const s=new TradingService(false);
  try {
    s.start(strategy({orderType:'LMT',limitPrice:1}));
    const order=s.snapshot().orders[0];assert.equal(order.status,'Submitted');assert.equal(s.snapshot().balance,100000);
    s.stop();assert.equal(s.snapshot().orders[0].status,'Submitted','stop does not silently cancel an outstanding order');
    s.cancel(order.id);assert.equal(s.snapshot().orders[0].status,'Cancelled');
    assert.throws(()=>s.cancel(order.id),/abgeschlossen/);
  }finally{s.close();}
});

test('simulation rejects unaffordable orders and uncovered sells without corrupting cash',()=>{
  const s=new TradingService(false);
  try {
    s.start(strategy({quantity:1000}));assert.equal(s.snapshot().orders[0].status,'Rejected');assert.equal(s.snapshot().balance,100000);
    s.stop();s.start(strategy({side:'SELL'}));assert.equal(s.snapshot().orders[0].status,'Rejected');assert.equal(s.snapshot().positions.length,0);
  }finally{s.close();}
});

test('reset clears a running simulation, positions and orders',()=>{
  const s=new TradingService(false);
  try{s.start(strategy());const reset=s.reset();assert.equal(reset.balance,100000);assert.equal(reset.orders.length,0);assert.equal(reset.positions.length,0);assert.equal(reset.run.running,false);}finally{s.close();}
});

test('bad strategy and unconfirmed paper arming cannot place orders',()=>{
  const s=new TradingService(false);
  try{
    assert.throws(()=>s.start(strategy({quantity:1001})));assert.throws(()=>s.start(null as unknown as Strategy));
    assert.throws(()=>s.arm(true),/DU-Paper/);assert.equal(s.snapshot().orders.length,0);
  }finally{s.close();}
});

test('twenty-order execution cap stops even a graph with twenty-one simultaneous triggers',()=>{
  const s=new TradingService(false);
  try {
    const graph=strategy({quantity:1});
    for(let i=0;i<20;i++){graph.nodes.push({...graph.nodes[2],id:`extra${i}`});graph.edges.push({id:`extra-e${i}`,source:'c',target:`extra${i}`});}
    const state=s.start(graph);assert.equal(state.orders.length,20);assert.equal(state.run.executions,20);assert.equal(state.run.running,false);
  }finally{s.close();}
});

test('paper endpoint only accepts loopback/private addresses, paper ports and bounded client IDs',()=>{
  for(const host of ['127.0.0.1','localhost','::1','192.168.1.12','10.0.0.2','172.20.0.1'])assert.doesNotThrow(()=>validatePaperEndpoint(host,7497,17));
  for(const host of ['example.com','8.8.8.8','172.32.0.1','169.254.169.254'])assert.throws(()=>validatePaperEndpoint(host,7497,17));
  for(const port of [7496,4001,80,0])assert.throws(()=>validatePaperEndpoint('127.0.0.1',port,17));
  for(const id of [0,-1,1.5,1000000])assert.throws(()=>validatePaperEndpoint('127.0.0.1',7497,id));
});

class FakeIB extends EventEmitter {
  isConnected=false;
  accounts='DU12345';
  placed:unknown[][]=[];
  cancelled:number[]=[];
  connect(){this.isConnected=true;queueMicrotask(()=>{this.emit('nextValidId',100);this.emit('managedAccounts',this.accounts);});return this;}
  disconnect(){this.isConnected=false;this.emit('disconnected');return this;}
  reqMarketDataType(){return this;}
  reqAccountUpdates(){return this;}
  reqPositions(){return this;}
  reqOpenOrders(){return this;}
  reqExecutions(){return this;}
  reqMktData(){return this;}
  placeOrder(...args:unknown[]){this.placed.push(args);return this;}
  cancelOrder(id:number){this.cancelled.push(id);return this;}
}
const paperOrder={symbol:'AAPL',side:'BUY' as const,quantity:1,orderType:'MKT' as const};

test('broker adapter rejects live account identity even on a paper port',async()=>{
  const ib=new FakeIB();ib.accounts='U12345';const b=new PaperBroker('127.0.0.1',7497,17,()=>ib as unknown as IBApi);
  await assert.rejects(b.connect(),/DU-Paper/);assert.throws(()=>b.place(paperOrder));assert.equal(ib.placed.length,0);b.close();
});

test('broker adapter verifies paper account, routes an order through the mocked API, and revokes submission on broker error',async()=>{
  const ib=new FakeIB();const b=new PaperBroker('127.0.0.1',7497,17,()=>ib as unknown as IBApi);
  try {
    assert.throws(()=>b.place(paperOrder));assert.equal(await b.connect(),'DU12345');
    const order=b.place(paperOrder);assert.equal(order.id,'100');assert.equal(ib.placed.length,1);
    const apiOrder=ib.placed[0][2] as {account:string;transmit:boolean};assert.equal(apiOrder.account,'DU12345');assert.equal(apiOrder.transmit,true);
    ib.emit('error',new Error('No market data permission'),354,1000);
    assert.throws(()=>b.place(paperOrder));b.cancel(order.id);assert.deepEqual(ib.cancelled,[100],'cancellation remains available on a connected verified paper account after disarming');
  }finally{b.close();}
});

test('HTTP API rejects cross-origin mutations, non-JSON and DNS rebinding hosts',async()=>{
  const s=new TradingService(false);const {app}=createApp(s);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/health`)).status,200);
    assert.equal((await fetch(`${base}/api/reset`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal((await fetch(`${base}/api/reset`,{method:'POST',body:'{}'})).status,415);
    const reboundStatus=await new Promise<number|undefined>((resolve,reject)=>get(`${base}/api/state`,{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject));
    assert.equal(reboundStatus,403);
    const response=await fetch(`${base}/api/strategy/start`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({strategy:strategy()})});
    assert.equal(response.status,200);assert.equal((await response.json() as {orders:unknown[]}).orders.length,1);
    const live=await fetch(`${base}/api/connection`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'paper',host:'127.0.0.1',port:7496,clientId:17})});assert.equal(live.status,400);
    assert.equal(s.snapshot().connection.mode,'simulation');
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));s.close();}
});

test('broker restores only verified-account open orders and advances next order ID',async()=>{
  const ib=new FakeIB();const b=new PaperBroker('127.0.0.1',7497,17,()=>ib as unknown as IBApi);
  const restored:unknown[]=[];b.on('openOrder',order=>restored.push(order));
  try {
    await b.connect();
    ib.emit('openOrder',140,{symbol:'AAPL',secType:'STK',currency:'USD'},{account:'U12345',action:'BUY',orderType:'MKT',totalQuantity:2},{status:'Submitted'});
    assert.equal(restored.length,0,'foreign or live accounts must not be adopted');
    ib.emit('openOrder',140,{symbol:'AAPL',secType:'STK',currency:'USD'},{account:'DU12345',action:'BUY',orderType:'LMT',totalQuantity:2,lmtPrice:100},{status:'Submitted'});
    assert.equal(restored.length,1);assert.equal(b.place(paperOrder).id,'141');
  }finally{b.close();}
});

test('same-endpoint paper reconnect preserves open orders, resynchronizes status and permits cancellation',async()=>{
  const instances:FakeIB[]=[];
  const s=new TradingService(false,(host,port,clientId)=>{
    const ib=new FakeIB();instances.push(ib);return new PaperBroker(host,port,clientId,()=>ib as unknown as IBApi);
  });
  try {
    const config={mode:'paper' as const,host:'127.0.0.1',port:7497,clientId:17};
    await s.connect(config);
    instances[0].emit('openOrder',140,{symbol:'AAPL',secType:'STK',currency:'USD'},{account:'DU12345',action:'BUY',orderType:'LMT',totalQuantity:2,lmtPrice:100},{status:'Submitted'});
    instances[0].isConnected=false;instances[0].emit('disconnected');
    assert.equal(s.snapshot().connection.connected,false);
    await assert.rejects(s.connect({...config,clientId:18}),/offene Orders/);
    await assert.rejects(s.connect({mode:'simulation'}),/offene Orders/);
    await s.connect(config);
    assert.equal(s.snapshot().orders.length,1);assert.equal(s.snapshot().orders[0].id,'140');
    assert.equal(s.snapshot().connection.armed,false,'reconnect never re-arms trading');
    instances[1].emit('openOrder',140,{symbol:'AAPL',secType:'STK',currency:'USD'},{account:'DU12345',action:'BUY',orderType:'LMT',totalQuantity:2,lmtPrice:100},{status:'PreSubmitted'});
    assert.equal(s.snapshot().orders[0].status,'PreSubmitted','resync must refresh existing order metadata');
    s.cancel('140');assert.deepEqual(instances[1].cancelled,[140]);
  }finally{s.close();}
});

test('paper reconnect refuses an account change and retains the original account and outstanding orders',async()=>{
  const instances:FakeIB[]=[];
  const s=new TradingService(false,(host,port,clientId)=>{
    const ib=new FakeIB();if(instances.length)ib.accounts='DU99999';instances.push(ib);return new PaperBroker(host,port,clientId,()=>ib as unknown as IBApi);
  });
  try {
    const config={mode:'paper' as const,host:'127.0.0.1',port:7497,clientId:17};await s.connect(config);
    instances[0].emit('openOrder',140,{symbol:'AAPL',secType:'STK',currency:'USD'},{account:'DU12345',action:'BUY',orderType:'LMT',totalQuantity:2,lmtPrice:100},{status:'Submitted'});
    await assert.rejects(s.connect(config),/Konto stimmt nicht/);
    const state=s.snapshot();assert.equal(state.connection.connected,false);assert.equal(state.connection.armed,false);assert.equal(state.connection.account,'DU12345');assert.equal(state.orders.length,1);
    assert.throws(()=>s.arm(true));assert.throws(()=>s.cancel('140'));
  }finally{s.close();}
});

test('history retention never evicts a pending order even after more than 250 submissions',()=>{
  const s=new TradingService(false);
  try {
    let oldestId='';
    for(let i=0;i<260;i++){s.start(strategy({orderType:'LMT',limitPrice:1,quantity:1}));if(i===0)oldestId=s.snapshot().orders[0].id;s.stop();}
    assert.equal(s.snapshot().orders.length,260);assert.ok(s.snapshot().orders.some(o=>o.id===oldestId));
    s.cancel(oldestId);assert.equal(s.snapshot().orders.find(o=>o.id===oldestId)?.status,'Cancelled');
  }finally{s.close();}
});

test('IB execution callbacks fill an order even if orderStatus is omitted; duplicates and foreign executions are ignored',async()=>{
  let ib:FakeIB;
  const s=new TradingService(false,(host,port,clientId)=>{ib=new FakeIB();return new PaperBroker(host,port,clientId,()=>ib as unknown as IBApi);});
  try {
    await s.connect({mode:'paper',host:'127.0.0.1',port:7497,clientId:17});
    const contract={symbol:'AAPL',secType:'STK',currency:'USD'};
    ib!.emit('openOrder',140,contract,{account:'DU12345',action:'BUY',orderType:'MKT',totalQuantity:2},{status:'Submitted'});
    const execution={orderId:140,clientId:17,acctNumber:'DU12345',execId:'fill.01',cumQty:2,avgPrice:222.5};
    ib!.emit('execDetails',-1,contract,{...execution,acctNumber:'U12345'});assert.equal(s.snapshot().orders[0].filled,0);
    ib!.emit('execDetails',-1,contract,execution);
    assert.equal(s.snapshot().orders[0].status,'Filled');assert.equal(s.snapshot().orders[0].filled,2);assert.equal(s.snapshot().orders[0].averageFillPrice,222.5);
    const activityCount=s.snapshot().activity.length;
    ib!.emit('execDetails',-1,contract,execution);assert.equal(s.snapshot().activity.length,activityCount);
    ib!.emit('orderStatus',140,'Submitted',0,2,0);assert.equal(s.snapshot().orders[0].status,'Filled');assert.equal(s.snapshot().orders[0].filled,2);
  }finally{s.close();}
});

test('an offline order missing from the TWS open snapshot is marked unconfirmed and prevents re-arming',async()=>{
  const instances:FakeIB[]=[];
  const s=new TradingService(false,(host,port,clientId)=>{const ib=new FakeIB();instances.push(ib);return new PaperBroker(host,port,clientId,()=>ib as unknown as IBApi);});
  try {
    const config={mode:'paper' as const,host:'127.0.0.1',port:7497,clientId:17};await s.connect(config);
    instances[0].emit('openOrder',140,{symbol:'AAPL',secType:'STK',currency:'USD'},{account:'DU12345',action:'BUY',orderType:'LMT',totalQuantity:2,lmtPrice:100},{status:'Submitted'});
    await s.connect(config);instances[1].emit('openOrderEnd');
    assert.equal(s.snapshot().orders[0].status,'Unconfirmed');assert.throws(()=>s.arm(true),/Unbestätigte Orders/);
    // Historical execution detail resolves a fully filled offline order correctly.
    instances[1].emit('execDetails',900,{symbol:'AAPL',secType:'STK',currency:'USD'},{orderId:140,clientId:17,acctNumber:'DU12345',execId:'offline.01',cumQty:2,avgPrice:99});
    assert.equal(s.snapshot().orders[0].status,'Filled');assert.doesNotThrow(()=>s.arm(true));
  }finally{s.close();}
});

test('late events from a closed paper broker cannot mutate the reconnected session',async()=>{
  const instances:FakeIB[]=[];
  const s=new TradingService(false,(host,port,clientId)=>{const ib=new FakeIB();instances.push(ib);return new PaperBroker(host,port,clientId,()=>ib as unknown as IBApi);});
  try {
    const config={mode:'paper' as const,host:'127.0.0.1',port:7497,clientId:17};await s.connect(config);await s.connect(config);
    const before=s.snapshot();
    instances[0].emit('tickPrice',1000,4,999);instances[0].emit('updateAccountValue','NetLiquidation','99999','BASE','DU12345');instances[0].emit('position','DU12345',{symbol:'AAPL',secType:'STK',currency:'USD'},100,99);
    const after=s.snapshot();assert.deepEqual(after.quotes,before.quotes);assert.deepEqual(after.positions,before.positions);assert.equal(after.equity,before.equity);
  }finally{s.close();}
});

test('paper arming and starts wait for the complete open-order snapshot',async()=>{
  let ib:FakeIB;
  const s=new TradingService(false,(host,port,clientId)=>{ib=new FakeIB();return new PaperBroker(host,port,clientId,()=>ib as unknown as IBApi);});
  try {
    await s.connect({mode:'paper',host:'127.0.0.1',port:7497,clientId:17});
    assert.throws(()=>s.arm(true),/synchronisiert/);assert.throws(()=>s.start(strategy()),/synchronisieren/);
    ib!.emit('openOrderEnd');assert.doesNotThrow(()=>s.arm(true));assert.doesNotThrow(()=>s.start(strategy()));
  }finally{s.close();}
});

test('a late openOrder snapshot cannot regress a confirmed full execution',async()=>{
  let ib:FakeIB;
  const s=new TradingService(false,(host,port,clientId)=>{ib=new FakeIB();return new PaperBroker(host,port,clientId,()=>ib as unknown as IBApi);});
  try {
    await s.connect({mode:'paper',host:'127.0.0.1',port:7497,clientId:17});
    const contract={symbol:'AAPL',secType:'STK',currency:'USD'},order={account:'DU12345',action:'BUY',orderType:'MKT',totalQuantity:2};
    ib!.emit('openOrder',140,contract,order,{status:'Submitted'});
    ib!.emit('execDetails',-1,contract,{orderId:140,clientId:17,acctNumber:'DU12345',execId:'race.01',cumQty:2,avgPrice:200});
    ib!.emit('openOrder',140,contract,order,{status:'Submitted'});
    assert.equal(s.snapshot().orders[0].status,'Filled');assert.equal(s.snapshot().orders[0].filled,2);
  }finally{s.close();}
});
