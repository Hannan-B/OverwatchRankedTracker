import { type ResolvedTheme } from '@/lib/theme'

// ============================================================
// CHART THEME (NEXT-STEPS #16) — light/dark palette for Recharts
// ------------------------------------------------------------
// Charts can't rely on the CSS-variable tokens the rest of the app uses: Recharts
// renders SVG whose stroke/fill are read as concrete values, and we want one
// predictable source of truth per theme. So chart colours live HERE as explicit
// hex, resolved against the active ResolvedTheme ('light' | 'dark').
//
// Usage (per chart, during the #16 per-file pass):
//   const c = chartColors(resolveTheme(themeMode()))   // or pass the live theme
//   <CartesianGrid stroke={c.grid} />
//   <XAxis stroke={c.axis} tick={{ fill: c.axisLabel }} />
//   <Bar fill={c.primary} />
//   <Cell fill={c.victory } /> // win/loss/draw
//   series.map((s,i) => <Line stroke={c.categorical[i % c.categorical.length]} />)
//
// All values contrast-checked on both backgrounds (light panel #eef2f8,
// dark panel #18294a): structural ink legible, every series colour >= 2.69 on
// light and >= 5.2 on dark — fine for fills/strokes (text needs 4.5, handled by
// axisLabel which is darker on light).
//
// NOTE: charts that currently hardcode fill="#e6edf3" (combat/time/outcomes/feel
// axis labels) should switch that literal to c.axisLabel so it flips on light.
// ============================================================

export interface ChartColors {
  axis: string       // axis lines + ticks
  grid: string       // cartesian grid lines (fainter than axis)
  axisLabel: string  // axis tick text / value labels (the #e6edf3 replacement)
  tooltipBg: string
  tooltipBorder: string
  tooltipText: string
  // semantic series
  primary: string    // the orange accent bars/lines
  victory: string
  defeat: string
  draw: string
  // multi-series categorical set (cycle with i % length)
  categorical: string[]
}

const DARK: ChartColors = {
  axis: '#334155',
  grid: '#1e293b',
  axisLabel: '#e6edf3',
  tooltipBg: '#18294a',
  tooltipBorder: '#334155',
  tooltipText: '#e2e8f0',
  primary: '#f99e1a',
  victory: '#4ade80',
  defeat: '#f87171',
  draw: '#fbbf24',
  categorical: ['#f99e1a', '#60a5fa', '#4ade80', '#c084fc', '#f87171', '#22d3ee'],
}

const LIGHT: ChartColors = {
  axis: '#9fb0c4',
  grid: '#c7d2e0',
  axisLabel: '#4a5a6e',
  tooltipBg: '#eef2f8',
  tooltipBorder: '#9fb0c4',
  tooltipText: '#1c2733',
  primary: '#e07a00',
  victory: '#16a34a',
  defeat: '#dc2626',
  draw: '#d97706',
  categorical: ['#e07a00', '#2563eb', '#16a34a', '#9333ea', '#dc2626', '#0891b2'],
}

/** Resolve the chart palette for the active theme. */
export function chartColors(theme: ResolvedTheme): ChartColors {
  return theme === 'light' ? LIGHT : DARK
}
