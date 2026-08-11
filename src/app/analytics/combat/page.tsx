'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, LabelList, LineChart, Line,
} from 'recharts'
import { supabase } from '@/lib/supabase'
import { keepVisible } from '@/lib/alpha'
import { loadExclusionPrefs, EXCLUSION_COLS } from '@/lib/leaver'
import { defaultSeasonSelection } from '@/lib/season-util'
import { HEROES } from '@/data/reference'
import AnalyticsFilters, {
  DEFAULT_FILTERS,
  matchesFilters,
  heroMatches,
  type AnalyticsFilterState,
  type FilterableMatch,
  type SeasonOption,
} from '@/components/AnalyticsFilters'
import { AnalyticsNav, AnalyticsHeader } from '@/components/AnalyticsNav'
import { useChartColors } from '@/components/useChartColors'
import { type ChartColors } from '@/lib/chart-theme'
import {
  SHARE_LABEL,
  dedupeMatches, withShareForRole, coverage,
  shareWinsVsLosses, shareTrendPerMatch, shareTrendByWeek,
  perRoleSummary, sixVsSixSummary, finalBlowRate,
  shareDrill, drillDimension, shareBySession, rateStat, finalBlowRatesByHero, ratesByHero,
  buildHeroRoleMap, filterBySixRoles,
  overallWinRate,
  deathShare,
  type CombatFactRow, type Role,
} from './combat-lib'

// ============================================================
// COMBAT (/analytics/combat) — your role-aware team share, and how it moves.
// ------------------------------------------------------------
// Reads `combat_facts` (hero_match_facts + role_played + is_alpha). Alpha rule
// applied in JS via keepVisible(). Shared Queue/Mode/Map/Hero filters apply via
// matchesFilters(); the Queue role drives WHICH share is shown.
//
//   • Compact wins-vs-losses (two averages).
//   • Share DRILL-DOWN: by mode → (mode filtered) by map → (map filtered) by
//     hero → (hero filtered) chart removed. Follows the deepest active filter.
//   • Share trend: by SESSION (main; role-absent sessions dropped), per-game
//     (secondary), and by week.
//   • Role-specific stats with per-game / per-minute / per-30s framing:
//       DPS  → final-blow %, final blows (avg/min/30s), per-hero FB rates
//       Tank → obj contest time (avg/min/30s)
//       Support → players saved (avg/min/30s)
//   • All-queues → per-role summary. 6v6 → role-agnostic headline PLUS a local
//     role multi-select that unlocks the same full breakdown as a 5v5 queue.
// ============================================================

interface CombatRow extends FilterableMatch, Omit<CombatFactRow, 'role_played'> { season_id: number | null }

const COLS =
  'hero_performance_id, match_id, hero_name, match_format, map, game_mode, starting_side, ' +
  'result, season_id, played_at, percent_played, is_single_hero, game_length_seconds, ' +
  'eff_play_time_seconds, scoreboard_hero, user_elims, user_assists, user_deaths, user_damage, ' +
  'user_healing, user_mitigation, ally_total_damage, enemy_total_damage, damage_pct, healing_pct, ' +
  'mitigation_pct, final_blows, solo_kills, obj_contest_time, players_saved, role_played, is_alpha, ' +
  'ally_total_deaths, ' +
  // The six columns the excluded-games policy needs. Selecting the leaver
  // BOOLEANS alone is not enough — they are true for both a permanent and a
  // returned leaver, which now have separate switches. combat_facts was
  // rebuilt in v1.1.0 to expose the type and thrower columns for this.
  EXCLUSION_COLS

const HERO_ROLE = buildHeroRoleMap(HEROES.map(h => ({ name: h.name, role: h.role as Role })))

const axisTickOf = (c: ChartColors) => ({ fill: c.axisLabel, fontSize: 11 })
const tooltipStyleOf = (c: ChartColors) => ({
  contentStyle: { background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 8, fontSize: 12 },
  labelStyle: { color: c.tooltipText },
})

function roleFromQueue(q: AnalyticsFilterState['queue']): Role | null {
  return q === 'tank' || q === 'dps' || q === 'support' ? q : null
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

function Stat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="bg-ow-panel rounded-xl border border-ow-line p-4 flex flex-col gap-1">
      <span className="font-display text-3xl tracking-wider text-ow-fg">{value}</span>
      <span className="text-[11px] text-ow-muted font-display tracking-wider uppercase">{label}</span>
      {sub && <span className="text-[11px] text-ow-faint">{sub}</span>}
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <div className="h-[140px] flex items-center justify-center text-center">
      <p className="text-sm text-ow-faint">No data for {label} with these filters yet.</p>
    </div>
  )
}

function CoverageNote({ withData, total, what }: { withData: number; total: number; what?: string }) {
  if (total === 0) return null
  const pct = Math.round((withData / total) * 100)
  return (
    <p className="text-[11px] text-ow-faint mt-2">
      From {withData} of {total} games ({pct}%){what ? ` with ${what}` : ''}.
    </p>
  )
}

// A horizontal avg-share bar chart for the drill-down (by mode/map/hero).
function ShareDrillChart({ data, dimLabel }: { data: { key: string; avgShare: number | null; games: number; lowConfidence: boolean }[]; dimLabel: string }) {
  const c = useChartColors()
  if (data.length === 0) return <Empty label={dimLabel} />
  const height = Math.max(150, data.length * 32 + 40)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 90, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={c.grid} horizontal={false} />
          <XAxis type="number" tick={axisTickOf(c)} stroke={c.axis} unit="%" />
          <YAxis type="category" dataKey="key" tick={axisTickOf(c)} stroke={c.axis} width={120} />
          <Tooltip {...tooltipStyleOf(c)}
            formatter={(_v, _n, p) => {
              const r = (p as { payload?: typeof data[number] } | undefined)?.payload
              return [`${r?.avgShare ?? '—'}% · ${r?.games ?? 0} games`, 'Avg share']
            }} />
          <Bar dataKey={(d: typeof data[number]) => d.avgShare ?? 0} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={c.primary} fillOpacity={d.lowConfidence ? 0.4 : 1} />)}
            <LabelList dataKey="avgShare" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const r = data[p.index ?? -1]
              if (!r || p.x == null || p.y == null || p.width == null || p.height == null) return null
              return <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central" fill={c.axisLabel} fontSize={11} fontFamily="inherit">{r.avgShare == null ? '—' : `${r.avgShare}%`}  n={r.games}</text>
            }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// The full per-role breakdown — reused by the 5v5 queue and by 6v6 (per selected
// role). `rows` are the fact rows already scoped to the role; `role` the lens.
function RoleBreakdown({ rows, role, modeActive, mapActive, heroActive, minGames }: {
  rows: CombatRow[]; role: Role; modeActive: boolean; mapActive: boolean; heroActive: boolean; minGames: number
}) {
  const c = useChartColors()
  const deduped = useMemo(() => withShareForRole(dedupeMatches(rows), role), [rows, role])
  const cov = useMemo(() => coverage(deduped), [deduped])
  const winLoss = useMemo(() => shareWinsVsLosses(deduped), [deduped])
  const bySession = useMemo(() => shareBySession(deduped), [deduped])
  const perGame = useMemo(() => shareTrendPerMatch(deduped), [deduped])
  const byWeek = useMemo(() => shareTrendByWeek(deduped, minGames), [deduped, minGames])
  const dim = drillDimension(modeActive, mapActive, heroActive)
  const drill = useMemo(() => shareDrill(rows, role, dim, minGames), [rows, role, dim, minGames])
  const shareLabel = SHARE_LABEL[role]
  const dimLabel = dim === 'mode' ? 'mode' : dim === 'map' ? 'map' : dim === 'hero' ? 'hero' : ''

  return (
    <>
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Stat value={winLoss.wins.avg != null ? `${winLoss.wins.avg}%` : '—'} label={`${shareLabel} · wins`} sub={`${winLoss.wins.n} games`} />
        <Stat value={winLoss.losses.avg != null ? `${winLoss.losses.avg}%` : '—'} label={`${shareLabel} · losses`} sub={`${winLoss.losses.n} games`} />
        <Stat value={String(cov.withData)} label="Games with share" sub={`of ${cov.total} in view`} />
        <Stat value={overallWinRate(deduped) == null ? '—' : `${overallWinRate(deduped)}%`} label="Win rate" />
      </div>

      {dim !== 'none' ? (
        <Panel title={`${shareLabel} — by ${dimLabel}`} hint="drill deeper by filtering mode → map → hero">
          <ShareDrillChart data={drill} dimLabel={dimLabel} />
        </Panel>
      ) : (
        <Panel title={`${shareLabel}`} hint="nothing left to break down by">
          <p className="text-sm text-ow-faint">Mode, map and hero are all filtered, so there is no dimension left to vary across; the averages above cover the current selection.</p>
        </Panel>
      )}

      <Panel title={`${shareLabel} — by session`} hint="avg per play session; role-absent sessions omitted">
        {bySession.length === 0 ? <Empty label="sessions" /> : (
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={bySession} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                <CartesianGrid stroke={c.grid} />
                <XAxis dataKey="label" tick={axisTickOf(c)} stroke={c.axis} />
                <YAxis tick={axisTickOf(c)} stroke={c.axis} unit="%" />
                <Tooltip {...tooltipStyleOf(c)}
                  formatter={(_v, _n, p) => {
                    const r = (p as { payload?: typeof bySession[number] } | undefined)?.payload
                    return [`${r?.avgShare ?? '—'}% · ${r?.games ?? 0} games`, 'Avg share']
                  }} />
                <Line type="monotone" dataKey="avgShare" stroke={c.primary} strokeWidth={2} dot={{ r: 3, fill: c.primary }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <Panel title={`${shareLabel} — per game`} hint="each game, oldest → newest (detail)">
          {perGame.length === 0 ? <Empty label="per-game trend" /> : (
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={perGame.map((p, i) => ({ i: i + 1, share: p.share }))} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke={c.grid} />
                  <XAxis dataKey="i" tick={axisTickOf(c)} stroke={c.axis} />
                  <YAxis tick={axisTickOf(c)} stroke={c.axis} unit="%" />
                  <Tooltip {...tooltipStyleOf(c)} formatter={(v) => [`${v}%`, shareLabel]} labelFormatter={(l: unknown) => `Game ${l}`} />
                  <Line type="monotone" dataKey="share" stroke={c.draw} strokeWidth={1.5} dot={{ r: 1.5, fill: c.draw }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
        <Panel title={`${shareLabel} — by week`} hint="ISO week · avg share">
          {byWeek.length === 0 ? <Empty label="weekly trend" /> : (
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={byWeek} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke={c.grid} />
                  <XAxis dataKey="label" tick={axisTickOf(c)} stroke={c.axis} />
                  <YAxis tick={axisTickOf(c)} stroke={c.axis} unit="%" />
                  <Tooltip {...tooltipStyleOf(c)}
                    formatter={(_v, _n, p) => {
                      const r = (p as { payload?: typeof byWeek[number] } | undefined)?.payload
                      return [`${r?.avgShare ?? '—'}% · ${r?.games ?? 0} games`, shareLabel]
                    }} />
                  <Line type="monotone" dataKey={(d: typeof byWeek[number]) => d.avgShare ?? null} stroke={c.categorical[3]} strokeWidth={2} dot={{ r: 3, fill: c.categorical[3] }} connectNulls isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>

      <CoverageNote withData={cov.withData} total={cov.total} what="share data" />

      {/* Role-specific stats with per-game / per-min / per-30s framing. */}
      <RoleSpecific rows={rows} role={role} minGames={minGames} />
    </>
  )
}

// Role-specific stats, with the avg / per-minute / per-30s rate framing.
// Reusable per-hero rate chart: average-per-game bars with per-min/per-30s in
// the label + tooltip. Used by all three roles for their respective stat.
function RatesByHeroChart({ data, unit = '/game', isSecs = false }: {
  data: { hero: string; avgPerGame: number | null; perMinute: number | null; per30Sec: number | null; games: number; timeGames: number; lowConfidence: boolean }[]
  unit?: string
  isSecs?: boolean
}) {
  const c = useChartColors()
  if (data.length === 0) return <Empty label="by hero" />
  const fmtVal = (v: number | null) => v == null ? '—' : isSecs ? fmtSecs(v) : String(v)
  return (
    <div style={{ height: Math.max(160, data.length * 30 + 40) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 160, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={c.grid} horizontal={false} />
          <XAxis type="number" tick={axisTickOf(c)} stroke={c.axis} />
          <YAxis type="category" dataKey="hero" tick={axisTickOf(c)} stroke={c.axis} width={110} />
          <Tooltip {...tooltipStyleOf(c)}
            formatter={(_v, _n, p) => {
              const r = (p as { payload?: typeof data[number] } | undefined)?.payload
              const pm = r?.perMinute == null ? 'n/a' : `${r.perMinute}/min`
              const p3 = r?.per30Sec == null ? 'n/a' : `${r.per30Sec}/30s`
              return [`${fmtVal(r?.avgPerGame ?? null)}${unit} · ${pm} · ${p3} · ${r?.games ?? 0} games`, r?.hero ?? '']
            }} />
          <Bar dataKey="avgPerGame" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={c.primary} fillOpacity={d.lowConfidence ? 0.4 : 1} />)}
            <LabelList dataKey="avgPerGame" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const r = data[p.index ?? -1]
              if (!r || p.x == null || p.y == null || p.width == null || p.height == null) return null
              const pm = r.perMinute == null ? '' : ` · ${r.perMinute}/min`
              return <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central" fill={c.axisLabel} fontSize={11} fontFamily="inherit">{`${fmtVal(r.avgPerGame)}${unit}${pm}`}</text>
            }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function RoleSpecific({ rows, role, minGames }: { rows: CombatRow[]; role: Role; minGames: number }) {
  const fb = useMemo(() => finalBlowRate(rows), [rows])
  const fbRate = useMemo(() => rateStat(rows, r => r.final_blows), [rows])
  const fbByHero = useMemo(() => finalBlowRatesByHero(rows, minGames), [rows, minGames])
  const solo = useMemo(() => rateStat(rows, r => r.solo_kills), [rows])
  const objTime = useMemo(() => rateStat(rows, r => r.obj_contest_time, true), [rows])
  const saved = useMemo(() => rateStat(rows, r => r.players_saved), [rows])
  const objByHero = useMemo(() => ratesByHero(rows, r => r.obj_contest_time, true, minGames), [rows, minGames])
  const savedByHero = useMemo(() => ratesByHero(rows, r => r.players_saved, false, minGames), [rows, minGames])

  if (role === 'dps') {
    return (
      <>
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <Stat value={fb.avgPct == null ? '—' : `${fb.avgPct}%`} label="Final-blow %" sub={`FB ÷ elims · ${fb.withData}/${fb.total} games`} />
          <Stat value={fbRate.perGameAvg == null ? '—' : String(fbRate.perGameAvg)} label="Final blows / game" />
          <Stat value={fbRate.perMinute == null ? '—' : String(fbRate.perMinute)} label="Final blows / min" />
          <Stat value={fbRate.per30Sec == null ? '—' : String(fbRate.per30Sec)} label="Final blows / 30s" />
        </div>
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-2">
          <Stat value={solo.perGameAvg == null ? '—' : String(solo.perGameAvg)} label="Solo kills / game" sub={`${solo.gameCoverage.withData}/${solo.gameCoverage.total} games`} />
          <Stat value={solo.perMinute == null ? '—' : String(solo.perMinute)} label="Solo kills / min" sub={`${solo.timeCoverage.withData}/${solo.timeCoverage.total} with hero time`} />
        </div>

        <Panel title="Final blows — by hero" hint="average per game; per-min & per-30s where hero time exists">
          <RatesByHeroChart data={fbByHero} unit="/game" />
          <CoverageNote withData={fbRate.timeCoverage.withData} total={fbRate.timeCoverage.total} what="hero time (for the per-min/30s rates)" />
        </Panel>
      </>
    )
  }

  if (role === 'tank') {
    return (
      <>
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <Stat value={objTime.perGameAvg == null ? '—' : fmtSecs(objTime.perGameAvg)} label="Obj contest / game" sub={`${objTime.gameCoverage.withData}/${objTime.gameCoverage.total} games`} />
          <Stat value={objTime.perMinute == null ? '—' : `${objTime.perMinute}s`} label="Obj contest / min" sub="seconds contested per min" />
          <Stat value={objTime.per30Sec == null ? '—' : `${objTime.per30Sec}s`} label="Obj contest / 30s" />
          <Stat value={String(objTime.timeCoverage.withData)} label="Games w/ hero time" sub={`of ${objTime.timeCoverage.total}`} />
        </div>
        <Panel title="Obj contest time — by hero" hint="average per game; per-min & per-30s where hero time exists">
          <RatesByHeroChart data={objByHero} unit="/game" isSecs />
          <CoverageNote withData={objTime.timeCoverage.withData} total={objTime.timeCoverage.total} what="hero time (for the per-min/30s rates)" />
        </Panel>
      </>
    )
  }

  // support
  return (
    <>
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Stat value={saved.perGameAvg == null ? '—' : String(saved.perGameAvg)} label="Players saved / game" sub={`${saved.gameCoverage.withData}/${saved.gameCoverage.total} games`} />
        <Stat value={saved.perMinute == null ? '—' : String(saved.perMinute)} label="Players saved / min" />
        <Stat value={saved.per30Sec == null ? '—' : String(saved.per30Sec)} label="Players saved / 30s" />
        <Stat value={String(saved.timeCoverage.withData)} label="Games w/ hero time" sub={`of ${saved.timeCoverage.total}`} />
      </div>
      <Panel title="Players saved — by hero" hint="average per game; per-min & per-30s where hero time exists">
        <RatesByHeroChart data={savedByHero} unit="/game" />
        <CoverageNote withData={saved.timeCoverage.withData} total={saved.timeCoverage.total} what="hero time (for the per-min/30s rates)" />
      </Panel>
    </>
  )
}

export default function CombatPage() {
  const c = useChartColors()
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)
  const [factRows, setFactRows] = useState<CombatRow[]>([])
  const [seasonOptions, setSeasonOptions] = useState<SeasonOption[]>([])
  const [loading, setLoading] = useState(true)
  const [sixRoles, setSixRoles] = useState<Set<Role>>(new Set())
  // Bumped once the excluded-games preferences have loaded, so the filter memo
  // re-runs with the correct show/hide decisions (the cache starts fully hidden).
  const [leaverReady, setLeaverReady] = useState(false)
  const seasonDefaulted = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // Load the excluded-games preferences (cached) alongside the data.
    loadExclusionPrefs().then(() => { if (!cancelled) setLeaverReady(true) })
    Promise.all([
      supabase.from('combat_facts').select(COLS),
      supabase.from('seasons').select('id, name, start_date, end_date').order('start_date', { ascending: false }),
    ]).then(([res, sRes]) => {
      if (cancelled) return
      const data = ((res.data as unknown) as CombatRow[] | null) || []
      setFactRows(keepVisible(data))
      const seasonRows = (((sRes as unknown) as { data: { id: number; name: string; start_date: string; end_date: string }[] | null }).data) || []
      setSeasonOptions(seasonRows.map(s => ({ id: s.id, name: s.name })))
      if (!seasonDefaulted.current) {
        seasonDefaulted.current = true
        setFilters(f => ({ ...f, seasons: defaultSeasonSelection(seasonRows) }))
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const role = roleFromQueue(filters.queue)
  const is6v6 = filters.queue === '6v6'
  // "Is this filter narrowing anything?" — feeds drillDimension, which picks the
  // next UNFILTERED dimension to break the chart down by (mode → map → hero).
  // An empty array means no filter, so the test is length-based now.
  const modeActive = filters.modes.length > 0
  const mapActive = filters.maps.length > 0
  const heroActive = filters.heroes.length > 0

  // Apply shared Queue/Mode/Map/Season/Hero filters, plus the excluded-games policy.
  // Combat is a performance surface, so leavers and throwers are hidden unless
  // their switches are on. The page no longer decides WHICH games to drop — it
  // opts in and @/lib/leaver owns the rule, so every surface agrees. leaverReady
  // is in the deps so this re-runs once the prefs arrive from the DB.
  //
  // (v1.1.0 Phase 2) Hero is tested with the shared heroMatches() rather than a
  // local comparison. These rows are HERO-GRAIN (one per hero per match, from
  // combat_facts), so pooling is a direct membership test — unlike the
  // match-grain pages, which have to union id sets to reach the same semantics.
  const rows = useMemo(() => {
    return factRows.filter(r => {
      if (!matchesFilters(r, filters, { applyExclusions: true })) return false
      if (!heroMatches(r.hero_name, filters)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factRows, filters, leaverReady])

  const deduped = useMemo(() => dedupeMatches(rows), [rows])
  const overall = useMemo(() => overallWinRate(deduped), [deduped])
  const roleSummary = useMemo(() => perRoleSummary(deduped, filters.minGames), [deduped, filters.minGames])
  const sixSummary = useMemo(() => sixVsSixSummary(deduped, filters.minGames), [deduped, filters.minGames])

  // Death share, capped to the latest 10 games that match the current filters.
  // Built from `rows` (CombatRow[], the type deathShare accepts) rather than
  // `deduped` (dedupeMatches → the narrower MatchRow[], which deathShare rejects).
  // We dedupe by match_id ourselves to keep one row per match AND preserve the
  // CombatRow type, then sort by played_at desc and take the latest 10. If fewer
  // than 10 qualify we show whatever exists, with a note. Sorts a copy (no mutation).
  const deaths = useMemo(() => {
    const seen = new Set<number>()
    const oneEach = rows.filter(r => {
      if (seen.has(r.match_id)) return false
      seen.add(r.match_id)
      return true
    })
    const latest10 = oneEach
      .sort((a, b) => (b.played_at ?? '').localeCompare(a.played_at ?? ''))
      .slice(0, 10)
    return { result: deathShare(latest10), windowSize: latest10.length }
  }, [rows])

  // 6v6 with roles selected → scope rows to those roles for the breakdown.
  const sixScopedRows = useMemo(
    () => filterBySixRoles(rows, sixRoles, HERO_ROLE) as CombatRow[],
    [rows, sixRoles],
  )

  function toggleSixRole(r: Role) {
    setSixRoles(prev => {
      const next = new Set(prev)
      if (next.has(r)) next.delete(r); else next.add(r)
      return next
    })
  }

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Combat" subtitle="Your role-aware team share, how it shifts between wins and losses, and over time." />
      <AnalyticsNav />

      <AnalyticsFilters value={filters} onChange={setFilters} show={{ queue: true, mode: true, map: true, hero: true, season: true, minGames: true }} seasonOptions={seasonOptions} />

      {loading ? (
        <div className="bg-ow-panel rounded-xl border border-ow-line p-10 text-center text-ow-muted font-display tracking-wider">LOADING…</div>
      ) : (
        <>
          <p className="text-sm text-ow-muted">
            {deduped.length} game{deduped.length === 1 ? '' : 's'} in view · overall win rate {overall == null ? '—' : overall + '%'} ·
            share = your slice of your team&apos;s total · win rate excludes draws
          </p>

          {/* All-queues: per-role summary. */}
          {role == null && !is6v6 && (
            <Panel title="Team share by role" hint="pick a role in Queue to drill in">
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
                {roleSummary.map(s => (
                  <Stat key={s.role} value={s.avgShare == null ? '—' : `${s.avgShare}%`} label={s.label} sub={`from ${s.withData} of ${s.total} ${s.role} games`} />
                ))}
              </div>
              <p className="text-[11px] text-ow-faint mt-3">Each role uses its own stat (tanks mitigate, supports heal, DPS deal damage) — not comparable as one number.</p>
            </Panel>
          )}

          {/* 6v6: headline + local role multi-select that unlocks the breakdown. */}
          {is6v6 && (
            <>
              <Panel title="Team share — 6v6 (all roles)" hint="averaged across all your 6v6 games">
                <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
                  {sixSummary.map(s => (
                    <Stat key={s.role} value={s.avgShare == null ? '—' : `${s.avgShare}%`} label={s.label} sub={`from ${s.withData} of ${s.total} games`} />
                  ))}
                </div>
                <div className="mt-4">
                  <span className="text-[11px] text-ow-muted font-display tracking-wider uppercase">Filter by role(s) played in 6v6</span>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {(['tank', 'dps', 'support'] as Role[]).map(r => {
                      const on = sixRoles.has(r)
                      return (
                        <button key={r} onClick={() => toggleSixRole(r)}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-display tracking-wider uppercase border transition-colors ${on ? 'border-ow-orange/60 text-ow-orange bg-ow-orange/10' : 'border-ow-line text-ow-muted'}`}>
                          {r}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-ow-faint mt-2">Pick any combination. Selecting role(s) shows the full breakdown below for games you played that role.</p>
                </div>
              </Panel>

              {/* When roles are selected, show the full breakdown per selected role. */}
              {sixRoles.size > 0 && Array.from(sixRoles).map(r => (
                <div key={r} className="space-y-6">
                  <h3 className="font-display tracking-[0.12em] text-ow-muted uppercase text-xs">6v6 · {r}</h3>
                  <RoleBreakdown rows={filterBySixRoles(sixScopedRows, new Set([r]), HERO_ROLE) as CombatRow[]} role={r} modeActive={modeActive} mapActive={mapActive} heroActive={heroActive} minGames={filters.minGames} />
                </div>
              ))}
            </>
          )}

          {/* 5v5 single role: the full breakdown. */}
          {role != null && (
            <RoleBreakdown rows={rows} role={role} modeActive={modeActive} mapActive={mapActive} heroActive={heroActive} minGames={filters.minGames} />
          )}

          <p className="text-xs text-ow-faint">
            Team share is your slice of your team&apos;s total for your role&apos;s stat (DPS damage, support healing, tank mitigation).
            Games without full team capture show no share and are excluded — the coverage notes say how many. Per-minute / per-30s rates
            use your time on the hero; games missing that time drop from those rates only. Sparse bars (under {filters.minGames} games) are dimmed.
          </p>

          {/* My share of team deaths — always last; latest 10 filter-matching games only. */}
          <Panel title="My share of team deaths" hint={`latest ${deaths.windowSize} game${deaths.windowSize === 1 ? '' : 's'} · how much of the dying is yours`}>
            {deaths.result.withData === 0 ? <Empty label="team deaths" /> : (
              <>
                <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 mb-2">
                  <Stat value={deaths.result.avgSharePct == null ? '—' : `${deaths.result.avgSharePct}%`} label="My share of deaths" sub="avg across these games" />
                  <Stat value={deaths.result.myAvgDeaths == null ? '—' : String(deaths.result.myAvgDeaths)} label="My deaths / game" />
                  <Stat value={deaths.result.teammateAvgDeaths == null ? '—' : String(deaths.result.teammateAvgDeaths)} label="Teammate avg / game" sub="each other ally" />
                </div>
                <p className="text-[11px] text-ow-faint mb-3">
                  {deaths.result.myAvgDeaths != null && deaths.result.teammateAvgDeaths != null
                    ? (deaths.result.myAvgDeaths < deaths.result.teammateAvgDeaths
                        ? 'You die LESS than the average teammate.'
                        : deaths.result.myAvgDeaths > deaths.result.teammateAvgDeaths
                          ? 'You die MORE than the average teammate.'
                          : 'You die about as often as the average teammate.')
                    : ''}
                </p>
                <div style={{ height: Math.max(220, deaths.result.perMatch.length * 8 + 80) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={deaths.result.perMatch} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                      <CartesianGrid stroke={c.grid} vertical={false} />
                      <XAxis dataKey="match_id" tick={false} stroke={c.axis} label={{ value: 'games (oldest → newest)', position: 'insideBottom', offset: -2, fill: c.axis, fontSize: 11 }} />
                      <YAxis domain={[0, 100]} tick={axisTickOf(c)} stroke={c.axis} unit="%" />
                      <Tooltip {...tooltipStyleOf(c)}
                        formatter={(_v, _n, p) => {
                          const row = (p as { payload?: typeof deaths.result.perMatch[number] } | undefined)?.payload
                          return [`${row?.sharePct ?? 0}% · ${row?.myDeaths ?? 0} of ${row?.teamDeaths ?? 0} team deaths`, 'My death share']
                        }}
                        labelFormatter={() => ''} />
                      <Line type="monotone" dataKey="sharePct" stroke={c.primary} strokeWidth={2} dot={{ r: 2, fill: c.primary }} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <CoverageNote withData={deaths.result.withData} total={deaths.result.total} what="a team-death total" />
                {deaths.windowSize < 10 && (
                  <p className="text-[11px] text-ow-faint mt-2">Only {deaths.windowSize} game{deaths.windowSize === 1 ? '' : 's'} match the current filters — showing all of them (fewer than 10).</p>
                )}
              </>
            )}
          </Panel>
        </>
      )}
    </div>
  )
}

// Seconds → "M:SS" (or "Ns" under a minute) for obj contest time display.
function fmtSecs(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`
}
