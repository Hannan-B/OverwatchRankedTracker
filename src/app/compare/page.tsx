'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { HEROES, MAPS, GAME_MODE_CONFIG, type GameMode } from '@/data/reference'
import { formatStatValue, HERO_BREAKDOWN_ORDER, type BreakdownStat } from '@/data/stat-meta'

// ============================================================
// HERO COMPARISON (Phase 2)
// Two tabs:
//   "Compare Heroes"  — up to 4 DIFFERENT heroes, ONE shared filter bar.
//   "Hero Deep Dive"  — up to 4 slots, each its own hero + own filters
//                       (defaults to the same hero so you can split one hero
//                        across conditions, e.g. Mei/Control vs Mei/Escort).
//
// DATA: queries the verified view `hero_match_facts` (one row per hero-per-
// match, all dimensions + per-match math). Filters are pushed into the query
// (real generated SQL via the Supabase builder); the page averages the rows
// that come back. 5v5/6v6 never mix — format is always part of the filter.
//
// Percentage stats (dmg/heal/mit %) + E/A/D are only meaningful on single-hero
// (>=95% played) games, so they're averaged over is_single_hero rows only, and
// flagged when that sample is small.
// ============================================================

type Format = '5v5' | '6v6'
type Role = 'tank' | 'dps' | 'support'
const TINY_SAMPLE = 3 // single-hero games at/below this -> show a low-confidence warning
const MAX_SLOTS = 4

const HERO_ROLE = new Map<string, Role>(HEROES.map(h => [h.name, h.role]))
const HERO_NAMES = HEROES.map(h => h.name).sort()
const GAME_MODES = Object.keys(GAME_MODE_CONFIG) as GameMode[]
const mapsForMode = (mode: GameMode) =>
  MAPS.filter(m => m.mode === mode).map(m => m.name).sort()
const modeHasSide = (mode: GameMode | '') => mode !== '' && GAME_MODE_CONFIG[mode].needsStartingSide

// One row of the fact table (only the columns we use)
interface Fact {
  hero_name: string
  match_format: Format
  map: string | null
  game_mode: string | null
  starting_side: 'attack' | 'defense' | null
  result: 'victory' | 'defeat' | 'draw'
  percent_played: number | null
  is_single_hero: boolean
  game_length_seconds: number | null
  user_elims: number | null
  user_assists: number | null
  user_deaths: number | null
  damage_pct: number | null
  healing_pct: number | null
  mitigation_pct: number | null
  final_blows: number | null
  solo_kills: number | null
  obj_contest_time: number | null
  players_saved: number | null
}

interface Filters {
  format: Format
  mode: GameMode | ''
  map: string
  side: 'attack' | 'defense' | ''
}
const emptyFilters: Filters = { format: '5v5', mode: '', map: '', side: '' }

// ---- aggregation: turn a set of fact rows into the displayed stats ----
interface Computed {
  games: number
  wins: number
  losses: number
  draws: number
  winRate: number | null
  singleHeroGames: number
  // breakdown (over all >=1-min games)
  avgFinalBlows: number | null
  avgSoloKills: number | null
  avgObjContest: number | null
  avgPlayersSaved: number | null
  per10FinalBlows: number | null
  per10SoloKills: number | null
  // single-hero only
  avgElims: number | null
  avgAssists: number | null
  avgDeaths: number | null
  avgDamagePct: number | null
  avgHealingPct: number | null
  avgMitigationPct: number | null
}

function mean(vals: (number | null)[]): number | null {
  const nums = vals.filter((v): v is number => v != null)
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}
function per10Mean(rows: Fact[], pick: (f: Fact) => number | null): number | null {
  const vals = rows.map(r => {
    const v = pick(r)
    if (v == null || !r.game_length_seconds || r.game_length_seconds <= 0) return null
    return v / (r.game_length_seconds / 600)
  })
  return mean(vals)
}

function compute(rows: Fact[]): Computed {
  const sh = rows.filter(r => r.is_single_hero)
  const wins = rows.filter(r => r.result === 'victory').length
  const losses = rows.filter(r => r.result === 'defeat').length
  const draws = rows.filter(r => r.result === 'draw').length
  return {
    games: rows.length, wins, losses, draws,
    winRate: (wins + losses) === 0 ? null : Math.round((1000 * wins) / (wins + losses)) / 10,
    singleHeroGames: sh.length,
    avgFinalBlows: mean(rows.map(r => r.final_blows)),
    avgSoloKills: mean(rows.map(r => r.solo_kills)),
    avgObjContest: mean(rows.map(r => r.obj_contest_time)),
    avgPlayersSaved: mean(rows.map(r => r.players_saved)),
    per10FinalBlows: per10Mean(rows, r => r.final_blows),
    per10SoloKills: per10Mean(rows, r => r.solo_kills),
    avgElims: mean(sh.map(r => r.user_elims)),
    avgAssists: mean(sh.map(r => r.user_assists)),
    avgDeaths: mean(sh.map(r => r.user_deaths)),
    avgDamagePct: mean(sh.map(r => r.damage_pct)),
    avgHealingPct: mean(sh.map(r => r.healing_pct)),
    avgMitigationPct: mean(sh.map(r => r.mitigation_pct)),
  }
}

// ---- styling shared with the rest of the app ----
const selectCls =
  'bg-ow-dark border border-white/20 rounded-lg px-3 py-2 text-sm text-slate-100 ' +
  'font-display tracking-wider focus:border-ow-orange focus:outline-none transition-colors [color-scheme:dark]'
const labelCls = 'text-[11px] text-slate-400 font-display tracking-wider uppercase'

function heroPortrait(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/:/g, '')
  return `/heroes/${cleaned}.png`
}

// A single column = one hero under one filter set, with its computed stats.
interface Column {
  id: string
  hero: string
  filters: Filters        // used in Deep Dive (per-slot); in Compare mode the shared filters apply
  data: Computed | null
  breakdown: Record<string, { perGame: number | null; per10: number | null }> | null
  loading: boolean
}

// fetch + aggregate the full breakdown stat set for one hero under filters
type BreakdownMap = Record<string, { perGame: number | null; per10: number | null }>
interface StatFactRow {
  stat_canonical: string; stat_num: number | null; game_length_seconds: number | null
}

export default function ComparePage() {
  const [tab, setTab] = useState<'compare' | 'deepdive'>('compare')

  // ---- Compare Heroes mode: list of heroes + one shared filter ----
  const [cmpHeroes, setCmpHeroes] = useState<string[]>([])
  const [cmpFilters, setCmpFilters] = useState<Filters>(emptyFilters)
  const [cmpData, setCmpData] = useState<Record<string, Computed | null>>({})
  const [cmpLoading, setCmpLoading] = useState(false)

  // ---- Deep Dive mode: per-slot hero + filters ----
  const [slots, setSlots] = useState<Column[]>([
    { id: 's1', hero: '', filters: { ...emptyFilters }, data: null, breakdown: null, loading: false },
    { id: 's2', hero: '', filters: { ...emptyFilters }, data: null, breakdown: null, loading: false },
  ])
  const [showBreakdown, setShowBreakdown] = useState(false)

  // build + run a filtered query against the fact table, return computed stats
  const fetchStats = useCallback(async (hero: string, f: Filters): Promise<Computed | null> => {
    if (!hero) return null
    let q = supabase.from('hero_match_facts').select('*').eq('hero_name', hero).eq('match_format', f.format)
    if (f.mode) q = q.eq('game_mode', f.mode)
    if (f.map) q = q.eq('map', f.map)
    if (f.side && modeHasSide(f.mode)) q = q.eq('starting_side', f.side)
    const { data, error } = await q
    if (error) { console.error('compare fetch error', error); return null }
    return compute((data as Fact[] | null) || [])
  }, [])

  // ---- Compare mode: refetch all heroes when heroes or shared filters change ----
  useEffect(() => {
    let cancelled = false
    if (cmpHeroes.length === 0) { setCmpData({}); return }
    setCmpLoading(true)
    Promise.all(cmpHeroes.map(h => fetchStats(h, cmpFilters).then(d => [h, d] as const)))
      .then(pairs => { if (!cancelled) { setCmpData(Object.fromEntries(pairs)); setCmpLoading(false) } })
    return () => { cancelled = true }
  }, [cmpHeroes, cmpFilters, fetchStats])

  // fetch the full breakdown stat set for a hero under filters, aggregated
  const fetchBreakdown = useCallback(async (hero: string, f: Filters): Promise<BreakdownMap | null> => {
    if (!hero) return null
    let q = supabase.from('hero_stat_facts').select('stat_canonical, stat_num, game_length_seconds')
      .eq('hero_name', hero).eq('match_format', f.format)
    if (f.mode) q = q.eq('game_mode', f.mode)
    if (f.map) q = q.eq('map', f.map)
    if (f.side && modeHasSide(f.mode)) q = q.eq('starting_side', f.side)
    const { data, error } = await q
    if (error) { console.error('breakdown fetch error', error); return null }
    const rows = (data as StatFactRow[] | null) || []
    const byStat = new Map<string, StatFactRow[]>()
    for (const r of rows) {
      if (!byStat.has(r.stat_canonical)) byStat.set(r.stat_canonical, [])
      byStat.get(r.stat_canonical)!.push(r)
    }
    const out: BreakdownMap = {}
    for (const [stat, rs] of byStat) {
      out[stat] = {
        perGame: mean(rs.map(r => r.stat_num)),
        per10: mean(rs.map(r => r.stat_num != null && r.game_length_seconds && r.game_length_seconds > 0
          ? r.stat_num / (r.game_length_seconds / 600) : null)),
      }
    }
    return out
  }, [])

  // ---- Deep Dive: refetch a single slot when its hero/filters change ----
  const refetchSlot = useCallback(async (id: string) => {
    setSlots(prev => prev.map(s => s.id === id ? { ...s, loading: true } : s))
    const slot = slots.find(s => s.id === id)
    if (!slot) return
    const [data, breakdown] = await Promise.all([
      fetchStats(slot.hero, slot.filters),
      fetchBreakdown(slot.hero, slot.filters),
    ])
    setSlots(prev => prev.map(s => s.id === id ? { ...s, data, breakdown, loading: false } : s))
  }, [slots, fetchStats, fetchBreakdown])

  // ---- filter bar (shared component for both modes) ----
  function FilterBar({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
    const maps = value.mode ? mapsForMode(value.mode) : []
    return (
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Format</span>
          <select className={selectCls} value={value.format}
            onChange={e => onChange({ ...value, format: e.target.value as Format })}>
            <option value="5v5">5v5</option>
            <option value="6v6">6v6</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Game Mode</span>
          <select className={selectCls} value={value.mode}
            onChange={e => {
              const mode = e.target.value as GameMode | ''
              onChange({ ...value, mode, map: '', side: modeHasSide(mode) ? value.side : '' })
            }}>
            <option value="">All modes</option>
            {GAME_MODES.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        {value.mode && (
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Map</span>
            <select className={selectCls} value={value.map}
              onChange={e => onChange({ ...value, map: e.target.value })}>
              <option value="">All {value.mode} maps</option>
              {maps.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}
        {modeHasSide(value.mode) && (
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Starting Side</span>
            <select className={selectCls} value={value.side}
              onChange={e => onChange({ ...value, side: e.target.value as 'attack' | 'defense' | '' })}>
              <option value="">Either side</option>
              <option value="attack">Attack first</option>
              <option value="defense">Defense first</option>
            </select>
          </label>
        )}
      </div>
    )
  }

  // ---- decide which stat rows to show, given the roles present in columns ----
  // breakdown rows are role-specific; show a row if ANY column's hero has that role
  function statRows(heroes: string[], detailed: boolean): { key: keyof Computed; label: string; pct?: boolean; suffix?: string; higherBetter: boolean; singleHero?: boolean }[] {
    const roles = new Set(heroes.map(h => HERO_ROLE.get(h)).filter(Boolean) as Role[])
    const rows: { key: keyof Computed; label: string; pct?: boolean; suffix?: string; higherBetter: boolean; singleHero?: boolean }[] = [
      { key: 'games', label: 'Games', higherBetter: true },
      { key: 'winRate', label: 'Win rate', pct: true, higherBetter: true },
    ]
    if (roles.has('tank')) rows.push({ key: 'avgObjContest', label: 'Obj Contest', higherBetter: true })
    if (roles.has('dps')) {
      rows.push({ key: 'avgFinalBlows', label: 'Final Blows', higherBetter: true })
      rows.push({ key: 'avgSoloKills', label: 'Solo Kills', higherBetter: true })
      if (detailed) {
        rows.push({ key: 'per10FinalBlows', label: 'Final Blows /10min', higherBetter: true })
        rows.push({ key: 'per10SoloKills', label: 'Solo Kills /10min', higherBetter: true })
      }
    }
    if (roles.has('support')) rows.push({ key: 'avgPlayersSaved', label: 'Players Saved', higherBetter: true })
    // single-hero stats
    rows.push({ key: 'avgElims', label: 'Avg Elims', higherBetter: true, singleHero: true })
    rows.push({ key: 'avgAssists', label: 'Avg Assists', higherBetter: true, singleHero: true })
    rows.push({ key: 'avgDeaths', label: 'Avg Deaths', higherBetter: false, singleHero: true })
    rows.push({ key: 'avgDamagePct', label: 'Damage % (team)', pct: true, higherBetter: true, singleHero: true })
    rows.push({ key: 'avgHealingPct', label: 'Healing % (vs enemy)', pct: true, higherBetter: true, singleHero: true })
    rows.push({ key: 'avgMitigationPct', label: 'Mitigation % (vs enemy)', pct: true, higherBetter: true, singleHero: true })
    return rows
  }

  function fmtVal(v: number | null, pct?: boolean): string {
    if (v == null) return '—'
    return pct ? `${Math.round(v * 10) / 10}%` : `${Math.round(v * 100) / 100}`
  }

  // ---- the comparison grid (used by both modes) ----
  function Grid({ columns, detailed }: { columns: { hero: string; data: Computed | null; loading: boolean; sub?: string }[]; detailed: boolean }) {
    const heroes = columns.map(c => c.hero).filter(Boolean)
    if (heroes.length === 0) {
      return <p className="text-sm text-slate-400 py-8 text-center">Pick at least one hero to compare.</p>
    }
    const rows = statRows(heroes, detailed)
    // for highlighting: per row, find the best column value
    const bestIndex = (key: keyof Computed, higherBetter: boolean): number => {
      let best = -1, bestVal: number | null = null
      columns.forEach((c, i) => {
        const v = c.data ? (c.data[key] as number | null) : null
        if (v == null) return
        if (bestVal == null || (higherBetter ? v > bestVal : v < bestVal)) { bestVal = v; best = i }
      })
      return best
    }
    return (
      <div className="overflow-x-auto">
        <div className="grid gap-px bg-white/10 rounded-lg overflow-hidden"
          style={{ gridTemplateColumns: `minmax(140px, 1.2fr) repeat(${columns.length}, minmax(110px, 1fr))` }}>
          {/* header row */}
          <div className="bg-ow-dark p-3" />
          {columns.map((c, i) => (
            <div key={i} className="bg-ow-dark p-3 text-center">
              {c.hero ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={heroPortrait(c.hero)} alt={c.hero}
                    className="w-10 h-10 rounded mx-auto mb-1 bg-ow-panel object-cover"
                    onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                  <p className="font-display text-white text-sm truncate">{c.hero}</p>
                  {c.sub && <p className="text-[10px] text-slate-400 truncate">{c.sub}</p>}
                </>
              ) : <p className="text-slate-500 text-sm">—</p>}
            </div>
          ))}
          {/* stat rows */}
          {rows.map(r => {
            const best = bestIndex(r.key, r.higherBetter)
            return (
              <div key={r.key} className="contents">
                <div className="bg-ow-panel p-3 text-sm text-slate-300 font-display tracking-wide flex items-center">
                  {r.label}
                  {r.singleHero && <span className="ml-1 text-[9px] text-slate-500">(1-hero)</span>}
                </div>
                {columns.map((c, i) => {
                  const v = c.data ? (c.data[r.key] as number | null) : null
                  const isBest = i === best && v != null && columns.length > 1
                  const tiny = r.singleHero && c.data != null && c.data.singleHeroGames <= TINY_SAMPLE && c.data.singleHeroGames > 0
                  return (
                    <div key={i} className={`bg-ow-panel p-3 text-center font-display
                      ${isBest ? 'text-ow-victory font-bold' : 'text-white'}`}>
                      {c.loading ? <span className="text-slate-500 text-xs">…</span> : fmtVal(v, r.pct)}
                      {tiny && v != null && (
                        <span className="block text-[9px] text-ow-draw" title="Small sample">
                          n={c.data!.singleHeroGames}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        {/* footnote when single-hero rows are mostly empty */}
        <p className="text-[11px] text-slate-500 mt-3">
          “1-hero” stats (E/A/D and %s) only count games where you played that hero ≥95% of the match.
          Narrow filters shrink that sample, so these may be blank or flagged as low-confidence.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link href="/heroes" className="text-sm text-slate-400 hover:text-ow-orange font-display tracking-wider">← Heroes</Link>
      <div>
        <h1 className="font-display text-3xl tracking-[0.12em] text-slate-100 uppercase">Compare</h1>
        <p className="text-sm text-slate-400 mt-1">Hero comparison &amp; single-hero deep dive</p>
      </div>

      {/* tabs */}
      <div className="flex gap-2">
        {([['compare', 'Compare Heroes'], ['deepdive', 'Hero Deep Dive']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-1.5 rounded-lg text-sm font-display tracking-wider transition-colors
              ${tab === k ? 'bg-ow-orange text-ow-dark font-bold' : 'bg-ow-panel text-slate-400 hover:text-white border border-white/10'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'compare' ? (
        <div className="space-y-5">
          {/* hero pickers (up to 4 distinct) */}
          <div className="flex flex-wrap gap-3 items-end">
            {Array.from({ length: MAX_SLOTS }).map((_, i) => (
              <label key={i} className="flex flex-col gap-1">
                <span className={labelCls}>Hero {i + 1}</span>
                <select className={selectCls}
                  value={cmpHeroes[i] || ''}
                  onChange={e => {
                    const next = [...cmpHeroes]
                    if (e.target.value) next[i] = e.target.value; else next.splice(i, 1)
                    // keep distinct + compact
                    setCmpHeroes(Array.from(new Set(next.filter(Boolean))))
                  }}>
                  <option value="">—</option>
                  {HERO_NAMES.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
          <FilterBar value={cmpFilters} onChange={setCmpFilters} />
          <Grid detailed={false}
            columns={cmpHeroes.map(h => ({ hero: h, data: cmpData[h] ?? null, loading: cmpLoading }))} />
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-slate-400">
            Each slot is a hero with its own filters — set the same hero in multiple slots to compare it across
            maps, modes, or sides.
          </p>
          <div className="space-y-4">
            {slots.map((s, idx) => (
              <div key={s.id} className="bg-ow-panel/40 border border-white/10 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <label className="flex flex-col gap-1">
                    <span className={labelCls}>Slot {idx + 1} — Hero</span>
                    <select className={selectCls} value={s.hero}
                      onChange={e => {
                        const hero = e.target.value
                        setSlots(prev => prev.map(x => x.id === s.id ? { ...x, hero } : x))
                      }}>
                      <option value="">—</option>
                      {HERO_NAMES.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </label>
                  {slots.length > 1 && (
                    <button onClick={() => setSlots(prev => prev.filter(x => x.id !== s.id))}
                      className="text-xs text-slate-400 hover:text-ow-defeat font-display tracking-wider">REMOVE</button>
                  )}
                </div>
                <FilterBar value={s.filters}
                  onChange={f => setSlots(prev => prev.map(x => x.id === s.id ? { ...x, filters: f } : x))} />
                <button onClick={() => refetchSlot(s.id)}
                  className="text-xs bg-ow-dark border border-white/15 hover:border-ow-orange/40 text-slate-200 font-display tracking-wider px-3 py-1.5 rounded">
                  APPLY
                </button>
              </div>
            ))}
            {slots.length < MAX_SLOTS && (
              <button
                onClick={() => setSlots(prev => [...prev, { id: `s${Date.now()}`, hero: prev[0]?.hero || '', filters: { ...emptyFilters }, data: null, breakdown: null, loading: false }])}
                className="w-full bg-ow-panel border border-white/15 hover:border-ow-orange/40 text-slate-200 font-display font-bold py-2.5 rounded-lg tracking-wider text-sm">
                + ADD SLOT
              </button>
            )}
          </div>
          <Grid detailed={true}
            columns={slots.map(s => ({
              hero: s.hero, data: s.data, loading: s.loading,
              sub: [s.filters.mode, s.filters.map, s.filters.side].filter(Boolean).join(' · ') || 'all',
            }))} />

          {/* Toggleable full breakdown stats table */}
          {slots.some(s => s.hero) && (
            <div className="border border-white/10 rounded-lg overflow-hidden">
              <button onClick={() => setShowBreakdown(v => !v)}
                className="w-full flex items-center justify-between bg-ow-panel px-4 py-3 text-left">
                <span className="font-display text-slate-200 text-sm tracking-wider uppercase">Hero breakdown stats</span>
                <span className="text-ow-orange font-display text-sm">{showBreakdown ? '− HIDE' : '+ SHOW'}</span>
              </button>
              {showBreakdown && (() => {
                // union of each slot-hero's breakdown stats in the USER's order,
                // preserving first-seen order across slots.
                const seen: BreakdownStat[] = []
                const seenKeys = new Set<string>()
                slots.forEach(s => {
                  if (!s.hero) return
                  ;(HERO_BREAKDOWN_ORDER[s.hero] || []).forEach(st => {
                    if (!seenKeys.has(st.canonical)) { seenKeys.add(st.canonical); seen.push(st) }
                  })
                })
                if (seen.length === 0) return <p className="text-sm text-slate-500 p-4">No breakdown stats for these heroes.</p>
                return (
                  <div className="overflow-x-auto">
                    <div className="grid gap-px bg-white/10"
                      style={{ gridTemplateColumns: `minmax(160px, 1.4fr) repeat(${slots.length}, minmax(120px, 1fr))` }}>
                      <div className="bg-ow-dark p-2.5" />
                      {slots.map((s, i) => (
                        <div key={i} className="bg-ow-dark p-2.5 text-center font-display text-white text-xs truncate">
                          {s.hero || '—'}
                          <span className="block text-[10px] text-slate-400">
                            {[s.filters.mode, s.filters.map].filter(Boolean).join(' · ') || 'all'}
                          </span>
                        </div>
                      ))}
                      {seen.map(st => (
                        <div key={st.canonical} className="contents">
                          <div className="bg-ow-panel p-2.5 text-xs text-slate-300 font-display tracking-wide flex items-center">
                            {st.label}
                          </div>
                          {slots.map((s, i) => {
                            const v = s.breakdown?.[st.canonical]
                            return (
                              <div key={i} className="bg-ow-panel p-2.5 text-center font-display text-white text-xs">
                                {formatStatValue(st.canonical, v?.perGame ?? null)}
                                {v?.per10 != null && <span className="text-slate-400 ml-1.5">{formatStatValue(st.canonical, v.per10)}/10</span>}
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
