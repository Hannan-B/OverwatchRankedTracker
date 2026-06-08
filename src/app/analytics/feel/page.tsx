'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, Legend, LabelList,
} from 'recharts'
import { supabase } from '@/lib/supabase'
import { matchQuery } from '@/lib/alpha'
import AnalyticsFilters, {
  DEFAULT_FILTERS,
  matchesFilters,
  type AnalyticsFilterState,
  type FilterableMatch,
} from '@/components/AnalyticsFilters'
import { AnalyticsNav, AnalyticsHeader } from '@/components/AnalyticsNav'
import { HEROES } from '@/data/reference'
import {
  winRateByEnum, funDistribution, avgFunByResult, funByResult,
  allFlagOutcomes, teamVsEnemyByEnum, feelVsStats,
  applyResultFilter, distByEnum, teamVsEnemyDist,
  MATCH_FEEL_ORDER, PERF_FEEL_ORDER, TILT_ORDER, TEMPO_ORDER, COORD_ORDER, MIN_GAMES,
  type FeelMatch, type FeelStatRow, type CatRow, type DistRow, type Role,
  type ResultFilter, type TeamEnemyDistRow,
} from './feel-lib'

// ============================================================
// FEEL (/analytics/feel) — the "how did it feel?" qualitative page.
// ------------------------------------------------------------
// Match-grain feel fields read off `matches`; the role-aware "feel vs reality"
// section joins performance_feel ↔ hero share stats by match_id (hero-grain).
// Built for the full-data future: everything renders, < MIN_GAMES dimmed.
// ============================================================

const OW = {
  orange: '#f99e1a', accent: '#ffcb6b', victory: '#3fb950', defeat: '#f85149',
  draw: '#8b949e', team: '#58a6ff', enemy: '#f0883e',
  grid: 'rgba(255,255,255,0.08)', axis: 'rgba(255,255,255,0.45)',
}

interface FeelMatchRow extends FilterableMatch, FeelMatch {}

const MATCH_COLS =
  'id, result, role_played, match_format, game_mode, map, ' +
  'fun_rating, match_feel, performance_feel, tilt_mood, ' +
  'team_tempo, enemy_tempo, team_coordination, enemy_coordination, ' +
  'team_leaver, team_thrower, enemy_leaver, enemy_thrower'

// hero-grain rows for feel-vs-reality (share %s + hero→role) and the hero filter.
const HERO_COLS = 'match_id, hero_name, damage_pct, healing_pct, mitigation_pct'

const HERO_ROLE = new Map<string, Role>(HEROES.map(h => [h.name, h.role as Role]))
const LABELS_RESULT: Record<string, string> = { all: 'All', victory: 'Victory', defeat: 'Defeat', draw: 'Draw' }

const axisTick = { fill: OW.axis, fontSize: 11 }
const tooltipStyle = {
  contentStyle: { background: '#0f1419', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#e6edf3' },
}

function wrColor(wr: number | null): string {
  if (wr === null) return OW.draw
  return wr >= 55 ? OW.victory : wr <= 45 ? OW.defeat : OW.accent
}
function num(v: number | string | null): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isNaN(n) ? null : n
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="bg-ow-panel rounded-xl border border-white/10 p-4">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display tracking-[0.12em] text-slate-100 uppercase text-sm">{title}</h2>
        {hint && <span className="text-[11px] text-slate-500">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
function Empty({ label }: { label: string }) {
  return (
    <div className="h-[140px] flex items-center justify-center text-center">
      <p className="text-sm text-slate-500">No {label} recorded with these filters yet.</p>
    </div>
  )
}

// Horizontal win-rate bars with "% n=N" labels (ordered; not re-sorted).
function WinRateBars({ data, label }: { data: CatRow[]; label: string }) {
  const any = data.some(d => d.games > 0)
  if (!any) return <Empty label={label} />
  const height = Math.max(150, data.length * 38 + 36)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 84, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={OW.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTick} stroke={OW.axis} unit="%" />
          <YAxis type="category" dataKey="label" tick={axisTick} stroke={OW.axis} width={110} />
          <Tooltip {...tooltipStyle} formatter={(_v, _n, p) => {
            const row = (p as { payload?: CatRow } | undefined)?.payload
            return [`${row?.winRate == null ? '—' : row.winRate + '%'} · ${row?.games ?? 0} games`, 'Win rate']
          }} />
          <Bar dataKey={(d: CatRow) => d.winRate ?? 0} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={wrColor(d.winRate)} fillOpacity={d.lowConfidence ? 0.4 : 1} />)}
            <LabelList dataKey="winRate" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const row = data[p.index ?? -1]
              if (!row || p.x == null || p.y == null || p.width == null || p.height == null) return null
              return (
                <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central" fill="#e6edf3" fontSize={11}>
                  {`${row.winRate == null ? '—' : row.winRate + '%'}  n=${row.games}`}
                </text>
              )
            }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Distribution variant: % of (result-filtered) games at each value, with n=.
function DistBars({ data, label }: { data: DistRow[]; label: string }) {
  const any = data.some(d => d.count > 0)
  if (!any) return <Empty label={label} />
  const height = Math.max(150, data.length * 38 + 36)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 84, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={OW.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTick} stroke={OW.axis} unit="%" />
          <YAxis type="category" dataKey="label" tick={axisTick} stroke={OW.axis} width={110} />
          <Tooltip {...tooltipStyle} formatter={(_v, _n, p) => {
            const row = (p as { payload?: DistRow } | undefined)?.payload
            return [`${row?.pct == null ? '—' : row.pct + '%'} · ${row?.count ?? 0} games`, 'Share']
          }} />
          <Bar dataKey={(d: DistRow) => d.pct ?? 0} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={OW.orange} fillOpacity={d.lowConfidence ? 0.4 : 0.9} />)}
            <LabelList dataKey="pct" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const row = data[p.index ?? -1]
              if (!row || p.x == null || p.y == null || p.width == null || p.height == null) return null
              return (
                <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central" fill="#e6edf3" fontSize={11}>
                  {`${row.pct == null ? '—' : row.pct + '%'}  n=${row.count}`}
                </text>
              )
            }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Either win-rate or distribution bars depending on whether a result filter is on.
function FeelBars({ wr, dist, filtered, label }: { wr: CatRow[]; dist: DistRow[]; filtered: boolean; label: string }) {
  return filtered ? <DistBars data={dist} label={label} /> : <WinRateBars data={wr} label={label} />
}

// Team-vs-enemy grouped DISTRIBUTION bars (when result-filtered).
function TeamEnemyDistChart({ data }: { data: TeamEnemyDistRow[] }) {
  const any = data.some(d => d.teamCount > 0 || d.enemyCount > 0)
  if (!any) return <Empty label="tempo/coordination" />
  return (
    <div style={{ height: Math.max(170, data.length * 56 + 40) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={OW.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTick} stroke={OW.axis} unit="%" />
          <YAxis type="category" dataKey="label" tick={axisTick} stroke={OW.axis} width={110} />
          <Tooltip {...tooltipStyle} formatter={(v, n, p) => {
            const row = (p as { payload?: TeamEnemyDistRow } | undefined)?.payload
            const side = String(n)
            const c = side === 'Team' ? row?.teamCount : row?.enemyCount
            return [`${v == null ? '—' : v + '%'} · ${c ?? 0} games`, side]
          }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey={(d: TeamEnemyDistRow) => d.teamPct ?? 0} name="Team" fill={OW.team} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          <Bar dataKey={(d: TeamEnemyDistRow) => d.enemyPct ?? 0} name="Enemy" fill={OW.enemy} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function FeelPage() {
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)
  const [matches, setMatches] = useState<FeelMatchRow[]>([])
  const [heroRows, setHeroRows] = useState<{ match_id: number; hero_name: string; damage_pct: number | string | null; healing_pct: number | string | null; mitigation_pct: number | string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      matchQuery(MATCH_COLS).order('played_at', { ascending: false }),
      supabase.from('hero_match_facts').select(HERO_COLS),
    ]).then(([mRes, hRes]) => {
      if (cancelled) return
      setMatches((((mRes as unknown) as { data: FeelMatchRow[] | null }).data) || [])
      setHeroRows((((hRes as unknown) as { data: typeof heroRows | null }).data) || [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const matchIdsByHero = useMemo(() => {
    const m = new Map<string, Set<number>>()
    for (const r of heroRows) {
      if (!m.has(r.hero_name)) m.set(r.hero_name, new Set())
      m.get(r.hero_name)!.add(r.match_id)
    }
    return m
  }, [heroRows])

  const rows = useMemo(() => {
    const base = matches.filter(m => matchesFilters(m, filters))
    if (filters.hero === '') return base
    const ids = matchIdsByHero.get(filters.hero)
    if (!ids) return []
    return base.filter(m => ids.has(m.id))
  }, [matches, filters, matchIdsByHero])

  // Result filter: when active, every chart narrows to that result, and the
  // win-rate charts switch to distribution (win rate would be 100%/0% otherwise).
  const filtered = resultFilter !== 'all'
  const viewRows = useMemo(() => applyResultFilter(rows, resultFilter), [rows, resultFilter])

  // visible match ids (after ALL filters incl. result) → restrict the
  // hero-grain feel-vs-reality join and fun charts to the current view.
  const visibleIds = useMemo(() => new Set(viewRows.map(r => r.id)), [viewRows])
  const feelByMatch = useMemo(() => {
    const m = new Map<number, FeelMatchRow>()
    for (const r of viewRows) m.set(r.id, r)
    return m
  }, [viewRows])

  // ---- win-rate aggregations (used when NOT result-filtered) ----
  const matchFeel = useMemo(() => winRateByEnum(rows, m => m.match_feel, MATCH_FEEL_ORDER), [rows])
  const perfFeel = useMemo(() => winRateByEnum(rows, m => m.performance_feel, PERF_FEEL_ORDER), [rows])
  const tilt = useMemo(() => winRateByEnum(rows, m => m.tilt_mood, TILT_ORDER), [rows])
  const teamTempo = useMemo(() => winRateByEnum(rows, m => m.team_tempo, TEMPO_ORDER), [rows])
  const enemyTempo = useMemo(() => winRateByEnum(rows, m => m.enemy_tempo, TEMPO_ORDER), [rows])
  const teamCoord = useMemo(() => winRateByEnum(rows, m => m.team_coordination, COORD_ORDER), [rows])
  const enemyCoord = useMemo(() => winRateByEnum(rows, m => m.enemy_coordination, COORD_ORDER), [rows])
  const tempoCombined = useMemo(() => teamVsEnemyByEnum(rows, m => m.team_tempo, m => m.enemy_tempo, TEMPO_ORDER), [rows])
  const coordCombined = useMemo(() => teamVsEnemyByEnum(rows, m => m.team_coordination, m => m.enemy_coordination, COORD_ORDER), [rows])

  // ---- distribution aggregations (used WHEN result-filtered) ----
  const matchFeelD = useMemo(() => distByEnum(viewRows, m => m.match_feel, MATCH_FEEL_ORDER), [viewRows])
  const perfFeelD = useMemo(() => distByEnum(viewRows, m => m.performance_feel, PERF_FEEL_ORDER), [viewRows])
  const tiltD = useMemo(() => distByEnum(viewRows, m => m.tilt_mood, TILT_ORDER), [viewRows])
  const teamTempoD = useMemo(() => distByEnum(viewRows, m => m.team_tempo, TEMPO_ORDER), [viewRows])
  const enemyTempoD = useMemo(() => distByEnum(viewRows, m => m.enemy_tempo, TEMPO_ORDER), [viewRows])
  const teamCoordD = useMemo(() => distByEnum(viewRows, m => m.team_coordination, COORD_ORDER), [viewRows])
  const enemyCoordD = useMemo(() => distByEnum(viewRows, m => m.enemy_coordination, COORD_ORDER), [viewRows])
  const tempoCombinedD = useMemo(() => teamVsEnemyDist(viewRows, m => m.team_tempo, m => m.enemy_tempo, TEMPO_ORDER), [viewRows])
  const coordCombinedD = useMemo(() => teamVsEnemyDist(viewRows, m => m.team_coordination, m => m.enemy_coordination, COORD_ORDER), [viewRows])

  // flags + fun narrow to the current view (result-filtered if active)
  const flags = useMemo(() => allFlagOutcomes(viewRows), [viewRows])
  const funDist = useMemo(() => funDistribution(viewRows), [viewRows])
  const funByRes = useMemo(() => avgFunByResult(rows), [rows]) // always compares results (only shown when not filtered)
  const funSplit = useMemo(() => funByResult(rows), [rows])    // ditto
  // when filtered, "does winning = fun?" repurposes to this result's avg fun + count
  const funForResult = useMemo(
    () => (filtered ? avgFunByResult(rows).find(r => r.result === resultFilter) ?? null : null),
    [rows, filtered, resultFilter]
  )

  // ---- hero-grain feel-vs-reality (narrowed to current view) ----
  const feelStatRows: FeelStatRow[] = useMemo(() => {
    const out: FeelStatRow[] = []
    for (const h of heroRows) {
      if (!visibleIds.has(h.match_id)) continue
      const match = feelByMatch.get(h.match_id)
      if (!match) continue
      out.push({
        match_id: h.match_id,
        performance_feel: match.performance_feel,
        role: HERO_ROLE.get(h.hero_name) ?? null,
        damage_pct: num(h.damage_pct),
        healing_pct: num(h.healing_pct),
        mitigation_pct: num(h.mitigation_pct),
      })
    }
    return out
  }, [heroRows, visibleIds, feelByMatch])
  const fvsBuckets = useMemo(() => feelVsStats(feelStatRows), [feelStatRows])

  const totalGames = rows.length

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title="Feel"
        subtitle="Fun, match feel, mood, tempo and coordination against your results — plus whether your performance feel matches reality."
      />
      <AnalyticsNav />

      <AnalyticsFilters value={filters} onChange={setFilters} show={{ queue: true, mode: true, map: true, hero: true }} />

      {/* Result filter — default All. When a result is picked, win-rate charts
          become distribution (% of that result's games). */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-slate-400 font-display tracking-wider uppercase mr-1">Result</span>
        {([['all', 'All'], ['victory', 'Victory'], ['defeat', 'Defeat'], ['draw', 'Draw']] as [ResultFilter, string][]).map(([v, lbl]) => (
          <button key={v} onClick={() => setResultFilter(v)}
            className={`px-4 py-1.5 rounded-lg text-sm font-display tracking-wider transition-colors
              ${resultFilter === v ? 'bg-ow-orange text-ow-dark font-bold' : 'bg-ow-panel text-slate-400 hover:text-white border border-white/10'}`}>
            {lbl}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="bg-ow-panel rounded-xl border border-white/10 p-10 text-center text-slate-400 font-display tracking-wider">LOADING…</div>
      ) : (
        <>
          <p className="text-sm text-slate-400">
            {totalGames} game{totalGames === 1 ? '' : 's'} in view ·{' '}
            {filtered
              ? `showing ${LABELS_RESULT[resultFilter]} only — charts show distribution (% of these games)`
              : 'win rate excludes draws'} · under {MIN_GAMES} games dimmed
          </p>

          {/* FUN */}
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Panel title={filtered ? `Fun ratings in your ${LABELS_RESULT[resultFilter].toLowerCase()}s` : 'Fun rating distribution'} hint="how often each rating">
              {funDist.some(b => b.count > 0) ? (
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={funDist} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                      <CartesianGrid stroke={OW.grid} vertical={false} />
                      <XAxis dataKey="star" tick={axisTick} stroke={OW.axis} tickFormatter={v => `${v}★`} />
                      <YAxis tick={axisTick} stroke={OW.axis} allowDecimals={false} />
                      <Tooltip {...tooltipStyle} formatter={(v) => [`${v} games`, 'Count']} labelFormatter={l => `${l}★`} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                        {funDist.map((b, i) => <Cell key={i} fill={OW.orange} fillOpacity={b.lowConfidence ? 0.45 : 1} />)}
                        <LabelList dataKey="count" position="top" fill="#e6edf3" fontSize={11} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : <Empty label="fun ratings" />}
            </Panel>

            <Panel title={filtered ? `Fun in your ${LABELS_RESULT[resultFilter].toLowerCase()}s` : 'Does winning = fun?'} hint={filtered ? 'average rating' : 'avg fun by result'}>
              {filtered ? (
                funForResult && funForResult.games > 0 ? (
                  <div className="h-[200px] flex flex-col items-center justify-center gap-2">
                    <span className="font-display text-6xl text-ow-orange">{funForResult.avgFun ?? '—'}</span>
                    <span className="text-sm text-slate-400">avg fun · n={funForResult.games} {LABELS_RESULT[resultFilter].toLowerCase()}{funForResult.games === 1 ? '' : 's'}</span>
                    <span className="text-[11px] text-slate-500">out of 5 · see the distribution chart for the full spread</span>
                  </div>
                ) : <Empty label="fun ratings" />
              ) : funByRes.some(r => r.games > 0) ? (
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={funByRes} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                      <CartesianGrid stroke={OW.grid} vertical={false} />
                      <XAxis dataKey="result" tick={axisTick} stroke={OW.axis} tickFormatter={v => String(v).toUpperCase()} />
                      <YAxis domain={[0, 5]} tick={axisTick} stroke={OW.axis} />
                      <Tooltip {...tooltipStyle} formatter={(_v, _n, p) => {
                        const r = (p as { payload?: { avgFun: number | null; games: number } } | undefined)?.payload
                        return [`${r?.avgFun ?? '—'} avg · ${r?.games ?? 0} games`, 'Fun']
                      }} />
                      <Bar dataKey={(d: { avgFun: number | null }) => d.avgFun ?? 0} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                        {funByRes.map((r, i) => (
                          <Cell key={i} fill={r.result === 'victory' ? OW.victory : r.result === 'defeat' ? OW.defeat : OW.draw}
                            fillOpacity={r.lowConfidence ? 0.45 : 1} />
                        ))}
                        <LabelList dataKey={(d: { avgFun: number | null }) => d.avgFun ?? ''} position="top" fill="#e6edf3" fontSize={11} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : <Empty label="fun ratings" />}
            </Panel>
          </div>

          {!filtered && (
            <Panel title="Fun distribution by result" hint="how wins, losses and draws spread across ratings">
              {funSplit.some(b => b.total > 0) ? (
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={funSplit} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                      <CartesianGrid stroke={OW.grid} vertical={false} />
                      <XAxis dataKey="star" tick={axisTick} stroke={OW.axis} tickFormatter={v => `${v}★`} />
                      <YAxis tick={axisTick} stroke={OW.axis} allowDecimals={false} />
                      <Tooltip {...tooltipStyle} labelFormatter={l => `${l}★`} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="victory" stackId="r" name="Victory" fill={OW.victory} isAnimationActive={false} />
                      <Bar dataKey="defeat" stackId="r" name="Defeat" fill={OW.defeat} isAnimationActive={false} />
                      <Bar dataKey="draw" stackId="r" name="Draw" fill={OW.draw} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : <Empty label="fun ratings" />}
            </Panel>
          )}

          {/* FEEL vs OUTCOME (distribution when result-filtered) */}
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Panel title={filtered ? 'Match feel distribution' : 'Match feel vs outcome'} hint={filtered ? `share of ${LABELS_RESULT[resultFilter]} games` : 'win rate by how the game felt'}>
              <FeelBars wr={matchFeel} dist={matchFeelD} filtered={filtered} label="match feel" />
            </Panel>
            <Panel title={filtered ? 'Performance feel distribution' : 'Performance feel vs outcome'} hint={filtered ? `share of ${LABELS_RESULT[resultFilter]} games` : 'win rate by how you felt you played'}>
              <FeelBars wr={perfFeel} dist={perfFeelD} filtered={filtered} label="performance feel" />
            </Panel>
          </div>

          <Panel title={filtered ? 'Mood distribution' : 'Mood vs win rate'} hint="tilted → hyped">
            <FeelBars wr={tilt} dist={tiltD} filtered={filtered} label="mood" />
          </Panel>

          {/* TEMPO */}
          <Panel title={filtered ? 'Tempo distribution — team and enemy' : 'Tempo vs win rate — team and enemy'} hint="combined">
            {filtered ? <TeamEnemyDistChart data={tempoCombinedD} /> : <TeamEnemyBars data={tempoCombined} />}
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Panel title="Team tempo" hint={filtered ? 'share' : 'win rate'}><FeelBars wr={teamTempo} dist={teamTempoD} filtered={filtered} label="team tempo" /></Panel>
            <Panel title="Enemy tempo" hint={filtered ? 'share' : 'win rate'}><FeelBars wr={enemyTempo} dist={enemyTempoD} filtered={filtered} label="enemy tempo" /></Panel>
          </div>

          {/* COORDINATION */}
          <Panel title={filtered ? 'Coordination distribution — team and enemy' : 'Coordination vs win rate — team and enemy'} hint="combined">
            {filtered ? <TeamEnemyDistChart data={coordCombinedD} /> : <TeamEnemyBars data={coordCombined} />}
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Panel title="Team coordination" hint={filtered ? 'share' : 'win rate'}><FeelBars wr={teamCoord} dist={teamCoordD} filtered={filtered} label="team coordination" /></Panel>
            <Panel title="Enemy coordination" hint={filtered ? 'share' : 'win rate'}><FeelBars wr={enemyCoord} dist={enemyCoordD} filtered={filtered} label="enemy coordination" /></Panel>
          </div>

          {/* LEAVER / THROWER — count + outcome */}
          <Panel title="Leavers & throwers" hint="how often, and how those games go">
            <FlagTable flags={flags} />
          </Panel>

          {/* FEEL vs REALITY */}
          <Panel title="Performance feel vs reality" hint="role-aware share %, by how you felt you played">
            <FeelVsReality buckets={fvsBuckets} />
          </Panel>
        </>
      )}
    </div>
  )
}

// Team-vs-enemy grouped bars for an ordered enum.
function TeamEnemyBars({ data }: { data: { key: string; label: string; teamWinRate: number | null; enemyWinRate: number | null; teamGames: number; enemyGames: number }[] }) {
  const any = data.some(d => d.teamGames > 0 || d.enemyGames > 0)
  if (!any) return <Empty label="tempo/coordination" />
  return (
    <div style={{ height: Math.max(170, data.length * 56 + 40) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={OW.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTick} stroke={OW.axis} unit="%" />
          <YAxis type="category" dataKey="label" tick={axisTick} stroke={OW.axis} width={110} />
          <Tooltip {...tooltipStyle} formatter={(v, n, p) => {
            const row = (p as { payload?: { teamGames: number; enemyGames: number } } | undefined)?.payload
            const side = String(n)
            const g = side === 'Team' ? row?.teamGames : row?.enemyGames
            return [`${v == null ? '—' : v + '%'} · ${g ?? 0} games`, side]
          }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey={(d: { teamWinRate: number | null }) => d.teamWinRate ?? 0} name="Team" fill={OW.team} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          <Bar dataKey={(d: { enemyWinRate: number | null }) => d.enemyWinRate ?? 0} name="Enemy" fill={OW.enemy} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Leaver/thrower count + outcome table (not a win-rate-factor chart).
function FlagTable({ flags }: { flags: { key: string; label: string; games: number; wins: number; losses: number; draws: number; winRate: number | null; lowConfidence: boolean }[] }) {
  const anyData = flags.some(f => f.games > 0)
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[1.4fr_auto_auto_auto] gap-3 text-[10px] font-display tracking-wider text-slate-500 uppercase px-2">
        <span>Event</span><span>Games</span><span>W–L–D</span><span>Win rate</span>
      </div>
      {flags.map(f => (
        <div key={f.key}
          className={`grid grid-cols-[1.4fr_auto_auto_auto] gap-3 items-center bg-ow-dark rounded-lg px-2.5 py-2 border border-white/10 ${f.games === 0 ? 'opacity-40' : f.lowConfidence ? 'opacity-60' : ''}`}>
          <span className="font-display text-sm text-slate-100">{f.label}</span>
          <span className="text-sm text-slate-300 font-display">{f.games}</span>
          <span className="text-xs text-slate-400 font-display">{f.wins}–{f.losses}–{f.draws}</span>
          <span className="text-sm font-display" style={{ color: wrColor(f.winRate) }}>{f.winRate == null ? '—' : `${f.winRate}%`}</span>
        </div>
      ))}
      {!anyData && <p className="text-[11px] text-slate-500 pt-1">No leaver/thrower games recorded yet — this fills in as you flag them on upload.</p>}
    </div>
  )
}

// Feel-vs-reality: per role, the avg role-appropriate share across the three
// performance-feel levels. Read each role's row left→right: carried should
// out-share struggled if your feel tracks reality.
function FeelVsReality({ buckets }: { buckets: { feel: string; role: Role; n: number; avgShare: number | null; shareLabel: string; lowConfidence: boolean }[] }) {
  const roles: Role[] = ['tank', 'dps', 'support']
  const feels = PERF_FEEL_ORDER
  const labelFor: Record<string, string> = { carried: 'Carried', did_my_job: 'Did my job', struggled: 'Struggled' }
  const anyData = buckets.some(b => b.n > 0)
  if (!anyData) return <Empty label="performance feel + role stats" />
  return (
    <div className="space-y-4">
      {roles.map(role => {
        const rb = feels.map(f => buckets.find(b => b.role === role && b.feel === f)!)
        if (!rb.some(b => b.n > 0)) return null
        const shareLabel = rb[0].shareLabel
        const maxShare = Math.max(1, ...rb.map(b => b.avgShare ?? 0))
        return (
          <div key={role} className="bg-ow-dark rounded-lg p-3 border border-white/10">
            <div className="flex items-baseline justify-between mb-2">
              <span className="font-display text-sm text-ow-orange tracking-wider uppercase">{role}</span>
              <span className="text-[11px] text-slate-500">{shareLabel}</span>
            </div>
            <div className="space-y-1.5">
              {feels.map((f, i) => {
                const b = rb[i]
                const pct = b.avgShare == null ? 0 : (b.avgShare / maxShare) * 100
                return (
                  <div key={f} className={`flex items-center gap-3 ${b.lowConfidence ? 'opacity-60' : ''}`}>
                    <span className="text-xs text-slate-300 font-display w-20 shrink-0">{labelFor[f]}</span>
                    <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden">
                      <div className="h-full rounded" style={{ width: `${pct}%`, background: OW.orange, opacity: b.avgShare == null ? 0 : 0.85 }} />
                    </div>
                    <span className="text-xs font-display text-white w-24 text-right shrink-0">
                      {b.avgShare == null ? '—' : `${b.avgShare}%`} <span className="text-slate-500">n={b.n}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      <p className="text-[11px] text-slate-500">
        Share % is your portion of the relevant lobby total (damage for DPS, healing for support, mitigation for tank) — more
        meaningful than raw E/A/D. If your feel tracks reality, “Carried” rows should out-share “Struggled”.
      </p>
    </div>
  )
}
