import type { NodeKind, Quote, Strategy, StrategyNode } from './types.js';

export interface OrderIntent {
  nodeId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MKT' | 'LMT';
  limitPrice?: number;
}
export interface Evaluation {
  values: Record<string, number | boolean | null>;
  errors: string[];
  orders: OrderIntent[];
}

const KINDS = new Set<NodeKind>(['market', 'compare', 'and', 'or', 'not', 'timer', 'order']);
const BOOLEAN_KINDS = new Set<NodeKind>(['compare', 'and', 'or', 'not', 'timer']);
const symbolPattern = /^[A-Z][A-Z0-9.-]{0,9}$/;
const validSymbol = (value: unknown): value is string => typeof value === 'string' && symbolPattern.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100 && !['__proto__', 'constructor', 'prototype'].includes(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const label = (node: StrategyNode): string => node.config?.label || node.id;

/** Validates both the graph and its data before it can be executed. */
export function validateStrategy(strategy: Strategy): string[] {
  if (!record(strategy) || !Array.isArray(strategy.nodes) || !Array.isArray(strategy.edges)) {
    return ['Die Strategie muss Nodes und Verbindungen enthalten.'];
  }
  const errors: string[] = [];
  if (!validId(strategy.id)) errors.push('Die Strategie benötigt eine gültige ID.');
  if (typeof strategy.name !== 'string' || !strategy.name.trim() || strategy.name.length > 100) errors.push('Der Strategiename muss 1 bis 100 Zeichen enthalten.');
  if (strategy.nodes.length === 0) errors.push('Füge mindestens eine Node hinzu.');
  if (strategy.nodes.length > 60 || strategy.edges.length > 120) return [...errors, 'Eine Strategie darf maximal 60 Nodes und 120 Verbindungen enthalten.'];

  const nodes = new Map<string, StrategyNode>();
  for (const node of strategy.nodes) {
    if (!record(node) || !validId(node.id) || !KINDS.has(node.kind) || !record(node.config) ||
        !record(node.position) || !finite(node.position.x) || !finite(node.position.y)) {
      errors.push('Eine Node besitzt einen ungültigen Typ, eine ungültige ID, Position oder Konfiguration.');
      continue;
    }
    if (nodes.has(node.id)) { errors.push(`Node-ID „${node.id}“ ist doppelt vorhanden.`); continue; }
    nodes.set(node.id, node);
    const config = node.config;
    if (config.label !== undefined && (typeof config.label !== 'string' || config.label.length > 100)) errors.push(`Node „${node.id}“: ungültige Bezeichnung.`);
    const name = label(node);
    if ((node.kind === 'market' || node.kind === 'order') && !validSymbol(config.symbol)) errors.push(`„${name}“: Gib ein gültiges Aktiensymbol in Großbuchstaben ein.`);
    if (node.kind === 'compare') {
      if (typeof config.operator !== 'string' || !['gt', 'gte', 'lt', 'lte'].includes(config.operator)) errors.push(`„${name}“: Wähle einen gültigen Preisvergleich.`);
      if (!finite(config.value) || config.value < 0) errors.push(`„${name}“: Der Vergleichspreis muss eine nicht negative Zahl sein.`);
    }
    if (node.kind === 'timer' && (!finite(config.intervalSeconds) || !Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 2 || config.intervalSeconds > 86400)) errors.push(`„${name}“: Das Zeitintervall muss 2 bis 86400 ganze Sekunden betragen.`);
    if (node.kind === 'order') {
      if (config.side !== 'BUY' && config.side !== 'SELL') errors.push(`„${name}“: Wähle Kaufen oder Verkaufen.`);
      if (!finite(config.quantity) || !Number.isInteger(config.quantity) || config.quantity < 1 || config.quantity > 1000) errors.push(`„${name}“: Die Stückzahl muss zwischen 1 und 1000 liegen und ganzzahlig sein.`);
      if (config.orderType !== 'MKT' && config.orderType !== 'LMT') errors.push(`„${name}“: Wähle eine Market- oder Limit-Order.`);
      if (config.orderType === 'LMT' && (!finite(config.limitPrice) || config.limitPrice <= 0)) errors.push(`„${name}“: Eine Limit-Order benötigt einen positiven Limitpreis.`);
    }
  }
  if (![...nodes.values()].some(node => node.kind === 'order')) errors.push('Füge mindestens eine Order-Node hinzu.');

  const incoming = new Map([...nodes.keys()].map(id => [id, [] as string[]]));
  const outgoing = new Map([...nodes.keys()].map(id => [id, [] as string[]]));
  const edgeIds = new Set<string>();
  const connections = new Set<string>();
  for (const edge of strategy.edges) {
    if (!record(edge) || !validId(edge.id) || !validId(edge.source) || !validId(edge.target)) { errors.push('Eine Verbindung besitzt ungültige IDs.'); continue; }
    if (edgeIds.has(edge.id)) errors.push(`Verbindungs-ID „${edge.id}“ ist doppelt vorhanden.`);
    edgeIds.add(edge.id);
    const connection = `${edge.source}\u0000${edge.target}`;
    if (connections.has(connection)) { errors.push('Zwei Nodes dürfen nur einmal direkt miteinander verbunden sein.'); continue; }
    connections.add(connection);
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    if (!source || !target) { errors.push('Eine Verbindung verweist auf eine fehlende Node.'); continue; }
    if (source.id === target.id) errors.push(`„${label(source)}“ darf nicht mit sich selbst verbunden sein.`);
    incoming.get(target.id)!.push(source.id);
    outgoing.get(source.id)!.push(target.id);
    if (target.kind === 'compare' && source.kind !== 'market') errors.push(`„${label(target)}“ benötigt einen numerischen Kurs als Eingang.`);
    if (['and', 'or', 'not', 'order'].includes(target.kind) && !BOOLEAN_KINDS.has(source.kind)) errors.push(`„${label(target)}“ benötigt ein logisches Signal als Eingang.`);
    if (source.kind === 'order') errors.push('Eine Order-Node ist ein Ausgang und kann keine anderen Nodes ansteuern.');
  }
  for (const node of nodes.values()) {
    const count = incoming.get(node.id)!.length, name = label(node);
    if (['market', 'timer'].includes(node.kind) && count !== 0) errors.push(`„${name}“ darf keine Eingänge haben.`);
    if (['compare', 'not', 'order'].includes(node.kind) && count !== 1) errors.push(`„${name}“ benötigt genau einen Eingang.`);
    if (['and', 'or'].includes(node.kind) && count < 2) errors.push(`„${name}“ benötigt mindestens zwei Eingänge.`);
  }
  const indegree = new Map([...incoming].map(([id, sources]) => [id, sources.length]));
  const ready = [...nodes.keys()].filter(id => indegree.get(id) === 0);
  let visited = 0;
  for (let index = 0; index < ready.length; index++) {
    visited++;
    for (const target of outgoing.get(ready[index])!) {
      const remaining = indegree.get(target)! - 1;
      indegree.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  if (visited !== nodes.size) errors.push('Die Strategie enthält einen Kreis. Verbinde die Nodes ohne Rückkopplung.');
  return [...new Set(errors)];
}

/** Pure evaluation. The runner, not this function, owns rising-edge/order deduplication. */
export function evaluateStrategy(strategy: Strategy, quotes: Quote[], now = Date.now(), startedAt = now): Evaluation {
  const result: Evaluation = { values: {}, errors: validateStrategy(strategy), orders: [] };
  if (!finite(now) || !finite(startedAt)) result.errors.push('Ungültiger Ausführungszeitpunkt.');
  if (result.errors.length) return result;
  const nodes = new Map(strategy.nodes.map(node => [node.id, node]));
  const incoming = new Map(strategy.nodes.map(node => [node.id, [] as string[]]));
  const outgoing = new Map(strategy.nodes.map(node => [node.id, [] as string[]]));
  for (const edge of strategy.edges) { incoming.get(edge.target)!.push(edge.source); outgoing.get(edge.source)!.push(edge.target); }
  const remaining = new Map([...incoming].map(([id, sources]) => [id, sources.length]));
  const ready = [...nodes.keys()].filter(id => remaining.get(id) === 0);
  const quoteMap = new Map(quotes.map(quote => [quote.symbol, quote]));
  for (let index = 0; index < ready.length; index++) {
    const node = nodes.get(ready[index])!, config = node.config;
    const inputs = incoming.get(node.id)!.map(id => result.values[id]);
    let value: number | boolean | null = null;
    switch (node.kind) {
      case 'market': {
        const quote = quoteMap.get(config.symbol!);
        const timestamp = quote ? Date.parse(quote.updatedAt) : NaN;
        if (!quote || !finite(quote.price) || quote.price <= 0) result.errors.push(`Kein gültiger Kurs für ${config.symbol}.`);
        else if (!finite(timestamp) || now - timestamp > 15000 || timestamp - now > 5000) result.errors.push(`Der Kurs für ${config.symbol} ist veraltet oder besitzt keinen gültigen Zeitstempel.`);
        else value = quote.price;
        break;
      }
      case 'compare': {
        const input = inputs[0], target = config.value!;
        if (typeof input === 'number') {
          if (config.operator === 'gt') value = input > target;
          if (config.operator === 'gte') value = input >= target;
          if (config.operator === 'lt') value = input < target;
          if (config.operator === 'lte') value = input <= target;
        }
        break;
      }
      case 'and': if (inputs.every(input => typeof input === 'boolean')) value = inputs.every(input => input === true); break;
      case 'or': if (inputs.every(input => typeof input === 'boolean')) value = inputs.some(input => input === true); break;
      case 'not': if (typeof inputs[0] === 'boolean') value = !inputs[0]; break;
      case 'timer': {
        const elapsed = Math.floor((now - startedAt) / 1000);
        value = elapsed >= config.intervalSeconds! && elapsed % config.intervalSeconds! === 0;
        break;
      }
      case 'order':
        if (typeof inputs[0] === 'boolean') value = inputs[0];
        if (value === true) {
          // The signal may originate from a timer or a different stock. Every
          // target still needs a fresh quote before an order can be eligible.
          const quote = quoteMap.get(config.symbol!);
          const timestamp = quote ? Date.parse(quote.updatedAt) : NaN;
          if (!quote || !finite(quote.price) || quote.price <= 0 || !finite(timestamp) || now - timestamp > 15000 || timestamp - now > 5000) {
            value = null;
            result.errors.push(`Order „${label(node)}“ wartet auf einen aktuellen Kurs für ${config.symbol}.`);
          } else result.orders.push({ nodeId: node.id, symbol: config.symbol!, side: config.side!, quantity: config.quantity!, orderType: config.orderType!, ...(config.orderType === 'LMT' ? { limitPrice: config.limitPrice! } : {}) });
        }
        break;
    }
    result.values[node.id] = value;
    for (const target of outgoing.get(node.id)!) {
      const count = remaining.get(target)! - 1;
      remaining.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  return result;
}
