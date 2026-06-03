'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { HEROES } from '@/data/reference'

// ============================================================
// HERO ANALYTICS (Phase 2)
// - Reads the verified SQL views: hero_card_stats + hero_breakdown_stats
// - Controls: 5v5 / 6v6 format toggle  +  role row (All/Tank/DPS/Support)
//   HARD RULE: 5v5 and 6v6 never mix (the view is keyed by match_format;
//   we query one format at a time).
// - Cards: portrait, games, W, L, W/L%.  Appear only at games >= 5.
// - Percentage block (dmg%/heal%/mit%) + avg E/A/D show only when the hero
//   has MORE THAN 5 single-hero (>=95%) games; the card labels that sample.
// - Breakdown stats per role (Tank: Obj Contest; DPS: Final Blows + Solo
//   Kills; Support: Players Saved), per-game and per-10-min.
// - Season scope mirrors Match History (current / specific / all time).
// ============================================================

type Format = '5v5' | '6v6'
type RoleTab = 'all' | 'tank' | 'dps' | 'support'
const MIN_GAMES = 5            // hero appears on the page at >= this many games
const MIN_PCT_GAMES = 5        // % / E-A-D block shows at MORE THAN this many single-hero games

// hero -> real role, from reference data (single source of truth)
const HERO_ROLE = new Map<string, 'tank' | 'dps' | 'support'>(HEROES.map(h => [h.name, h.role]))

// Portrait filename rule, derived from the real /public/heroes listing:
// filename == hero name, EXCEPT strip accents and remove colons.
// (Soldier: 76 -> "Soldier 76", Torbjörn -> "Torbjorn", Lúcio -> "Lucio";
//  all other 48 match exactly, including spaces and the "." in D.Va.)
function heroPortrait(name: string): string {
  const cleaned = name
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/:/g, '')                                  // remove colons
  return `/heroes/${cleaned}.png`
}

interface CardRow {
  hero_name: string
  match_format: Format
  season_id: number | null
  games: number
  wins: number
  losses: number
  draws: number
  win_rate: number | null
  single_hero_games: number | null
  avg_damage_pct: number | null
  avg_healing_pct: number | null
  avg_mitigation_pct: number | null
  avg_elims: number | null
  avg_assists: number | null
  avg_deaths: number | null
  avg_elims_per_10: number | null
  avg_assists_per_10: number | null
  avg_deaths_per_10: number | null
}
interface BreakdownRow {
  hero_name: string
  match_format: Format
  season_id: number | null
  stat_canonical: string
  games_with_stat: number
  avg_per_game: number | null
  avg_per_10_min: number | null
}
interface SeasonRow { id: number; name: string; start_date: string; end_date: string }

// which breakdown stats to surface per role, in display order
const ROLE_BREAKDOWN: Record<'tank' | 'dps' | 'support', string[]> = {
  tank:    ['OBJ CONTEST TIME'],
  dps:     ['FINAL BLOWS', 'SOLO KILLS'],
  support: ['PLAYERS SAVED'],
}
const STAT_LABEL: Record<string, string> = {
  'OBJ CONTEST TIME': 'Obj Contest', 'FINAL BLOWS': 'Final Blows',
  'SOLO KILLS': 'Solo Kills', 'PLAYERS SAVED': 'Players Saved',
}
const ROLE_LABEL: Record<string, string> = { tank: 'TANK', dps: 'DPS', support: 'SUPPORT' }

const winRateColor = (wr: number | null) =>
  wr == null ? 'text-slate-400' : wr >= 55 ? 'text-ow-victory' : wr <= 45 ? 'text-ow-defeat' : 'text-ow-draw'

export default function HeroAnalyticsPage() {
  const [cards, setCards] = useState<CardRow[]>([])
  const [breakdowns, setBreakdowns] = useState<BreakdownRow[]>([])
  const [loading, setLoading] = useState(true)
  const [format, setFormat] = useState<Format>('5v5')
  const [roleTab, setRoleTab] = useState<RoleTab>('all')
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
    // If no current season is configured (e.g. during testing, or matches with
    // no season_id), default the scope to All Time so the page is usable instead
    // of showing an empty "current season" view. Only do this once, and never
    // override a choice the user has already made.
    if (!scopeDefaulted.current) {
      scopeDefaulted.current = true
      if (current?.id == null) setScope('all')
    }

    const [{ data: cardData }, { data: bdData }] = await Promise.all([
      supabase.from('hero_card_stats').select('*'),
      supabase.from('hero_breakdown_stats').select('*'),
    ])
    setCards((cardData as CardRow[] | null) || [])
    setBreakdowns((bdData as BreakdownRow[] | null) || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // The views are per (hero, format, season). For an "all time" scope we sum
  // across seasons; for a specific season we filter to it. We aggregate in the
  // page so the SQL stays simple and verifiable.
  const seasonId = scope === 'current' ? currentSeasonId : scope === 'all' ? null : scope

  function inScope<T extends { season_id: number | null }>(rows: T[]): T[] {
    if (scope === 'all') return rows
    if (seasonId == null) return [] // current scope but no current season set
    return rows.filter(r => r.season_id === seasonId)
  }

  // Aggregate card rows for the chosen format + scope into one row per hero.
  // Win/loss sums are exact; for averages we do a games-weighted mean so that
  // combining seasons stays honest (a 20-game season weighs more than a 6-game one).
  type Agg = CardRow & { _shg: number }
  const aggByHero = new Map<string, Agg>()
  for (const r of inScope(cards).filter(r => r.match_format === format)) {
    const cur = aggByHero.get(r.hero_name)
    if (!cur) {
      aggByHero.set(r.hero_name, { ...r, _shg: r.single_hero_games || 0 })
    } else {
      // weighted accumulation
      const g1 = cur.games, g2 = r.games
      const wmean = (a: number | null, b: number | null, wa: number, wb: number) => {
        if (a == null && b == null) return null
        if (a == null) return b
        if (b == null) return a
        const tot = wa + wb
        return tot === 0 ? null : (a * wa + b * wb) / tot
      }
      const s1 = cur._shg, s2 = r.single_hero_games || 0
      cur.games += g2; cur.wins += r.wins; cur.losses += r.losses; cur.draws += r.draws
      cur.avg_elims = wmean(cur.avg_elims, r.avg_elims, s1, s2)
      cur.avg_assists = wmean(cur.avg_assists, r.avg_assists, s1, s2)
      cur.avg_deaths = wmean(cur.avg_deaths, r.avg_deaths, s1, s2)
      cur.avg_elims_per_10 = wmean(cur.avg_elims_per_10, r.avg_elims_per_10, s1, s2)
      cur.avg_assists_per_10 = wmean(cur.avg_assists_per_10, r.avg_assists_per_10, s1, s2)
      cur.avg_deaths_per_10 = wmean(cur.avg_deaths_per_10, r.avg_deaths_per_10, s1, s2)
      cur.avg_damage_pct = wmean(cur.avg_damage_pct, r.avg_damage_pct, s1, s2)
      cur.avg_healing_pct = wmean(cur.avg_healing_pct, r.avg_healing_pct, s1, s2)
      cur.avg_mitigation_pct = wmean(cur.avg_mitigation_pct, r.avg_mitigation_pct, s1, s2)
      cur._shg += s2
    }
  }
  for (const a of aggByHero.values()) {
    a.single_hero_games = a._shg
    a.win_rate = (a.wins + a.losses) === 0 ? null
      : Math.round((1000 * a.wins) / (a.wins + a.losses)) / 10
  }

  let heroes = Array.from(aggByHero.values()).filter(h => h.games >= MIN_GAMES)
  if (roleTab !== 'all') heroes = heroes.filter(h => HERO_ROLE.get(h.hero_name) === roleTab)
  heroes.sort((a, b) => b.games - a.games)

  // breakdown lookup: hero -> canonical -> games-weighted avg, for this format+scope
  const bdByHero = new Map<string, Map<string, { perGame: number | null; per10: number | null }>>()
  for (const r of inScope(breakdowns).filter(r => r.match_format === format)) {
    let m = bdByHero.get(r.hero_name)
    if (!m) { m = new Map(); bdByHero.set(r.hero_name, m) }
    const prev = m.get(r.stat_canonical)
    if (!prev) {
      m.set(r.stat_canonical, { perGame: r.avg_per_game, per10: r.avg_per_10_min })
    } else {
      // simple mean across seasons (breakdown rows don't carry their own weight;
      // good enough for display, and single-season scope is the common case)
      const avg = (a: number | null, b: number | null) =>
        a == null ? b : b == null ? a : (a + b) / 2
      m.set(r.stat_canonical, {
        perGame: avg(prev.perGame, r.avg_per_game),
        per10: avg(prev.per10, r.avg_per_10_min),
      })
    }
  }

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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-[0.12em] text-slate-100 uppercase">Hero Analytics</h1>
          <p className="text-sm text-slate-400 mt-1">{heroes.length} heroes · {format.toUpperCase()} · min {MIN_GAMES} games</p>
        </div>
        <Link href="/compare"
          className="shrink-0 bg-ow-orange text-ow-dark font-display font-bold text-sm tracking-wider px-4 py-2 rounded-lg hover:opacity-90 transition-opacity">
          COMPARE →
        </Link>
      </div>

      {/* Controls: format toggle + season + role row */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400 font-display tracking-wider uppercase">Format</span>
          <div className="flex gap-2">{(['5v5', '6v6'] as Format[]).map(fmtToggle)}</div>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400 font-display tracking-wider uppercase">Season</span>
          <select
            className="bg-ow-dark border border-white/20 rounded-lg px-3 py-2 text-sm text-slate-100 font-display tracking-wider focus:border-ow-orange focus:outline-none [color-scheme:dark]"
            value={String(scope)}
            onChange={e => { const v = e.target.value; setScope(v === 'current' || v === 'all' ? v : Number(v)); setExpanded(null) }}>
            {currentSeasonId && <option value="current">Current</option>}
            {seasons.filter(s => s.id !== currentSeasonId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="all">All Time</option>
          </select>
        </label>
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

      {loading ? (
        <div className="text-center py-12 text-slate-300 font-display tracking-wider">LOADING…</div>
      ) : heroes.length === 0 ? (
        <div className="text-center py-16 text-slate-300">
          <p className="font-display text-lg tracking-wider">No heroes yet</p>
          <p className="text-sm mt-1 text-slate-400">
            {scope === 'current' && !currentSeasonId
              ? 'No current season set. Add one in Settings → Seasons, or pick All Time.'
              : `No heroes with ${MIN_GAMES}+ games in ${format.toUpperCase()} for this scope.`}
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
                    {/* Breakdown stats — always available (>=1-min games) */}
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

                    {/* Percentage + E/A/D block — only with enough single-hero games */}
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
                          <span className="text-white font-display">{h.avg_damage_pct != null ? `${h.avg_damage_pct}%` : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-300 font-display tracking-wide">Healing % (vs enemy dmg)</span>
                          <span className="text-white font-display">{h.avg_healing_pct != null ? `${h.avg_healing_pct}%` : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-300 font-display tracking-wide">Mitigation % (vs enemy dmg)</span>
                          <span className="text-white font-display">{h.avg_mitigation_pct != null ? `${h.avg_mitigation_pct}%` : '—'}</span>
                        </div>
                        <p className="text-[10px] text-slate-500 pt-1">From {shg} single-hero games (≥95% played).</p>
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-500">
                        Damage/healing/mitigation and avg E/A/D need more than {MIN_PCT_GAMES} single-hero games
                        (≥95% played). This hero has {shg}.
                      </p>
                    )}
                    <Link href={`/heroes/${encodeURIComponent(h.hero_name)}`}
                      onClick={e => e.stopPropagation()}
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
