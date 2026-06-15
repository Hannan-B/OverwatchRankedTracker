'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import Select from '@/components/Select'
import { matchQuery } from '@/lib/alpha'
import { loadLeaverPref, showLeaverGames } from '@/lib/leaver'
import { HEROES, MAPS, GAME_MODE_CONFIG, type GameMode } from '@/data/reference'
import { normaliseStat, formatStatValue, HERO_BREAKDOWN_ORDER, type BreakdownStat } from '@/data/stat-meta'

// ============================================================
// HERO DETAIL (/analytics/heroes/[name])  — moved into the Analytics area.
// - Role-specific stats at the TOP (most important).
// - Then the hero's FULL breakdown stat set (USER-ordered, from stat-meta), per-game and
//   per-10-min (per-10-min only for stats flagged hasPer10 in the ordered list).
// - Cascading map/mode/side filters affect everything.
// - Last 5 games with this hero.
// - Reads hero_stat_facts (full breakdown) + hero_match_facts (games/W-L/EAD/%).
// (Moved from /heroes/[name]; only the back-link path changed.)
// ============================================================

type Format = '5v5' | '6v6'
type Role = 'tank' | 'dps' | 'support'
const HERO_ROLE = new Map<string, Role>(HEROES.map(h => [h.name, h.role]))
const GAME_MODES = Object.keys(GAME_MODE_CONFIG) as GameMode[]
const mapsForMode = (mode: GameMode) => MAPS.filter(m => m.mode === mode).map(m => m.name).sort()
const modeHasSide = (mode: GameMode | '') => mode !== '' && GAME_MODE_CONFIG[mode].needsStartingSide

const ROLE_STAT: Record<Role, string[]> = {
  tank: ['OBJ CONTEST TIME'], dps: ['FINAL BLOWS', 'SOLO KILLS'], support: ['PLAYERS SAVED'],
}

interface StatFact {
  hero_name: string; match_id: number; map: string | null; game_mode: string | null
  starting_side: string | null; result: string; game_length_seconds: number | null
  is_single_hero: boolean; percent_played: number | null; stat_canonical: string; stat_num: number | null
}
interface MatchFact {
  match_id: number; map: string | null; game_mode: string | null; starting_side: string | null
  result: 'victory' | 'defeat' | 'draw'; played_at: string | null; is_single_hero: boolean; percent_played: number | null
  user_elims: number | null; user_assists: number | null; user_deaths: number | null
  damage_pct: number | null; healing_pct: number | null; mitigation_pct: number | null
}
interface Filters { format: Format; mode: GameMode | ''; map: string; side: 'attack' | 'defense' | ''; playtimePct: number }
// Playtime-% options for the single-hero stat block (default 95; can loosen to 90).
const PLAYTIME_PCT_OPTIONS = [95, 90] as const
const emptyFilters: Filters = { format: '5v5', mode: '', map: '', side: '', playtimePct: 95 }

const selectCls =
  'bg-ow-dark border border-ow-line rounded-lg px-3 py-2 text-sm text-ow-fg font-display tracking-wider focus:border-ow-orange focus:outline-none [color-scheme:dark]'
const labelCls = 'text-[11px] text-ow-muted font-display tracking-wider uppercase'

function heroPortrait(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/:/g, '')
  return `/heroes/${cleaned}.png`
}
function mean(vals: (number | null)[]): number | null {
  const n = vals.filter((v): v is number => v != null)
  return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null
}
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

export default function HeroDetailPage() {
  const params = useParams()
  const heroName = decodeURIComponent(String(params?.name || ''))
  const role = HERO_ROLE.get(heroName)

  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [statFacts, setStatFacts] = useState<StatFact[]>([])
  const [matchFacts, setMatchFacts] = useState<MatchFact[]>([])
  const [loading, setLoading] = useState(true)
  // Match ids of leaver games, to exclude from this hero's stats (a performance
  // surface) unless the Settings switch is on. Empty when leaver games are shown.
  const [excludedIds, setExcludedIds] = useState<Set<number>>(new Set())

  const buildQuery = useCallback((table: string, f: Filters) => {
    let q = supabase.from(table).select('*').eq('hero_name', heroName).eq('match_format', f.format)
    if (f.mode) q = q.eq('game_mode', f.mode)
    if (f.map) q = q.eq('map', f.map)
    if (f.side && modeHasSide(f.mode)) q = q.eq('starting_side', f.side)
    return q
  }, [heroName])

  // Load the leaver preference + the set of leaver match ids ONCE. When the
  // switch is off, those ids are excluded from this hero's stats below.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await loadLeaverPref()
      if (showLeaverGames()) { if (!cancelled) setExcludedIds(new Set()); return }
      const res = await matchQuery('id, team_leaver, enemy_leaver').order('played_at', { ascending: false })
      const rows =
        (((res as unknown) as { data: { id: number; team_leaver: boolean | null; enemy_leaver: boolean | null }[] | null }).data) || []
      const ids = rows.filter(r => r.team_leaver === true || r.enemy_leaver === true).map(r => r.id)
      if (!cancelled) setExcludedIds(new Set(ids))
    })()
    return () => { cancelled = true }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: sf }, { data: mf }] = await Promise.all([
      buildQuery('hero_stat_facts', filters),
      buildQuery('hero_match_facts', filters).order('played_at', { ascending: false }),
    ])
    setStatFacts((sf as StatFact[] | null) || [])
    setMatchFacts((mf as MatchFact[] | null) || [])
    setLoading(false)
  }, [buildQuery, filters])

  useEffect(() => { load() }, [load])

  // Leaver games are excluded from this performance surface (unless the switch is
  // on, in which case excludedIds is empty). Applied to BOTH fact grains before
  // any aggregation, so games / W-L / breakdown / last-5 all honour it.
  const visibleStatFacts = statFacts.filter(r => !excludedIds.has(r.match_id))
  const visibleMatchFacts = matchFacts.filter(r => !excludedIds.has(r.match_id))

  // ---- aggregate stat facts: per canonical stat, avg per game + per 10 ----
  const statAgg = new Map<string, { perGame: number | null; per10: number | null; n: number }>()
  {
    const byStat = new Map<string, StatFact[]>()
    for (const r of visibleStatFacts) {
      if (!byStat.has(r.stat_canonical)) byStat.set(r.stat_canonical, [])
      byStat.get(r.stat_canonical)!.push(r)
    }
    for (const [stat, rows] of byStat) {
      statAgg.set(stat, {
        perGame: mean(rows.map(r => r.stat_num)),
        per10: mean(rows.map(r =>
          r.stat_num != null && r.game_length_seconds && r.game_length_seconds > 0
            ? r.stat_num / (r.game_length_seconds / 600) : null)),
        n: rows.length,
      })
    }
  }

  // games / W-L / single-hero stats from match facts
  const games = visibleMatchFacts.length
  const wins = visibleMatchFacts.filter(m => m.result === 'victory').length
  const losses = visibleMatchFacts.filter(m => m.result === 'defeat').length
  const winRate = (wins + losses) === 0 ? null : Math.round((1000 * wins) / (wins + losses)) / 10
  // Single-hero block uses a LIVE playtime-% cut (default 95 == the old
  // is_single_hero flag; loosening to 90 includes 90-94% games). Falls back to
  // the frozen flag only if percent_played is missing on a row.
  const sh = visibleMatchFacts.filter(m =>
    m.percent_played != null ? m.percent_played >= filters.playtimePct : m.is_single_hero)
  const eadPct = {
    elims: mean(sh.map(m => m.user_elims)), assists: mean(sh.map(m => m.user_assists)),
    deaths: mean(sh.map(m => m.user_deaths)), dmg: mean(sh.map(m => m.damage_pct)),
    heal: mean(sh.map(m => m.healing_pct)), mit: mean(sh.map(m => m.mitigation_pct)),
  }

  const last5 = visibleMatchFacts.slice(0, 5)

  // role-specific stats (top), drawn from statAgg
  const roleStats = role ? ROLE_STAT[role] : []
  // full breakdown set in the USER's specified order (from stat-meta), excluding
  // any role stats (those are pinned on top). Falls back to empty if hero absent.
  const orderedBreakdown: BreakdownStat[] = (HERO_BREAKDOWN_ORDER[heroName] || [])
    .filter(s => !roleStats.includes(s.canonical))

  // Column header row for the two-column stat layout (per-game / per-10-min).
  function StatHeader() {
    return (
      <div className="grid grid-cols-[1.6fr_1fr_1fr] gap-2 text-[10px] text-ow-faint font-display tracking-wider uppercase pb-1 border-b border-ow-line">
        <span>Stat</span>
        <span className="text-right">Per Game</span>
        <span className="text-right">Per 10 Min</span>
      </div>
    )
  }

  // Two columns: per-game / per-10-min. (Per-round removed — rounds/match isn't
  // stored, so it was always a '—' placeholder; dropped from the UX per user.)
  // Accepts either a BreakdownStat (label/canonical/fmt from the user-ordered list)
  // or a bare role-stat name. Values formatted per type (% / m:ss / number).
  function StatLine({ stat, name, hasPer10 }: { stat?: BreakdownStat; name?: string; hasPer10?: boolean }) {
    const label = stat ? stat.label : (name || '')
    const canon = stat ? stat.canonical : normaliseStat(name || '')
    const showPer10 = stat ? stat.hasPer10 : !!hasPer10
    const a = statAgg.get(canon) || statAgg.get((name || '').toUpperCase())
    return (
      <div className="grid grid-cols-[1.6fr_1fr_1fr] gap-2 text-sm py-1.5 border-b border-ow-line">
        <span className="text-ow-muted font-display tracking-wide">{titleCase(label)}</span>
        <span className="text-ow-fg font-display text-right">{formatStatValue(canon, a?.perGame ?? null)}</span>
        <span className="text-ow-muted font-display text-right">{showPer10 ? formatStatValue(canon, a?.per10 ?? null) : '—'}</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link href="/analytics/heroes" className="text-sm text-ow-muted hover:text-ow-orange font-display tracking-wider">← Heroes</Link>

      {/* header */}
      <div className="flex items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={heroPortrait(heroName)} alt={heroName}
          className="w-16 h-16 rounded bg-ow-panel object-cover"
          onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }} />
        <div>
          <h1 className="font-display text-3xl tracking-[0.1em] text-ow-fg uppercase">{heroName}</h1>
          <p className="text-sm text-ow-muted mt-0.5">
            {role ? role.toUpperCase() : ''} · {games} games · {winRate == null ? '—' : `${winRate}% WR`}
          </p>
        </div>
      </div>

      {/* filters */}
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1"><span className={labelCls}>Format</span>
          <Select<Format>
            className={selectCls}
            value={filters.format}
            onChange={format => setFilters({ ...filters, format })}
            options={[
              { value: '5v5', label: '5v5' },
              { value: '6v6', label: '6v6' },
            ]}
          /></label>
        <label className="flex flex-col gap-1"><span className={labelCls}>Game Mode</span>
          <Select<GameMode | ''>
            className={selectCls}
            value={filters.mode}
            onChange={mode => setFilters({ ...filters, mode, map: '', side: modeHasSide(mode) ? filters.side : '' })}
            options={[
              { value: '', label: 'All modes' },
              ...GAME_MODES.map(m => ({ value: m, label: m })),
            ]}
          /></label>
        {filters.mode && (
          <label className="flex flex-col gap-1"><span className={labelCls}>Map</span>
            <Select<string>
              className={selectCls}
              value={filters.map}
              onChange={map => setFilters({ ...filters, map })}
              options={[
                { value: '', label: `All ${filters.mode} maps` },
                ...mapsForMode(filters.mode).map(m => ({ value: m, label: m })),
              ]}
            /></label>
        )}
        {modeHasSide(filters.mode) && (
          <label className="flex flex-col gap-1"><span className={labelCls}>Starting Side</span>
            <Select<'attack' | 'defense' | ''>
              className={selectCls}
              value={filters.side}
              onChange={side => setFilters({ ...filters, side })}
              options={[
                { value: '', label: 'Either side' },
                { value: 'attack', label: 'Attack first' },
                { value: 'defense', label: 'Defense first' },
              ]}
            /></label>
        )}
        {/* Playtime-% — the single-hero cut for the E/A/D + share block. Default
            95 matches the old behaviour; 90 loosens it to include 90–94% games. */}
        <label className="flex flex-col gap-1"><span className={labelCls}>Playtime %</span>
          <Select<number>
            className={selectCls}
            value={filters.playtimePct}
            onChange={playtimePct => setFilters({ ...filters, playtimePct })}
            options={PLAYTIME_PCT_OPTIONS.map(p => ({ value: p, label: `${p}%+` }))}
          /></label>
      </div>

      {loading ? (
        <div className="text-center py-12 text-ow-muted font-display tracking-wider">LOADING…</div>
      ) : games === 0 ? (
        <div className="text-center py-16 text-ow-muted">
          <p className="font-display text-lg tracking-wider">No games</p>
          <p className="text-sm mt-1 text-ow-muted">No {heroName} games match these filters.</p>
        </div>
      ) : (
        <>
          {/* ROLE-SPECIFIC STATS — top */}
          {roleStats.length > 0 && (
            <div className="bg-ow-panel rounded-lg p-4 border border-ow-orange/30">
              <h2 className="font-display text-ow-orange text-sm tracking-wider uppercase mb-2">Role stats</h2>
              <StatHeader />
              {roleStats.map(s => <StatLine key={s} name={s} hasPer10 />)}
            </div>
          )}

          {/* FULL BREAKDOWN SET — user-specified order */}
          <div className="bg-ow-panel rounded-lg p-4 border border-ow-line">
            <h2 className="font-display text-ow-fg text-sm tracking-wider uppercase mb-2">Hero breakdown stats</h2>
            {orderedBreakdown.length === 0 ? (
              <p className="text-sm text-ow-faint">No breakdown stats configured for this hero.</p>
            ) : (
              <div>
                <StatHeader />
                {orderedBreakdown.map(s => <StatLine key={s.canonical} stat={s} />)}
              </div>
            )}
          </div>

          {/* LAST 5 GAMES */}
          <div className="bg-ow-panel rounded-lg p-4 border border-ow-line">
            <h2 className="font-display text-ow-fg text-sm tracking-wider uppercase mb-2">Last {last5.length} games</h2>
            <div className="space-y-1.5">
              {last5.map(m => (
                <div key={m.match_id} className="flex items-center justify-between text-sm border-b border-ow-line pb-1.5">
                  <span className="text-ow-fg font-display">{m.map || '—'}</span>
                  <span className="text-ow-muted text-xs">{m.game_mode || ''}{m.starting_side ? ` · ${m.starting_side}` : ''}</span>
                  <span className={`font-display font-bold text-xs ${m.result === 'victory' ? 'text-ow-victory' : m.result === 'defeat' ? 'text-ow-defeat' : 'text-ow-draw'}`}>
                    {m.result.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* PERFORMANCE — single-hero E/A/D + % (bottom) */}
          <div className="bg-ow-panel rounded-lg p-4 border border-ow-line">
            <h2 className="font-display text-ow-fg text-sm tracking-wider uppercase mb-2">
              Performance <span className="text-[10px] text-ow-faint">· single-hero games ({sh.length})</span>
            </h2>
            {sh.length === 0 ? (
              <p className="text-sm text-ow-faint">No ≥{filters.playtimePct}%-played games in this filter, so per-match performance stats aren’t available.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div><p className="text-ow-muted text-xs">Avg E/A/D</p><p className="text-ow-fg font-display">{eadPct.elims?.toFixed(1) ?? '—'} / {eadPct.assists?.toFixed(1) ?? '—'} / {eadPct.deaths?.toFixed(1) ?? '—'}</p></div>
                <div><p className="text-ow-muted text-xs">Damage % (team)</p><p className="text-ow-fg font-display">{eadPct.dmg != null ? `${Math.round(eadPct.dmg * 10) / 10}%` : '—'}</p></div>
                <div><p className="text-ow-muted text-xs">Healing % (vs enemy)</p><p className="text-ow-fg font-display">{eadPct.heal != null ? `${Math.round(eadPct.heal * 10) / 10}%` : '—'}</p></div>
                <div><p className="text-ow-muted text-xs">Mitigation % (vs enemy)</p><p className="text-ow-fg font-display">{eadPct.mit != null ? `${Math.round(eadPct.mit * 10) / 10}%` : '—'}</p></div>
              </div>
            )}
          </div>

          <p className="text-[11px] text-ow-faint">
            Per-game uses all games where you played {heroName} ≥1 min. “/10min” shown for stats that have a per-10-min figure.
            Performance %s use only ≥{filters.playtimePct}%-played games. For side-by-side splits, use the <Link href="/compare" className="text-ow-orange hover:underline">Compare</Link> page.
          </p>
        </>
      )}
    </div>
  )
}
