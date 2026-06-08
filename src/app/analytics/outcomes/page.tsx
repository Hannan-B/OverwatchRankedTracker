'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, PieChart, Pie, Legend, LabelList,
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

// ============================================================
// OUTCOMES (/analytics/outcomes) — the densest curated page.
// ------------------------------------------------------------
// All match-grain, read straight off `matches`:
//   • Win rate by mode / map / role  → sorted horizontal bars (best→worst)
//   • 5v5 vs 6v6                      → side-by-side bars
//   • Result mix (victory/defeat/draw)→ donut
//   • Attack vs defense, per map      → grouped bars
//
// Conventions (shared with the rest of the app):
//   • Win rate = wins / (wins + losses); DRAWS EXCLUDED from the percentage,
//     but counted in sample size and shown as their own slice in the result mix.
//   • All charts always render (built for the full-data future); bars under 5
//     games are DIMMED as a low-confidence signal, never hidden.
//   • Shared Queue/Mode/Map filters narrow the feed; charts stay visible.
//     Queue carries the 5v5/6v6 split, so format is filtered there.
// ============================================================

const OW = {
  orange: '#f99e1a', accent: '#ffcb6b', victory: '#3fb950', defeat: '#f85149',
  draw: '#8b949e', grid: 'rgba(255,255,255,0.08)', axis: 'rgba(255,255,255,0.45)',
}
const MIN_GAMES = 5

interface OutcomeMatch extends FilterableMatch {
  id: number
  result: 'victory' | 'defeat' | 'draw' | null
  starting_side: 'attack' | 'defense' | null
  played_at: string | null
}

const MATCH_COLS = 'id, result, role_played, match_format, game_mode, map, starting_side, played_at'
// Hero-grain rows, only to resolve "which matches did I play hero X in" for the
// Hero filter (matches has no hero column). Alpha excluded via match_id.
const HERO_COLS = 'match_id, hero_name'

// ---- win-rate helpers ----
interface Tally { wins: number; losses: number; draws: number }
function emptyTally(): Tally { return { wins: 0, losses: 0, draws: 0 } }
function add(t: Tally, r: string | null) {
  if (r === 'victory') t.wins++
  else if (r === 'defeat') t.losses++
  else if (r === 'draw') t.draws++
}
function winRate(t: Tally): number | null {
  const decisive = t.wins + t.losses
  return decisive > 0 ? Math.round((t.wins / decisive) * 1000) / 10 : null
}
function games(t: Tally): number { return t.wins + t.losses + t.draws }

// Win-rate colour for a bar (green strong, amber mid, red weak; grey when null).
function wrColor(wr: number | null): string {
  if (wr === null) return OW.draw
  return wr >= 55 ? OW.victory : wr <= 45 ? OW.defeat : OW.accent
}

// Generic "win rate by category" aggregation → sorted rows.
interface CatRow { key: string; winRate: number | null; games: number; lowConfidence: boolean }
function byCategory(rows: OutcomeMatch[], keyOf: (m: OutcomeMatch) => string | null): CatRow[] {
  const m = new Map<string, Tally>()
  for (const r of rows) {
    const k = keyOf(r)
    if (k == null || k === '') continue
    if (!m.has(k)) m.set(k, emptyTally())
    add(m.get(k)!, r.result)
  }
  return Array.from(m.entries())
    .map(([key, t]) => ({ key, winRate: winRate(t), games: games(t), lowConfidence: games(t) < MIN_GAMES }))
    .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1) || b.games - a.games)
}

const axisTick = { fill: OW.axis, fontSize: 11 }
const tooltipStyle = {
  contentStyle: { background: '#0f1419', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#e6edf3' },
}

// Horizontal sorted win-rate bar chart.
function WinRateBars({ data, label }: { data: CatRow[]; label: string }) {
  if (data.length === 0) return <Empty label={label} />
  const height = Math.max(160, data.length * 34 + 40)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 80, bottom: 4, left: 8 }}>
          <CartesianGrid stroke={OW.grid} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={axisTick} stroke={OW.axis} unit="%" />
          <YAxis type="category" dataKey="key" tick={axisTick} stroke={OW.axis} width={110} />
          <Tooltip
            {...tooltipStyle}
            formatter={(_v, _n, p) => {
              const row = (p as { payload?: CatRow } | undefined)?.payload
              const wr = row?.winRate
              return [`${wr == null ? '—' : wr + '%'} · ${row?.games ?? 0} games`, 'Win rate']
            }} />
          <Bar dataKey={(d: CatRow) => d.winRate ?? 0} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={wrColor(d.winRate)} fillOpacity={d.lowConfidence ? 0.4 : 1} />
            ))}
            <LabelList dataKey="winRate" position="right" content={(props: unknown) => {
              const p = props as { x?: number; y?: number; width?: number; height?: number; index?: number }
              const row = data[p.index ?? -1]
              if (!row || p.x == null || p.y == null || p.width == null || p.height == null) return null
              const txt = `${row.winRate == null ? '—' : row.winRate + '%'}  n=${row.games}`
              return (
                <text x={p.x + p.width + 6} y={p.y + p.height / 2} dominantBaseline="central"
                  fill="#e6edf3" fontSize={11} fontFamily="inherit">
                  {txt}
                </text>
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
      <p className="text-sm text-slate-500">No data for {label} with these filters yet.</p>
    </div>
  )
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

export default function OutcomesPage() {
  const [filters, setFilters] = useState<AnalyticsFilterState>(DEFAULT_FILTERS)
  const [matches, setMatches] = useState<OutcomeMatch[]>([])
  const [heroRows, setHeroRows] = useState<{ match_id: number; hero_name: string }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      matchQuery(MATCH_COLS).order('played_at', { ascending: false }),
      supabase.from('hero_match_facts').select(HERO_COLS),
    ]).then(([mRes, hRes]) => {
      if (cancelled) return
      setMatches((((mRes as unknown) as { data: OutcomeMatch[] | null }).data) || [])
      setHeroRows((((hRes as unknown) as { data: { match_id: number; hero_name: string }[] | null }).data) || [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // match_ids in which a given hero was played (any %), for the Hero filter.
  // Restricted to the loaded (alpha-excluded) matches via the id set below.
  const matchIdsByHero = useMemo(() => {
    const m = new Map<string, Set<number>>()
    for (const r of heroRows) {
      if (!m.has(r.hero_name)) m.set(r.hero_name, new Set())
      m.get(r.hero_name)!.add(r.match_id)
    }
    return m
  }, [heroRows])

  // Apply shared Queue/Mode/Map filters, then the Hero filter (a match counts if
  // the selected hero was played in it at all — the honest reading for outcomes).
  const rows = useMemo(() => {
    const base = matches.filter(m => matchesFilters(m, filters))
    if (filters.hero === '') return base
    const ids = matchIdsByHero.get(filters.hero)
    if (!ids) return []
    return base.filter(m => ids.has(m.id))
  }, [matches, filters, matchIdsByHero])

  // Queue narrowed to a specific format → the 5v5/6v6 chart is redundant.
  const queueIsFormatSpecific = filters.queue !== 'all'

  const byMode = useMemo(() => byCategory(rows, m => m.game_mode), [rows])
  const byMap = useMemo(() => byCategory(rows, m => m.map), [rows])
  const byRole = useMemo(() => byCategory(rows.filter(m => m.match_format === '5v5'), m => m.role_played), [rows])

  // 5v5 vs 6v6 — two-way split (ignores the Queue format filter so it always
  // shows both; Mode/Map still apply).
  const formatSplit = useMemo(() => {
    const f5 = emptyTally(); const f6 = emptyTally()
    for (const r of rows) {
      if (r.match_format === '5v5') add(f5, r.result)
      else if (r.match_format === '6v6') add(f6, r.result)
    }
    return [
      { key: '5v5', winRate: winRate(f5), games: games(f5), lowConfidence: games(f5) < MIN_GAMES },
      { key: '6v6', winRate: winRate(f6), games: games(f6), lowConfidence: games(f6) < MIN_GAMES },
    ] as CatRow[]
  }, [rows])

  // Result mix — counts of victory / defeat / draw.
  const resultMix = useMemo(() => {
    const t = emptyTally()
    for (const r of rows) add(t, r.result)
    return [
      { name: 'Victory', value: t.wins, color: OW.victory },
      { name: 'Defeat', value: t.losses, color: OW.defeat },
      { name: 'Draw', value: t.draws, color: OW.draw },
    ].filter(d => d.value > 0)
  }, [rows])

  // Attack vs defense, per map (grouped bars). Only maps where a side was
  // recorded contribute; modes without sides naturally drop out.
  const sideByMap = useMemo(() => {
    const m = new Map<string, { attack: Tally; defense: Tally }>()
    for (const r of rows) {
      if (r.map == null || (r.starting_side !== 'attack' && r.starting_side !== 'defense')) continue
      if (!m.has(r.map)) m.set(r.map, { attack: emptyTally(), defense: emptyTally() })
      add(m.get(r.map)![r.starting_side], r.result)
    }
    return Array.from(m.entries())
      .map(([map, t]) => ({
        map,
        attack: winRate(t.attack), defense: winRate(t.defense),
        attackGames: games(t.attack), defenseGames: games(t.defense),
      }))
      .sort((a, b) => a.map.localeCompare(b.map))
  }, [rows])

  // Win rate by day of week (Mon→Sun, calendar order). Day derived from
  // played_at in the viewer's local timezone. Days with no games still listed.
  const byDayOfWeek = useMemo(() => {
    const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    const tallies: Tally[] = DOW.map(() => emptyTally())
    for (const r of rows) {
      if (!r.played_at) continue
      const d = new Date(r.played_at)
      if (Number.isNaN(d.getTime())) continue
      // JS getDay(): 0=Sun..6=Sat → map to Mon=0..Sun=6
      const idx = (d.getDay() + 6) % 7
      add(tallies[idx], r.result)
    }
    return DOW.map((day, i) => ({
      key: day, winRate: winRate(tallies[i]), games: games(tallies[i]),
      lowConfidence: games(tallies[i]) < MIN_GAMES,
    })) as CatRow[]
  }, [rows])

  const totalGames = rows.length

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title="Outcomes"
        subtitle="Win rate by mode, map, role; 5v5 vs 6v6; result mix; attack vs defense."
      />
      <AnalyticsNav />

      <AnalyticsFilters value={filters} onChange={setFilters} show={{ queue: true, mode: true, map: true, hero: true }} />

      {loading ? (
        <div className="bg-ow-panel rounded-xl border border-white/10 p-10 text-center text-slate-400 font-display tracking-wider">
          LOADING…
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-400">{totalGames} game{totalGames === 1 ? '' : 's'} in view · win rate excludes draws · bars under {MIN_GAMES} games dimmed</p>

          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Panel title="Win rate by game mode" hint="best → worst">
              <WinRateBars data={byMode} label="game mode" />
            </Panel>

            <Panel title="Win rate by role" hint="5v5 roles">
              <WinRateBars data={byRole} label="role" />
            </Panel>

            {!queueIsFormatSpecific && (
              <Panel title="5v5 vs 6v6" hint="format split">
                <WinRateBars data={formatSplit} label="format" />
              </Panel>
            )}

            <Panel title="Result mix" hint="victory / defeat / draw">
              {resultMix.length === 0 ? <Empty label="results" /> : (
                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={resultMix} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95}
                        paddingAngle={2} isAnimationActive={false}>
                        {resultMix.map((d, i) => <Cell key={i} fill={d.color} />)}
                      </Pie>
                      <Tooltip {...tooltipStyle} formatter={(v, n) => [`${v} games`, String(n)]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Panel>
          </div>

          <Panel title="Win rate by map" hint="best → worst">
            <WinRateBars data={byMap} label="map" />
          </Panel>

          <Panel title="Attack vs defense, per map" hint="win rate by starting side">
            {sideByMap.length === 0 ? <Empty label="attack/defense" /> : (
              <div style={{ height: Math.max(180, sideByMap.length * 40 + 40) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={sideByMap} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 8 }}>
                    <CartesianGrid stroke={OW.grid} horizontal={false} />
                    <XAxis type="number" domain={[0, 100]} tick={axisTick} stroke={OW.axis} unit="%" />
                    <YAxis type="category" dataKey="map" tick={axisTick} stroke={OW.axis} width={110} />
                    <Tooltip
                      {...tooltipStyle}
                      formatter={(v, n, p) => {
                        const row = (p as { payload?: { attackGames: number; defenseGames: number } } | undefined)?.payload
                        const side = String(n)
                        const g = side === 'Attack' ? row?.attackGames : row?.defenseGames
                        return [`${v == null ? '—' : v + '%'} · ${g ?? 0} games`, side]
                      }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey={(d: { attack: number | null }) => d.attack ?? 0} name="Attack" fill={OW.orange} radius={[0, 4, 4, 0]} isAnimationActive={false} />
                    <Bar dataKey={(d: { defense: number | null }) => d.defense ?? 0} name="Defense" fill={OW.accent} radius={[0, 4, 4, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>

          <Panel title="Win rate by day of week" hint="Mon → Sun · your local time">
            <WinRateBars data={byDayOfWeek} label="day of week" />
          </Panel>
        </>
      )}
    </div>
  )
}
