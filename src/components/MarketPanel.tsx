import { useId, useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, BarChart3 } from 'lucide-react';
import type { Quote, TradingMode } from '../../shared/types';
import { SYMBOLS } from '../../shared/types';
import './MarketPanel.css';

interface Props {
  quotes: Quote[];
  selected: string;
  onSelect: (symbol: string) => void;
  mode: TradingMode;
}
const companies: Record<string, string> = {
  AAPL: 'Apple Inc.', MSFT: 'Microsoft Corporation', NVDA: 'NVIDIA Corporation',
  TSLA: 'Tesla, Inc.', SPY: 'SPDR S&P 500 ETF', AMZN: 'Amazon.com, Inc.',
};
const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WIDTH = 720;
const HEIGHT = 164;
const LEFT = 8;
const RIGHT = 68;
const TOP = 13;
const BOTTOM = 17;
const chartWidth = WIDTH - LEFT - RIGHT;
const chartHeight = HEIGHT - TOP - BOTTOM;

export default function MarketPanel({ quotes, selected, onSelect, mode }: Props) {
  const [range, setRange] = useState<number>(60);
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId().replace(/:/g, '');
  const quote = quotes.find((item) => item.symbol === selected);
  const values = useMemo(() => (quote?.history ?? []).filter(Number.isFinite).slice(-range), [quote?.history, range]);
  const chart = useMemo(() => {
    if (!values.length) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = Math.max((max - min) * 0.18, max * 0.00015, 0.02);
    const low = min - padding;
    const high = max + padding;
    const y = (value: number) => TOP + (high - value) / (high - low) * chartHeight;
    const points = values.map((value, index) => ({ x: LEFT + index / Math.max(values.length - 1, 1) * chartWidth, y: y(value), value }));
    const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
    const area = `${path} L${points.at(-1)!.x},${HEIGHT - BOTTOM} L${LEFT},${HEIGHT - BOTTOM} Z`;
    return { points, path, area, low, high, y };
  }, [values]);
  const active = hover !== null && chart ? chart.points[Math.min(hover, chart.points.length - 1)] : null;
  const change = quote?.change ?? 0;
  const positive = change >= 0;
  const ChangeIcon = positive ? ArrowUpRight : ArrowDownRight;
  const last = chart?.points.at(-1);

  return <section className="market-panel" aria-label="Kursverlauf">
    <div className="market-heading">
      <div className="market-instrument">
        <span className={`market-ticker-icon ticker-${selected.toLowerCase()}`}>{selected.slice(0, 1)}</span>
        <div>
          <select aria-label="Chart-Symbol auswählen" value={selected} onChange={(event) => { onSelect(event.target.value); setHover(null); }} className="market-symbol-select">
            {[...new Set([...SYMBOLS, ...quotes.map(q => q.symbol)])].map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
          </select>
          <span className="market-company">{companies[selected] ?? selected} <span>· USD</span></span>
        </div>
      </div>
      <div className="market-price-block">
        <span className="market-current-price">{quote ? usd.format(active?.value ?? quote.price) : '—'}</span>
        <span className={`market-change ${positive ? 'positive' : 'negative'}`}><ChangeIcon size={12} />{quote ? `${positive ? '+' : ''}${change.toFixed(2)}%` : 'Keine Kursdaten'}</span>
      </div>
    </div>
    <div className="market-chart-toolbar">
      <span className="market-feed-label"><Activity size={11} /> {mode === 'simulation' ? 'SIMULIERTER KURS' : 'IBKR · GGF. VERZÖGERT'}</span>
      <div className="market-ranges" aria-label="Anzahl der Kursticks">
        {[30, 60, 120].map((count) => <button key={count} type="button" className={range === count ? 'active' : ''} aria-pressed={range === count} onClick={() => { setRange(count); setHover(null); }}>{count} Ticks</button>)}
      </div>
    </div>
    {chart && values.length > 1 ? <div className="market-chart-wrap">
      <svg className="market-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${selected} Kursverlauf, letzte ${values.length} Ticks`} onMouseLeave={() => setHover(null)} onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width * WIDTH;
        setHover(Math.max(0, Math.min(values.length - 1, Math.round((x - LEFT) / chartWidth * (values.length - 1)))));
      }}>
        <defs>
          <linearGradient id={`market-fill-${gradientId}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b9e77a" stopOpacity=".13"/><stop offset="100%" stopColor="#b9e77a" stopOpacity="0"/></linearGradient>
        </defs>
        {[0, 0.33, 0.66, 1].map((ratio) => {
          const y = TOP + chartHeight * ratio;
          return <g key={ratio} className="market-chart-axis"><line x1={LEFT} x2={WIDTH - RIGHT + 3} y1={y} y2={y} stroke="#272d28" strokeDasharray="3 5"/><text x={WIDTH - RIGHT + 13} y={y + 3}>{usd.format(chart.high - (chart.high - chart.low) * ratio)}</text></g>;
        })}
        <path d={chart.area} fill={`url(#market-fill-${gradientId})`}/>
        <path d={chart.path} fill="none" stroke="#c6f26b" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
        {last && !active && <><line x1={last.x} x2={WIDTH - RIGHT + 6} y1={last.y} y2={last.y} stroke="#c6f26b" strokeOpacity=".3" strokeDasharray="3 3"/><circle cx={last.x} cy={last.y} r="3" fill="#c6f26b"/></>}
        {active && <g><line x1={active.x} x2={active.x} y1={TOP} y2={HEIGHT - BOTTOM} stroke="#71805f" strokeDasharray="3 3"/><line x1={LEFT} x2={WIDTH - RIGHT} y1={active.y} y2={active.y} stroke="#71805f" strokeDasharray="3 3"/><circle cx={active.x} cy={active.y} r="4" fill="#c6f26b" stroke="#171a18" strokeWidth="2"/>
          <rect x={WIDTH - RIGHT + 6} y={Math.max(3, Math.min(HEIGHT - 22, active.y - 9))} width="59" height="19" rx="3" fill="#c6f26b"/><text className="market-hover-price" x={WIDTH - RIGHT + 35} y={Math.max(3, Math.min(HEIGHT - 22, active.y - 9)) + 13} textAnchor="middle">{usd.format(active.value)}</text>
        </g>}
      </svg>
      <div className="market-chart-footer"><span>{values.length} Kursticks</span><span>{mode === 'simulation' ? 'Synthetische Daten · kein Börsenkurs' : 'Verfügbarkeit abhängig vom IBKR-Datenabo'}<i className="market-live-dot"/></span></div>
    </div> : <div className="market-chart-empty"><BarChart3 size={26}/><span>{mode === 'paper' ? 'Warte auf Kursticks von TWS' : 'Kursdaten werden vorbereitet'}</span><small>{mode === 'paper' ? 'API-Verbindung und Marktdatenberechtigungen prüfen.' : 'Die Simulation startet automatisch.'}</small></div>}
  </section>;
}
