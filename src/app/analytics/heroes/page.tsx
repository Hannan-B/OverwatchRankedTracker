'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { matchQuery } from '@/lib/alpha'
import { HEROES, MAPS, GAME_MODE_CONFIG, type GameMode } from '@/data/reference'
import { AnalyticsNav, AnalyticsHeader } from '@/components/AnalyticsNav'

// ============================================================
// HERO ANALYTICS  (/analytics/heroes)  — moved into the Analytics area.
// ------------------------------------------------------------
// Re-pointed (Option 2a) from the pre-aggregated hero_card_stats /
// hero_breakdown_stats views to the ROW-LEVEL views hero_match_facts +
// hero_stat_facts, so the page can now filter by Game Mode and Map (the
// pre-aggregated views had no mode/map column). Aggregation is done in-page,
// games-weighted, exactly mirroring the old card maths.
//
// Controls: Format (5v5/6v6, never mixed) · Season · Mode · Map · Role.
// Cards: portrait, games, W, L, W/L% — appear only at games >= 5.
// Detail block (per role breakdown + avg E/A/D + dmg/heal/mit %) gated behind
// MORE THAN 5 single-hero (>=95%) games, sample labelled.
// Alpha test matches excluded via match_id against the matches table (the hero
// views carry no is_alpha column — same approach the builder uses).
// ============================================================

type Format = '5v5' | '6v6'
type RoleTab = 'all' | 'tank' | 'dps' | 'support'
const MIN_GAMES = 5
const MIN_PCT_GAMES = 5
const SINGLE_HERO_PCT = 95   // a "single-hero game" = played >= this % on the hero

const HERO_ROLE = new Map<string, 'tank' | 'dps' | 'support'>(HEROES.map(h => [h.name, h.role]))
const GAME_MODES = Object.keys(GAME_MODE_CONFIG) as GameMode[]
const mapsForMode = (mode: GameMode) => MAPS.filter(m => m.mode === mode).map(m => m.name).sort()

function heroPortrait(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/:/g, '')
  return `/heroes/${cleaned}.png`
}

// Row-level columns we read (mirrors the live views; NO is_alpha on the view).
const MATCH_FACT_COLS =
  'match_id, hero_name, match_format, game_mode, map, season_id, result, ' +
  'percent_played, is_single_hero, game_length_seconds, ' +
  'user_elims, user_assists, user_deaths, damage_pct, healing_pct, mitigation_pct'
const STAT_FACT_COLS =
  'match_id, hero_name, match_format, game_mode, map, season_id, ' +
  'game_length_seconds, stat_canonical, stat_num'

interface MatchFactRow {
  match_id: number
  hero_name: string
  match_format: Format
  game_mode: string | null
  map: string | null
  season_id: number | null
  result: 'victory' | 'defeat' | 'draw'
  percent_played: number | string | null
  is_single_hero: boolean | null
  game_length_seconds: number | null
  user_elims: number | null
  user_assists: number | null
  user_deaths: number | null
  damage_pct: number | string | null
  healing_pct: number | string | null
  mitigation_pct: number | string | null
}
interface StatFactRow {
  match_id: number
  hero_name: string
  match_format: Format
  game_mode: string | null
  map: string | null
  season_id: number | null
  game_length_seconds: number | null
  stat_canonical: string
  stat_num: number | string | null
}
interface SeasonRow { id: number; name: string; start_date: string; end_date: string }

const ROLE_BREAKDOWN: Record<'tank' | 'dps' | 'support', string[]> = {
  tank: ['OBJ CONTEST TIME'],
  dps: ['FINAL BLOWS', 'SOLO KILLS'],
  support: ['PLAYERS SAVED'],
}
const STAT_LABEL: Record<string, string> = {
  'OBJ CONTEST TIME': 'Obj Contest', 'FINAL BLOWS': 'Final Blows',
  'SOLO KILLS': 'Solo Kills', 'PLAYERS SAVED': 'Players Saved',
}
const ROLE_LABEL: Record<string, string> = { tank: 'TANK', dps: 'DPS', support: 'SUPPORT' }

const winRateColor = (wr: number | null) =>
  wr == null ? 'text-slate-400' : wr >= 55 ? 'text-ow-victory' : wr <= 45 ? 'text-ow-defeat' : 'text-ow-draw'

const selectCls =
  'bg-ow-dark border border-white/20 rounded-lg px-3 py-2 text-sm text-slate-100 font-display tracking-wider focus:border-ow-orange focus:outline-none [color-scheme:dark]'
const labelCls = 'text-[11px] text-slate-400 font-display tracking-wider uppercase'

function num(v: number | string | null): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isNaN(n) ? null : n
}
function mean(vals: (number | null)[]): number | null {
  const n = vals.filter((v): v is number => v != null)
  return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null
}

export default function AnalyticsHeroesPage() {
  const [matchFacts, setMatchFacts] = useState<MatchFactRow[]>([])
  const [statFacts, setStatFacts] = useState<StatFactRow[]>([])
  const [visibleIds, setVisibleIds] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)

  const [format, setFormat] = useState<Format>('5v5')
  const [roleTab, setRoleTab] = useState<RoleTab>('all')
  const [mode, setMode] = useState<GameMode | ''>('')
  const [mapName, setMapName] = useState<string>('')
  const [seasons, setSeasons] = useState<SeasonRow[]>([])
  const [currentSeasonId, setCurrentSeasonId] = useState<number | null>(null)
  const [scope, setScope] = useState<'current' | 'all' | number>('current')
  const [expanded, setExpanded] = useState<string | null>(null)
  const scopeDefaulted = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    const today = new Date().toISOString().slice(0, 10)
    const { data: seasonData } = await supabase
      .from('seasons').select('id, name, start_date, end_date')
      .order('start_date', { ascending: false })
    const seasonsList = (seasonData as SeasonRow[] | null) || []
    setSeasons(seasonsList)
    const current = seasonsList.find(s => s.start_date <= today && today <= s.end_date)
    setCurrentSeasonId(current?.id ?? null)
    if (!scopeDefaulted.current) {
      scopeDefaulted.current = true
      if (current?.id == null) setScope('all')
    }

    const [mIds, { data: mf }, { data: sf }] = await Promise.all([
      matchQuery('id').order('played_at', { ascending: false }),
      supabase.from('hero_match_facts').select(MATCH_FACT_COLS),
      supabase.from('hero_stat_facts').select(STAT_FACT_COLS),
    ])
    const ids = (((mIds as unknown) as { data: { id: number }[] | null }).data) || []
    setVisibleIds(new Set(ids.map(r => r.id)))
    setMatchFacts((mf as MatchFactRow[] | null) || [])
    setStatFacts((sf as StatFactRow[] | null) || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const seasonId = scope === 'current' ? currentSeasonId : scope === 'all' ? null : scope

  // Shared row filter: alpha-excluded, format, season scope, mode, map.
  const matchRowsInScope = useMemo(() => {
    return matchFacts.filter(r => {
      if (!visibleIds.has(r.match_id)) return false
      if (r.match_format !== format) return false
      if (scope !== 'all') {
        if (seasonId == null) return false
        if (r.season_id !== seasonId) return false
      }
      if (mode && r.game_mode !== mode) return false
      if (mapName && r.map !== mapName) return false
      return true
    })
  }, [matchFacts, visibleIds, format, scope, seasonId, mode, mapName])

  const statRowsInScope = useMemo(() => {
    return statFacts.filter(r => {
      if (!visibleIds.has(r.match_id)) return false
      if (r.match_format !== format) return false
      if (scope !== 'all') {
        if (seasonId == null) return false
        if (r.season_id !== seasonId) return false
      }
      if (mode && r.game_mode !== mode) return false
      if (mapName && r.map !== mapName) return false
      return true
    })
  }, [statFacts, visibleIds, format, scope, seasonId, mode, mapName])

  // ---- aggregate per hero (games-weighted, one match counted once) ----
  interface HeroAgg {
    hero_name: string
    games: number
    wins: number
    losses: number
    draws: number
    win_rate: number | null
    single_hero_games: number
    avg_elims: number | null
    avg_assists: number | null
    avg_deaths: number | null
    avg_damage_pct: number | null
    avg_healing_pct: number | null
    avg_mitigation_pct: number | null
  }

  const heroAggs = useMemo(() => {
    // Group match-fact rows by hero. Each row is one (hero, match); a match
    // where the hero was played is one game for that hero (already 1 row each).
    const byHero = new Map<string, MatchFactRow[]>()
    for (const r of matchRowsInScope) {
      if (!byHero.has(r.hero_name)) byHero.set(r.hero_name, [])
      byHero.get(r.hero_name)!.push(r)
    }
    const out: HeroAgg[] = []
    for (const [hero, rows] of byHero) {
      const wins = rows.filter(r => r.result === 'victory').length
      const losses = rows.filter(r => r.result === 'defeat').length
      const draws = rows.filter(r => r.result === 'draw').length
      // single-hero rows for the % / E-A-D block
      const sh = rows.filter(r => r.is_single_hero === true ||
        (num(r.percent_played) != null && (num(r.percent_played) as number) >= SINGLE_HERO_PCT))
      out.push({
        hero_name: hero,
        games: rows.length,
        wins, losses, draws,
        win_rate: (wins + losses) === 0 ? null : Math.round((1000 * wins) / (wins + losses)) / 10,
        single_hero_games: sh.length,
        avg_elims: mean(sh.map(r => num(r.user_elims))),
        avg_assists: mean(sh.map(r => num(r.user_assists))),
        avg_deaths: mean(sh.map(r => num(r.user_deaths))),
        avg_damage_pct: mean(sh.map(r => num(r.damage_pct))),
        avg_healing_pct: mean(sh.map(r => num(r.healing_pct))),
        avg_mitigation_pct: mean(sh.map(r => num(r.mitigation_pct))),
      })
    }
    return out
  }, [matchRowsInScope])

  // breakdown stats per hero -> canonical -> {perGame, per10}
  const bdByHero = useMemo(() => {
    const m = new Map<string, Map<string, { perGame: number | null; per10: number | null }>>()
    const byHeroStat = new Map<string, Map<string, StatFactRow[]>>()
    for (const r of statRowsInScope) {
      if (!byHeroStat.has(r.hero_name)) byHeroStat.set(r.hero_name, new Map())
      const hm = byHeroStat.get(r.hero_name)!
      if (!hm.has(r.stat_canonical)) hm.set(r.stat_canonical, [])
      hm.get(r.stat_canonical)!.push(r)
    }
    for (const [hero, statMap] of byHeroStat) {
      const out = new Map<string, { perGame: number | null; per10: number | null }>()
      for (const [stat, rows] of statMap) {
        out.set(stat, {
          perGame: mean(rows.map(r => num(r.stat_num))),
          per10: mean(rows.map(r => {
            const v = num(r.stat_num)
            return v != null && r.game_length_seconds && r.game_length_seconds > 0
              ? v / (r.game_length_seconds / 600) : null
          })),
        })
      }
      m.set(hero, out)
    }
    return m
  }, [statRowsInScope])

  let heroes = heroAggs.filter(h => h.games >= MIN_GAMES)
  if (roleTab !== 'all') heroes = heroes.filter(h => HERO_ROLE.get(h.hero_name) === roleTab)
  heroes.sort((a, b) => b.games - a.games)

  const fmtToggle = (f: Format) => (
    <button key={f} onClick={() => { setFormat(f); setExpanded(null) }}
      className={`px-5 py-1.5 rounded-lg text-sm font-display tracking-wider transition-colors
        ${format === f ? 'bg-ow-orange text-ow-dark font-bold'
                       : 'bg-ow-panel text-slate-400 hover:text-white border border-white/10'}`}>
      {f.toUpperCase()}
    </button>
  )

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title="Heroes"
        subtitle="Per-hero performance — win rate, record, and detailed stats, filterable by mode and map."
      />
      <AnalyticsNav />

      {/* Controls: format · season · mode · map */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <span className={labelCls}>Format</span>
          <div className="flex gap-2">{(['5v5', '6v6'] as Format[]).map(fmtToggle)}</div>
        </div>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Season</span>
          <select className={selectCls} value={String(scope)}
            onChange={e => { const v = e.target.value; setScope(v === 'current' || v === 'all' ? v : Number(v)); setExpanded(null) }}>
            {currentSeasonId && <option value="current">Current</option>}
            {seasons.filter(s => s.id !== currentSeasonId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="all">All Time</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Game Mode</span>
          <select className={selectCls} value={mode}
            onChange={e => { const m = e.target.value as GameMode | ''; setMode(m); setMapName(''); setExpanded(null) }}>
            <option value="">All modes</option>
            {GAME_MODES.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        {mode && (
          <label className="flex flex-col gap-1">
            <span className={labelCls}>Map</span>
            <select className={selectCls} value={mapName} onChange={e => { setMapName(e.target.value); setExpanded(null) }}>
              <option value="">All {mode} maps</option>
              {mapsForMode(mode).map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="flex gap-2">
        {(['all', 'tank', 'dps', 'support'] as RoleTab[]).map(role => (
          <button key={role} onClick={() => { setRoleTab(role); setExpanded(null) }}
            className={`px-4 py-1.5 rounded-lg text-sm font-display tracking-wider transition-colors
              ${roleTab === role ? 'bg-ow-orange text-ow-dark font-bold'
                                 : 'bg-ow-panel text-slate-400 hover:text-white border border-white/10'}`}>
            {role.toUpperCase()}
          </button>
        ))}
      </div>

      <p className="text-sm text-slate-400">{heroes.length} heroes · {format.toUpperCase()} · min {MIN_GAMES} games</p>

      {loading ? (
        <div className="text-center py-12 text-slate-300 font-display tracking-wider">LOADING…</div>
      ) : heroes.length === 0 ? (
        <div className="text-center py-16 text-slate-300">
          <p className="font-display text-lg tracking-wider">No heroes yet</p>
          <p className="text-sm mt-1 text-slate-400">
            {scope === 'current' && !currentSeasonId
              ? 'No current season set. Add one in Settings → Seasons, or pick All Time.'
              : `No heroes with ${MIN_GAMES}+ games in ${format.toUpperCase()} for this scope/filters.`}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
          {heroes.map(h => {
            const role = HERO_ROLE.get(h.hero_name)
            const shg = h.single_hero_games || 0
            const showStats = shg > MIN_PCT_GAMES
            const isOpen = expanded === h.hero_name
            const bd = bdByHero.get(h.hero_name)
            const roleStats = role ? ROLE_BREAKDOWN[role] : []

            return (
              <div key={h.hero_name}
                className="bg-ow-panel rounded-lg border border-white/10 hover:border-ow-orange/30 transition-colors overflow-hidden">
                <button onClick={() => setExpanded(isOpen ? null : h.hero_name)} className="w-full text-left p-4">
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={heroPortrait(h.hero_name)} alt={h.hero_name}
                      className="w-12 h-12 rounded object-cover bg-ow-dark shrink-0"
                      onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                    <div className="min-w-0 flex-1">
                      <h3 className="font-display text-white text-lg truncate">{h.hero_name}</h3>
                      <p className="text-[11px] text-slate-400 font-display tracking-wide uppercase">
                        {role ? ROLE_LABEL[role] : ''} · {h.games} games
                      </p>
                    </div>
                    <span className={`text-lg font-display font-bold ${winRateColor(h.win_rate)}`}>
                      {h.win_rate == null ? '—' : `${h.win_rate}%`}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center mt-3">
                    <div><p className="text-base font-display text-white">{h.games}</p><p className="text-[10px] text-slate-500 tracking-wider">PLAYED</p></div>
                    <div><p className="text-base font-display text-ow-victory">{h.wins}</p><p className="text-[10px] text-slate-500 tracking-wider">WINS</p></div>
                    <div><p className="text-base font-display text-ow-defeat">{h.losses}</p><p className="text-[10px] text-slate-500 tracking-wider">LOSSES</p></div>
                  </div>
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 pt-1 border-t border-white/10 space-y-3">
                    {roleStats.length > 0 && (
                      <div className="space-y-1.5">
                        {roleStats.map(sc => {
                          const v = bd?.get(sc)
                          return (
                            <div key={sc} className="flex items-center justify-between text-sm">
                              <span className="text-slate-300 font-display tracking-wide">{STAT_LABEL[sc] || sc}</span>
                              <span className="text-white font-display">
                                {v?.perGame != null ? v.perGame.toFixed(1) : '—'}
                                <span className="text-slate-500 text-xs"> /game</span>
                                {v?.per10 != null && <span className="text-slate-400 text-xs ml-2">{v.per10.toFixed(1)}/10min</span>}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {showStats ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-300 font-display tracking-wide">Avg E / A / D</span>
                          <span className="text-white font-display">
                            {h.avg_elims?.toFixed(1) ?? '—'} / {h.avg_assists?.toFixed(1) ?? '—'} / {h.avg_deaths?.toFixed(1) ?? '—'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-300 font-display tracking-wide">Damage % (of team)</span>
                          <span className="text-white font-display">{h.avg_damage_pct != null ? `${Math.round(h.avg_damage_pct * 10) / 10}%` : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-300 font-display tracking-wide">Healing % (vs enemy dmg)</span>
                          <span className="text-white font-display">{h.avg_healing_pct != null ? `${Math.round(h.avg_healing_pct * 10) / 10}%` : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-300 font-display tracking-wide">Mitigation % (vs enemy dmg)</span>
                          <span className="text-white font-display">{h.avg_mitigation_pct != null ? `${Math.round(h.avg_mitigation_pct * 10) / 10}%` : '—'}</span>
                        </div>
                        <p className="text-[10px] text-slate-500 pt-1">From {shg} single-hero games (≥{SINGLE_HERO_PCT}% played).</p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-500">
                        Damage/healing/mitigation and avg E/A/D need more than {MIN_PCT_GAMES} single-hero games
                        (≥{SINGLE_HERO_PCT}% played). This hero has {shg}.
                      </p>
                    )}
                    <Link href={`/analytics/heroes/${encodeURIComponent(h.hero_name)}`}
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      className="inline-block mt-1 text-xs text-ow-orange hover:underline font-display tracking-wider">
                      View details →
                    </Link>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
