'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, LabelList, LineChart, Line,
} from 'recharts'
import { supabase } from '@/lib/supabase'
import { keepVisible } from '@/lib/alpha'
import { HEROES } from '@/data/reference'
import AnalyticsFilters, {
  DEFAULT_FILTERS,
  matchesFilters,
  type AnalyticsFilterState,
  type FilterableMatch,
} from '@/components/AnalyticsFilters'
import { AnalyticsNav, AnalyticsHeader } from '@/components/AnalyticsNav'
import {
  MIN_GAMES, SHARE_LABEL,
  dedupeMatches, withShareForRole, coverage,
  shareWinsVsLosses, shareTrendPerMatch, shareTrendByWeek,
  perRoleSummary, sixVsSixSummary, finalBlowRate,
  shareDrill, drillDimension, shareBySession, rateStat, finalBlowRatesByHero, ratesByHero,
  buildHeroRoleMap, filterBySixRoles,
  overallWinRate,
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

const OW = {
  orange: '#f99e1a', accent: '#ffcb6b', victory: '#3fb950', defeat: '#f85149',
  draw: '#8b949e', grid: 'rgba(255,255,255,0.08)', axis: 'rgba(255,255,255,0.45)',
}

interface CombatRow extends FilterableMatch, Omit<CombatFactRow, 'role_played'> {}

const COLS =
  'hero_performance_id, match_id, hero_name, match_format, map, game_mode, starting_side, ' +
  'result, season_id, played_at, percent_played, is_single_hero, game_length_seconds, ' +
  'eff_play_time_seconds, scoreboard_hero, user_elims, user_assists, user_deaths, user_damage, ' +
  'user_healing, user_mitigation, ally_total_damage, enemy_total_damage, damage_pct, healing_pct, ' +
  'mitigation_pct, final_blows, solo_kills, obj_contest_time, players_saved, role_played, is_alpha'

const HERO_ROLE = buildHeroRoleMap(HEROES.map(h => ({ name: h.name, role: h.role as Role })))

const axisTick = { fill: OW.axis, fontSize: 11 }
const tooltipStyle = {
  contentStyle: { background: '#0f1419', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#e6edf3' },
}

function roleFromQueue(q: AnalyticsFilterState['queue']): Role | null {
  return q === 'tank' || q === 'dps' || q === 'support' ? q : null
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

function Stat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="bg-ow-panel rounded-xl border border-white/10 p-4 flex flex-col gap-1">
      <span className="font-display text-3xl tracking-wider text-slate-100">{value}</span>
      <span className="text-[11px] text-slate-400 font-display tracking-wider uppercase">{label}</span>
      {sub && <span className="text-[11px] text-slate-500">{sub}</span>}
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <div className="h-[140px] flex items-center justify-center text-center">
      <p className="text-sm text-slate-500">No data for {label} with these filters yet.</p>
    </div>
  )
}

function CoverageNote({ withData, total, what }: { withData: number; total: number; what?: string }) {
  if (total === 0) return null
  const pct = Math.round((withData / total) * 100)
  return (
    <p className="text-[11px] text-slate-500 mt-2">
      From {withData} of {total} games ({pct}%){what ? ` with ${what}` : ''}.
    </p>
  )
}

// A horizontal avg-share bar chart for the drill-down (by mode/map/hero).
function ShareDrillChart({ data, dimLabel }: { data: { key: string; avgShare: number | null; games: number; lowConfidence: boolean }[]; dimLabel: string }) {
  if (data.length === 0) return <Empty label={dimLabel} />
  const height = Math.max(150, data.length * 32 + 40)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 90, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={OW.grid} horizontal={false} />
          <XAxis type="number" tick={axisTick} stroke={OW.axis} unit="%" />
          <YAxis type="category" dataKey="key" tick={axisTick} stroke={OW.axis} width={120} />
          <Tooltip {...tooltipStyle}
            formatter={(_v, _n, p) => {
              const r = (p as { payload?: typeof data[number] } | undefined)?.payload
              return [`${r?.avgShare ?? '—'}% · ${r?.games ?? 0} games`, 'Avg share']
            }} />
          <Bar dataKey={(d: typeof data[number]) => d.avgShare ?? 0} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={OW.orange} fillOpacity={d.lowConfidence ? 0.4 : 1} />)}
            <LabelList dataKey="avgShare" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const r = data[p.index ?? -1]
              if (!r || p.x == null || p.y == null || p.width == null || p.height == null) return null
              return <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central" fill="#e6edf3" fontSize={11} fontFamily="inherit">{r.avgShare == null ? '—' : `${r.avgShare}%`}  n={r.games}</text>
            }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// The full per-role breakdown — reused by the 5v5 queue and by 6v6 (per selected
// role). `rows` are the fact rows already scoped to the role; `role` the lens.
function RoleBreakdown({ rows, role, modeActive, mapActive, heroActive }: {
  rows: CombatRow[]; role: Role; modeActive: boolean; mapActive: boolean; heroActive: boolean
}) {
  const deduped = useMemo(() => withShareForRole(dedupeMatches(rows), role), [rows, role])
  const cov = useMemo(() => coverage(deduped), [deduped])
  const winLoss = useMemo(() => shareWinsVsLosses(deduped), [deduped])
  const bySession = useMemo(() => shareBySession(deduped), [deduped])
  const perGame = useMemo(() => shareTrendPerMatch(deduped), [deduped])
  const byWeek = useMemo(() => shareTrendByWeek(deduped), [deduped])
  const dim = drillDimension(modeActive, mapActive, heroActive)
  const drill = useMemo(() => shareDrill(rows, role, dim), [rows, role, dim])
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
        <Panel title={`${shareLabel}`} hint="hero selected — see the stat cards above">
          <p className="text-sm text-slate-500">With a single hero filtered, the breakdown chart is hidden; the averages above cover that hero.</p>
        </Panel>
      )}

      <Panel title={`${shareLabel} — by session`} hint="avg per play session; role-absent sessions omitted">
        {bySession.length === 0 ? <Empty label="sessions" /> : (
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={bySession} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                <CartesianGrid stroke={OW.grid} />
                <XAxis dataKey="label" tick={axisTick} stroke={OW.axis} />
                <YAxis tick={axisTick} stroke={OW.axis} unit="%" />
                <Tooltip {...tooltipStyle}
                  formatter={(_v, _n, p) => {
                    const r = (p as { payload?: typeof bySession[number] } | undefined)?.payload
                    return [`${r?.avgShare ?? '—'}% · ${r?.games ?? 0} games`, 'Avg share']
                  }} />
                <Line type="monotone" dataKey="avgShare" stroke={OW.orange} strokeWidth={2} dot={{ r: 3, fill: OW.orange }} isAnimationActive={false} />
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
                  <CartesianGrid stroke={OW.grid} />
                  <XAxis dataKey="i" tick={axisTick} stroke={OW.axis} />
                  <YAxis tick={axisTick} stroke={OW.axis} unit="%" />
                  <Tooltip {...tooltipStyle} formatter={(v) => [`${v}%`, shareLabel]} labelFormatter={(l: unknown) => `Game ${l}`} />
                  <Line type="monotone" dataKey="share" stroke={OW.draw} strokeWidth={1.5} dot={{ r: 1.5, fill: OW.draw }} isAnimationActive={false} />
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
                  <CartesianGrid stroke={OW.grid} />
                  <XAxis dataKey="label" tick={axisTick} stroke={OW.axis} />
                  <YAxis tick={axisTick} stroke={OW.axis} unit="%" />
                  <Tooltip {...tooltipStyle}
                    formatter={(_v, _n, p) => {
                      const r = (p as { payload?: typeof byWeek[number] } | undefined)?.payload
                      return [`${r?.avgShare ?? '—'}% · ${r?.games ?? 0} games`, shareLabel]
                    }} />
                  <Line type="monotone" dataKey={(d: typeof byWeek[number]) => d.avgShare ?? null} stroke={OW.accent} strokeWidth={2} dot={{ r: 3, fill: OW.accent }} connectNulls isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>

      <CoverageNote withData={cov.withData} total={cov.total} what="share data" />

      {/* Role-specific stats with per-game / per-min / per-30s framing. */}
      <RoleSpecific rows={rows} role={role} />
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
  if (data.length === 0) return <Empty label="by hero" />
  const fmtVal = (v: number | null) => v == null ? '—' : isSecs ? fmtSecs(v) : String(v)
  return (
    <div style={{ height: Math.max(160, data.length * 30 + 40) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 160, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={OW.grid} horizontal={false} />
          <XAxis type="number" tick={axisTick} stroke={OW.axis} />
          <YAxis type="category" dataKey="hero" tick={axisTick} stroke={OW.axis} width={110} />
          <Tooltip {...tooltipStyle}
            formatter={(_v, _n, p) => {
              const r = (p as { payload?: typeof data[number] } | undefined)?.payload
              const pm = r?.perMinute == null ? 'n/a' : `${r.perMinute}/min`
              const p3 = r?.per30Sec == null ? 'n/a' : `${r.per30Sec}/30s`
              return [`${fmtVal(r?.avgPerGame ?? null)}${unit} · ${pm} · ${p3} · ${r?.games ?? 0} games`, r?.hero ?? '']
            }} />
          <Bar dataKey="avgPerGame" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={OW.orange} fillOpacity={d.lowConfidence ? 0.4 : 1} />)}
            <LabelList dataKey="avgPerGame" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const r = data[p.index ?? -1]
              if (!r || p.x == null || p.y == null || p.width == null || p.height == null) return null
              const pm = r.perMinute == null ? '' : ` · ${r.perMinute}/min`
              return <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central" fill="#e6edf3" fontSize={11} fontFamily="inherit">{`${fmtVal(r.avgPerGame)}${unit}${pm}`}</text>
            }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function RoleSpecific({ rows, role }: { rows: CombatRow[]; role: Role }) {
  const fb = useMemo(() => finalBlowRate(rows), [rows])
  const fbRate = useMemo(() => rateStat(rows, r => r.final_blows), [rows])
  const fbByHero = useMemo(() => finalBlowRatesByHero(rows), [rows])
  const solo = useMemo(() => rateStat(rows, r => r.solo_kills), [rows])
  const objTime = useMemo(() => rateStat(rows, r => r.obj_contest_time, true), [rows])
  const saved = useMemo(() => rateStat(rows, r => r.players_saved), [rows])
  const objByHero = useMemo(() => ratesByHero(rows, r => r.obj_contest_time, true), [rows])
  const savedByHero = useMemo(() => ratesByHero(rows, r => r.players_saved), [rows])

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
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)
  const [factRows, setFactRows] = useState<CombatRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sixRoles, setSixRoles] = useState<Set<Role>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    supabase.from('combat_facts').select(COLS).then(res => {
      if (cancelled) return
      const data = ((res.data as unknown) as CombatRow[] | null) || []
      setFactRows(keepVisible(data))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const role = roleFromQueue(filters.queue)
  const is6v6 = filters.queue === '6v6'
  const modeActive = filters.mode !== 'all'
  const mapActive = filters.map !== ''
  const heroActive = filters.hero !== ''

  // Apply shared Queue/Mode/Map/Hero filters.
  const rows = useMemo(() => {
    return factRows.filter(r => {
      if (!matchesFilters(r, filters)) return false
      if (filters.hero !== '' && r.hero_name !== filters.hero) return false
      return true
    })
  }, [factRows, filters])

  const deduped = useMemo(() => dedupeMatches(rows), [rows])
  const overall = useMemo(() => overallWinRate(deduped), [deduped])
  const roleSummary = useMemo(() => perRoleSummary(deduped), [deduped])
  const sixSummary = useMemo(() => sixVsSixSummary(deduped), [deduped])

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

      <AnalyticsFilters value={filters} onChange={setFilters} show={{ queue: true, mode: true, map: true, hero: true }} />

      {loading ? (
        <div className="bg-ow-panel rounded-xl border border-white/10 p-10 text-center text-slate-400 font-display tracking-wider">LOADING…</div>
      ) : (
        <>
          <p className="text-sm text-slate-400">
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
              <p className="text-[11px] text-slate-500 mt-3">Each role uses its own stat (tanks mitigate, supports heal, DPS deal damage) — not comparable as one number.</p>
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
                  <span className="text-[11px] text-slate-400 font-display tracking-wider uppercase">Filter by role(s) played in 6v6</span>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {(['tank', 'dps', 'support'] as Role[]).map(r => {
                      const on = sixRoles.has(r)
                      return (
                        <button key={r} onClick={() => toggleSixRole(r)}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-display tracking-wider uppercase border transition-colors ${on ? 'border-ow-orange/60 text-ow-orange bg-ow-orange/10' : 'border-white/15 text-slate-400'}`}>
                          {r}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-2">Pick any combination. Selecting role(s) shows the full breakdown below for games you played that role.</p>
                </div>
              </Panel>

              {/* When roles are selected, show the full breakdown per selected role. */}
              {sixRoles.size > 0 && Array.from(sixRoles).map(r => (
                <div key={r} className="space-y-6">
                  <h3 className="font-display tracking-[0.12em] text-slate-300 uppercase text-xs">6v6 · {r}</h3>
                  <RoleBreakdown rows={filterBySixRoles(sixScopedRows, new Set([r]), HERO_ROLE) as CombatRow[]} role={r} modeActive={modeActive} mapActive={mapActive} heroActive={heroActive} />
                </div>
              ))}
            </>
          )}

          {/* 5v5 single role: the full breakdown. */}
          {role != null && (
            <RoleBreakdown rows={rows} role={role} modeActive={modeActive} mapActive={mapActive} heroActive={heroActive} />
          )}

          <p className="text-xs text-slate-500">
            Team share is your slice of your team&apos;s total for your role&apos;s stat (DPS damage, support healing, tank mitigation).
            Games without full team capture show no share and are excluded — the coverage notes say how many. Per-minute / per-30s rates
            use your time on the hero; games missing that time drop from those rates only. Sparse bars (under {MIN_GAMES} games) are dimmed.
          </p>
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
