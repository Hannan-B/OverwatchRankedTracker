'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, LabelList, LineChart, Line, Legend,
} from 'recharts'
import { supabase } from '@/lib/supabase'
import { matchQuery } from '@/lib/alpha'
import { loadLeaverPref, showLeaverGames } from '@/lib/leaver'
import { defaultSeasonSelection } from '@/lib/season-util'
import AnalyticsFilters, {
  DEFAULT_FILTERS,
  matchesFilters,
  type AnalyticsFilterState,
  type FilterableMatch,
} from '@/components/AnalyticsFilters'
import { AnalyticsNav, AnalyticsHeader } from '@/components/AnalyticsNav'
import { useChartColors } from '@/components/useChartColors'
import { type ChartColors } from '@/lib/chart-theme'
import {
  SESSION_GAP_MINUTES,
  streaks, sessionOverview, overallWinRate,
  winRateByTimeBlock, winRateByGameLength,
  winRateByPositionInSession, winRateByTimeIntoSession,
  decayByHoursPlayed, decayByGamesDeep,
  winRateByWeekPerSeason, avgSessionPerMonth,
  heatmapDayByTimeOfDay, heatmapWeekByDay, heatmapSessionShape,
  formatDuration,
  type TimeMatch, type CatRow, type SeasonRow, type Heatmap, type HeatCell,
} from './time-lib'

// ============================================================
// TIME (/analytics/time) — when you play and how it holds up.
// ------------------------------------------------------------
// All match-grain, read straight off `matches`, sorted CHRONOLOGICALLY so the
// order-dependent pieces (streaks, sessions, decay) are correct. Seasons are
// read from the `seasons` table for the week chart's per-season grouping.
//
//   • Win/loss streaks                 → headline stat cards
//   • Session overview                 → headline stats (durations as h:mm / mm)
//   • Avg session per month            → grouped bars (minutes + games)
//   • Win rate by week, per season     → small-multiples + season-banded timeline
//   • Win rate by time of day          → ordered bars
//   • Win rate by game length          → ordered bars
//   • Within-session decay             → by game position AND time into session
//   • Decay point                      → by hours played AND games deep (flagged)
//   • Heatmaps (×3)                     → day×time-of-day, week×day, session shape
//
// Conventions (shared with Outcomes/Feel):
//   • Win rate = wins / (wins + losses); DRAWS EXCLUDED from %, counted in N.
//   • Ordered scales keep their natural order (NOT sorted by win rate).
//   • All charts always render; sparse buckets/cells DIMMED, never hidden.
//   • Day-of-week WR (1-D) lives on OUTCOMES; here it only appears as a heatmap
//     axis crossed with time-of-day, which is a different question.
//
// SESSION = a 45+ min gap starts a new one (time-lib SESSION_GAP_MINUTES).
// SEASON  = matches grouped by season_id; when the `seasons` table is empty
//           every match is season_id=null and groups under one "All time" panel.
// ============================================================

interface TimeMatchRow extends FilterableMatch, TimeMatch { season_id: number | null }

const MATCH_COLS = 'id, result, role_played, match_format, game_mode, map, played_at, game_length_seconds, season_id, team_leaver, enemy_leaver'
const HERO_COLS = 'match_id, hero_name'
const SEASON_COLS = 'id, name, start_date, end_date'

// Win-rate colour for a bar (green strong, amber mid, red weak; grey when null).
function wrColor(wr: number | null, c: ChartColors): string {
  if (wr === null) return c.draw
  return wr >= 55 ? c.victory : wr <= 45 ? c.defeat : c.primary
}

// Heatmap cell background: green/amber/red by win rate (faint when no data).
function heatColor(cell: HeatCell, c: ChartColors): string {
  if (cell.winRate === null) return 'rgba(127,127,127,0.10)'
  return cell.winRate >= 55 ? c.victory : cell.winRate <= 45 ? c.defeat : c.primary
}

// Distinct hues for season bands / lines (cycled if more than this many).
const seasonHues = (c: ChartColors) => c.categorical

const axisTickOf = (c: ChartColors) => ({ fill: c.axisLabel, fontSize: 11 })
const tooltipStyleOf = (c: ChartColors) => ({
  contentStyle: { background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, borderRadius: 8, fontSize: 12 },
  labelStyle: { color: c.tooltipText },
})

// Horizontal win-rate bars (ordered, not sorted). `flagDecay` tints belowAverage
// buckets red regardless of their own WR — the decay-point band.
function WinRateBars({ data, label, flagDecay = false }: { data: CatRow[]; label: string; flagDecay?: boolean }) {
  const cc = useChartColors()
  if (data.length === 0) return <Empty label={label} />
  const height = Math.max(160, data.length * 34 + 40)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 96, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={cc.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTickOf(cc)} stroke={cc.axis} unit="%" />
          <YAxis type="category" dataKey="key" tick={axisTickOf(cc)} stroke={cc.axis} width={130} />
          <Tooltip
            {...tooltipStyleOf(cc)}
            formatter={(_v, _n, p) => {
              const row = (p as { payload?: CatRow } | undefined)?.payload
              const wr = row?.winRate
              const tag = flagDecay && row?.belowAverage ? ' · below your average' : ''
              return [`${wr == null ? '—' : wr + '%'} · ${row?.games ?? 0} games${tag}`, 'Win rate']
            }} />
          <Bar dataKey={(d: CatRow) => d.winRate ?? 0} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={flagDecay && d.belowAverage ? cc.defeat : wrColor(d.winRate, cc)} fillOpacity={d.lowConfidence ? 0.4 : 1} />
            ))}
            <LabelList dataKey="winRate" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const row = data[p.index ?? -1]
              if (!row || p.x == null || p.y == null || p.width == null || p.height == null) return null
              const mark = flagDecay && row.belowAverage ? ' ↓' : ''
              const txt = `${row.winRate == null ? '—' : row.winRate + '%'}  n=${row.games}${mark}`
              return (
                <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central" fill={cc.axisLabel} fontSize={11} fontFamily="inherit">{txt}</text>
              )
            }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <div className="h-[160px] flex items-center justify-center text-center">
      <p className="text-sm text-ow-faint">No data for {label} with these filters yet.</p>
    </div>
  )
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

function Stat({ value, label, tone = 'default' }: { value: string; label: string; tone?: 'default' | 'win' | 'loss' }) {
  const color = tone === 'win' ? 'text-ow-victory' : tone === 'loss' ? 'text-ow-defeat' : 'text-ow-fg'
  return (
    <div className="bg-ow-panel rounded-xl border border-ow-line p-4 flex flex-col gap-1">
      <span className={`font-display text-3xl tracking-wider ${color}`}>{value}</span>
      <span className="text-[11px] text-ow-muted font-display tracking-wider uppercase">{label}</span>
    </div>
  )
}

// ---- Heatmap grid (HTML/CSS — recharts has no native heatmap).
// Colour = win rate; the game count n is printed in-cell; sparse cells dimmed.
function HeatGrid({ map, label }: { map: Heatmap; label: string }) {
  const cc = useChartColors()
  if (map.rowLabels.length === 0 || map.colLabels.length === 0) return <Empty label={label} />
  const cellAt = (r: string, c: string) => map.cells.find(x => x.rowKey === r && x.colKey === c)
  return (
    <div className="overflow-x-auto">
      <table className="border-separate" style={{ borderSpacing: 3 }}>
        <thead>
          <tr>
            <th className="w-20" />
            {map.colLabels.map(c => (
              <th key={c} className="text-[10px] text-ow-muted font-display tracking-wider uppercase px-1 pb-1 align-bottom" style={{ minWidth: 54 }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {map.rowLabels.map(r => (
            <tr key={r}>
              <td className="text-[10px] text-ow-muted font-display tracking-wider uppercase pr-2 text-right whitespace-nowrap">{r}</td>
              {map.colLabels.map(c => {
                const cl = cellAt(r, c)
                const empty = !cl || cl.games === 0
                const op = empty ? 1 : cl!.lowConfidence ? 0.4 : 1
                return (
                  <td key={c} className="rounded-md text-center align-middle"
                    style={{ background: empty ? 'rgba(255,255,255,0.03)' : heatColor(cl!, cc), opacity: op, height: 40, minWidth: 54 }}
                    title={cl ? `${r} · ${c}: ${cl.winRate == null ? '—' : cl.winRate + '%'} · ${cl.games} games` : ''}>
                    {empty ? (
                      <span className="text-[10px] text-ow-faint">·</span>
                    ) : (
                      <div className="leading-tight">
                        <div className="text-[11px] font-display text-[#0b0e13]">{cl!.winRate == null ? '—' : `${cl!.winRate}%`}</div>
                        <div className="text-[9px] text-[#0b0e13]/70">n={cl!.games}</div>
                      </div>
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

export default function TimePage() {
  const cc = useChartColors()
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)
  const [matches, setMatches] = useState<TimeMatchRow[]>([])
  const [heroRows, setHeroRows] = useState<{ match_id: number; hero_name: string }[]>([])
  const [seasons, setSeasons] = useState<SeasonRow[]>([])
  const [hiddenSeasons, setHiddenSeasons] = useState<Set<number | null>>(new Set())
  const [loading, setLoading] = useState(true)
  // Re-runs the filter memo once the leaver preference has loaded (cache starts
  // at "hide"); Time is a performance surface, so leaver games are excluded.
  const [leaverReady, setLeaverReady] = useState(false)
  // Seed the current-season default only once.
  const seasonDefaulted = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadLeaverPref().then(() => { if (!cancelled) setLeaverReady(true) })
    Promise.all([
      matchQuery(MATCH_COLS).order('played_at', { ascending: true }),
      supabase.from('hero_match_facts').select(HERO_COLS),
      supabase.from('seasons').select(SEASON_COLS).order('start_date', { ascending: true }),
    ]).then(([mRes, hRes, sRes]) => {
      if (cancelled) return
      setMatches((((mRes as unknown) as { data: TimeMatchRow[] | null }).data) || [])
      setHeroRows((((hRes as unknown) as { data: { match_id: number; hero_name: string }[] | null }).data) || [])
      const seasonRows = (((sRes as unknown) as { data: SeasonRow[] | null }).data) || []
      setSeasons(seasonRows)
      if (!seasonDefaulted.current) {
        seasonDefaulted.current = true
        setFilters(f => ({ ...f, seasons: defaultSeasonSelection(seasonRows) }))
      }
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
    const excludeLeavers = !showLeaverGames()
    const base = matches.filter(m => matchesFilters(m, filters, { excludeLeavers }))
    if (filters.hero === '') return base
    const ids = matchIdsByHero.get(filters.hero)
    if (!ids) return []
    return base.filter(m => ids.has(m.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, filters, matchIdsByHero, leaverReady])

  // season id → name. With no seasons, the only group is null → "All time".
  // Once seasons exist, an unassigned (null) match is "Unassigned".
  const seasonName = useMemo(() => {
    const byId = new Map(seasons.map(s => [s.id, s.name]))
    const noSeasons = seasons.length === 0
    return (id: number | null) =>
      id == null ? (noSeasons ? 'All time' : 'Unassigned') : (byId.get(id) ?? `Season ${id}`)
  }, [seasons])

  const streakSummary = useMemo(() => streaks(rows), [rows])
  const overview = useMemo(() => sessionOverview(rows), [rows])
  const overall = useMemo(() => overallWinRate(rows), [rows])
  const byTimeBlock = useMemo(() => winRateByTimeBlock(rows, filters.minGames), [rows, filters.minGames])
  const byLength = useMemo(() => winRateByGameLength(rows, filters.minGames), [rows, filters.minGames])
  const byPosition = useMemo(() => winRateByPositionInSession(rows, filters.minGames), [rows, filters.minGames])
  const byElapsed = useMemo(() => winRateByTimeIntoSession(rows, filters.minGames), [rows, filters.minGames])
  const decayHours = useMemo(() => decayByHoursPlayed(rows), [rows])
  const decayDeep = useMemo(() => decayByGamesDeep(rows, filters.minGames), [rows, filters.minGames])
  const monthSessions = useMemo(() => avgSessionPerMonth(rows, filters.minGames), [rows, filters.minGames])
  const weekGroups = useMemo(() => winRateByWeekPerSeason(rows, seasonName, filters.minGames), [rows, seasonName, filters.minGames])

  const heatDayTime = useMemo(() => heatmapDayByTimeOfDay(rows, filters.minGames), [rows, filters.minGames])
  const heatWeekDay = useMemo(() => heatmapWeekByDay(rows, filters.minGames), [rows, filters.minGames])
  const heatSession = useMemo(() => heatmapSessionShape(rows, filters.minGames), [rows, filters.minGames])

  const totalGames = rows.length
  const currentStreakText =
    streakSummary.currentKind === 'none' ? '—'
      : `${Math.abs(streakSummary.current)} ${streakSummary.currentKind === 'win' ? 'W' : 'L'}`

  const visibleGroups = weekGroups.filter(g => !hiddenSeasons.has(g.seasonId))
  const showSeasonToggles = weekGroups.length > 1

  function toggleSeason(id: number | null) {
    setHiddenSeasons(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Time" subtitle="Streaks, sessions, week trends, time of day, game length, and where your win rate decays." />
      <AnalyticsNav />

      <AnalyticsFilters value={filters} onChange={setFilters} show={{ queue: true, mode: true, map: true, hero: true, season: true, minGames: true }} seasonOptions={seasons.map(s => ({ id: s.id, name: s.name }))} />

      {loading ? (
        <div className="bg-ow-panel rounded-xl border border-ow-line p-10 text-center text-ow-muted font-display tracking-wider">LOADING…</div>
      ) : (
        <>
          <p className="text-sm text-ow-muted">
            {totalGames} game{totalGames === 1 ? '' : 's'} in view · overall win rate {overall == null ? '—' : overall + '%'} ·
            a {SESSION_GAP_MINUTES}-min gap starts a new session · win rate excludes draws · sparse buckets dimmed
          </p>

          {/* Streaks */}
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <Stat value={String(streakSummary.longestWin)} label="Longest win streak" tone="win" />
            <Stat value={String(streakSummary.longestLoss)} label="Longest loss streak" tone="loss" />
            <Stat value={currentStreakText} label="Current streak" tone={streakSummary.currentKind === 'win' ? 'win' : streakSummary.currentKind === 'loss' ? 'loss' : 'default'} />
            <Stat value={String(streakSummary.decided)} label="Decided games (W+L)" />
          </div>

          {/* Session overview — durations formatted h:mm / mm */}
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <Stat value={String(overview.sessionCount)} label="Sessions" />
            <Stat value={overview.avgGamesPerSession == null ? '—' : String(overview.avgGamesPerSession)} label="Avg games / session" />
            <Stat value={formatDuration(overview.avgSessionMinutes)} label="Avg session length" />
            <Stat value={String(overview.longestSessionGames)} label="Longest session (games)" />
          </div>

          {/* Win rate by week, per season */}
          <Panel title="Win rate by week" hint={showSeasonToggles ? 'per season · toggle below' : 'by ISO week'}>
            {weekGroups.length === 0 ? <Empty label="weekly win rate" /> : (
              <div className="space-y-5">
                {showSeasonToggles && (
                  <div className="flex flex-wrap gap-2">
                    {weekGroups.map((g, i) => {
                      const hidden = hiddenSeasons.has(g.seasonId)
                      const hue = seasonHues(cc)[i % seasonHues(cc).length]
                      return (
                        <button key={String(g.seasonId)} onClick={() => toggleSeason(g.seasonId)}
                          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-display tracking-wider uppercase border transition-colors ${hidden ? 'border-ow-line text-ow-faint' : 'border-ow-line text-ow-fg'}`}>
                          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: hidden ? 'transparent' : hue, border: `1px solid ${hue}` }} />
                          {g.seasonName}
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* Small-multiples: one mini week-chart per visible season */}
                <div className="grid gap-4 lg:grid-cols-2">
                  {visibleGroups.map((g) => {
                    const hue = seasonHues(cc)[weekGroups.indexOf(g) % seasonHues(cc).length]
                    return (
                      <div key={String(g.seasonId)} className="rounded-lg border border-ow-line p-3">
                        <div className="flex items-baseline justify-between mb-2">
                          <span className="text-xs font-display tracking-wider uppercase text-ow-fg">{g.seasonName}</span>
                          <span className="text-[11px] text-ow-faint">{g.totalGames} games</span>
                        </div>
                        <div style={{ height: 200 }}>
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={g.weeks} margin={{ top: 6, right: 12, bottom: 4, left: -16 }}>
                              <CartesianGrid stroke={cc.grid} />
                              <XAxis dataKey="label" tick={axisTickOf(cc)} stroke={cc.axis} />
                              <YAxis domain={[0, 100]} tick={axisTickOf(cc)} stroke={cc.axis} unit="%" />
                              <Tooltip {...tooltipStyleOf(cc)}
                                formatter={(_v, _n, p) => {
                                  const row = (p as { payload?: typeof g.weeks[number] } | undefined)?.payload
                                  return [`${row?.winRate == null ? '—' : row.winRate + '%'} · ${row?.games ?? 0} games`, 'Win rate']
                                }} />
                              <Line type="monotone" dataKey={(d: typeof g.weeks[number]) => d.winRate ?? null} stroke={hue}
                                strokeWidth={2} dot={{ r: 3, fill: hue }} connectNulls isAnimationActive={false} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Continuous overlay (shows its value with 2+ seasons) */}
                {showSeasonToggles && (
                  <div className="rounded-lg border border-ow-line p-3">
                    <div className="text-xs font-display tracking-wider uppercase text-ow-fg mb-2">All seasons — overlaid by week number</div>
                    <div style={{ height: 240 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart margin={{ top: 6, right: 12, bottom: 4, left: -16 }}>
                          <CartesianGrid stroke={cc.grid} />
                          <XAxis dataKey="label" type="category" allowDuplicatedCategory={false} tick={axisTickOf(cc)} stroke={cc.axis} />
                          <YAxis domain={[0, 100]} tick={axisTickOf(cc)} stroke={cc.axis} unit="%" />
                          <Tooltip {...tooltipStyleOf(cc)} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          {visibleGroups.map((g) => {
                            const hue = seasonHues(cc)[weekGroups.indexOf(g) % seasonHues(cc).length]
                            return (
                              <Line key={String(g.seasonId)} data={g.weeks} name={g.seasonName} type="monotone"
                                dataKey={(d: typeof g.weeks[number]) => d.winRate ?? null} stroke={hue}
                                strokeWidth={2} dot={{ r: 2, fill: hue }} connectNulls isAnimationActive={false} />
                            )
                          })}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="text-[11px] text-ow-faint mt-1">Each line is a season, plotted by week number so seasons overlay for comparison.</p>
                  </div>
                )}
              </div>
            )}
          </Panel>

          {/* Avg session per month */}
          <Panel title="Average session per month" hint="duration & games per session">
            {monthSessions.length === 0 ? <Empty label="monthly sessions" /> : (
              <div style={{ height: Math.max(220, monthSessions.length * 30 + 60) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthSessions} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                    <CartesianGrid stroke={cc.grid} vertical={false} />
                    <XAxis dataKey="label" tick={axisTickOf(cc)} stroke={cc.axis} />
                    <YAxis yAxisId="min" tick={axisTickOf(cc)} stroke={cc.axis} unit="m" />
                    <YAxis yAxisId="games" orientation="right" tick={axisTickOf(cc)} stroke={cc.axis} />
                    <Tooltip {...tooltipStyleOf(cc)}
                      formatter={(v, n) => {
                        if (n === 'Avg minutes') return [formatDuration(Number(v)), 'Avg session length']
                        return [`${v}`, 'Avg games / session']
                      }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="min" dataKey={(d: typeof monthSessions[number]) => d.avgMinutes ?? 0} name="Avg minutes" fill={cc.primary} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    <Bar yAxisId="games" dataKey={(d: typeof monthSessions[number]) => d.avgGames ?? 0} name="Avg games" fill={cc.categorical[3]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Panel title="Win rate by time of day" hint="your local time"><WinRateBars data={byTimeBlock} label="time of day" /></Panel>
            <Panel title="Win rate by game length" hint="short → long"><WinRateBars data={byLength} label="game length" /></Panel>
          </div>

          {/* Within-session decay */}
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Panel title="Win rate by game position in session" hint="1st game → later games"><WinRateBars data={byPosition} label="position in session" /></Panel>
            <Panel title="Win rate by time into session" hint="elapsed since session start"><WinRateBars data={byElapsed} label="time into session" /></Panel>
          </div>

          {/* Decay point */}
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Panel title="Decay point — by hours played" hint="red = first bucket below your average"><WinRateBars data={decayHours} label="hours played" flagDecay /></Panel>
            <Panel title="Decay point — by games deep" hint="red = first bucket below your average"><WinRateBars data={decayDeep} label="games deep" flagDecay /></Panel>
          </div>

          {/* Heatmaps */}
          <Panel title="When you win — day × time of day" hint="colour = win rate · n = games · sparse cells dimmed">
            <HeatGrid map={heatDayTime} label="day × time of day" />
          </Panel>

          <Panel title="Calendar — week × day" hint="colour = win rate · n = games">
            <HeatGrid map={heatWeekDay} label="week × day" />
          </Panel>

          <Panel title="Session shape — length × games in session" hint="colour = win rate · n = games">
            <HeatGrid map={heatSession} label="session shape" />
          </Panel>

          <p className="text-xs text-ow-faint">
            The decay point is the first stretch where your win rate drops below your overall average ({overall == null ? '—' : overall + '%'}),
            counting only buckets with at least {filters.minGames} games. Heatmap cells with under {filters.minGames} games are dimmed as a low-confidence cue.
            {seasons.length === 0 && ' Season grouping activates once you add seasons and matches carry a season — for now everything is grouped under “All time”.'}
          </p>
        </>
      )}
    </div>
  )
}
