import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStrategy, validateStrategy } from '../shared/engine.js';
import type { NodeKind, Quote, Strategy, StrategyNode } from '../shared/types.js';

const now = Date.UTC(2026, 10, 1, 12, 0, 0);
const quote = (price = 220, overrides: Partial<Quote> = {}): Quote => ({ symbol:'AAPL', price, change:0, history:[price], updatedAt:new Date(now).toISOString(), source:'simulation', ...overrides });
const node = (id: string, kind: NodeKind, config: StrategyNode['config'] = {}): StrategyNode => ({id,kind,config,position:{x:0,y:0}});
const basic = (): Strategy => ({ id:'test', name:'Test', nodes:[node('market','market',{symbol:'AAPL'}),node('condition','compare',{operator:'gt',value:200}),node('order','order',{symbol:'AAPL',side:'BUY',quantity:5,orderType:'MKT'})], edges:[{id:'mc',source:'market',target:'condition'},{id:'co',source:'condition',target:'order'}] });

test('validates a price condition and creates an exact eligible order', () => {
  const graph = basic();
  assert.deepEqual(validateStrategy(graph), []);
  const result = evaluateStrategy(graph, [quote()], now);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.values, {market:220,condition:true,order:true});
  assert.deepEqual(result.orders,[{nodeId:'order',symbol:'AAPL',side:'BUY',quantity:5,orderType:'MKT'}]);
  assert.equal(evaluateStrategy(graph,[quote(199)],now).orders.length,0);
});

test('all four comparison operators preserve strict/inclusive boundaries', () => {
  for (const [operator, expected] of [['gt',false],['gte',true],['lt',false],['lte',true]] as const) {
    const graph=basic(); graph.nodes[1].config={operator,value:220};
    assert.equal(evaluateStrategy(graph,[quote()],now).values.condition,expected,operator);
  }
});

test('out-of-order nodes are evaluated topologically', () => {
  const graph=basic(); graph.nodes.reverse();
  assert.equal(evaluateStrategy(graph,[quote()],now).orders.length,1);
});

test('missing, zero, stale and invalid-timestamp quotes cannot produce orders', () => {
  for(const quotes of [[],[quote(0)],[quote(220,{updatedAt:new Date(now-15001).toISOString()})],[quote(220,{updatedAt:'bad'})],[quote(220,{updatedAt:new Date(now+5001).toISOString()})]]) {
    const result=evaluateStrategy(basic(),quotes,now);
    assert.equal(result.orders.length,0);
    assert.equal(result.values.order,null);
    assert.ok(result.errors.length);
  }
});

test('unknown propagates through NOT and all boolean gates, never generating a trade', () => {
  const graph=basic();
  graph.nodes.push(node('not','not')); graph.edges[1]={id:'cn',source:'condition',target:'not'}; graph.edges.push({id:'no',source:'not',target:'order'});
  assert.equal(evaluateStrategy(graph,[],now).values.not,null);
  assert.equal(evaluateStrategy(graph,[],now).orders.length,0);
  for(const kind of ['and','or'] as const) {
    graph.nodes[3]=node('not',kind); graph.nodes.push(node('clock','timer',{intervalSeconds:2}));
    graph.edges.push({id:'clock-not',source:'clock',target:'not'});
    const result=evaluateStrategy(graph,[],now,now-2000);
    assert.equal(result.values.not,null,kind); assert.equal(result.orders.length,0,kind);
    graph.nodes.pop(); graph.edges.pop();
  }
});

test('timer pulses after a full interval and AND combines actual booleans', () => {
  const graph=basic();
  graph.nodes.push(node('clock','timer',{intervalSeconds:5}),node('gate','and'));
  graph.edges[1]={id:'cg',source:'condition',target:'gate'};
  graph.edges.push({id:'tg',source:'clock',target:'gate'},{id:'go',source:'gate',target:'order'});
  assert.equal(evaluateStrategy(graph,[quote()],now,now).orders.length,0);
  assert.equal(evaluateStrategy(graph,[quote()],now,now-5000).orders.length,1);
  assert.equal(evaluateStrategy(graph,[quote()],now,now-6000).orders.length,0);
});

test('OR and NOT evaluate true/false signals', () => {
  const graph=basic(); graph.nodes.push(node('clock','timer',{intervalSeconds:5}),node('gate','or'),node('invert','not'));
  graph.edges[1]={id:'cg',source:'condition',target:'gate'};
  graph.edges.push({id:'tg',source:'clock',target:'gate'},{id:'gn',source:'gate',target:'invert'},{id:'no',source:'invert',target:'order'});
  const result=evaluateStrategy(graph,[quote(100)],now,now);
  assert.deepEqual(result.errors,[]); assert.equal(result.values.gate,false); assert.equal(result.values.invert,true); assert.equal(result.orders.length,1);
});

test('rejects cycles, self edges and dangling references', () => {
  for(const edge of [{id:'cycle',source:'order',target:'market'},{id:'self',source:'condition',target:'condition'},{id:'missing',source:'absent',target:'order'}]) {
    const graph=basic(); graph.edges.push(edge);
    assert.ok(validateStrategy(graph).length); assert.equal(evaluateStrategy(graph,[quote()],now).orders.length,0);
  }
});

test('rejects duplicate IDs and duplicate direct connections', () => {
  const duplicate=basic(); duplicate.nodes.push({...duplicate.nodes[0]}); assert.ok(validateStrategy(duplicate).some(error=>error.includes('doppelt')));
  const edge=basic(); edge.edges.push({id:'another',source:'market',target:'condition'}); assert.ok(validateStrategy(edge).some(error=>error.includes('nur einmal')));
  const id=basic(); id.edges[1].id=id.edges[0].id; assert.ok(validateStrategy(id).some(error=>error.includes('doppelt')));
});

test('rejects wrong input types and arity', () => {
  const wrong=basic(); wrong.edges[1].source='market'; assert.ok(validateStrategy(wrong).some(error=>error.includes('logisches')));
  const missing=basic(); missing.edges.pop(); assert.ok(validateStrategy(missing).some(error=>error.includes('genau einen')));
  const extra=basic(); extra.nodes.push(node('extra','timer',{intervalSeconds:5})); extra.edges.push({id:'extra-c',source:'extra',target:'condition'}); assert.ok(validateStrategy(extra).some(error=>error.includes('numerischen')));
});

test('rejects malformed strategy data, prototype keys, limits and fractional quantities', () => {
  for(const malformed of [null,{}, {nodes:[null],edges:[]}, {nodes:[],edges:null}]) assert.ok(validateStrategy(malformed as unknown as Strategy).length);
  for (const patch of [{quantity:1001},{quantity:0},{quantity:1.5},{side:'HOLD'},{symbol:'aapl'},{orderType:'LMT'},{orderType:'LMT',limitPrice:-1}]) {
    const graph=basic(); Object.assign(graph.nodes[2].config,patch); assert.ok(validateStrategy(graph).length,JSON.stringify(patch));
  }
  const proto=basic(); proto.nodes[0].id='__proto__'; assert.ok(validateStrategy(proto).length);
  const tooMany=basic(); tooMany.nodes=Array.from({length:61},(_,index)=>node(`n${index}`,'market',{symbol:'AAPL'})); assert.ok(validateStrategy(tooMany).length);
});

test('requires an order sink, valid interval and finite threshold', () => {
  const graph=basic(); graph.nodes.pop(); graph.edges.pop(); assert.ok(validateStrategy(graph).some(error=>error.includes('Order-Node')));
  const timer=basic(); timer.nodes[0]=node('market','timer',{intervalSeconds:0}); assert.ok(validateStrategy(timer).some(error=>error.includes('Zeitintervall')));
  const price=basic(); price.nodes[1].config.value=NaN; assert.ok(validateStrategy(price).some(error=>error.includes('Vergleichspreis')));
});

test('limit intent preserves its price and engine is pure across repeated evaluations', () => {
  const graph=basic(); graph.nodes[2].config={symbol:'AAPL',side:'SELL',quantity:1,orderType:'LMT',limitPrice:230};
  const before=JSON.stringify(graph), first=evaluateStrategy(graph,[quote()],now), second=evaluateStrategy(graph,[quote()],now);
  assert.equal(first.orders[0].limitPrice,230); assert.deepEqual(first,second); assert.equal(JSON.stringify(graph),before);
});


test('timer-only and cross-symbol orders require fresh target-symbol market data', () => {
  const graph=basic(); graph.nodes[2].config.symbol='TSLA';
  for(const quotes of [[quote()],[quote(),quote(250,{symbol:'TSLA',updatedAt:new Date(now-15001).toISOString()})]]) {
    const result=evaluateStrategy(graph,quotes,now);
    assert.equal(result.orders.length,0); assert.equal(result.values.order,null); assert.ok(result.errors.length);
  }
  assert.equal(evaluateStrategy(graph,[quote(),quote(250,{symbol:'TSLA'})],now).orders.length,1);
  const timer:Strategy={id:'timer',name:'Timer',nodes:[node('clock','timer',{intervalSeconds:5}),node('trade','order',{symbol:'AAPL',side:'BUY',quantity:1,orderType:'MKT'})],edges:[{id:'clock-trade',source:'clock',target:'trade'}]};
  assert.equal(evaluateStrategy(timer,[],now,now-5000).orders.length,0);
  assert.equal(evaluateStrategy(timer,[quote()],now,now-5000).orders.length,1);
});


test('one-second timers are rejected because the runner samples at one second', () => {
  const graph=basic(); graph.nodes[0]=node('market','timer',{intervalSeconds:1});
  assert.ok(validateStrategy(graph).some(error=>error.includes('2 bis 86400')));
  assert.equal(evaluateStrategy(graph,[quote()],now,now-5000).orders.length,0);
});

test('symbol length matches the broker limit of ten characters', () => {
  const graph=basic(); graph.nodes[0].config.symbol='ABCDEFGHIJ';graph.nodes[2].config.symbol='ABCDEFGHIJ';
  assert.deepEqual(validateStrategy(graph),[]);
  graph.nodes[0].config.symbol='ABCDEFGHIJK';
  assert.ok(validateStrategy(graph).some(error=>error.includes('Aktiensymbol')));
});
