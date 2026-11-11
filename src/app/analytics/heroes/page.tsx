'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
// (v1.1.0 Phase 2) <Select> is no longer used here — Season, Mode and Map are all
// multi-select now, and Format/Role are button toggles.
import MultiSelect from '@/components/MultiSelect'
import { matchQuery } from '@/lib/alpha'
import { loadExclusionPrefs, isExcludedGame, EXCLUSION_COLS, type ExcludableRow } from '@/lib/leaver'
import { defaultSeasonSelection } from '@/lib/season-util'
import { MAPS, GAME_MODE_CONFIG, heroRoleAt, type GameMode, type HeroRole } from '@/data/reference'
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

const GAME_MODES = Object.keys(GAME_MODE_CONFIG) as GameMode[]
const mapsForMode = (mode: GameMode) => MAPS.filter(m => m.mode === mode).map(m => m.name).sort()

// (v1.1.0 Phase 5) How the hero list is ordered. Kept as a union rather than a
// boolean so a third order (avg deaths, playtime) is an addition, not a rewrite.
type HeroSort = 'games' | 'win_rate'
// (v1.1.0 Phase 2) Maps offered for a SET of modes: no modes = every map, several
// modes = the UNION of their maps, deduped (the same map can serve more than one
// mode in reference data, and a duplicate row would tick twice). Mirrors
// AnalyticsFilters.mapNamesForModes — kept local because this page holds its own
// filter state rather than the shared one.
const mapNamesForModes = (modes: GameMode[]): string[] => {
  const src = modes.length === 0
    ? MAPS.map(m => m.name)
    : modes.flatMap(m => mapsForMode(m))
  return Array.from(new Set(src)).sort((a, b) => a.localeCompare(b))
}

function heroPortrait(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/:/g, '')
  return `/heroes/${cleaned}.png`
}

// Row-level columns we read (mirrors the live views; NO is_alpha on the view).
const MATCH_FACT_COLS =
  'match_id, hero_name, match_format, game_mode, map, season_id, played_at, result, ' +
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
  played_at: string | null
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
  tank: ['OBJ CONTEST TIME', 'PLAYERS PROTECTED'],
  dps: ['FINAL BLOWS', 'SOLO KILLS'],
  support: ['PLAYERS SAVED'],
}
const STAT_LABEL: Record<string, string> = {
  'OBJ CONTEST TIME': 'Obj Contest', 'FINAL BLOWS': 'Final Blows',
  'SOLO KILLS': 'Solo Kills', 'PLAYERS SAVED': 'Players Saved',
  'PLAYERS PROTECTED': 'Players Protected',
}
const ROLE_LABEL: Record<string, string> = { tank: 'TANK', dps: 'DPS', support: 'SUPPORT' }

const winRateColor = (wr: number | null) =>
  wr == null ? 'text-ow-muted' : wr >= 55 ? 'text-ow-victory' : wr <= 45 ? 'text-ow-defeat' : 'text-ow-draw'

const selectCls =
  'bg-ow-dark border border-ow-line rounded-lg px-3 py-2 text-sm text-ow-fg font-display tracking-wider focus:border-ow-orange focus:outline-none [color-scheme:dark]'
const labelCls = 'text-[11px] text-ow-muted font-display tracking-wider uppercase'

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
  const [modes, setModes] = useState<GameMode[]>([])
  const [maps, setMaps] = useState<string[]>([])
  const [seasons, setSeasons] = useState<SeasonRow[]>([])
  // Season multi-select: [] = All Time; else exactly these season ids.
  const [seasonSel, setSeasonSel] = useState<number[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  // (v1.1.0 Phase 5) Sort order for the hero list. 'games' is the default and
  // reproduces the previous fixed behaviour exactly, so the page opens unchanged.
  const [sortBy, setSortBy] = useState<HeroSort>('games')
  const seasonDefaulted = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data: seasonData } = await supabase
      .from('seasons').select('id, name, start_date, end_date')
      .order('start_date', { ascending: false })
    const seasonsList = (seasonData as SeasonRow[] | null) || []
    setSeasons(seasonsList)
    if (!seasonDefaulted.current) {
      seasonDefaulted.current = true
      setSeasonSel(defaultSeasonSelection(seasonsList))
    }

    const [mIds, { data: mf }, { data: sf }] = await Promise.all([
      matchQuery('id, ' + EXCLUSION_COLS).order('played_at', { ascending: false }),
      supabase.from('hero_match_facts').select(MATCH_FACT_COLS),
      supabase.from('hero_stat_facts').select(STAT_FACT_COLS),
    ])
    // MUST be awaited BEFORE isExcludedGame runs: the predicate reads a
    // synchronous cache that starts fully hidden, so calling it first would drop
    // every flagged game regardless of the switches.
    await loadExclusionPrefs()
    // visibleIds gates every fact row (match + stat). The set already honours the
    // alpha rule (matchQuery). Heroes is a performance surface, so the
    // excluded-games policy applies here too — by dropping those ids from the
    // visible set, which removes them from both grains at once.
    const idRows =
      (((mIds as unknown) as { data: ({ id: number } & ExcludableRow)[] | null }).data) || []
    const keptIds = idRows.filter(r => !isExcludedGame(r))
    setVisibleIds(new Set(keptIds.map(r => r.id)))
    setMatchFacts((mf as MatchFactRow[] | null) || [])
    setStatFacts((sf as StatFactRow[] | null) || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Season predicate: [] = All Time (no filter); else the row's season must be
  // one of the selected ids (null season only shows under All Time).
  const seasonOk = useCallback((sid: number | null) => {
    if (seasonSel.length === 0) return true
    return sid != null && seasonSel.includes(sid)
  }, [seasonSel])

  // (v1.1.0 Phase 2) Mode and map are multi-select. OR within each list, AND
  // between them; [] = no filter. A row with a null mode/map belongs to none of
  // the ticked options, so it shows only under the empty selection — identical
  // to the old `mode && r.game_mode !== mode` behaviour.
  const modeMapOk = useCallback((gm: string | null, mp: string | null) => {
    if (modes.length > 0 && !(gm != null && (modes as string[]).includes(gm))) return false
    if (maps.length > 0 && !(mp != null && maps.includes(mp))) return false
    return true
  }, [modes, maps])

  // Shared row filter: alpha-excluded, format, season, mode, map.
  const matchRowsInScope = useMemo(() => {
    return matchFacts.filter(r => {
      if (!visibleIds.has(r.match_id)) return false
      if (r.match_format !== format) return false
      if (!seasonOk(r.season_id)) return false
      if (!modeMapOk(r.game_mode, r.map)) return false
      return true
    })
  }, [matchFacts, visibleIds, format, seasonOk, modeMapOk])

  const statRowsInScope = useMemo(() => {
    return statFacts.filter(r => {
      if (!visibleIds.has(r.match_id)) return false
      if (r.match_format !== format) return false
      if (!seasonOk(r.season_id)) return false
      if (!modeMapOk(r.game_mode, r.map)) return false
      return true
    })
  }, [statFacts, visibleIds, format, seasonOk, modeMapOk])

  // ---- aggregate per hero (games-weighted, one match counted once) ----
  interface HeroAgg {
    hero_name: string
    /** (v1.2.0) Role in the hero's most recent game in scope — a hero's role
     *  can change between seasons (Sombra: DPS -> support at Season 5). */
    role: HeroRole | undefined
    /** Every role the hero held across the games in scope, oldest first. */
    roles: HeroRole[]
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
      // Roles in date order. ISO played_at strings sort chronologically; a
      // missing date falls back to the current role (heroRoleAt with no date).
      const dated = [...rows].sort((a, b) => (a.played_at ?? '').localeCompare(b.played_at ?? ''))
      const roles: HeroRole[] = []
      for (const r of dated) {
        const role = heroRoleAt(hero, r.played_at)
        if (role && !roles.includes(role)) roles.push(role)
      }
      out.push({
        hero_name: hero,
        role: dated.length ? heroRoleAt(hero, dated[dated.length - 1].played_at) : heroRoleAt(hero),
        roles,
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
  if (roleTab !== 'all') heroes = heroes.filter(h => h.role === roleTab)
  // (v1.1.0 Phase 5) Sortable. Games remains the default.
  //
  // ⚠️ A null win rate means NO DECISIVE GAMES (all draws) — not a zero. Those
  // heroes sink to the bottom under the win-rate sort rather than sorting as 0%,
  // which would rank "never won or lost" below a genuine 0% and above nothing.
  // Games is the tiebreak either way, so equal win rates put the larger sample
  // first — the same convention the matchups lists use.
  heroes.sort((a, b) => {
    if (sortBy === 'win_rate') {
      const aw = a.win_rate, bw = b.win_rate
      if (aw == null && bw == null) return b.games - a.games
      if (aw == null) return 1
      if (bw == null) return -1
      if (bw !== aw) return bw - aw
    }
    return b.games - a.games
  })

  const fmtToggle = (f: Format) => (
    <button key={f} onClick={() => { setFormat(f); setExpanded(null) }}
      className={`px-5 py-1.5 rounded-lg text-sm font-display tracking-wider transition-colors
        ${format === f ? 'bg-ow-orange text-ow-dark font-bold'
                       : 'bg-ow-panel text-ow-muted hover:text-ow-fg border border-ow-line'}`}>
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
        <div className="flex flex-col gap-1">
          <span className={labelCls}>Season</span>
          <MultiSelect<number>
            className={selectCls}
            value={seasonSel}
            onChange={sel => { setSeasonSel(sel); setExpanded(null) }}
            options={seasons.map(s => ({ value: s.id, label: s.name }))}
            allLabel="All Time"
            noun="seasons"
            aria-label="Season"
          />
        </div>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Game Mode</span>
          <MultiSelect<GameMode>
            className={selectCls}
            value={modes}
            onChange={next => {
              // Drop any selected map that no longer belongs to one of the chosen
              // modes. Clearing to "All modes" widens the offer, so nothing is
              // dropped — widening never destroys picks.
              const offered = new Set(mapNamesForModes(next))
              setMaps(prev => prev.filter(m => offered.has(m)))
              setModes(next)
              setExpanded(null)
            }}
            options={GAME_MODES.map(m => ({ value: m, label: m }))}
            allLabel="All modes"
            noun="modes"
            aria-label="Game Mode"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={labelCls}>Map</span>
          <MultiSelect<string>
            className={selectCls}
            value={maps}
            onChange={m => { setMaps(m); setExpanded(null) }}
            options={mapNamesForModes(modes).map(m => ({ value: m, label: m }))}
            allLabel="All maps"
            noun="maps"
            searchable
            searchPlaceholder="Search maps…"
            aria-label="Map"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {(['all', 'tank', 'dps', 'support'] as RoleTab[]).map(role => (
            <button key={role} onClick={() => { setRoleTab(role); setExpanded(null) }}
              className={`px-4 py-1.5 rounded-lg text-sm font-display tracking-wider transition-colors
                ${roleTab === role ? 'bg-ow-orange text-ow-dark font-bold'
                                   : 'bg-ow-panel text-ow-muted hover:text-ow-fg border border-ow-line'}`}>
              {role.toUpperCase()}
            </button>
        ))}
        </div>

        {/* (v1.1.0 Phase 5) Sort toggle. Sits opposite the role tabs — same row,
            since both narrow/order the one list below. */}
        <div className="flex items-center gap-2">
          <span className={labelCls}>Sort by</span>
          <div className="flex gap-2">
            {([['games', 'GAMES'], ['win_rate', 'WIN RATE']] as [HeroSort, string][]).map(([key, label]) => (
              <button key={key} onClick={() => { setSortBy(key); setExpanded(null) }}
                className={`px-4 py-1.5 rounded-lg text-sm font-display tracking-wider transition-colors
                  ${sortBy === key ? 'bg-ow-orange text-ow-dark font-bold'
                                   : 'bg-ow-panel text-ow-muted hover:text-ow-fg border border-ow-line'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-sm text-ow-muted">{heroes.length} heroes · {format.toUpperCase()} · min {MIN_GAMES} games</p>

      {loading ? (
        <div className="text-center py-12 text-ow-muted font-display tracking-wider">LOADING…</div>
      ) : heroes.length === 0 ? (
        <div className="text-center py-16 text-ow-muted">
          <p className="font-display text-lg tracking-wider">No heroes yet</p>
          <p className="text-sm mt-1 text-ow-muted">
            {seasonSel.length > 0 && seasons.length === 0
              ? 'No seasons set up yet. Add one in Settings → Seasons, or pick All Time.'
              : `No heroes with ${MIN_GAMES}+ games in ${format.toUpperCase()} for these filters.`}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
          {heroes.map(h => {
            const role = h.role
            const shg = h.single_hero_games || 0
            const showStats = shg > MIN_PCT_GAMES
            const isOpen = expanded === h.hero_name
            const bd = bdByHero.get(h.hero_name)
            // (v1.2.0) Tiles for EVERY role held in scope, so a hero that changed
            // role keeps its earlier tiles (Sombra's Final Blows / Solo Kills)
            // when the filter reaches back before the change.
            const roleStats = Array.from(new Set(h.roles.flatMap(r => ROLE_BREAKDOWN[r])))

            return (
              <div key={h.hero_name}
                className="bg-ow-panel rounded-lg border border-ow-line hover:border-ow-orange/30 transition-colors overflow-hidden">
                <button onClick={() => setExpanded(isOpen ? null : h.hero_name)} className="w-full text-left p-4">
                  <div className="flex items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={heroPortrait(h.hero_name)} alt={h.hero_name}
                      className="w-12 h-12 rounded object-cover bg-ow-dark shrink-0"
                      onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
                    <div className="min-w-0 flex-1">
                      <h3 className="font-display text-ow-fg text-lg truncate">{h.hero_name}</h3>
                      <p className="text-[11px] text-ow-muted font-display tracking-wide uppercase">
                        {role ? ROLE_LABEL[role] : ''} · {h.games} games
                      </p>
                    </div>
                    <span className={`text-lg font-display font-bold ${winRateColor(h.win_rate)}`}>
                      {h.win_rate == null ? '—' : `${h.win_rate}%`}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center mt-3">
                    <div><p className="text-base font-display text-ow-fg">{h.games}</p><p className="text-[10px] text-ow-faint tracking-wider">PLAYED</p></div>
                    <div><p className="text-base font-display text-ow-victory">{h.wins}</p><p className="text-[10px] text-ow-faint tracking-wider">WINS</p></div>
                    <div><p className="text-base font-display text-ow-defeat">{h.losses}</p><p className="text-[10px] text-ow-faint tracking-wider">LOSSES</p></div>
                  </div>
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 pt-1 border-t border-ow-line space-y-3">
                    {roleStats.length > 0 && (
                      <div className="space-y-1.5">
                        {roleStats.map(sc => {
                          const v = bd?.get(sc)
                          return (
                            <div key={sc} className="flex items-center justify-between text-sm">
                              <span className="text-ow-muted font-display tracking-wide">{STAT_LABEL[sc] || sc}</span>
                              <span className="text-ow-fg font-display">
                                {v?.perGame != null ? v.perGame.toFixed(1) : '—'}
                                <span className="text-ow-faint text-xs"> /game</span>
                                {v?.per10 != null && <span className="text-ow-muted text-xs ml-2">{v.per10.toFixed(1)}/10min</span>}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {showStats ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-ow-muted font-display tracking-wide">Avg E / A / D</span>
                          <span className="text-ow-fg font-display">
                            {h.avg_elims?.toFixed(1) ?? '—'} / {h.avg_assists?.toFixed(1) ?? '—'} / {h.avg_deaths?.toFixed(1) ?? '—'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-ow-muted font-display tracking-wide">Damage % (of team)</span>
                          <span className="text-ow-fg font-display">{h.avg_damage_pct != null ? `${Math.round(h.avg_damage_pct * 10) / 10}%` : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-ow-muted font-display tracking-wide">Healing % (vs enemy dmg)</span>
                          <span className="text-ow-fg font-display">{h.avg_healing_pct != null ? `${Math.round(h.avg_healing_pct * 10) / 10}%` : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-ow-muted font-display tracking-wide">Mitigation % (vs enemy dmg)</span>
                          <span className="text-ow-fg font-display">{h.avg_mitigation_pct != null ? `${Math.round(h.avg_mitigation_pct * 10) / 10}%` : '—'}</span>
                        </div>
                        <p className="text-[10px] text-ow-faint pt-1">From {shg} single-hero games (≥{SINGLE_HERO_PCT}% played).</p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-ow-faint">
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
