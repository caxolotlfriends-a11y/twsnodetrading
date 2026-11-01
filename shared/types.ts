export type NodeKind = 'market' | 'compare' | 'and' | 'or' | 'not' | 'timer' | 'order';
export type CompareOperator = 'gt' | 'gte' | 'lt' | 'lte';
export interface NodeConfig {
  label?: string;
  symbol?: string;
  operator?: CompareOperator;
  value?: number;
  quantity?: number;
  side?: 'BUY' | 'SELL';
  orderType?: 'MKT' | 'LMT';
  limitPrice?: number;
  intervalSeconds?: number;
}
export interface StrategyNode { id: string; kind: NodeKind; position: {x:number;y:number}; config: NodeConfig }
export interface StrategyEdge { id: string; source: string; target: string }
export interface Strategy { id: string; name: string; nodes: StrategyNode[]; edges: StrategyEdge[] }
export type TradingMode = 'simulation' | 'paper';
export interface Quote { symbol: string; price: number; change: number; history: number[]; updatedAt: string; source: 'simulation' | 'ibkr' }
export interface Position { symbol: string; quantity: number; averageCost: number; marketPrice: number; unrealizedPnl: number }
export interface TradeOrder { id: string; symbol: string; side: 'BUY' | 'SELL'; quantity: number; orderType: 'MKT' | 'LMT'; limitPrice?: number; status: string; filled: number; averageFillPrice: number; createdAt: string; mode: TradingMode }
export interface Activity { id: string; time: string; level: 'info' | 'success' | 'warning' | 'error'; message: string }
export interface ConnectionState { mode: TradingMode; connected: boolean; host: string; port: number; clientId: number; account: string | null; armed: boolean; message: string }
export interface RunState { running: boolean; strategyId: string | null; startedAt: string | null; values: Record<string, number | boolean | null>; errors: string[]; executions: number }
export interface AppState { connection: ConnectionState; quotes: Quote[]; positions: Position[]; orders: TradeOrder[]; activity: Activity[]; run: RunState; balance: number; equity: number; accountCurrency?: string; accountValuesReady?: boolean }
export const SYMBOLS = ['AAPL','MSFT','NVDA','TSLA','SPY','AMZN'] as const;
