'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  ResponsiveContainer,
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  PieChart, Pie,
  ScatterChart, Scatter,
  RadarChart, Radar,
  XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, Legend, Cell,
  PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from 'recharts'
import { supabase } from '@/lib/supabase'
import { matchQuery } from '@/lib/alpha'
import AnalyticsFilters, {
  DEFAULT_FILTERS,
  matchesFilters,
  heroMatches,
  type AnalyticsFilterState,
} from '@/components/AnalyticsFilters'
import { AnalyticsNav, AnalyticsHeader } from '@/components/AnalyticsNav'
import {
  byKey, catVars, numVars, VARIABLES,
  MEASURES, chartAvailability, sortBuckets,
  aggregate, scatterPoints, sessionMap, streakMap,
  heroRowPasses, formatValue,
  pairValidity, freeChartAvailability, crossTab, cellIntensity,
  baselineWinRate, cellPassesWinFilter, DEFAULT_WIN_FILTER,
  CELL_MEASURES,
  MATCH_COLS,
  type VarDef, type MeasureKind, type ChartType, type Readiness,
  type MatchRow, type HeroRow, type ValueFormat,
  type CellMeasure, type FreeChartType, type CrossTabResult,
  type WinFilter,
} from './builder-lib'
import {
  configKey, toggleSave, logView, isSaved,
  savedChartStats, getCurrentSeason,
  type ChartConfig, type SavedChartStats, type SeasonRow,
} from '@/lib/builder-usage'
import {
  freeConfigKey,
  toggleSave as toggleSaveFree,
  logView as logViewFree,
  isSaved as isSavedFree,
  savedChartStats as savedChartStatsFree,
  getCurrentSeason as getCurrentSeasonFree,
  type FreeChartConfig, type FreeSavedChartStats,
} from '@/lib/builder2-usage'

// ============================================================
// THE BUILDER — generic analytics laboratory (surface 1), full build
// ------------------------------------------------------------
// Reads BOTH grains and never mixes them in one chart:
//   • match grain → matchQuery() on `matches` (alpha rule baked in)
//   • hero grain  → hero_match_facts, alpha-filtered in JS via keepVisible()
// The chosen X variable's grain decides which dataset the chart uses; a measure
// needing the other grain's column is disabled with a reason.
//
// "Every variable, valid pairings only" enforced via chartAvailability() and
// grain checks. Foundation rules honoured: alpha exclusion, 5v5/6v6 never
// blended (auto-split into series), sample size always shown, the 5-game
// confidence rule (sub-5 buckets flagged + a toggle to drop/isolate them),
// percentages never averaged like counts.
// ============================================================

const OW = {
  orange: '#f99e1a', accent: '#ffcb6b', victory: '#3fb950', defeat: '#f85149',
  draw: '#8b949e', grid: 'rgba(255,255,255,0.08)', axis: 'rgba(255,255,255,0.45)',
}
const SERIES_COLORS = [OW.orange, '#5aa9e6', OW.victory, OW.accent, '#b072d6', OW.defeat, '#3fcaa8', '#e0934d']

const READY_BADGE: Record<Readiness, { label: string; cls: string }> = {
  ready: { label: 'READY', cls: 'text-ow-victory bg-ow-victory/10' },
  thin: { label: 'THIN', cls: 'text-ow-accent bg-ow-accent/10' },
  starved: { label: 'STARVED', cls: 'text-ow-defeat bg-ow-defeat/10' },
}

// hero_match_facts columns we read (mirrors the real view shape)
const HERO_COLS =
  'match_id, played_at, result, map, game_mode, match_format, starting_side, ' +
  'hero_name, scoreboard_hero, user_elims, user_assists, user_deaths, ' +
  'user_damage, user_healing, user_mitigation, damage_pct, healing_pct, mitigation_pct'

// Group the variable list into <optgroup>s for the pickers.
function grouped(vars: VarDef[]): [string, VarDef[]][] {
  const m = new Map<string, VarDef[]>()
  for (const v of vars) {
    if (!m.has(v.group)) m.set(v.group, [])
    m.get(v.group)!.push(v)
  }
  return Array.from(m.entries())
}

function ChartBuilder() {
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)
  const [matchRows, setMatchRows] = useState<MatchRow[]>([])
  const [heroRows, setHeroRows] = useState<HeroRow[]>([])
  const [loading, setLoading] = useState(true)

  // Builder selections
  const [xVarKey, setXVarKey] = useState<string>('map')
  const [measure, setMeasure] = useState<MeasureKind>('win_rate')
  const [avgVarKey, setAvgVarKey] = useState<string>('total_eliminations')
  const [yVarKey, setYVarKey] = useState<string>('total_deaths') // scatter Y
  const [chartType, setChartType] = useState<ChartType>('bar')
  const [subFive, setSubFive] = useState<'show' | 'hide' | 'only'>('show')
  const [hideNull, setHideNull] = useState(true) // default: hide the '—' (null) bucket

  // ---- Usage tracking ----
  const [saved, setSaved] = useState(false)              // is the current combo saved?
  const [savedStats, setSavedStats] = useState<SavedChartStats[]>([])
  const [season, setSeason] = useState<SeasonRow | null>(null)
  const [scope, setScope] = useState<'season' | 'all'>('season')
  const [panelOpen, setPanelOpen] = useState(false)

  // ---- Load both datasets once ----
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      matchQuery(MATCH_COLS).order('played_at', { ascending: false }),
      supabase.from('hero_match_facts').select(HERO_COLS),
    ]).then(([mRes, hRes]) => {
      if (cancelled) return
      const m = (((mRes as unknown) as { data: MatchRow[] | null }).data) || []
      const hAll = (((hRes as unknown) as { data: HeroRow[] | null }).data) || []
      setMatchRows(m)
      setHeroRows(hAll)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const xVar = byKey(xVarKey) ?? catVars()[0]
  const avgVar = numVars().find(v => v.key === avgVarKey) ?? numVars()[0]
  const yVar = numVars().find(v => v.key === yVarKey) ?? numVars()[0]
  const activeMeasure = MEASURES.find(m => m.kind === measure)!
  const availability = chartAvailability(measure)

  // For X-vs-Y scatter the X variable must itself be numeric; offer numeric
  // X vars when in xy mode, categorical otherwise.
  const xOptions = measure === 'xy' ? numVars() : catVars()
  // Keep xVar valid when the mode flips.
  useEffect(() => {
    const pool = measure === 'xy' ? numVars() : catVars()
    if (!pool.some(v => v.key === xVarKey)) setXVarKey(pool[0].key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure])

  // Snap chart type to a valid one for the measure.
  useEffect(() => {
    if (availability[chartType] !== null) {
      setChartType(measure === 'xy' ? 'scatter' : 'bar')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure])

  // Which grain are we in? (X variable decides.)
  const grain = xVar.grain

  // ---- Filter the active dataset ----
  const filteredMatch = useMemo(
    () => matchRows.filter(r => matchesFilters(r, filters)),
    [matchRows, filters]
  )
  // The `matches` read already applied the alpha rule (matchQuery on live
  // excludes alpha; on localhost the toggle decides). hero_match_facts has no
  // is_alpha column of its own, so we keep only hero rows whose match_id is in
  // the visible match set — inheriting the alpha decision via the join key.
  const visibleMatchIds = useMemo(
    () => new Set(matchRows.map(r => r.id)),
    [matchRows]
  )
  const filteredHero = useMemo(
    () => heroRows
      .filter(r => visibleMatchIds.has(r.match_id))
      .filter(r => heroRowPasses(r, filters))
      .filter(r => heroMatches(r.hero_name, filters)),
    [heroRows, visibleMatchIds, filters]
  )

  const formatPinned = filters.queue !== 'all'
  const splitByFormat = !formatPinned && xVar.column !== 'match_format'

  // Derived-variable context (sessions, streaks) computed from match grain.
  const derivedCtx = useMemo(() => ({
    session: sessionMap(matchRows),
    streak: streakMap(matchRows),
  }), [matchRows])

  // ---- Aggregate (non-scatter) ----
  const agg = useMemo(() => {
    if (measure === 'xy') return null
    const rows = (grain === 'hero' ? filteredHero : filteredMatch) as unknown as Record<string, unknown>[]
    return aggregate({
      rows,
      xVar,
      measure,
      avgCol: avgVar.column,
      splitByFormat,
      derivedCtx,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grain, filteredHero, filteredMatch, xVar, measure, avgVar, splitByFormat, derivedCtx])

  // ---- Scatter points ----
  const scatter = useMemo(() => {
    if (measure !== 'xy') return []
    const rows = (xVar.grain === 'hero' || yVar.grain === 'hero' ? filteredHero : filteredMatch) as unknown as Record<string, unknown>[]
    return scatterPoints(rows, xVar.column, yVar.column)
  }, [measure, xVar, yVar, filteredHero, filteredMatch])

  // ---- Apply the null-hide and sub-5 toggles to bucketed data ----
  const shown = useMemo(() => {
    if (!agg) return null
    let data = agg.data
    if (hideNull) data = data.filter(d => String(d.bucket) !== '—')
    if (subFive !== 'show') {
      data = data.filter(d => {
        const n = agg.perBucketN[String(d.bucket)] ?? 0
        return subFive === 'hide' ? n >= 5 : n < 5
      })
    }
    const sortedKeep = sortBuckets(data.map(d => String(d.bucket)), xVar)
    const byBucket = new Map(data.map(d => [String(d.bucket), d]))
    return { ...agg, data: sortedKeep.map(b => byBucket.get(b)!).filter(Boolean) }
  }, [agg, subFive, hideNull, xVar])

  const seriesLabel = (s: string) => (s === 'all' ? activeMeasure.label : s.toUpperCase())
  // Value format for the Y axis / tooltip: win rate is a percent; averaging a
  // duration column shows m:ss; everything else is a plain number.
  const activeFormat: ValueFormat =
    activeMeasure.isPercent ? 'percent'
      : measure === 'avg' ? (avgVar.format ?? 'number')
        : 'number'
  const measureTitle =
    measure === 'xy' ? `${yVar.label} vs ${xVar.label}`
      : measure === 'avg' ? `Average ${avgVar.label.toLowerCase()}`
        : activeMeasure.label
  const subFiveCount = agg ? agg.data.filter(d => (agg.perBucketN[String(d.bucket)] ?? 0) < 5).length : 0

  // ---- Current chart config (for save/track) ----
  const currentConfig: ChartConfig = useMemo(() => ({
    xVar: xVarKey, measure, chartType,
    avgVar: measure === 'avg' ? avgVarKey : null,
    yVar: measure === 'xy' ? yVarKey : null,
  }), [xVarKey, measure, chartType, avgVarKey, yVarKey])
  const currentKey = configKey(currentConfig)
  const currentLabel =
    `${measureTitle}${measure !== 'xy' ? ` by ${xVar.label}` : ''} (${chartType})`

  // Load season + saved stats (refreshed when scope changes or after a save).
  const refreshStats = useCallback(async () => {
    const s = scope === 'season' ? season : null
    const window = s ? { start: s.start_date, end: s.end_date } : undefined
    setSavedStats(await savedChartStats(window))
  }, [scope, season])

  useEffect(() => {
    getCurrentSeason().then(setSeason)
  }, [])
  useEffect(() => { refreshStats() }, [refreshStats])

  // Track whether the current combo is saved, and log a revisit when you land
  // on a combo that IS saved (debounced slightly so flicking through dropdowns
  // doesn't spam views — only a combo you settle on for ~1.2s logs).
  useEffect(() => {
    let cancelled = false
    isSaved(currentKey).then(s => { if (!cancelled) setSaved(s) })
    return () => { cancelled = true }
  }, [currentKey])

  useEffect(() => {
    if (!saved) return
    const t = window.setTimeout(() => {
      logView(currentKey).then(() => refreshStats())
    }, 1200)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, saved])

  const onToggleSave = useCallback(async () => {
    const nowSaved = await toggleSave(currentConfig, currentLabel)
    setSaved(nowSaved)
    if (nowSaved) await logView(currentKey) // first save counts as the first visit
    await refreshStats()
  }, [currentConfig, currentLabel, currentKey, refreshStats])

  // Reload a saved chart's exact combo into the builder.
  const loadSaved = useCallback((s: SavedChartStats) => {
    setMeasure(s.measure as MeasureKind)
    setXVarKey(s.x_var)
    setChartType(s.chart_type as ChartType)
    if (s.avg_var) setAvgVarKey(s.avg_var)
    if (s.y_var) setYVarKey(s.y_var)
    setPanelOpen(false)
  }, [])

  const pieData = useMemo(
    () => (shown ? shown.data.map(d => ({ name: String(d.bucket), value: Number(d[shown.seriesKeys[0]] ?? 0) })) : []),
    [shown]
  )

  const selectCls =
    'bg-ow-dark border border-white/20 rounded-xl px-3 py-2 text-sm text-slate-100 ' +
    'font-display tracking-wider focus:border-ow-orange focus:outline-none transition-colors ' +
    '[color-scheme:dark] max-w-[15rem]'
  const labelCls = 'text-[11px] text-slate-400 font-display tracking-wider uppercase'

  function renderVarOptions(vars: VarDef[]) {
    return grouped(vars).map(([group, items]) => (
      <optgroup key={group} label={group}>
        {items.map(v => (
          <option key={v.key} value={v.key}>
            {v.label}{v.ready !== 'ready' ? ` (${READY_BADGE[v.ready].label.toLowerCase()})` : ''}
          </option>
        ))}
      </optgroup>
    ))
  }

  const hasData = measure === 'xy' ? scatter.length > 0 : (shown?.data.length ?? 0) > 0

  return (
    <div className="space-y-6">
      <AnalyticsFilters value={filters} onChange={setFilters} show={{ queue: true, mode: true, map: true, hero: true }} />

      {/* Pickers */}
      <div className="bg-ow-panel rounded-xl border border-white/10 p-4">
        <div className="flex items-center gap-2 mb-4">
          <div className="h-1 w-10 bg-ow-orange rounded-full" />
          <span className="font-display tracking-[0.15em] text-slate-300 uppercase text-xs">Build a chart</span>
          <span className={`text-[10px] font-display tracking-wider uppercase px-2 py-0.5 rounded ${READY_BADGE[xVar.ready].cls}`}>
            {grain === 'hero' ? 'per-hero data' : 'per-match data'} · {READY_BADGE[xVar.ready].label}
          </span>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>{measure === 'xy' ? 'X-axis (numeric)' : 'Group by (X-axis)'}</span>
            <select className={selectCls} value={xVarKey} onChange={e => setXVarKey(e.target.value)}>
              {renderVarOptions(xOptions)}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className={labelCls}>Measure</span>
            <select className={selectCls} value={measure} onChange={e => setMeasure(e.target.value as MeasureKind)}>
              {MEASURES.map(m => <option key={m.kind} value={m.kind}>{m.label}</option>)}
            </select>
          </label>

          {measure === 'avg' && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Of which stat</span>
              <select className={selectCls} value={avgVarKey} onChange={e => setAvgVarKey(e.target.value)}>
                {renderVarOptions(numVars())}
              </select>
            </label>
          )}

          {measure === 'xy' && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Y-axis (numeric)</span>
              <select className={selectCls} value={yVarKey} onChange={e => setYVarKey(e.target.value)}>
                {renderVarOptions(numVars())}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className={labelCls}>Chart type</span>
            <select className={selectCls} value={chartType} onChange={e => setChartType(e.target.value as ChartType)}>
              {(['bar', 'line', 'area', 'pie', 'scatter', 'radar'] as ChartType[]).map(ct => {
                const reason = availability[ct]
                return (
                  <option key={ct} value={ct} disabled={reason !== null}>
                    {ct[0].toUpperCase() + ct.slice(1)}{reason ? ' — N/A' : ''}
                  </option>
                )
              })}
            </select>
          </label>

          {measure !== 'xy' && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Small samples (&lt;5)</span>
              <select className={selectCls} value={subFive} onChange={e => setSubFive(e.target.value as 'show' | 'hide' | 'only')}>
                <option value="show">Show all{subFiveCount ? ` (${subFiveCount} thin)` : ''}</option>
                <option value="hide">Hide &lt;5-game buckets</option>
                <option value="only">Only &lt;5-game buckets</option>
              </select>
            </label>
          )}

          {measure !== 'xy' && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>No-value (—) bucket</span>
              <select className={selectCls} value={hideNull ? 'hide' : 'show'} onChange={e => setHideNull(e.target.value === 'hide')}>
                <option value="hide">Hide —</option>
                <option value="show">Show —</option>
              </select>
            </label>
          )}
        </div>

        {availability[chartType] && (
          <p className="text-[11px] text-ow-accent/80 mt-3">{availability[chartType]}</p>
        )}
        {splitByFormat && measure !== 'xy' && (
          <p className="text-[11px] text-slate-500 mt-3">
            5v5 and 6v6 are shown as separate series (never blended). Pick a Queue to focus one format.
          </p>
        )}
        {grain === 'hero' && (
          <p className="text-[11px] text-slate-500 mt-2">
            Per-hero data: rates are games-weighted (a multi-hero game counts once). Combat columns are sparse on older matches.
          </p>
        )}
      </div>

      {/* Chart */}
      <div className="bg-ow-panel rounded-xl border border-white/10 p-4">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <h2 className="font-display tracking-[0.12em] text-slate-100 uppercase text-sm">
            {measureTitle}{measure !== 'xy' ? ` by ${xVar.label}` : ''}
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 font-display tracking-wider">
              {measure === 'xy'
                ? `${scatter.length} point${scatter.length === 1 ? '' : 's'}`
                : `n = ${shown?.totalN ?? 0} match${(shown?.totalN ?? 0) === 1 ? '' : 'es'}`}
            </span>
            <button
              onClick={onToggleSave}
              title={saved ? 'Saved — click to remove' : 'Save this chart to revisit it'}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-display tracking-wider uppercase transition-colors border ${
                saved
                  ? 'bg-ow-orange text-ow-dark border-ow-orange font-bold'
                  : 'bg-ow-dark text-slate-300 border-white/20 hover:border-ow-orange/50'
              }`}>
              <span>{saved ? '★' : '☆'}</span>
              {saved ? 'Saved' : 'Save chart'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="h-[360px] flex items-center justify-center text-slate-400 font-display tracking-wider">LOADING…</div>
        ) : !hasData ? (
          <div className="h-[360px] flex flex-col items-center justify-center text-center">
            <p className="font-display tracking-wider text-slate-300 uppercase text-sm">No data</p>
            <p className="text-sm text-slate-500 mt-1">
              {subFive === 'only' ? 'No buckets under 5 games for this cut.' : 'No matches fit these filters.'}
            </p>
          </div>
        ) : (
          <>
            <div className="h-[360px]">
              <ResponsiveContainer width="100%" height="100%">
                {measure === 'xy'
                  ? renderScatter(scatter, xVar.label, yVar.label, xVar.format, yVar.format)
                  : renderChart(chartType, {
                      chartData: shown!.data, seriesKeys: shown!.seriesKeys, pieData, valueFormat: activeFormat, seriesLabel,
                    })}
              </ResponsiveContainer>
            </div>

            {measure !== 'xy' && shown && (
              <>
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
                  {shown.data.map(d => {
                    const n = shown.perBucketN[String(d.bucket)] ?? 0
                    return (
                      <span key={String(d.bucket)} className="text-[11px] text-slate-500">
                        <span className="text-slate-400">{String(d.bucket)}</span>{' '}
                        <span className={n < 5 ? 'text-ow-defeat/80' : ''}>n={n}</span>
                      </span>
                    )
                  })}
                </div>
                <p className="text-[11px] text-slate-600 mt-2">
                  Buckets under 5 matches are flagged — small samples aren&apos;t signal. Use the &lt;5 control to drop or isolate them.
                </p>
              </>
            )}
          </>
        )}
      </div>

      {/* Saved charts panel */}
      <div className="bg-ow-panel rounded-xl border border-white/10 p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <button
            onClick={() => setPanelOpen(o => !o)}
            className="flex items-center gap-2 text-slate-200 hover:text-ow-orange transition-colors">
            <div className="h-1 w-10 bg-ow-orange rounded-full" />
            <span className="font-display tracking-[0.15em] uppercase text-xs">
              Saved charts ({savedStats.length})
            </span>
            <span className="text-slate-500 text-xs">{panelOpen ? '▾' : '▸'}</span>
          </button>
          <label className="flex items-center gap-2">
            <span className={labelCls}>Showing</span>
            <select
              className={selectCls}
              value={scope}
              onChange={e => setScope(e.target.value as 'season' | 'all')}>
              <option value="season">{season ? `This season (${season.name})` : 'This season'}</option>
              <option value="all">All time</option>
            </select>
          </label>
        </div>

        {scope === 'season' && !season && (
          <p className="text-[11px] text-ow-accent/80 mb-2">
            No current season set — counts below are empty. Add one in Settings → Seasons, or switch to All time.
          </p>
        )}

        {panelOpen && (
          savedStats.length === 0 ? (
            <p className="text-sm text-slate-500">
              No saved charts yet. Build a cut you like and hit ★ Save chart — revisits get counted here so you can see what you lean on across the season.
            </p>
          ) : (
            <div className="space-y-2">
              {[...savedStats]
                .sort((a, b) => b.distinctSessions - a.distinctSessions || b.totalViews - a.totalViews)
                .map(s => (
                  <button
                    key={s.config_key}
                    onClick={() => loadSaved(s)}
                    className="w-full text-left bg-ow-dark rounded-lg px-3 py-2.5 border border-white/10
                      hover:border-ow-orange/40 transition-colors flex items-center justify-between gap-3">
                    <span className="font-display text-sm text-slate-100 truncate">{s.label}</span>
                    <span className="flex items-center gap-3 shrink-0 text-[11px] font-display tracking-wider">
                      <span className="text-ow-orange">{s.distinctSessions} session{s.distinctSessions === 1 ? '' : 's'}</span>
                      <span className="text-slate-400">{s.totalViews} view{s.totalViews === 1 ? '' : 's'}</span>
                    </span>
                  </button>
                ))}
              <p className="text-[11px] text-slate-600 mt-1">
                Sorted by distinct sessions returned — the signal that a chart is worth promoting to a curated page.
              </p>
            </div>
          )
        )}
      </div>
    </div>
  )
}

// ---- Renderers ----------------------------------------------------------
const AXIS_TICK = { fill: OW.axis, fontSize: 11 }
const TOOLTIP = {
  contentStyle: { background: '#0f1419', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8 },
  labelStyle: { color: '#e6edf3' },
  itemStyle: { color: '#e6edf3' },
}

interface RenderArgs {
  chartData: { bucket: string; [s: string]: number | string }[]
  seriesKeys: string[]
  pieData: { name: string; value: number }[]
  valueFormat: ValueFormat
  seriesLabel: (s: string) => string
}

function renderChart(type: ChartType, a: RenderArgs) {
  const isPercent = a.valueFormat === 'percent'
  const yDomain = isPercent ? ([0, 100] as [number, number]) : (['auto', 'auto'] as ['auto', 'auto'])
  // Axis tick + tooltip both run values through the shared formatter, so a
  // duration shows m:ss, a percent shows N%, a count shows the plain number.
  const tickFmt = (v: number) => formatValue(v, a.valueFormat)
  const tipFmt = (v: number | string | ReadonlyArray<number | string> | undefined) => {
    const n = Array.isArray(v) ? Number(v[0]) : Number(v ?? 0)
    return formatValue(n, a.valueFormat)
  }

  if (type === 'line') {
    return (
      <LineChart data={a.chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid stroke={OW.grid} vertical={false} />
        <XAxis dataKey="bucket" tick={AXIS_TICK} stroke={OW.axis} />
        <YAxis tick={AXIS_TICK} stroke={OW.axis} domain={yDomain} tickFormatter={tickFmt} width={56} />
        <Tooltip {...TOOLTIP} formatter={tipFmt} />
        {a.seriesKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {a.seriesKeys.map((s, i) => (
          <Line key={s} type="monotone" dataKey={s} name={a.seriesLabel(s)}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
        ))}
      </LineChart>
    )
  }
  if (type === 'area') {
    return (
      <AreaChart data={a.chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid stroke={OW.grid} vertical={false} />
        <XAxis dataKey="bucket" tick={AXIS_TICK} stroke={OW.axis} />
        <YAxis tick={AXIS_TICK} stroke={OW.axis} domain={yDomain} tickFormatter={tickFmt} width={56} />
        <Tooltip {...TOOLTIP} formatter={tipFmt} />
        {a.seriesKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {a.seriesKeys.map((s, i) => (
          <Area key={s} type="monotone" dataKey={s} name={a.seriesLabel(s)}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            fill={SERIES_COLORS[i % SERIES_COLORS.length]} fillOpacity={0.25} strokeWidth={2} />
        ))}
      </AreaChart>
    )
  }
  if (type === 'pie') {
    return (
      <PieChart>
        <Tooltip {...TOOLTIP} formatter={tipFmt} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Pie data={a.pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={120} label>
          {a.pieData.map((_, i) => <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />)}
        </Pie>
      </PieChart>
    )
  }
  if (type === 'radar') {
    return (
      <RadarChart data={a.chartData} outerRadius={130}>
        <PolarGrid stroke={OW.grid} />
        <PolarAngleAxis dataKey="bucket" tick={AXIS_TICK} />
        <PolarRadiusAxis tick={AXIS_TICK} stroke={OW.axis} tickFormatter={tickFmt} />
        <Tooltip {...TOOLTIP} formatter={tipFmt} />
        {a.seriesKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {a.seriesKeys.map((s, i) => (
          <Radar key={s} dataKey={s} name={a.seriesLabel(s)}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            fill={SERIES_COLORS[i % SERIES_COLORS.length]} fillOpacity={0.3} />
        ))}
      </RadarChart>
    )
  }
  // bar (default)
  return (
    <BarChart data={a.chartData} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
      <CartesianGrid stroke={OW.grid} vertical={false} />
      <XAxis dataKey="bucket" tick={AXIS_TICK} stroke={OW.axis} />
      <YAxis tick={AXIS_TICK} stroke={OW.axis} domain={yDomain} tickFormatter={tickFmt} width={56} />
      <Tooltip {...TOOLTIP} formatter={tipFmt} />
      {a.seriesKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
      {a.seriesKeys.map((s, i) => (
        <Bar key={s} dataKey={s} name={a.seriesLabel(s)} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[4, 4, 0, 0]} />
      ))}
    </BarChart>
  )
}

function renderScatter(
  points: { x: number; y: number; label: string }[],
  xLabel: string, yLabel: string,
  xFormat?: ValueFormat, yFormat?: ValueFormat,
) {
  const xFmt = (v: number) => formatValue(v, xFormat)
  const yFmt = (v: number) => formatValue(v, yFormat)
  const tipFmt = (v: number | string | ReadonlyArray<number | string> | undefined, name: number | string | undefined) => {
    const n = Array.isArray(v) ? Number(v[0]) : Number(v ?? 0)
    return [formatValue(n, name === 'y' ? yFormat : xFormat), name === 'y' ? yLabel : xLabel] as [string, string]
  }
  return (
    <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
      <CartesianGrid stroke={OW.grid} />
      <XAxis type="number" dataKey="x" name={xLabel} tick={AXIS_TICK} stroke={OW.axis} tickFormatter={xFmt}
        label={{ value: xLabel, position: 'insideBottom', offset: -12, fill: OW.axis, fontSize: 11 }} />
      <YAxis type="number" dataKey="y" name={yLabel} tick={AXIS_TICK} stroke={OW.axis} tickFormatter={yFmt} width={56} />
      <ZAxis range={[50, 50]} />
      <Tooltip {...TOOLTIP} cursor={{ strokeDasharray: '3 3' }} formatter={tipFmt} />
      <Scatter data={points} fill={OW.orange} fillOpacity={0.7} />
    </ScatterChart>
  )
}

// Single-category renderer (Y = None): one series, bar/line/area/radar, with
// optional per-bucket DIMMING for the win-rate filter (matches stay bright,
// the rest fade). Bars dim per-bar via <Cell>; line/area/radar dim the whole
// series colour when a filter is active (individual points can't fade cleanly
// on a connected line, so the series mutes to signal "filter on").
function renderFreeSingle(
  type: ChartType,
  data: { bucket: string; [s: string]: number | string }[],
  seriesKeys: string[],
  valueFormat: ValueFormat,
  seriesLabel: (s: string) => string,
  dimBucket?: (bucket: string) => boolean,
) {
  const isPercent = valueFormat === 'percent'
  const yDomain = isPercent ? ([0, 100] as [number, number]) : (['auto', 'auto'] as ['auto', 'auto'])
  const tickFmt = (v: number) => formatValue(v, valueFormat)
  const tipFmt = (v: number | string | ReadonlyArray<number | string> | undefined) => {
    const n = Array.isArray(v) ? Number(v[0]) : Number(v ?? 0)
    return formatValue(n, valueFormat)
  }
  const s0 = seriesKeys[0]
  const filterOn = !!dimBucket

  if (type === 'line') {
    return (
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid stroke={OW.grid} vertical={false} />
        <XAxis dataKey="bucket" tick={AXIS_TICK} stroke={OW.axis} />
        <YAxis tick={AXIS_TICK} stroke={OW.axis} domain={yDomain} tickFormatter={tickFmt} width={56} />
        <Tooltip {...TOOLTIP} formatter={tipFmt} />
        {seriesKeys.map((s, i) => (
          <Line key={s} type="monotone" dataKey={s} name={seriesLabel(s)}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeOpacity={filterOn ? 0.4 : 1}
            strokeWidth={2} dot={{ r: 3 }} />
        ))}
      </LineChart>
    )
  }
  if (type === 'area') {
    return (
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid stroke={OW.grid} vertical={false} />
        <XAxis dataKey="bucket" tick={AXIS_TICK} stroke={OW.axis} />
        <YAxis tick={AXIS_TICK} stroke={OW.axis} domain={yDomain} tickFormatter={tickFmt} width={56} />
        <Tooltip {...TOOLTIP} formatter={tipFmt} />
        {seriesKeys.map((s, i) => (
          <Area key={s} type="monotone" dataKey={s} name={seriesLabel(s)}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            fill={SERIES_COLORS[i % SERIES_COLORS.length]}
            fillOpacity={filterOn ? 0.1 : 0.25} strokeOpacity={filterOn ? 0.4 : 1} strokeWidth={2} />
        ))}
      </AreaChart>
    )
  }
  if (type === 'radar') {
    return (
      <RadarChart data={data} outerRadius={130}>
        <PolarGrid stroke={OW.grid} />
        <PolarAngleAxis dataKey="bucket" tick={AXIS_TICK} />
        <PolarRadiusAxis tick={AXIS_TICK} stroke={OW.axis} tickFormatter={tickFmt} />
        <Tooltip {...TOOLTIP} formatter={tipFmt} />
        {seriesKeys.map((s, i) => (
          <Radar key={s} dataKey={s} name={seriesLabel(s)}
            stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            fill={SERIES_COLORS[i % SERIES_COLORS.length]} fillOpacity={filterOn ? 0.12 : 0.3} />
        ))}
      </RadarChart>
    )
  }
  // bar (default) — per-bar dimming via <Cell>
  return (
    <BarChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
      <CartesianGrid stroke={OW.grid} vertical={false} />
      <XAxis dataKey="bucket" tick={AXIS_TICK} stroke={OW.axis} />
      <YAxis tick={AXIS_TICK} stroke={OW.axis} domain={yDomain} tickFormatter={tickFmt} width={56} />
      <Tooltip {...TOOLTIP} formatter={tipFmt} />
      <Bar dataKey={s0} name={seriesLabel(s0)} fill={OW.orange} radius={[4, 4, 0, 0]}>
        {data.map((d, i) => {
          const dim = dimBucket ? dimBucket(String(d.bucket)) : false
          return <Cell key={i} fill={OW.orange} fillOpacity={dim ? 0.18 : 1} />
        })}
      </Bar>
    </BarChart>
  )
}

// ============================================================
// FREE BUILDER (dual-axis) — X variable × Y variable × cell measure
// ------------------------------------------------------------
// Both axes are variables. The pairing decides the shape:
//   • cat × cat  → cross-tab; you pick a cell measure (win rate / count / avg).
//                  Rendered as a HEATMAP (primary) or grouped BARS.
//   • cat × num  → average the numeric within each category (reuses aggregate).
//   • num × num  → scatter (reuses scatterPoints / renderScatter).
// Same foundation rules as the generic builder; cross-grain pairs are disabled
// with a reason. Its OWN saved-charts store (builder2_*).
// ============================================================

// Heatmap colour: blend from a muted base to OW orange by intensity (0..1),
// honouring direction (the lib already flips intensity for lower-is-better).
function heatColor(intensity: number | null): string {
  if (intensity === null) return 'transparent'
  // base (cool, faint) → strong orange. Simple linear RGB blend.
  const from = [42, 49, 58]      // slate-ish panel
  const to = [249, 158, 26]      // ow-orange
  const c = from.map((f, i) => Math.round(f + (to[i] - f) * intensity))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}
// Readable text colour on a heat cell (dark text on bright cells).
function heatText(intensity: number | null): string {
  if (intensity === null) return '#475569'
  return intensity > 0.55 ? '#0f1419' : '#e6edf3'
}

// Map a FreeChartType to the renderChart() ChartType. 'bars' → 'bar'; heatmap
// and scatter are handled by their own branches, so they fall back to 'bar'
// here (never actually reached for those).
function freeChartToChartType(ft: FreeChartType): ChartType {
  switch (ft) {
    case 'bars': return 'bar'
    case 'line': return 'line'
    case 'area': return 'area'
    case 'radar': return 'radar'
    default: return 'bar'
  }
}

function FreeHeatmap({
  ct, valueFormat, dimNonPassing,
}: {
  ct: CrossTabResult
  valueFormat: ValueFormat
  dimNonPassing?: (x: string, y: string) => boolean // true → dim this cell (highlight mode)
}) {
  // A scrollable grid: top-left blank, Y labels down the left, X labels across
  // the top. Cells coloured by direction-aware intensity; thin (<5) cells get a
  // dashed ring so small samples read as low-confidence. In highlight mode,
  // cells that don't pass the win filter are dimmed (not removed).
  return (
    <div className="overflow-auto max-h-[460px]">
      <table className="border-separate" style={{ borderSpacing: 3 }}>
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 bg-ow-panel" />
            {ct.xBuckets.map(xb => (
              <th key={xb}
                className="sticky top-0 z-10 bg-ow-panel px-2 py-1 text-[10px] font-display tracking-wider
                  text-slate-400 uppercase whitespace-nowrap text-left align-bottom">
                {xb}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ct.yBuckets.map(yb => (
            <tr key={yb}>
              <th className="sticky left-0 z-10 bg-ow-panel pr-2 text-[10px] font-display tracking-wider
                text-slate-400 uppercase whitespace-nowrap text-right">
                {yb}
              </th>
              {ct.xBuckets.map(xb => {
                const cell = ct.cellAt(xb, yb)
                const val = cell?.value ?? null
                const intensity = cellIntensity(val, ct.min, ct.max, ct.lowerIsBetter)
                const thin = (cell?.n ?? 0) > 0 && (cell?.n ?? 0) < 5
                const dimmed = val !== null && dimNonPassing ? dimNonPassing(xb, yb) : false
                return (
                  <td key={xb}
                    title={`${xb} × ${yb}\n${val === null ? 'no games' : formatValue(val, valueFormat)} · n=${cell?.n ?? 0}`}
                    className="text-center rounded-md transition-opacity"
                    style={{
                      minWidth: 56, height: 44,
                      background: heatColor(intensity),
                      color: heatText(intensity),
                      boxShadow: thin ? 'inset 0 0 0 1.5px rgba(248,81,73,0.7)' : undefined,
                      opacity: dimmed ? 0.18 : 1,
                    }}>
                    <div className="text-xs font-display leading-tight">
                      {val === null ? '·' : formatValue(val, valueFormat)}
                    </div>
                    {val !== null && (
                      <div className="text-[9px] opacity-70 leading-tight">n={cell?.n ?? 0}</div>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function FreeBuilder() {
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)
  const [matchRows, setMatchRows] = useState<MatchRow[]>([])
  const [heroRows, setHeroRows] = useState<HeroRow[]>([])
  const [loading, setLoading] = useState(true)

  // Selections: both axes are variables.
  const [xVarKey, setXVarKey] = useState<string>('map')
  const [yVarKey, setYVarKey] = useState<string>('role_played')
  const [cellMeasure, setCellMeasure] = useState<CellMeasure>('win_rate')
  const [avgVarKey, setAvgVarKey] = useState<string>('total_eliminations')
  const [freeChart, setFreeChart] = useState<FreeChartType>('heatmap')
  const [subFive, setSubFive] = useState<'show' | 'hide' | 'only'>('show')
  // Win-rate "nugget" filter. Non-matching buckets are always DIMMED (not hidden).
  const [winFilter, setWinFilter] = useState<WinFilter>(DEFAULT_WIN_FILTER)

  // ---- Usage tracking (separate store) ----
  const [saved, setSaved] = useState(false)
  const [savedStats, setSavedStats] = useState<FreeSavedChartStats[]>([])
  const [season, setSeason] = useState<SeasonRow | null>(null)
  const [scope, setScope] = useState<'season' | 'all'>('season')
  const [panelOpen, setPanelOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      matchQuery(MATCH_COLS).order('played_at', { ascending: false }),
      supabase.from('hero_match_facts').select(HERO_COLS),
    ]).then(([mRes, hRes]) => {
      if (cancelled) return
      const m = (((mRes as unknown) as { data: MatchRow[] | null }).data) || []
      const hAll = (((hRes as unknown) as { data: HeroRow[] | null }).data) || []
      setMatchRows(m)
      setHeroRows(hAll)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const xVar = byKey(xVarKey) ?? VARIABLES[0]
  // Y can be "None" (empty string) → a single-category chart.
  const yVar = yVarKey === '' ? null : (byKey(yVarKey) ?? null)
  const avgVar = numVars().find(v => v.key === avgVarKey) ?? numVars()[0]

  const validity = pairValidity(xVar, yVar)
  const chartAvail = freeChartAvailability(validity.shape)

  // Keep the cell measure valid for the current pairing.
  useEffect(() => {
    if (validity.cellMeasures.length && !validity.cellMeasures.includes(cellMeasure)) {
      setCellMeasure(validity.cellMeasures[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xVarKey, yVarKey, validity.shape])

  // Snap the chart type to a valid one for the shape.
  useEffect(() => {
    if (validity.shape === 'scatter') setFreeChart('scatter')
    else if (validity.shape === 'cat_num' || validity.shape === 'single') {
      if (freeChart === 'heatmap' || freeChart === 'scatter') setFreeChart('bars')
    } else if (validity.shape === 'crosstab' && freeChart === 'scatter') setFreeChart('heatmap')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validity.shape])

  // Swap X ↔ Y. If Y is None (single-category), swapping would put None on X,
  // which isn't valid — so a swap with Y=None is a no-op (nothing to swap to).
  const swapAxes = useCallback(() => {
    if (yVarKey === '') return
    setXVarKey(yVarKey)
    setYVarKey(xVarKey)
  }, [xVarKey, yVarKey])

  // The grain is shared across both axes once valid; pick the dataset from X.
  const grain = xVar.grain

  const filteredMatch = useMemo(
    () => matchRows.filter(r => matchesFilters(r, filters)),
    [matchRows, filters]
  )
  const visibleMatchIds = useMemo(() => new Set(matchRows.map(r => r.id)), [matchRows])
  const filteredHero = useMemo(
    () => heroRows
      .filter(r => visibleMatchIds.has(r.match_id))
      .filter(r => heroRowPasses(r, filters))
      .filter(r => heroMatches(r.hero_name, filters)),
    [heroRows, visibleMatchIds, filters]
  )

  const derivedCtx = useMemo(() => ({
    session: sessionMap(matchRows),
    streak: streakMap(matchRows),
  }), [matchRows])

  const rowsForGrain = (grain === 'hero' ? filteredHero : filteredMatch) as unknown as Record<string, unknown>[]

  // ---- cat × cat → cross-tab ----
  const ct = useMemo(() => {
    if (validity.shape !== 'crosstab' || !yVar) return null
    return crossTab({
      rows: rowsForGrain, xVar, yVar, cellMeasure,
      avgVar: cellMeasure === 'avg' ? avgVar : undefined,
      derivedCtx,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validity.shape, rowsForGrain, xVar, yVar, cellMeasure, avgVar, derivedCtx])

  // Apply the <5 toggle to the heatmap (drops thin cells' VALUES, keeps layout).
  const ctShown = useMemo(() => {
    if (!ct || subFive === 'show') return ct
    const cells = ct.cells.map(c => {
      const isThin = c.n > 0 && c.n < 5
      const keep = subFive === 'hide' ? !isThin : isThin
      return keep ? c : { ...c, value: null }
    })
    const cellMap = new Map(cells.map(c => [`${c.x}\u0000${c.y}`, c]))
    return { ...ct, cells, cellAt: (x: string, y: string) => cellMap.get(`${x}\u0000${y}`) }
  }, [ct, subFive])

  // ---- single category (Y = None) → measure by ONE variable ----
  // Reuses the generic aggregate(): buckets by X, computes the chosen measure.
  const singleAgg = useMemo(() => {
    if (validity.shape !== 'single') return null
    const formatPinned = filters.queue !== 'all'
    const splitByFormat = !formatPinned && xVar.column !== 'match_format'
    const res = aggregate({
      rows: rowsForGrain, xVar,
      measure: cellMeasure as MeasureKind, // 'win_rate' | 'count' | 'avg'
      avgCol: cellMeasure === 'avg' ? avgVar.column : undefined,
      splitByFormat, derivedCtx,
    })
    return res
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validity.shape, rowsForGrain, xVar, cellMeasure, avgVar, filters.queue, derivedCtx])

  const singleShown = useMemo(() => {
    if (!singleAgg) return null
    let data = singleAgg.data.filter(d => String(d.bucket) !== '—')
    if (subFive !== 'show') {
      data = data.filter(d => {
        const n = singleAgg.perBucketN[String(d.bucket)] ?? 0
        return subFive === 'hide' ? n >= 5 : n < 5
      })
    }
    return { ...singleAgg, data }
  }, [singleAgg, subFive])

  // ---- Win-rate "nugget" filter -------------------------------------------
  // Works on ANY bucketed WIN-RATE chart: cat×cat cross-tab AND single-category.
  // The baseline is the pooled, games-weighted win rate across the rows in view
  // (moves with the 4 filters). Non-matching buckets are always DIMMED.
  const winFilterApplies =
    (validity.shape === 'crosstab' || validity.shape === 'single') && cellMeasure === 'win_rate'
  const baseline = useMemo(
    () => (winFilterApplies ? baselineWinRate(rowsForGrain, grain) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [winFilterApplies, rowsForGrain, grain]
  )
  const winFilterActive = winFilterApplies && winFilter.mode !== 'off'

  // Cross-tab: the set of cell keys that PASS (for dimming the heatmap/bars).
  const passKeys = useMemo(() => {
    if (!ctShown || !winFilterActive) return null
    const keys = new Set<string>()
    for (const c of ctShown.cells) {
      if (cellPassesWinFilter(c.value, winFilter, baseline)) keys.add(`${c.x}\u0000${c.y}`)
    }
    return keys
  }, [ctShown, winFilterActive, winFilter, baseline])

  // Single-category: the set of bucket names that PASS (series 'all' or first).
  const passBuckets = useMemo(() => {
    if (!singleShown || !winFilterActive) return null
    const keys = new Set<string>()
    const sKey = singleShown.seriesKeys[0]
    for (const d of singleShown.data) {
      const v = Number(d[sKey] ?? 0)
      if (cellPassesWinFilter(v, winFilter, baseline)) keys.add(String(d.bucket))
    }
    return keys
  }, [singleShown, winFilterActive, winFilter, baseline])

  // ---- cat × cat as grouped series (reshape the cross-tab) ----
  // X bucket on the axis, one series per Y bucket. Feeds renderChart for
  // bar/line/area/radar.
  const crosstabChartTypes: FreeChartType[] = ['bars', 'line', 'area', 'radar']
  const barData = useMemo(() => {
    const src = ctShown
    if (!src || !crosstabChartTypes.includes(freeChart) || validity.shape !== 'crosstab') return null
    const data = src.xBuckets.map(xb => {
      const row: { bucket: string; [s: string]: number | string } = { bucket: xb }
      for (const yb of src.yBuckets) {
        const c = src.cellAt(xb, yb)
        row[yb] = c?.value ?? 0
      }
      return row
    })
    return { data, seriesKeys: src.yBuckets }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctShown, freeChart, validity.shape])

  // ---- cat × num → average the numeric within each category bucket ----
  // Identify which axis is categorical and which is numeric.
  const catNumAgg = useMemo(() => {
    if (validity.shape !== 'cat_num' || !yVar) return null
    const catVar = xVar.kinds.includes('cat') && !xVar.kinds.includes('num') ? xVar
      : (yVar.kinds.includes('cat') && !yVar.kinds.includes('num') ? yVar : (xVar.kinds.includes('cat') ? xVar : yVar))
    const theNumVar = catVar === xVar ? yVar : xVar
    const formatPinned = filters.queue !== 'all'
    const splitByFormat = !formatPinned && catVar.column !== 'match_format'
    const res = aggregate({
      rows: rowsForGrain, xVar: catVar, measure: 'avg',
      avgCol: theNumVar.column, splitByFormat, derivedCtx,
    })
    return { res, catVar, numVar: theNumVar }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validity.shape, rowsForGrain, xVar, yVar, filters.queue, derivedCtx])

  const catNumShown = useMemo(() => {
    if (!catNumAgg) return null
    let data = catNumAgg.res.data.filter(d => String(d.bucket) !== '—')
    if (subFive !== 'show') {
      data = data.filter(d => {
        const n = catNumAgg.res.perBucketN[String(d.bucket)] ?? 0
        return subFive === 'hide' ? n >= 5 : n < 5
      })
    }
    return { ...catNumAgg.res, data }
  }, [catNumAgg, subFive])

  // ---- num × num → scatter ----
  const scatter = useMemo(() => {
    if (validity.shape !== 'scatter' || !yVar) return []
    return scatterPoints(rowsForGrain, xVar.column, yVar.column)
  }, [validity.shape, rowsForGrain, xVar, yVar])

  // ---- value format for the active output ----
  const cellFormat: ValueFormat =
    cellMeasure === 'win_rate' ? 'percent'
      : cellMeasure === 'avg' ? (avgVar.format ?? 'number')
        : 'number'
  const catNumFormat: ValueFormat = catNumAgg ? (catNumAgg.numVar.format ?? 'number') : 'number'

  const cellMeasureLabel = CELL_MEASURES.find(m => m.kind === cellMeasure)?.label ?? ''
  const measureWord = cellMeasure === 'avg' ? `Avg ${avgVar.label.toLowerCase()}` : cellMeasureLabel
  const chartTitle =
    validity.shape === 'single' ? `${measureWord} by ${xVar.label}`
      : validity.shape === 'scatter' && yVar ? `${yVar.label} vs ${xVar.label}`
        : validity.shape === 'cat_num' && catNumAgg
          ? `Average ${catNumAgg.numVar.label.toLowerCase()} by ${catNumAgg.catVar.label}`
          : `${measureWord} — ${xVar.label} × ${yVar?.label ?? '—'}`

  // ---- Current config (for save/track) ----
  const currentConfig: FreeChartConfig = useMemo(() => ({
    xVar: xVarKey, yVar: yVarKey, cellMeasure, chartType: freeChart,
    avgVar: cellMeasure === 'avg' ? avgVarKey : null,
  }), [xVarKey, yVarKey, cellMeasure, freeChart, avgVarKey])
  const currentKey = freeConfigKey(currentConfig)
  const currentLabel = chartTitle + ` (${freeChart})`

  const refreshStats = useCallback(async () => {
    const s = scope === 'season' ? season : null
    const window = s ? { start: s.start_date, end: s.end_date } : undefined
    setSavedStats(await savedChartStatsFree(window))
  }, [scope, season])

  useEffect(() => { getCurrentSeasonFree().then(setSeason) }, [])
  useEffect(() => { refreshStats() }, [refreshStats])

  useEffect(() => {
    let cancelled = false
    isSavedFree(currentKey).then(s => { if (!cancelled) setSaved(s) })
    return () => { cancelled = true }
  }, [currentKey])

  useEffect(() => {
    if (!saved) return
    const t = window.setTimeout(() => {
      logViewFree(currentKey).then(() => refreshStats())
    }, 1200)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, saved])

  const onToggleSave = useCallback(async () => {
    const nowSaved = await toggleSaveFree(currentConfig, currentLabel)
    setSaved(nowSaved)
    if (nowSaved) await logViewFree(currentKey)
    await refreshStats()
  }, [currentConfig, currentLabel, currentKey, refreshStats])

  const loadSaved = useCallback((s: FreeSavedChartStats) => {
    setXVarKey(s.x_var)
    setYVarKey(s.y_var)
    setCellMeasure(s.cell_measure as CellMeasure)
    setFreeChart(s.chart_type as FreeChartType)
    if (s.avg_var) setAvgVarKey(s.avg_var)
    setPanelOpen(false)
  }, [])

  const selectCls =
    'bg-ow-dark border border-white/20 rounded-xl px-3 py-2 text-sm text-slate-100 ' +
    'font-display tracking-wider focus:border-ow-orange focus:outline-none transition-colors ' +
    '[color-scheme:dark] max-w-[15rem]'
  const labelCls = 'text-[11px] text-slate-400 font-display tracking-wider uppercase'

  const formatPinned = filters.queue !== 'all'
  const splitByFormat = !formatPinned && validity.shape === 'cat_num'

  const totalN =
    validity.shape === 'scatter' ? scatter.length
      : validity.shape === 'cat_num' ? (catNumShown?.totalN ?? 0)
        : validity.shape === 'single' ? (singleShown?.totalN ?? 0)
          : (ctShown?.totalN ?? 0)

  const hasData =
    validity.shape === 'scatter' ? scatter.length > 0
      : validity.shape === 'cat_num' ? (catNumShown?.data.length ?? 0) > 0
        : validity.shape === 'single' ? (singleShown?.data.length ?? 0) > 0
          : (ct?.xBuckets.length ?? 0) > 0 && (ct?.yBuckets.length ?? 0) > 0

  return (
    <div className="space-y-6">
      <AnalyticsFilters value={filters} onChange={setFilters} show={{ queue: true, mode: true, map: true, hero: true }} />

      {/* Pickers */}
      <div className="bg-ow-panel rounded-xl border border-white/10 p-4">
        <div className="flex items-center gap-2 mb-4">
          <div className="h-1 w-10 bg-ow-orange rounded-full" />
          <span className="font-display tracking-[0.15em] text-slate-300 uppercase text-xs">Free chart — any X × any Y</span>
          <span className={`text-[10px] font-display tracking-wider uppercase px-2 py-0.5 rounded ${READY_BADGE[xVar.ready].cls}`}>
            {grain === 'hero' ? 'per-hero data' : 'per-match data'}
          </span>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1">
            <span className={labelCls}>X-axis variable</span>
            <select className={selectCls} value={xVarKey} onChange={e => setXVarKey(e.target.value)}>
              {renderVarOptionsAll(xVarKey)}
            </select>
          </label>

          <div className="flex flex-col gap-1 justify-end">
            <span className={labelCls}>&nbsp;</span>
            <button
              type="button"
              onClick={swapAxes}
              title="Swap X and Y"
              className="bg-ow-dark border border-white/20 rounded-xl px-3 py-2 text-slate-300
                hover:border-ow-orange/50 hover:text-ow-orange transition-colors font-display text-sm">
              ⇄
            </button>
          </div>

          <label className="flex flex-col gap-1">
            <span className={labelCls}>Y-axis variable</span>
            <select className={selectCls} value={yVarKey} onChange={e => setYVarKey(e.target.value)}>
              <option value="">— None (one variable) —</option>
              {renderVarOptionsAll(yVarKey)}
            </select>
          </label>

          {(validity.shape === 'crosstab' || validity.shape === 'single') && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>{validity.shape === 'single' ? 'Show' : 'Cell shows'}</span>
              <select className={selectCls} value={cellMeasure} onChange={e => setCellMeasure(e.target.value as CellMeasure)}>
                {CELL_MEASURES.map(m => <option key={m.kind} value={m.kind}>{m.label}</option>)}
              </select>
            </label>
          )}

          {(validity.shape === 'crosstab' || validity.shape === 'single') && cellMeasure === 'avg' && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Of which stat</span>
              <select className={selectCls} value={avgVarKey} onChange={e => setAvgVarKey(e.target.value)}>
                {numVars().filter(v => v.grain === grain).map(v => (
                  <option key={v.key} value={v.key}>{v.label}</option>
                ))}
              </select>
            </label>
          )}

          {(validity.shape === 'crosstab' || validity.shape === 'cat_num' || validity.shape === 'single') && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>View as</span>
              <select className={selectCls} value={freeChart} onChange={e => setFreeChart(e.target.value as FreeChartType)}>
                {(validity.shape === 'crosstab'
                  ? (['heatmap', 'bars', 'line', 'area', 'radar'] as FreeChartType[])
                  : (['bars', 'line', 'area', 'radar'] as FreeChartType[])
                ).map(ft => (
                  <option key={ft} value={ft} disabled={chartAvail[ft] !== null}>
                    {ft === 'bars' ? 'Bars' : ft[0].toUpperCase() + ft.slice(1)}{chartAvail[ft] ? ' — N/A' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {validity.shape !== 'scatter' && (
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Small samples (&lt;5)</span>
              <select className={selectCls} value={subFive} onChange={e => setSubFive(e.target.value as 'show' | 'hide' | 'only')}>
                <option value="show">Show all</option>
                <option value="hide">Hide &lt;5-game</option>
                <option value="only">Only &lt;5-game</option>
              </select>
            </label>
          )}
        </div>

        {/* Win-rate "nugget" filter — on any bucketed win-rate chart. */}
        {winFilterApplies && (
          <div className="flex flex-wrap items-end gap-4 mt-4 pt-4 border-t border-white/10">
            <label className="flex flex-col gap-1">
              <span className={labelCls}>Win-rate filter</span>
              <select
                className={selectCls}
                value={winFilter.mode}
                onChange={e => setWinFilter({ ...winFilter, mode: e.target.value as WinFilter['mode'] })}>
                <option value="off">Off — show everything</option>
                <option value="threshold">Win rate is…</option>
                <option value="vs_baseline">Compare to my average</option>
              </select>
            </label>

            {winFilter.mode === 'threshold' && (
              <>
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>Direction</span>
                  <select
                    className={selectCls}
                    value={winFilter.dir}
                    onChange={e => setWinFilter({ ...winFilter, dir: e.target.value as WinFilter['dir'] })}>
                    <option value="above">At least (≥)</option>
                    <option value="below">At most (≤)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className={labelCls}>Win rate %</span>
                  <input
                    type="number" min={0} max={100} step={1}
                    className={selectCls + ' w-24'}
                    value={winFilter.value}
                    onChange={e => setWinFilter({ ...winFilter, value: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
                </label>
              </>
            )}

            {winFilter.mode === 'vs_baseline' && (
              <label className="flex flex-col gap-1">
                <span className={labelCls}>Show…</span>
                <select
                  className={selectCls}
                  value={winFilter.dir}
                  onChange={e => setWinFilter({ ...winFilter, dir: e.target.value as WinFilter['dir'] })}>
                  <option value="above">Above my average</option>
                  <option value="below">Below my average</option>
                </select>
              </label>
            )}

            {winFilterActive && (
              <span className="text-[11px] text-slate-500 self-center max-w-[14rem]">
                Matches stay bright; everything else dims.
              </span>
            )}
          </div>
        )}

        {!validity.ok && (
          <p className="text-[11px] text-ow-defeat/90 mt-3">{validity.reason}</p>
        )}
        {validity.ok && validity.shape === 'crosstab' && yVar && (
          <p className="text-[11px] text-slate-500 mt-3">
            Each cell is the {cellMeasure === 'avg' ? `average ${avgVar.label.toLowerCase()}` : cellMeasureLabel.toLowerCase()} of games where {xVar.label} meets {yVar.label}. Brighter = better; cells under 5 games are ringed in red.
          </p>
        )}
        {validity.ok && validity.shape === 'single' && (
          <p className="text-[11px] text-slate-500 mt-3">
            {measureWord} by {xVar.label}, one bar per value. Add a Y variable to cross-tabulate two variables instead.
          </p>
        )}
        {winFilterActive && winFilter.mode === 'vs_baseline' && (
          <p className="text-[11px] text-ow-orange/90 mt-2">
            Your baseline win rate across the {totalN} game{totalN === 1 ? '' : 's'} in view is {baseline}%. Showing pairings {winFilter.dir === 'above' ? 'above' : 'below'} that.
          </p>
        )}
        {validity.ok && validity.shape === 'cat_num' && splitByFormat && (
          <p className="text-[11px] text-slate-500 mt-3">5v5 and 6v6 are shown as separate series (never blended). Pick a Queue to focus one format.</p>
        )}
        {validity.ok && grain === 'hero' && (
          <p className="text-[11px] text-slate-500 mt-2">Per-hero data: rates are games-weighted (a multi-hero game counts once).</p>
        )}
      </div>

      {/* Output */}
      <div className="bg-ow-panel rounded-xl border border-white/10 p-4">
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <h2 className="font-display tracking-[0.12em] text-slate-100 uppercase text-sm">{chartTitle}</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 font-display tracking-wider">
              {validity.shape === 'scatter'
                ? `${scatter.length} point${scatter.length === 1 ? '' : 's'}`
                : `n = ${totalN} match${totalN === 1 ? '' : 'es'}`}
            </span>
            <button
              onClick={onToggleSave}
              disabled={!validity.ok}
              title={saved ? 'Saved — click to remove' : 'Save this chart to revisit it'}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-display tracking-wider uppercase transition-colors border disabled:opacity-40 ${
                saved
                  ? 'bg-ow-orange text-ow-dark border-ow-orange font-bold'
                  : 'bg-ow-dark text-slate-300 border-white/20 hover:border-ow-orange/50'
              }`}>
              <span>{saved ? '★' : '☆'}</span>
              {saved ? 'Saved' : 'Save chart'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="h-[360px] flex items-center justify-center text-slate-400 font-display tracking-wider">LOADING…</div>
        ) : !validity.ok ? (
          <div className="h-[360px] flex flex-col items-center justify-center text-center px-6">
            <p className="font-display tracking-wider text-slate-300 uppercase text-sm">Pick a valid pair</p>
            <p className="text-sm text-slate-500 mt-1 max-w-md">{validity.reason}</p>
          </div>
        ) : !hasData ? (
          <div className="h-[360px] flex flex-col items-center justify-center text-center">
            <p className="font-display tracking-wider text-slate-300 uppercase text-sm">No data</p>
            <p className="text-sm text-slate-500 mt-1">No matches fit these filters.</p>
          </div>
        ) : validity.shape === 'crosstab' && freeChart === 'heatmap' && ctShown ? (
          <FreeHeatmap
            ct={ctShown}
            valueFormat={cellFormat}
            dimNonPassing={
              winFilterActive && passKeys
                ? (x: string, y: string) => !passKeys.has(`${x}\u0000${y}`)
                : undefined
            }
          />
        ) : validity.shape === 'crosstab' && barData ? (
          <div className="h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              {renderChart(freeChartToChartType(freeChart), {
                chartData: barData.data, seriesKeys: barData.seriesKeys, pieData: [],
                valueFormat: cellFormat, seriesLabel: (s: string) => s,
              })}
            </ResponsiveContainer>
          </div>
        ) : validity.shape === 'single' && singleShown ? (
          <div className="h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              {renderFreeSingle(
                freeChartToChartType(freeChart),
                singleShown.data,
                singleShown.seriesKeys,
                cellFormat,
                (s: string) => (s === 'all' ? measureWord : s.toUpperCase()),
                winFilterActive && passBuckets
                  ? (bucket: string) => !passBuckets.has(bucket)
                  : undefined,
              )}
            </ResponsiveContainer>
          </div>
        ) : validity.shape === 'cat_num' && catNumShown ? (
          <div className="h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              {renderChart(freeChartToChartType(freeChart), {
                chartData: catNumShown.data, seriesKeys: catNumShown.seriesKeys, pieData: [],
                valueFormat: catNumFormat,
                seriesLabel: (s: string) => (s === 'all' ? (catNumAgg?.numVar.label ?? '') : s.toUpperCase()),
              })}
            </ResponsiveContainer>
          </div>
        ) : validity.shape === 'scatter' && yVar ? (
          <div className="h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              {renderScatter(scatter, xVar.label, yVar.label, xVar.format, yVar.format)}
            </ResponsiveContainer>
          </div>
        ) : null}

        {validity.ok && validity.shape === 'crosstab' && (
          <p className="text-[11px] text-slate-600 mt-3">
            Cells under 5 games are low-confidence — use the &lt;5 control to drop or isolate them. A “·” means no games at that intersection.
          </p>
        )}
      </div>

      {/* Saved charts panel (Free Builder's own store) */}
      <div className="bg-ow-panel rounded-xl border border-white/10 p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <button
            onClick={() => setPanelOpen(o => !o)}
            className="flex items-center gap-2 text-slate-200 hover:text-ow-orange transition-colors">
            <div className="h-1 w-10 bg-ow-orange rounded-full" />
            <span className="font-display tracking-[0.15em] uppercase text-xs">
              Saved free charts ({savedStats.length})
            </span>
            <span className="text-slate-500 text-xs">{panelOpen ? '▾' : '▸'}</span>
          </button>
          <label className="flex items-center gap-2">
            <span className={labelCls}>Showing</span>
            <select className={selectCls} value={scope} onChange={e => setScope(e.target.value as 'season' | 'all')}>
              <option value="season">{season ? `This season (${season.name})` : 'This season'}</option>
              <option value="all">All time</option>
            </select>
          </label>
        </div>

        {scope === 'season' && !season && (
          <p className="text-[11px] text-ow-accent/80 mb-2">
            No current season set — counts below are empty. Add one in Settings → Seasons, or switch to All time.
          </p>
        )}

        {panelOpen && (
          savedStats.length === 0 ? (
            <p className="text-sm text-slate-500">
              No saved free charts yet. Build a cut you like and hit ★ Save chart — revisits get counted here.
            </p>
          ) : (
            <div className="space-y-2">
              {[...savedStats]
                .sort((a, b) => b.distinctSessions - a.distinctSessions || b.totalViews - a.totalViews)
                .map(s => (
                  <button
                    key={s.config_key}
                    onClick={() => loadSaved(s)}
                    className="w-full text-left bg-ow-dark rounded-lg px-3 py-2.5 border border-white/10
                      hover:border-ow-orange/40 transition-colors flex items-center justify-between gap-3">
                    <span className="font-display text-sm text-slate-100 truncate">{s.label}</span>
                    <span className="flex items-center gap-3 shrink-0 text-[11px] font-display tracking-wider">
                      <span className="text-ow-orange">{s.distinctSessions} session{s.distinctSessions === 1 ? '' : 's'}</span>
                      <span className="text-slate-400">{s.totalViews} view{s.totalViews === 1 ? '' : 's'}</span>
                    </span>
                  </button>
                ))}
              <p className="text-[11px] text-slate-600 mt-1">
                Sorted by distinct sessions returned — the signal that a chart is worth promoting to a curated page.
              </p>
            </div>
          )
        )}
      </div>
    </div>
  )
}

// Full variable list for both Free Builder axes, grouped, with readiness hints.
function renderVarOptionsAll(_current: string) {
  const groups = new Map<string, VarDef[]>()
  for (const v of VARIABLES) {
    if (!groups.has(v.group)) groups.set(v.group, [])
    groups.get(v.group)!.push(v)
  }
  return Array.from(groups.entries()).map(([group, items]) => (
    <optgroup key={group} label={group}>
      {items.map(v => (
        <option key={v.key} value={v.key}>
          {v.label}{v.ready !== 'ready' ? ` (${READY_BADGE[v.ready].label.toLowerCase()})` : ''}
        </option>
      ))}
    </optgroup>
  ))
}

// ============================================================
// PAGE WRAPPER — header + nav + the two-builder tab switcher
// ============================================================
export default function AnalyticsBuilderPage() {
  const [tab, setTab] = useState<'chart' | 'free'>('chart')

  const tabCls = (active: boolean) =>
    `px-4 py-2 rounded-lg text-xs font-display tracking-[0.12em] uppercase transition-colors border ${
      active
        ? 'bg-ow-orange text-ow-dark border-ow-orange font-bold'
        : 'bg-ow-dark text-slate-300 border-white/20 hover:border-ow-orange/50'
    }`

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title="Builder"
        subtitle="The laboratory — assemble any cut. Generic only; curated charts live on their own pages."
      />
      <AnalyticsNav />

      <div className="flex items-center gap-2">
        <button className={tabCls(tab === 'chart')} onClick={() => setTab('chart')}>Chart Builder</button>
        <button className={tabCls(tab === 'free')} onClick={() => setTab('free')}>Free Builder</button>
        <span className="text-[11px] text-slate-500 ml-2">
          {tab === 'chart' ? 'Variable × measure × chart type.' : 'Variable × variable — full control of both axes.'}
        </span>
      </div>

      {tab === 'chart' ? <ChartBuilder /> : <FreeBuilder />}
    </div>
  )
}
