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
  type SeasonOption,
} from '@/components/AnalyticsFilters'
import { AnalyticsNav, AnalyticsHeader } from '@/components/AnalyticsNav'
import { useChartColors } from '@/components/useChartColors'
import { type ChartColors } from '@/lib/chart-theme'
import { heroRoleAt } from '@/data/reference'
import {
  winRateByEnum, funDistribution, avgFunByResult, funByResult,
  allFlagOutcomes, teamVsEnemyByEnum, feelVsStats,
  applyResultFilter, distByEnum, teamVsEnemyDist,
  scaleVersionOf, avgFunByEnum, funBinaryByEnum, standoutProfiles,
  MATCH_FEEL_ORDER, PERF_FEEL_ORDER, TILT_ORDER, TEMPO_ORDER, COORD_ORDER,
  MATCHUP_FEEL_ORDER, PERF_RATING_ORDER, FUN6_ORDER,
  MATCHUP_FEEL_LABELS, PERF_RATING_LABELS, FUN6_LABELS,
  type FeelMatch, type FeelStatRow, type CatRow, type DistRow, type Role,
  type ResultFilter, type TeamEnemyDistRow, type ScaleVersion,
  type StandoutRow, type StandoutProfile, type AvgFunByRow, type FunBinaryRow,
  type LeaverType,
} from './feel-lib'

// ============================================================
// FEEL (/analytics/feel) — the "how did it feel?" qualitative page.
// ------------------------------------------------------------
// Match-grain feel fields read off `matches`; the role-aware "feel vs reality"
// section joins the performance answer ↔ hero share stats by match_id (hero-grain).
// Built for the full-data future: everything renders, < min-games (default 5, hero-gated filter) dimmed.
//
// ⚠️ (v1.1.0) TWO QUESTION SCALES. This page renders ONE AT A TIME and never
// merges them. The scale selector appears only when both versions have data in
// view; with one version present there is nothing to choose and only a caption
// is shown.
//
// Why a selector rather than both sets stacked with a divider: a divider makes
// mixing discouraged, a selector makes it impossible. The two scales measure
// different things at different resolutions — a version-1 fun 5 is the top of
// the scale, a version-2 fun 5 is one below it — so any chart holding both is
// wrong no matter how it is captioned.
//
// Which version a match belongs to comes from its SEASON
// (seasons.question_scale_version), never a hardcoded season number.
//
// SCOPE: this is the compatibility layer, not the Phase 7 rework. Tempo,
// coordination and tilt panels remain for version 1 — that data is real and
// still worth reading — and simply do not exist in the version-2 view.
// ============================================================

// Chart colours now come from the theme-aware palette (useChartColors()) so they
// flip light/dark. feel.tsx uses two extra hues (team/enemy) not in the shared
// palette; they're derived per-theme here from the categorical set.
function teamEnemy(c: ChartColors): { team: string; enemy: string } {
  // categorical[1] is a blue, [0] the orange — good team/enemy split in both themes.
  return { team: c.categorical[1], enemy: c.primary }
}

// These six are RE-PINNED deliberately. FilterableMatch declares them OPTIONAL
// while FeelMatch declares them REQUIRED, and an interface extending both must
// restate any property the two parents do not declare identically — otherwise
// TS2320. The re-pinned type has to be assignable to BOTH parents, which is why
// the leaver types are pinned to LeaverType rather than the looser `string`
// FilterableMatch uses.
//
// This list grows whenever a column is added to FilterableMatch that FeelMatch
// also declares. It is the first place to look if this file stops compiling
// after a change to either interface.
interface FeelMatchRow extends FilterableMatch, FeelMatch {
  season_id: number | null
  /** (v1.2.0) For heroRoleAt — a hero's role is the role on the match date. */
  played_at: string | null
  team_leaver: boolean | null
  enemy_leaver: boolean | null
  team_leaver_type: LeaverType | null
  enemy_leaver_type: LeaverType | null
  team_thrower: boolean | null
  enemy_thrower: boolean | null
}

const MATCH_COLS =
  'id, season_id, played_at, result, role_played, match_format, game_mode, map, ' +
  'fun_rating, match_feel, performance_feel, tilt_mood, ' +
  'team_tempo, enemy_tempo, team_coordination, enemy_coordination, ' +
  'matchup_feel, performance_rating, fun_rating_6, ' +
  'team_leaver, team_thrower, enemy_leaver, enemy_thrower, ' +
  'team_leaver_type, enemy_leaver_type'

// hero-grain rows for feel-vs-reality (share %s + hero→role) and the hero filter.
const HERO_COLS = 'match_id, hero_name, damage_pct, healing_pct, mitigation_pct'

const LABELS_RESULT: Record<string, string> = { all: 'All', victory: 'Victory', defeat: 'Defeat', draw: 'Draw' }

// Palette-driven chart style builders (call with the live ChartColors).
const axisTickOf = (c: ChartColors) => ({ fill: c.axisLabel, fontSize: 11 })
const tooltipStyleOf = (c: ChartColors) => ({
  contentStyle: { background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 8, fontSize: 12 },
  labelStyle: { color: c.tooltipText },
})

function wrColor(wr: number | null, c: ChartColors): string {
  if (wr === null) return c.draw
  return wr >= 55 ? c.victory : wr <= 45 ? c.defeat : c.primary
}
function num(v: number | string | null): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isNaN(n) ? null : n
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="bg-ow-panel rounded-xl border border-ow-line p-4">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display tracking-[0.12em] text-ow-fg uppercase text-sm">{title}</h2>
        {hint && <span className="text-[11px] text-ow-faint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
function Empty({ label }: { label: string }) {
  return (
    <div className="h-[140px] flex items-center justify-center text-center">
      <p className="text-sm text-ow-faint">No {label} recorded with these filters yet.</p>
    </div>
  )
}

// Horizontal win-rate bars with "% n=N" labels (ordered; not re-sorted).
function WinRateBars({ data, label }: { data: CatRow[]; label: string }) {
  const c = useChartColors()
  const any = data.some(d => d.games > 0)
  if (!any) return <Empty label={label} />
  const height = Math.max(150, data.length * 38 + 36)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 84, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={c.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTickOf(c)} stroke={c.axis} unit="%" />
          <YAxis type="category" dataKey="label" tick={axisTickOf(c)} stroke={c.axis} width={110} />
          <Tooltip {...tooltipStyleOf(c)} formatter={(_v, _n, p) => {
            const row = (p as { payload?: CatRow } | undefined)?.payload
            return [`${row?.winRate == null ? '—' : row.winRate + '%'} · ${row?.games ?? 0} games`, 'Win rate']
          }} />
          <Bar dataKey={(d: CatRow) => d.winRate ?? 0} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={wrColor(d.winRate, c)} fillOpacity={d.lowConfidence ? 0.4 : 1} />)}
            <LabelList dataKey="winRate" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const row = data[p.index ?? -1]
              if (!row || p.x == null || p.y == null || p.width == null || p.height == null) return null
              return (
                <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central" fill={c.axisLabel} fontSize={11}>
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
  const c = useChartColors()
  const any = data.some(d => d.count > 0)
  if (!any) return <Empty label={label} />
  const height = Math.max(150, data.length * 38 + 36)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 84, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={c.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTickOf(c)} stroke={c.axis} unit="%" />
          <YAxis type="category" dataKey="label" tick={axisTickOf(c)} stroke={c.axis} width={110} />
          <Tooltip {...tooltipStyleOf(c)} formatter={(_v, _n, p) => {
            const row = (p as { payload?: DistRow } | undefined)?.payload
            return [`${row?.pct == null ? '—' : row.pct + '%'} · ${row?.count ?? 0} games`, 'Share']
          }} />
          <Bar dataKey={(d: DistRow) => d.pct ?? 0} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={c.primary} fillOpacity={d.lowConfidence ? 0.4 : 0.9} />)}
            <LabelList dataKey="pct" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const row = data[p.index ?? -1]
              if (!row || p.x == null || p.y == null || p.width == null || p.height == null) return null
              return (
                <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central" fill={c.axisLabel} fontSize={11}>
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
  const c = useChartColors()
  const any = data.some(d => d.teamCount > 0 || d.enemyCount > 0)
  if (!any) return <Empty label="tempo/coordination" />
  return (
    <div style={{ height: Math.max(170, data.length * 56 + 40) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={c.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTickOf(c)} stroke={c.axis} unit="%" />
          <YAxis type="category" dataKey="label" tick={axisTickOf(c)} stroke={c.axis} width={110} />
          <Tooltip {...tooltipStyleOf(c)} formatter={(v, n, p) => {
            const row = (p as { payload?: TeamEnemyDistRow } | undefined)?.payload
            const side = String(n)
            const c = side === 'Team' ? row?.teamCount : row?.enemyCount
            return [`${v == null ? '—' : v + '%'} · ${c ?? 0} games`, side]
          }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey={(d: TeamEnemyDistRow) => d.teamPct ?? 0} name="Team" fill={teamEnemy(c).team} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          <Bar dataKey={(d: TeamEnemyDistRow) => d.enemyPct ?? 0} name="Enemy" fill={teamEnemy(c).enemy} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function FeelPage() {
  const c = useChartColors()
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)
  const [matches, setMatches] = useState<FeelMatchRow[]>([])
  const [heroRows, setHeroRows] = useState<{ match_id: number; hero_name: string; damage_pct: number | string | null; healing_pct: number | string | null; mitigation_pct: number | string | null }[]>([])
  const [standouts, setStandouts] = useState<StandoutRow[]>([])
  /** Fun crosses: 'avg' shows the mean fun per value; 'binary' collapses fun to
   *  enjoyed / didn't across the 3-4 boundary the 6-point scale was designed to
   *  force. Binary is offered under scale version 2 ONLY — version 1's scale has
   *  a midpoint, so the same collapse would have nowhere to put it. */
  const [funView, setFunView] = useState<'avg' | 'binary'>('avg')
  const [loading, setLoading] = useState(true)
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all')
  const [seasonVersions, setSeasonVersions] = useState<Map<number, number>>(new Map())
  const [seasonOptions, setSeasonOptions] = useState<SeasonOption[]>([])
  // NOTE there is no manual question-set selector. The SEASON selection decides
  // which question set is shown, because a season IS the unit a question set
  // applies to — two controls for one decision would let them disagree.

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      matchQuery(MATCH_COLS).order('played_at', { ascending: false }),
      supabase.from('hero_match_facts').select(HERO_COLS),
      // Which question set each season was played under. This is the authority
      // for splitting the two scales — never a hardcoded season number, because
      // the questions are expected to keep changing.
      supabase.from('seasons').select('id, name, question_scale_version').order('start_date', { ascending: false }),
      // Standout picks. Read as a plain table rather than through matchQuery
      // (which targets `matches`); alpha rows are excluded for free because
      // every row is narrowed against the visible match ids, and those already
      // came through matchQuery.
      supabase.from('match_standouts').select('match_id, kind, hero_name'),
    ]).then(([mRes, hRes, sRes, stRes]) => {
      if (cancelled) return
      setMatches((((mRes as unknown) as { data: FeelMatchRow[] | null }).data) || [])
      setHeroRows((((hRes as unknown) as { data: typeof heroRows | null }).data) || [])
      const seasons = ((sRes as unknown) as { data: { id: number; name: string; question_scale_version: number | null }[] | null }).data || []
      setSeasonVersions(new Map(seasons.map(s => [s.id, s.question_scale_version ?? 1])))
      setSeasonOptions(seasons.map(s => ({ id: s.id, name: s.name })))
      setStandouts((((stRes as unknown) as { data: StandoutRow[] | null }).data) || [])
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

  // (v1.1.0 Phase 2) Hero is POOLED across the selection, per PATCH-SPEC §6.2:
  // the per-hero id sets are UNIONED, so ticking two heroes means "games with
  // either", not "games where both were played".
  //
  // No applyExclusions here — Feel is EXEMPT by omission. It analyses leaver and
  // thrower games deliberately, so filtering them out would remove the page's
  // own subject matter.
  const allFilteredRows = useMemo(() => {
    const base = matches.filter(m => matchesFilters(m, filters))
    if (filters.heroes.length === 0) return base
    const ids = new Set<number>()
    for (const h of filters.heroes) {
      const s = matchIdsByHero.get(h)
      if (s) for (const id of s) ids.add(id)
    }
    if (ids.size === 0) return []
    return base.filter(m => ids.has(m.id))
  }, [matches, filters, matchIdsByHero])

  // ---- Scale version split — the ONE place the never-pool rule is enforced.
  // Everything below this point works within a single version, so no aggregator
  // can accidentally mix them.
  const countsByVersion = useMemo(() => {
    const out: Record<ScaleVersion, number> = { 1: 0, 2: 0 }
    for (const r of allFilteredRows) out[scaleVersionOf(r, seasonVersions)]++
    return out
  }, [allFilteredRows, seasonVersions])

  // Does the current selection hold games from BOTH question sets? Only ever
  // true under All Time: the season guard below prevents a specific selection
  // from spanning two sets. When true, the caption tells you how many games are
  // sitting on the other set and how to reach them — otherwise they would simply
  // be absent from every number on the page with no explanation.
  //
  // ⚠️ This was REFERENCED but never DECLARED (feel/page.tsx line ~540), so the
  // file did not typecheck. Restored rather than removed: the caption it feeds
  // is the only thing that explains where the missing games went.
  const bothPresent = countsByVersion[1] > 0 && countsByVersion[2] > 0

  // Which question set to show, derived ENTIRELY from the season selection:
  //
  //   • Specific seasons picked → their version. The onChange guard below
  //     guarantees a selection never mixes versions, so "their version" is
  //     always singular.
  //   • All Time → the CURRENT question set, i.e. the newest version that has
  //     any data. Once season 4 has matches this is version 2 and stays there
  //     for every later season on the same questions. Falling back to whatever
  //     version does have data matters today, when version 2 has none — All
  //     Time would otherwise render an empty page.
  //
  // Seeing the older question set is therefore done by selecting that season on
  // its own, which is exactly what it means: those charts belong to that season.
  const activeScale: ScaleVersion = (() => {
    if (filters.seasons.length > 0) {
      const v = seasonVersions.get(filters.seasons[0])
      if (v === 2 || v === 1) return v
    }
    return countsByVersion[2] > 0 ? 2 : 1
  })()

  const rows = useMemo(
    () => allFilteredRows.filter(r => scaleVersionOf(r, seasonVersions) === activeScale),
    [allFilteredRows, seasonVersions, activeScale],
  )
  const isV2 = activeScale === 2

  /**
   * Season selection guard — a selection may never span two question sets.
   *
   * Seasons on different question sets cannot share a chart, so combining them
   * would leave one silently absent from every number on the page. Rather than
   * allow the combination and caption it away, ticking a season from a
   * different set REPLACES the selection instead of adding to it: the most
   * recently ticked season wins and the incompatible ones are dropped.
   *
   * The user never sees an error and never has to know the rule — the tick they
   * just made always takes effect, and the page always shows one coherent set.
   * Only ADDITIONS are policed; unticking is always left alone.
   */
  function handleFiltersChange(next: AnalyticsFilterState) {
    const added = next.seasons.filter(id => !filters.seasons.includes(id))
    if (added.length === 0) { setFilters(next); return }
    const targetVersion = seasonVersions.get(added[added.length - 1]) ?? 1
    const compatible = next.seasons.filter(
      id => (seasonVersions.get(id) ?? 1) === targetVersion,
    )
    setFilters(compatible.length === next.seasons.length
      ? next
      : { ...next, seasons: compatible })
  }

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
  // Version 1 fields. These aggregate to all-zero rows under version 2, and the
  // panels that consume them are not rendered there.
  const matchFeel = useMemo(() => winRateByEnum(rows, m => m.match_feel, MATCH_FEEL_ORDER, filters.minGames), [rows, filters.minGames])
  const perfFeel = useMemo(() => winRateByEnum(rows, m => m.performance_feel, PERF_FEEL_ORDER, filters.minGames), [rows, filters.minGames])
  const tilt = useMemo(() => winRateByEnum(rows, m => m.tilt_mood, TILT_ORDER, filters.minGames), [rows, filters.minGames])
  const teamTempo = useMemo(() => winRateByEnum(rows, m => m.team_tempo, TEMPO_ORDER, filters.minGames), [rows, filters.minGames])
  const enemyTempo = useMemo(() => winRateByEnum(rows, m => m.enemy_tempo, TEMPO_ORDER, filters.minGames), [rows, filters.minGames])
  const teamCoord = useMemo(() => winRateByEnum(rows, m => m.team_coordination, COORD_ORDER, filters.minGames), [rows, filters.minGames])
  const enemyCoord = useMemo(() => winRateByEnum(rows, m => m.enemy_coordination, COORD_ORDER, filters.minGames), [rows, filters.minGames])
  const tempoCombined = useMemo(() => teamVsEnemyByEnum(rows, m => m.team_tempo, m => m.enemy_tempo, TEMPO_ORDER, filters.minGames), [rows, filters.minGames])
  const coordCombined = useMemo(() => teamVsEnemyByEnum(rows, m => m.team_coordination, m => m.enemy_coordination, COORD_ORDER, filters.minGames), [rows, filters.minGames])

  // Version 2 fields. Each carries its OWN label map — the raw keys are '1'..'6'
  // across three different scales, so a shared map would collide.
  const matchupFeel = useMemo(() => winRateByEnum(rows, m => m.matchup_feel, MATCHUP_FEEL_ORDER, filters.minGames, MATCHUP_FEEL_LABELS), [rows, filters.minGames])
  const perfRating = useMemo(() => winRateByEnum(rows, m => m.performance_rating, PERF_RATING_ORDER, filters.minGames, PERF_RATING_LABELS), [rows, filters.minGames])

  // ---- distribution aggregations (used WHEN result-filtered) ----
  const matchFeelD = useMemo(() => distByEnum(viewRows, m => m.match_feel, MATCH_FEEL_ORDER, filters.minGames), [viewRows, filters.minGames])
  const perfFeelD = useMemo(() => distByEnum(viewRows, m => m.performance_feel, PERF_FEEL_ORDER, filters.minGames), [viewRows, filters.minGames])
  const tiltD = useMemo(() => distByEnum(viewRows, m => m.tilt_mood, TILT_ORDER, filters.minGames), [viewRows, filters.minGames])
  const teamTempoD = useMemo(() => distByEnum(viewRows, m => m.team_tempo, TEMPO_ORDER, filters.minGames), [viewRows, filters.minGames])
  const enemyTempoD = useMemo(() => distByEnum(viewRows, m => m.enemy_tempo, TEMPO_ORDER, filters.minGames), [viewRows, filters.minGames])
  const teamCoordD = useMemo(() => distByEnum(viewRows, m => m.team_coordination, COORD_ORDER, filters.minGames), [viewRows, filters.minGames])
  const enemyCoordD = useMemo(() => distByEnum(viewRows, m => m.enemy_coordination, COORD_ORDER, filters.minGames), [viewRows, filters.minGames])
  const tempoCombinedD = useMemo(() => teamVsEnemyDist(viewRows, m => m.team_tempo, m => m.enemy_tempo, TEMPO_ORDER, filters.minGames), [viewRows, filters.minGames])
  const coordCombinedD = useMemo(() => teamVsEnemyDist(viewRows, m => m.team_coordination, m => m.enemy_coordination, COORD_ORDER, filters.minGames), [viewRows, filters.minGames])
  const matchupFeelD = useMemo(() => distByEnum(viewRows, m => m.matchup_feel, MATCHUP_FEEL_ORDER, filters.minGames, MATCHUP_FEEL_LABELS), [viewRows, filters.minGames])
  const perfRatingD = useMemo(() => distByEnum(viewRows, m => m.performance_rating, PERF_RATING_ORDER, filters.minGames, PERF_RATING_LABELS), [viewRows, filters.minGames])

  // flags + fun narrow to the current view (result-filtered if active)
  const flags = useMemo(() => allFlagOutcomes(viewRows, filters.minGames, activeScale), [viewRows, filters.minGames, activeScale])
  const funDist = useMemo(() => funDistribution(viewRows, activeScale, filters.minGames), [viewRows, activeScale, filters.minGames])
  const funByRes = useMemo(() => avgFunByResult(rows, activeScale, filters.minGames), [rows, activeScale, filters.minGames]) // always compares results (only shown when not filtered)
  const funSplit = useMemo(() => funByResult(rows, activeScale), [rows, activeScale])    // ditto
  // when filtered, "does winning = fun?" repurposes to this result's avg fun + count
  const funForResult = useMemo(
    () => (filtered ? avgFunByResult(rows, activeScale, filters.minGames).find(r => r.result === resultFilter) ?? null : null),
    [rows, activeScale, filtered, resultFilter, filters.minGames]
  )
  /** Top of the fun scale for the active version — 5 or 6. Used for the axis
   *  domain and the "out of N" caption, both of which would otherwise silently
   *  misreport a 6-point answer as if it were on a 5-point scale. */
  const funMax = isV2 ? 6 : 5
  const funLabelFor = (v: number | string) =>
    (isV2 ? FUN6_LABELS[String(v)] : undefined) ?? `${v}${isV2 ? '' : '★'}`

  // ---- hero-grain feel-vs-reality (narrowed to current view AND scale) ----
  const feelStatRows: FeelStatRow[] = useMemo(() => {
    const out: FeelStatRow[] = []
    for (const h of heroRows) {
      if (!visibleIds.has(h.match_id)) continue
      const match = feelByMatch.get(h.match_id)
      if (!match) continue
      out.push({
        match_id: h.match_id,
        // The version-appropriate performance answer. visibleIds is already
        // scale-scoped, so this cannot pick up the other version's column.
        perfKey: isV2 ? match.performance_rating : match.performance_feel,
        role: (heroRoleAt(h.hero_name, match.played_at) as Role | undefined) ?? null,
        damage_pct: num(h.damage_pct),
        healing_pct: num(h.healing_pct),
        mitigation_pct: num(h.mitigation_pct),
      })
    }
    return out
  }, [heroRows, visibleIds, feelByMatch, isV2])
  const fvsOrder = isV2 ? PERF_RATING_ORDER : PERF_FEEL_ORDER
  const fvsBuckets = useMemo(
    () => feelVsStats(feelStatRows, fvsOrder, filters.minGames, isV2 ? PERF_RATING_LABELS : undefined),
    [feelStatRows, fvsOrder, filters.minGames, isV2],
  )

  // ---- Fun crosses (panels 4 and 5) ----
  // Both read the active scale's own fields, so they work under either version
  // without the caller choosing columns. The BINARY view is gated to version 2
  // in the render, not here — see funBinaryByEnum for why.
  const crossOrder = isV2 ? MATCHUP_FEEL_ORDER : MATCH_FEEL_ORDER
  // undefined falls through to the lib's shared LABELS map, which is where
  // the version-1 enum labels live.
  const crossLabels = isV2 ? MATCHUP_FEEL_LABELS : undefined
  const funByMatchup = useMemo(
    () => avgFunByEnum(viewRows, m => (isV2 ? m.matchup_feel : m.match_feel), crossOrder as (string | number)[], activeScale, filters.minGames, crossLabels),
    [viewRows, isV2, crossOrder, crossLabels, activeScale, filters.minGames],
  )
  const funByPerf = useMemo(
    () => avgFunByEnum(viewRows, m => (isV2 ? m.performance_rating : m.performance_feel), fvsOrder as (string | number)[], activeScale, filters.minGames, isV2 ? PERF_RATING_LABELS : undefined),
    [viewRows, isV2, fvsOrder, activeScale, filters.minGames],
  )
  const funBinMatchup = useMemo(
    () => funBinaryByEnum(viewRows, m => m.matchup_feel, MATCHUP_FEEL_ORDER, filters.minGames, MATCHUP_FEEL_LABELS),
    [viewRows, filters.minGames],
  )
  const funBinPerf = useMemo(
    () => funBinaryByEnum(viewRows, m => m.performance_rating, PERF_RATING_ORDER, filters.minGames, PERF_RATING_LABELS),
    [viewRows, filters.minGames],
  )

  // ---- Standout heroes (panel 10) ----
  // feelByMatch is already narrowed to the visible, single-scale rows, so the
  // profiles cannot pick up a match outside the current filters or blend the
  // two question scales inside one tile.
  const allyStandouts = useMemo(
    () => standoutProfiles(standouts, feelByMatch, 'impressed_ally', activeScale, 5, filters.minGames),
    [standouts, feelByMatch, activeScale, filters.minGames],
  )

  const totalGames = rows.length
  const enemyStandouts = useMemo(
    () => standoutProfiles(standouts, feelByMatch, 'struggled_enemy', activeScale, 5, filters.minGames),
    [standouts, feelByMatch, activeScale, filters.minGames],
  )

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title="Feel"
        subtitle="How your games felt against how they actually went — plus whether your read on your own performance matches the numbers."
      />
      <AnalyticsNav />

      {/* Season multi-select drives EVERYTHING on this page, including which
          question set is shown — see activeScale and handleFiltersChange.
          Seasons on different question sets can't be combined, so ticking one
          from a different set replaces the selection rather than adding to it.

          Default is All Time (DEFAULT_FILTERS.seasons = []), which shows the
          current question set across every season using it. Other pages default
          to the current season via defaultSeasonSelection(); Feel deliberately
          does not, because its subject is long-run pattern. */}
      <AnalyticsFilters
        value={filters}
        onChange={handleFiltersChange}
        show={{ queue: true, mode: true, map: true, hero: true, season: true, minGames: true }}
        seasonOptions={seasonOptions}
      />

      {/* Result filter — default All. When a result is picked, win-rate charts
          become distribution (% of that result's games). */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-ow-muted font-display tracking-wider uppercase mr-1">Result</span>
        {([['all', 'All'], ['victory', 'Victory'], ['defeat', 'Defeat'], ['draw', 'Draw']] as [ResultFilter, string][]).map(([v, lbl]) => (
          <button key={v} onClick={() => setResultFilter(v)}
            className={`px-4 py-1.5 rounded-lg text-sm font-display tracking-wider transition-colors
              ${resultFilter === v ? 'bg-ow-orange text-ow-dark font-bold' : 'bg-ow-panel text-ow-muted hover:text-ow-fg border border-ow-line'}`}>
            {lbl}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="bg-ow-panel rounded-xl border border-ow-line p-10 text-center text-ow-muted font-display tracking-wider">LOADING…</div>
      ) : (
        <>
          <p className="text-sm text-ow-muted">
            {totalGames} game{totalGames === 1 ? '' : 's'} in view ·{' '}
            {isV2 ? 'current question set' : 'earlier question set'}
            {bothPresent && ` · ${countsByVersion[isV2 ? 1 : 2]} game${countsByVersion[isV2 ? 1 : 2] === 1 ? '' : 's'} on the other question set — pick that season on its own to see them`} ·{' '}
            {filtered
              ? `showing ${LABELS_RESULT[resultFilter]} only — charts show distribution (% of these games)`
              : 'win rate excludes draws'} · under {filters.minGames} games dimmed
          </p>

          {/* FUN */}
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Panel title={filtered ? `Fun ratings in your ${LABELS_RESULT[resultFilter].toLowerCase()}s` : 'Fun rating distribution'} hint="how often each rating">
              {funDist.some(b => b.count > 0) ? (
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={funDist} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                      <CartesianGrid stroke={c.grid} vertical={false} />
                      <XAxis dataKey="star" tick={axisTickOf(c)} stroke={c.axis} tickFormatter={v => funLabelFor(v as number)} interval={0} />
                      <YAxis tick={axisTickOf(c)} stroke={c.axis} allowDecimals={false} />
                      <Tooltip {...tooltipStyleOf(c)} formatter={(v) => [`${v} games`, 'Count']} labelFormatter={l => funLabelFor(l as number)} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                        {funDist.map((b, i) => <Cell key={i} fill={c.primary} fillOpacity={b.lowConfidence ? 0.45 : 1} />)}
                        <LabelList dataKey="count" position="top" fill={c.axisLabel} fontSize={11} />
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
                    <span className="text-sm text-ow-muted">avg fun · n={funForResult.games} {LABELS_RESULT[resultFilter].toLowerCase()}{funForResult.games === 1 ? '' : 's'}</span>
                    <span className="text-[11px] text-ow-faint">out of {funMax} · see the distribution chart for the full spread</span>
                  </div>
                ) : <Empty label="fun ratings" />
              ) : funByRes.some(r => r.games > 0) ? (
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={funByRes} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                      <CartesianGrid stroke={c.grid} vertical={false} />
                      <XAxis dataKey="result" tick={axisTickOf(c)} stroke={c.axis} tickFormatter={v => String(v).toUpperCase()} />
                      <YAxis domain={[0, funMax]} tick={axisTickOf(c)} stroke={c.axis} />
                      <Tooltip {...tooltipStyleOf(c)} formatter={(_v, _n, p) => {
                        const r = (p as { payload?: { avgFun: number | null; games: number } } | undefined)?.payload
                        return [`${r?.avgFun ?? '—'} avg · ${r?.games ?? 0} games`, 'Fun']
                      }} />
                      <Bar dataKey={(d: { avgFun: number | null }) => d.avgFun ?? 0} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                        {funByRes.map((r, i) => (
                          <Cell key={i} fill={r.result === 'victory' ? c.victory : r.result === 'defeat' ? c.defeat : c.draw}
                            fillOpacity={r.lowConfidence ? 0.45 : 1} />
                        ))}
                        <LabelList dataKey={(d: { avgFun: number | null }) => d.avgFun ?? ''} position="top" fill={c.axisLabel} fontSize={11} />
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
                      <CartesianGrid stroke={c.grid} vertical={false} />
                      <XAxis dataKey="star" tick={axisTickOf(c)} stroke={c.axis} tickFormatter={v => funLabelFor(v as number)} interval={0} />
                      <YAxis tick={axisTickOf(c)} stroke={c.axis} allowDecimals={false} />
                      <Tooltip {...tooltipStyleOf(c)} labelFormatter={l => funLabelFor(l as number)} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="victory" stackId="r" name="Victory" fill={c.victory} isAnimationActive={false} />
                      <Bar dataKey="defeat" stackId="r" name="Defeat" fill={c.defeat} isAnimationActive={false} />
                      <Bar dataKey="draw" stackId="r" name="Draw" fill={c.draw} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : <Empty label="fun ratings" />}
            </Panel>
          )}

          {/* FEEL vs OUTCOME (distribution when result-filtered) */}
          {/* Version 2: matchup + performance rating. Version 1: match feel +
              performance feel, plus mood, tempo and coordination — all three of
              which were RETIRED under version 2 and have no successor column, so
              they simply do not appear there. */}
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            {isV2 ? (
              <>
                <Panel title={filtered ? 'Match-up distribution' : 'Match-up vs outcome'} hint={filtered ? `share of ${LABELS_RESULT[resultFilter]} games` : 'win rate by how the teams matched up'}>
                  <FeelBars wr={matchupFeel} dist={matchupFeelD} filtered={filtered} label="match-up ratings" />
                </Panel>
                <Panel title={filtered ? 'Performance distribution' : 'Performance vs outcome'} hint={filtered ? `share of ${LABELS_RESULT[resultFilter]} games` : 'win rate by how you felt you played'}>
                  <FeelBars wr={perfRating} dist={perfRatingD} filtered={filtered} label="performance ratings" />
                </Panel>
              </>
            ) : (
              <>
                <Panel title={filtered ? 'Match feel distribution' : 'Match feel vs outcome'} hint={filtered ? `share of ${LABELS_RESULT[resultFilter]} games` : 'win rate by how the game felt'}>
                  <FeelBars wr={matchFeel} dist={matchFeelD} filtered={filtered} label="match feel" />
                </Panel>
                <Panel title={filtered ? 'Performance feel distribution' : 'Performance feel vs outcome'} hint={filtered ? `share of ${LABELS_RESULT[resultFilter]} games` : 'win rate by how you felt you played'}>
                  <FeelBars wr={perfFeel} dist={perfFeelD} filtered={filtered} label="performance feel" />
                </Panel>
              </>
            )}
          </div>

          {isV2 && (
            <p className="text-[11px] text-ow-faint">
              Match-up measures how the two teams compared, not who won — &ldquo;Behind&rdquo; with a
              victory is a real and interesting combination. Mood, tempo and coordination
              were retired with the earlier question set and have no equivalent here.
            </p>
          )}

          {/* ── THE HYPOTHESIS: fun against match-up, and against performance ──
              The claim is that a tight loss beats a stomp win. These two panels
              state it; the result-based fun panels below are the control it is
              measured against, which is why both are kept. */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h3 className="font-display text-sm text-ow-orange tracking-wider uppercase">Does the game type drive the fun?</h3>
              {isV2 && (
                <div className="flex gap-1">
                  {([['avg', 'Average fun'], ['binary', 'Enjoyed or not']] as const).map(([v, lbl]) => (
                    <button key={v} onClick={() => setFunView(v)}
                      className={`px-3 py-1 rounded-md text-xs font-display tracking-wider transition-colors
                        ${funView === v ? 'bg-ow-orange text-ow-dark font-bold' : 'bg-ow-dark text-ow-muted hover:text-ow-fg border border-ow-line'}`}>
                      {lbl}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-2 items-start">
              <Panel
                title={isV2 ? 'Match-up vs fun' : 'Match feel vs fun'}
                hint={isV2 && funView === 'binary' ? '% of games you enjoyed' : `average fun, out of ${funMax}`}
              >
                {isV2 && funView === 'binary'
                  ? <FunBinaryBars data={funBinMatchup} />
                  : <AvgFunBars data={funByMatchup} max={funMax} />}
              </Panel>
              <Panel
                title="Performance vs fun"
                hint={isV2 && funView === 'binary' ? '% of games you enjoyed' : `average fun, out of ${funMax}`}
              >
                {isV2 && funView === 'binary'
                  ? <FunBinaryBars data={funBinPerf} />
                  : <AvgFunBars data={funByPerf} max={funMax} />}
              </Panel>
            </div>

            {isV2 && funView === 'binary' && (
              <p className="text-[11px] text-ow-faint">
                Fun splits at the 3&ndash;4 boundary, which is the split the six-point scale was
                built to force — there is no neutral answer to discard. The full five-by-six
                grid needs several hundred games before its most interesting cells fill;
                this asks the same question far sooner.
              </p>
            )}
          </div>

          {!isV2 && (
            <>
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
            </>
          )}

          {/* FEEL vs REALITY */}
          <Panel title="Performance vs reality" hint="role-aware share %, by how you felt you played">
            <FeelVsReality buckets={fvsBuckets} />
          </Panel>

          {/* STANDOUT HEROES — version 2 only. The picks are captured on the
              phone after each match, so no version-1 match has any. Rendering
              the section under version 1 would show two permanently empty
              columns and read as a fault rather than an absence. */}
          {isV2 && (
            <div className="space-y-3">
              <h3 className="font-display text-sm text-ow-orange tracking-wider uppercase">Standout heroes</h3>
              <div className="grid gap-4 lg:grid-cols-2 items-start">
                <Panel title="Allies who impressed you" hint="most flagged, and how those games felt">
                  <StandoutTiles profiles={allyStandouts} funMax={funMax} />
                </Panel>
                <Panel title="Enemies you struggled against" hint="most flagged, and how those games felt">
                  <StandoutTiles profiles={enemyStandouts} funMax={funMax} />
                </Panel>
              </div>
              <p className="text-[11px] text-ow-faint">
                The two lists are not mirror images: you flag an ally who impressed you and an
                enemy who gave you trouble, so there is no &ldquo;ally who played badly&rdquo; here.
                The filters above narrow which of YOUR games are counted, not which heroes can
                appear — filtering to support shows the heroes you noticed while playing support,
                whatever role they were.
              </p>
            </div>
          )}

          {/* LEAVER / THROWER — count + outcome. Last: it describes the games
              rather than how they felt. */}
          <Panel title="Leavers & throwers" hint={isV2 ? 'split by whether they came back' : 'how often, and how those games go'}>
            <FlagTable flags={flags} />
          </Panel>
        </>
      )}
    </div>
  )
}

// Team-vs-enemy grouped bars for an ordered enum.
function TeamEnemyBars({ data }: { data: { key: string; label: string; teamWinRate: number | null; enemyWinRate: number | null; teamGames: number; enemyGames: number }[] }) {
  const c = useChartColors()
  const any = data.some(d => d.teamGames > 0 || d.enemyGames > 0)
  if (!any) return <Empty label="tempo/coordination" />
  return (
    <div style={{ height: Math.max(170, data.length * 56 + 40) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={c.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTickOf(c)} stroke={c.axis} unit="%" />
          <YAxis type="category" dataKey="label" tick={axisTickOf(c)} stroke={c.axis} width={110} />
          <Tooltip {...tooltipStyleOf(c)} formatter={(v, n, p) => {
            const row = (p as { payload?: { teamGames: number; enemyGames: number } } | undefined)?.payload
            const side = String(n)
            const g = side === 'Team' ? row?.teamGames : row?.enemyGames
            return [`${v == null ? '—' : v + '%'} · ${g ?? 0} games`, side]
          }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey={(d: { teamWinRate: number | null }) => d.teamWinRate ?? 0} name="Team" fill={teamEnemy(c).team} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          <Bar dataKey={(d: { enemyWinRate: number | null }) => d.enemyWinRate ?? 0} name="Enemy" fill={teamEnemy(c).enemy} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Leaver/thrower count + outcome table (not a win-rate-factor chart).
function FlagTable({ flags }: { flags: { key: string; label: string; games: number; wins: number; losses: number; draws: number; winRate: number | null; lowConfidence: boolean }[] }) {
  const c = useChartColors()
  const anyData = flags.some(f => f.games > 0)
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[1.4fr_auto_auto_auto] gap-3 text-[10px] font-display tracking-wider text-ow-faint uppercase px-2">
        <span>Event</span><span>Games</span><span>W–L–D</span><span>Win rate</span>
      </div>
      {flags.map(f => (
        <div key={f.key}
          className={`grid grid-cols-[1.4fr_auto_auto_auto] gap-3 items-center bg-ow-dark rounded-lg px-2.5 py-2 border border-ow-line ${f.games === 0 ? 'opacity-40' : f.lowConfidence ? 'opacity-60' : ''}`}>
          <span className="font-display text-sm text-ow-fg">{f.label}</span>
          <span className="text-sm text-ow-muted font-display">{f.games}</span>
          <span className="text-xs text-ow-muted font-display">{f.wins}–{f.losses}–{f.draws}</span>
          <span className="text-sm font-display" style={{ color: wrColor(f.winRate, c) }}>{f.winRate == null ? '—' : `${f.winRate}%`}</span>
        </div>
      ))}
      {!anyData && <p className="text-[11px] text-ow-faint pt-1">No leaver/thrower games recorded yet — this fills in as you flag them on upload.</p>}
    </div>
  )
}

// Feel-vs-reality: per role, the avg role-appropriate share across the
// performance values. Read each role's block top to bottom: the strongest
// self-assessment should out-share the weakest if your feel tracks reality.
//
// The value order and labels come from the BUCKETS rather than being hardcoded,
// because the performance question has two forms — a 3-point enum under version
// 1 and a 5-point rating under version 2 — and the caller has already chosen
// which one is in play. Hardcoding PERF_FEEL_ORDER here would render the
// version-2 view empty while looking perfectly healthy.
function FeelVsReality({ buckets }: { buckets: { feel: string; label: string; role: Role; n: number; avgShare: number | null; shareLabel: string; lowConfidence: boolean }[] }) {
  const c = useChartColors()
  const roles: Role[] = ['tank', 'dps', 'support']
  // First-seen order: feelVsStats emits in scale order within each role.
  const feels = Array.from(new Set(buckets.map(b => b.feel)))
  const anyData = buckets.some(b => b.n > 0)
  if (!anyData) return <Empty label="performance answers + role stats" />
  return (
    <div className="space-y-4">
      {roles.map(role => {
        const rb = feels
          .map(f => buckets.find(b => b.role === role && b.feel === f))
          .filter((b): b is NonNullable<typeof b> => b != null)
        if (rb.length === 0 || !rb.some(b => b.n > 0)) return null
        const shareLabel = rb[0].shareLabel
        const maxShare = Math.max(1, ...rb.map(b => b.avgShare ?? 0))
        return (
          <div key={role} className="bg-ow-dark rounded-lg p-3 border border-ow-line">
            <div className="flex items-baseline justify-between mb-2">
              <span className="font-display text-sm text-ow-orange tracking-wider uppercase">{role}</span>
              <span className="text-[11px] text-ow-faint">{shareLabel}</span>
            </div>
            <div className="space-y-1.5">
              {rb.map(b => {
                const pct = b.avgShare == null ? 0 : (b.avgShare / maxShare) * 100
                return (
                  <div key={b.feel} className={`flex items-center gap-3 ${b.lowConfidence ? 'opacity-60' : ''}`}>
                    <span className="text-xs text-ow-muted font-display w-28 shrink-0">{b.label}</span>
                    <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden">
                      <div className="h-full rounded" style={{ width: `${pct}%`, background: c.primary, opacity: b.avgShare == null ? 0 : 0.85 }} />
                    </div>
                    <span className="text-xs font-display text-ow-fg w-24 text-right shrink-0">
                      {b.avgShare == null ? '\u2014' : `${b.avgShare}%`} <span className="text-ow-faint">n={b.n}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      <p className="text-[11px] text-ow-faint">
        Share % is your portion of the relevant lobby total (damage for DPS, healing for support, mitigation for tank) \u2014 more
        meaningful than raw E/A/D. If your feel tracks reality, the values you rated highest should out-share the ones you rated lowest.
      </p>
    </div>
  )
}

// ── Average fun at each value of another answer (panels 4 and 5, default view).
// Horizontal bars, natural scale order preserved so it reads top→bottom as the
// scale does. The domain is pinned to the FULL fun range rather than the data's
// range: a 0.4-point spread would otherwise stretch across the whole panel and
// look like a decisive finding.
function AvgFunBars({ data, max }: { data: AvgFunByRow[]; max: number }) {
  const c = useChartColors()
  if (!data.some(d => d.n > 0)) return <Empty label="both answers together" />
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 42)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 44, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={c.grid} horizontal={false} />
        <XAxis type="number" domain={[0, max]} tick={axisTickOf(c)} stroke={c.axis} />
        <YAxis type="category" dataKey="label" tick={axisTickOf(c)} stroke={c.axis} width={120} />
        <Tooltip
          {...tooltipStyleOf(c)}
          formatter={(v, _n, p) => [`${v ?? '—'} avg fun · ${(p?.payload as AvgFunByRow)?.n ?? 0} games`, 'Fun']}
        />
        <Bar dataKey="avgFun" radius={[0, 4, 4, 0]}>
          {data.map(d => <Cell key={d.key} fill={c.primary} fillOpacity={d.lowConfidence ? 0.4 : 0.9} />)}
          {/* dataKey accessor rather than `formatter`: recharts types the
              formatter parameter as RenderableText (which includes undefined),
              so a (v: number) signature is rejected. The accessor form is what
              the rest of this file already uses — see the fun-by-result chart. */}
          <LabelList dataKey={(d: { n: number }) => (d.n ? `n=${d.n}` : '')} position="right" fill={c.axis} fontSize={10} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Fun collapsed to enjoyed / didn't, per value of another answer.
// Version 2 only — the six-point scale has no midpoint, so every answer falls
// cleanly on one side and nothing has to be discarded to draw this.
function FunBinaryBars({ data }: { data: FunBinaryRow[] }) {
  const c = useChartColors()
  if (!data.some(d => d.total > 0)) return <Empty label="match-up and fun together" />
  return (
    <div className="space-y-1.5">
      {data.map(d => (
        <div key={d.key} className={`flex items-center gap-3 ${d.lowConfidence ? 'opacity-60' : ''}`}>
          <span className="text-xs text-ow-muted font-display w-28 shrink-0">{d.label}</span>
          <div className="flex-1 h-5 bg-white/5 rounded overflow-hidden flex">
            <div className="h-full" style={{ width: `${d.enjoyedPct ?? 0}%`, background: c.primary, opacity: 0.9 }} />
            <div className="h-full" style={{ width: `${d.enjoyedPct == null ? 0 : 100 - d.enjoyedPct}%`, background: c.axis, opacity: 0.35 }} />
          </div>
          <span className="text-xs font-display text-ow-fg w-24 text-right shrink-0">
            {d.enjoyedPct == null ? '—' : `${d.enjoyedPct}%`} <span className="text-ow-faint">n={d.total}</span>
          </span>
        </div>
      ))}
      <p className="text-[11px] text-ow-faint pt-1">Filled = games you enjoyed (4&ndash;6). Faded = games you didn&apos;t (1&ndash;3).</p>
    </div>
  )
}

// ── Standout hero tiles. One per hero, up to five, most-flagged first.
// Every tile carries its own n and dims below the confidence floor, because at
// low counts the RANKING itself is the unreliable part — which heroes reach the
// top five says as much about who you happened to meet as about anything else.
function StandoutTiles({ profiles, funMax }: { profiles: StandoutProfile[]; funMax: number }) {
  if (profiles.length === 0) return <Empty label="standout picks" />
  const fmt = (v: number | null, suffix = '') => (v == null ? '—' : `${v}${suffix}`)
  return (
    <div className="space-y-2">
      {profiles.map(p => (
        <div key={p.hero} className={`bg-ow-dark rounded-lg p-3 border border-ow-line ${p.lowConfidence ? 'opacity-60' : ''}`}>
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <span className="font-display text-sm text-ow-fg tracking-wider">{p.hero}</span>
            <span className="text-[11px] text-ow-faint">
              {p.picks} game{p.picks === 1 ? '' : 's'} · {fmt(p.winRate, '%')} win rate
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: 'Match-up', value: fmt(p.avgMatchup), of: '5' },
              { label: 'Performance', value: fmt(p.avgPerformance), of: '5' },
              { label: 'Fun', value: fmt(p.avgFun), of: String(funMax) },
            ].map(s => (
              <div key={s.label} className="bg-white/5 rounded px-2 py-1.5">
                <div className="text-[10px] text-ow-faint uppercase tracking-wider">{s.label}</div>
                <div className="font-display text-sm text-ow-fg">
                  {s.value}<span className="text-ow-faint text-[10px]">{s.value === '—' ? '' : `/${s.of}`}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
