'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { matchQuery } from '@/lib/alpha'
import { formatBritishDate } from '@/lib/date-format'
import Link from 'next/link'
import { AnalyticsMenu } from '@/components/AnalyticsNav'
import { currentSeasonId } from '@/lib/season-util'
import { HEROES } from '@/data/reference'
import { showLeaverGames, loadLeaverPref } from '@/lib/leaver'

// ============================================================
// HOME — career-profile landing (Phase 2)
//
// Glanceable, not a dense dashboard:
//   - Four season win-rate cards: Tank(5v5)/DPS(5v5)/Support(5v5)/6v6
//   - Identity stats: total games this season + per the 4 categories
//   - Last-10 results as W/L pips
//   - Small "last 5" win-rate box
//   - Season scope toggle: current season (default) / each season / all-time
//
// Reads base `matches` for the aggregates (needs role_played, match_format,
// season_id, result) and `match_overview` for the recent-matches strip.
//
// -- NEXT-STEPS #14 -- CURRENT-SEASON OVERVIEW (added below the recent-form pips,
//    above the Analytics menu) --
// A second block, ALWAYS locked to the CURRENT season (independent of the scope
// toggle above -- that toggle still drives the original cards/totals). It reads
// per-hero rows from `hero_performances` joined to `matches`, then renders, split
// by queue (5v5 / 6v6) x role (Tank / DPS / Support):
//   1. Most-played heroes by GAMES (hero-appearances >= the 30s time floor)
//   2. Most-played heroes by TIME (summed play_time_seconds)
//   3. Queues x game-modes played
//   4. Time played per mode per queue
//   5. Top-3 maps per queue x role
// The original "Games Played - total" panel already covers the season total, so
// the new block doesn't repeat it.
// ============================================================

interface SeasonRow { id: string; name: string; start_date: string; end_date: string }
interface MatchRow {
  id: string
  result: 'victory' | 'defeat' | 'draw' | null
  role_played: string | null
  match_format: '5v5' | '6v6' | null
  season_id: string | null
  played_at: string | null
  map: string | null
  game_mode: string | null
  team_leaver: boolean | null
  enemy_leaver: boolean | null
}

// Per-hero appearance row from hero_performances. play_time_seconds / percent_played
// can arrive as string | number | null from Supabase, so they're coerced via num()
// before any comparison or arithmetic (handover lesson 74).
interface HeroPerfRow {
  match_id: string
  hero_name: string | null
  percent_played: number | string | null
  play_time_seconds: number | string | null
}

// -- shared constants --
// Time floor for "counts as a game you played this hero in". Mirrors the app-wide
// 30s hard floor (v38 lowered the view floor 60->30; this is the read-side gate).
const TIME_FLOOR_SECONDS = 30

type Queue = '5v5' | '6v6'
type Role = 'tank' | 'dps' | 'support'
const QUEUES: Queue[] = ['5v5', '6v6']
const ROLES: Role[] = ['tank', 'dps', 'support']
const ROLE_LABEL: Record<Role, string> = { tank: 'Tank', dps: 'DPS', support: 'Support' }

// hero display-name -> role (display names are the SAME scheme used in the DB;
// safe-names are only for portrait filenames -- handover section 5).
const HERO_ROLE: Record<string, Role> = Object.fromEntries(
  HEROES.map(h => [h.name, h.role as Role]),
)

// Portrait path for a hero. Files live at public/heroes/{file}.png. VERIFIED
// against the real folder: the filename equals the display name for all heroes
// EXCEPT the three whose display names carry filename-awkward characters. The
// path is URL-encoded so spaces (e.g. "Jetpack Cat") and dots resolve correctly.
const PORTRAIT_FILE: Record<string, string> = {
  'Soldier: 76': 'Soldier 76', // colon dropped on disk
  'Torbjörn': 'Torbjorn',      // o-umlaut -> o
  'Lúcio': 'Lucio',            // u-acute -> u
}
function heroPortrait(hero: string): string {
  const base = PORTRAIT_FILE[hero] ?? hero
  return `/heroes/${encodeURIComponent(base)}.png`
}

// Coerce the string|number|null the views/tables hand back into a real number.
function num(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

// "1h 23m" / "12m" / "0m" from a seconds total.
function fmtDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// "escort" -> "Escort" (game_mode values arrive lower-case from the DB).
function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)
}

// ---- win-rate helper for a filtered set ----
function winRate(rows: MatchRow[]): { pct: number; w: number; l: number; total: number } {
  const w = rows.filter(r => r.result === 'victory').length
  const l = rows.filter(r => r.result === 'defeat').length
  const total = rows.length
  return { pct: total ? Math.round((w / total) * 100) : 0, w, l, total }
}

// ---- leaver split for a filtered set ----
// Three MUTUALLY EXCLUSIVE buckets so they sum to the leaver-game total:
//   ally  = team leaver only - enemy = enemy leaver only - both = both teams.
// Always counted from raw matches (the callout is about leaver games, so it
// ignores the Settings "show leaver games" switch entirely).
interface LeaverSplit { ally: number; enemy: number; both: number; total: number }
function leaverSplit(rows: MatchRow[]): LeaverSplit {
  let ally = 0, enemy = 0, both = 0
  for (const r of rows) {
    const t = r.team_leaver === true
    const e = r.enemy_leaver === true
    if (t && e) both++
    else if (t) ally++
    else if (e) enemy++
  }
  return { ally, enemy, both, total: ally + enemy + both }
}

// Small per-card line: "Leavers -- A:x E:y Both:z" (always shown, 0s included).
function LeaverLine({ rows }: { rows: MatchRow[] }) {
  const s = leaverSplit(rows)
  return (
    <p className="relative text-[10px] text-ow-faint font-display tracking-wider uppercase mt-1.5">
      Leavers — <span className="text-ow-muted">A:{s.ally}</span>{' '}
      <span className="text-ow-muted">E:{s.enemy}</span>{' '}
      <span className="text-ow-muted">Both:{s.both}</span>
    </p>
  )
}

// ---- one career-profile win-rate card ----
function WinRateCard({ title, rows }: { title: string; rows: MatchRow[] }) {
  const { pct, w, l, total } = winRate(rows)
  const tone = total === 0 ? 'text-ow-faint'
    : pct >= 50 ? 'text-ow-victory' : 'text-ow-defeat'
  return (
    <div className="bg-ow-panel rounded-xl p-4 border border-ow-line relative overflow-hidden">
      <div aria-hidden className="absolute inset-0 opacity-40 pointer-events-none"
        style={{ background: 'radial-gradient(80% 60% at 50% 0%, rgba(249,158,26,0.06), transparent 70%)' }} />
      <p className="relative text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase">{title}</p>
      <p className={`relative text-3xl font-display font-bold mt-1 ${tone}`}>
        {total === 0 ? '—' : `${pct}%`}
      </p>
      <p className="relative text-xs text-ow-faint mt-1">
        {total === 0 ? 'No games' : `${w}W – ${l}L · ${total} games`}
      </p>
      <LeaverLine rows={rows} />
    </div>
  )
}

// ============================================================
// CURRENT-SEASON OVERVIEW (#14) -- pure aggregation helpers
// ============================================================
// A "hero appearance" is one hero_performances row whose play_time >= the floor,
// joined to its match (for queue/map/mode). Role comes from the hero name.
interface Appearance {
  matchId: string
  queue: Queue
  role: Role | 'unknown'
  hero: string
  seconds: number
  map: string | null
  mode: string | null
}

// Build the appearance list from current-season matches + their hero rows.
// Only matches in `seasonMatches` (already current-season + leaver-filtered)
// contribute, so the joins inherit those rules for free.
function buildAppearances(
  seasonMatches: MatchRow[],
  heroRows: HeroPerfRow[],
): Appearance[] {
  const byId = new Map<string, MatchRow>()
  for (const m of seasonMatches) byId.set(m.id, m)

  const out: Appearance[] = []
  for (const hr of heroRows) {
    const m = byId.get(hr.match_id)
    if (!m || !m.match_format) continue // not a visible current-season match
    const secs = num(hr.play_time_seconds)
    if (secs < TIME_FLOOR_SECONDS) continue
    const hero = (hr.hero_name ?? '').trim()
    if (!hero) continue
    out.push({
      matchId: m.id,
      queue: m.match_format,
      role: HERO_ROLE[hero] ?? 'unknown',
      hero,
      seconds: secs,
      map: m.map,
      mode: m.game_mode,
    })
  }
  return out
}

// Top-N { key, games, seconds } for a filter over appearances.
interface Tally { key: string; games: number; seconds: number }
function topBy(
  apps: Appearance[],
  keyOf: (a: Appearance) => string | null,
  metric: 'games' | 'seconds',
  n: number,
): Tally[] {
  const acc = new Map<string, Tally>()
  for (const a of apps) {
    const k = keyOf(a)
    if (!k) continue
    const t = acc.get(k) ?? { key: k, games: 0, seconds: 0 }
    t.games += 1
    t.seconds += a.seconds
    acc.set(k, t)
  }
  return [...acc.values()]
    .sort((x, y) => (metric === 'games'
      ? y.games - x.games || y.seconds - x.seconds
      : y.seconds - x.seconds || y.games - x.games))
    .slice(0, n)
}

// ---- small presentational helpers for the overview tables ----
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase mb-2">{children}</p>
  )
}

// A compact panel holding one queue's worth of role columns.
function QueuePanel({ queue, children }: { queue: Queue; children: React.ReactNode }) {
  return (
    <div className="bg-ow-panel rounded-xl p-4 border border-ow-line">
      <p className="text-[11px] text-ow-orange font-display tracking-[0.15em] uppercase mb-3">{queue}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">{children}</div>
    </div>
  )
}

// A single role column: a heading + a list of "label ... value" rows (or em-dash).
// Each row may carry an optional `icon` URL (hero portrait); on load error the
// image hides itself so a missing file never shows a broken-image glyph.
function RoleColumn({
  role, rows,
}: { role: Role; rows: Array<{ label: string; value: string; icon?: string }> }) {
  return (
    <div className="bg-ow-dark/50 rounded-lg p-3">
      <p className="text-[10px] text-ow-faint font-display tracking-wider uppercase mb-2">{ROLE_LABEL[role]}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-ow-faint">—</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r, i) => (
            <li key={`${r.label}-${i}`} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 min-w-0">
                {r.icon && (
                  <img
                    src={r.icon}
                    alt=""
                    aria-hidden="true"
                    className="w-5 h-5 rounded object-cover bg-ow-panel shrink-0"
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                )}
                <span className="text-xs text-ow-muted truncate">{r.label}</span>
              </span>
              <span className="text-xs text-ow-muted font-display tabular-nums shrink-0">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function HomePage() {
  const [seasons, setSeasons] = useState<SeasonRow[]>([])
  // Season multi-select: [] = All Time; else exactly these season ids (strings,
  // matching matches.season_id typing on Home). Defaults to current season once known.
  const [seasonSel, setSeasonSel] = useState<string[]>([])
  const [allMatches, setAllMatches] = useState<MatchRow[]>([])
  const [heroPerf, setHeroPerf] = useState<HeroPerfRow[]>([])
  const [recent, setRecent] = useState<Array<{ id: string; result: string; map: string | null; played_at: string | null }>>([])
  const [loading, setLoading] = useState(true)
  // Re-render trigger once the leaver preference is loaded (it gates the overview).
  const [, setLeaverReady] = useState(false)
  const seasonDefaulted = useRef(false)

  const loadData = useCallback(async () => {
    setLoading(true)

    // Leaver preference into the sync cache (the overview tables read it).
    await loadLeaverPref()
    setLeaverReady(true)

    // Seasons (for the toggle + to find the current one)
    const { data: seasonData } = await supabase
      .from('seasons')
      .select('id, name, start_date, end_date')
      .order('start_date', { ascending: false })
    const seasonsList = (seasonData as SeasonRow[]) || []
    setSeasons(seasonsList)

    // Default to current season (the one whose range covers today) when one
    // exists; otherwise All Time ([]). Seeded once.
    const today = new Date()
    const current = seasonsList.find(s =>
      new Date(s.start_date) <= today && today <= new Date(s.end_date))
    if (!seasonDefaulted.current) {
      seasonDefaulted.current = true
      setSeasonSel(current ? [current.id] : [])
    }

    // All matches (aggregates computed client-side, filtered by scope).
    // game_mode added for the #14 queue x mode / map tables.
    // Routed through matchQuery so alpha (localhost test) matches are excluded
    // on the live site — same single-source-of-truth rule every other surface
    // uses. On localhost the dev switch still controls visibility.
    const { data: matchData } = await matchQuery(
      'id, result, role_played, match_format, season_id, played_at, map, game_mode, team_leaver, enemy_leaver',
    )
      .order('played_at', { ascending: false })
    setAllMatches((matchData as unknown as MatchRow[]) || [])

    // Per-hero rows for the #14 most-played / time / map tables. Joined to
    // matches client-side by match_id. Season/leaver scoping is applied on the
    // match side, so rows whose match isn't visible are dropped in the join.
    const { data: hpData } = await supabase
      .from('hero_performances')
      .select('match_id, hero_name, percent_played, play_time_seconds')
    setHeroPerf((hpData as HeroPerfRow[]) || [])

    // Recent strip from the overview view (last 10 overall)
    const { data: recentData } = await supabase
      .from('match_overview')
      .select('id, result, map, played_at')
      .order('played_at', { ascending: false })
      .limit(10)
    setRecent((recentData as typeof recent) || [])

    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // -- existing scope toggle (drives the original cards/totals/leaver box) --
  // Filter matches to the chosen seasons. [] = All Time (no filter). A match with
  // null season_id only appears under All Time.
  const allTime = seasonSel.length === 0
  const scoped = allTime
    ? allMatches
    : allMatches.filter(m => m.season_id != null && seasonSel.includes(m.season_id))

  // Four category sets
  const tank5 = scoped.filter(m => m.match_format === '5v5' && m.role_played === 'tank')
  const dps5 = scoped.filter(m => m.match_format === '5v5' && m.role_played === 'dps')
  const sup5 = scoped.filter(m => m.match_format === '5v5' && m.role_played === 'support')
  const six = scoped.filter(m => m.match_format === '6v6')

  const last5 = winRate(scoped.slice(0, 5))
  const last10 = scoped.slice(0, 10)

  // Grand-total leaver split for the current scope (always shown).
  const leaversAll = leaverSplit(scoped)

  // Label for the current selection: "All Time", one season's name, or "N seasons".
  const scopeLabel = allTime
    ? 'All Time'
    : seasonSel.length === 1
      ? (seasons.find(s => s.id === seasonSel[0])?.name ?? 'Season')
      : `${seasonSel.length} seasons`

  // -- #14 CURRENT-SEASON overview scope (ALWAYS current season, ignores toggle) --
  const curSeasonId = currentSeasonId(seasons)               // number | null
  const curSeason = curSeasonId == null
    ? null
    : seasons.find(s => Number(s.id) === curSeasonId) ?? null
  // Current-season matches, then apply the leaver rule (matches the rest of the
  // performance surfaces). Alpha is already excluded upstream: allMatches is
  // fetched via matchQuery, so live never includes alpha here.
  const overviewMatches = curSeasonId == null
    ? []
    : allMatches.filter(m =>
        m.season_id != null && Number(m.season_id) === curSeasonId)
  const overviewVisible = overviewMatches.filter(m =>
    showLeaverGames() ? true : (m.team_leaver !== true && m.enemy_leaver !== true))

  const appearances = buildAppearances(overviewVisible, heroPerf)

  // Per (queue x role) slices, memo-free (cheap; recomputed each render).
  const appsFor = (q: Queue, r: Role) =>
    appearances.filter(a => a.queue === q && a.role === r)

  return (
    <div className="space-y-8 relative">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl tracking-[0.12em] text-ow-fg uppercase">Home</h1>
          <p className="text-sm text-ow-faint mt-1">
            {allTime ? 'All-time overview' : `${scopeLabel} overview`}
          </p>
        </div>

        {/* Season multi-select: All Time + one toggle per season (combine freely). */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setSeasonSel([])}
            className={`px-3 py-1.5 rounded-lg text-xs font-display tracking-wider uppercase transition-colors
              ${allTime ? 'bg-ow-orange text-ow-dark font-bold'
                : 'bg-ow-panel text-ow-muted border border-ow-line hover:text-ow-fg'}`}
          >All Time</button>
          {seasons.map(s => {
            const on = seasonSel.includes(s.id)
            return (
              <button key={s.id}
                onClick={() => setSeasonSel(sel => sel.includes(s.id) ? sel.filter(x => x !== s.id) : [...sel, s.id])}
                className={`px-3 py-1.5 rounded-lg text-xs font-display tracking-wider uppercase transition-colors
                  ${on ? 'bg-ow-orange text-ow-dark font-bold'
                    : 'bg-ow-panel text-ow-muted border border-ow-line hover:text-ow-fg'}`}
              >{s.name}</button>
            )
          })}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-ow-faint font-display tracking-wider">LOADING…</div>
      ) : (
        <>
          {/* No-season notice (if scoped to a season with no data, or no seasons set up) */}
          {!allTime && scoped.length === 0 && (
            <div className="bg-ow-panel rounded-xl border border-ow-orange/20 p-4 text-sm text-ow-muted">
              No matches found for <span className="text-ow-orange">{scopeLabel}</span>.
              {seasons.length === 0 && ' No seasons are set up yet — add one in Settings → Season Management.'}
            </div>
          )}

          {/* Four win-rate cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <WinRateCard title="Tank · 5v5" rows={tank5} />
            <WinRateCard title="DPS · 5v5" rows={dps5} />
            <WinRateCard title="Support · 5v5" rows={sup5} />
            <WinRateCard title="6v6" rows={six} />
          </div>

          {/* Identity stats + last-5 box */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {/* Totals */}
            <div className="lg:col-span-2 bg-ow-panel rounded-xl p-5 border border-ow-line">
              <p className="text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase mb-3">Games Played</p>
              <div className="flex items-baseline gap-2 mb-4">
                <span className="text-4xl font-display font-bold text-ow-fg">{scoped.length}</span>
                <span className="text-sm text-ow-faint">total</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[
                  ['Tank 5v5', tank5.length],
                  ['DPS 5v5', dps5.length],
                  ['Support 5v5', sup5.length],
                  ['6v6', six.length],
                ].map(([label, n]) => (
                  <div key={label as string} className="bg-ow-dark/60 rounded-lg p-2 text-center">
                    <p className="text-lg font-display font-bold text-ow-fg">{n as number}</p>
                    <p className="text-[10px] text-ow-faint font-display tracking-wider uppercase mt-0.5">{label}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Last 5 win rate */}
            <div className="bg-ow-panel rounded-xl p-5 border border-ow-line flex flex-col justify-center">
              <p className="text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase">Last 5 Matches</p>
              <p className={`text-4xl font-display font-bold mt-1 ${last5.total === 0 ? 'text-ow-faint' : last5.pct >= 50 ? 'text-ow-victory' : 'text-ow-defeat'}`}>
                {last5.total === 0 ? '—' : `${last5.pct}%`}
              </p>
              <p className="text-xs text-ow-faint mt-1">
                {last5.total === 0 ? 'No recent games' : `${last5.w}W – ${last5.l}L`}
              </p>
            </div>
          </div>

          {/* Grand-total leaver box — counts leaver games across this scope.
              Always shown (independent of the Settings "show leaver games" switch). */}
          <div className="bg-ow-panel rounded-xl p-5 border border-ow-line">
            <p className="text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase mb-3">
              Leaver Games <span className="text-ow-faint normal-case tracking-normal">· {scopeLabel}</span>
            </p>
            <div className="flex items-baseline gap-2 mb-4">
              <span className="text-4xl font-display font-bold text-ow-fg">{leaversAll.total}</span>
              <span className="text-sm text-ow-faint">total</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                ['Ally team', leaversAll.ally],
                ['Enemy team', leaversAll.enemy],
                ['Both teams', leaversAll.both],
              ].map(([label, n]) => (
                <div key={label as string} className="bg-ow-dark/60 rounded-lg p-2 text-center">
                  <p className="text-lg font-display font-bold text-ow-fg">{n as number}</p>
                  <p className="text-[10px] text-ow-faint font-display tracking-wider uppercase mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Last-10 results pips */}
          <div>
            <p className="text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase mb-2">Recent Form</p>
            {last10.length === 0 ? (
              <p className="text-sm text-ow-faint">No matches yet.</p>
            ) : (
              <div className="flex gap-1.5">
                {last10.map(m => {
                  const c = m.result === 'victory' ? 'bg-ow-victory'
                    : m.result === 'defeat' ? 'bg-ow-defeat'
                    : 'bg-ow-draw'
                  const letter = m.result === 'victory' ? 'W' : m.result === 'defeat' ? 'L' : 'D'
                  return (
                    <div key={m.id} title={`${m.map ?? ''} · ${formatBritishDate(m.played_at)}`}
                      className={`w-8 h-8 rounded-md ${c} flex items-center justify-center
                        text-ow-dark font-display font-bold text-sm`}>
                      {letter}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* ================================================================
              #14 -- CURRENT-SEASON OVERVIEW
              Always locked to the current season (independent of the scope
              toggle above). Sits between the overview stats and Analytics.
              ================================================================ */}
          <div className="pt-2 border-t border-ow-line space-y-6">
            <div className="flex items-end justify-between flex-wrap gap-2">
              <div>
                <h2 className="font-display text-xl tracking-[0.12em] text-ow-fg uppercase">
                  Season Breakdown
                </h2>
                <p className="text-xs text-ow-faint mt-1">
                  Current season
                  {curSeason ? <span className="text-ow-orange"> · {curSeason.name}</span> : ''}
                  {' · always current-season (ignores the toggle above)'}
                </p>
              </div>
            </div>

            {curSeasonId == null ? (
              <div className="bg-ow-panel rounded-xl border border-ow-orange/20 p-4 text-sm text-ow-muted">
                No current season is set up, so there&apos;s nothing to break down yet.
                {seasons.length === 0
                  ? ' Add one in Settings → Season Management.'
                  : ' Today\u2019s date isn\u2019t inside any season\u2019s range.'}
              </div>
            ) : appearances.length === 0 ? (
              <div className="bg-ow-panel rounded-xl border border-ow-line p-4 text-sm text-ow-faint">
                No hero playtime recorded for {curSeason?.name ?? 'this season'} yet.
              </div>
            ) : (
              <>
                {/* 1 -- Most-played heroes by GAMES (per queue x role) */}
                <div>
                  <SectionTitle>Most-Played Heroes · by Games</SectionTitle>
                  <div className="space-y-3">
                    {QUEUES.map(q => (
                      <QueuePanel key={q} queue={q}>
                        {ROLES.map(r => {
                          const top = topBy(appsFor(q, r), a => a.hero, 'games', 5)
                          return (
                            <RoleColumn key={r} role={r}
                              rows={top.map(t => ({
                                label: t.key,
                                value: `${t.games}${t.games === 1 ? ' game' : ' games'}`,
                                icon: heroPortrait(t.key),
                              }))} />
                          )
                        })}
                      </QueuePanel>
                    ))}
                  </div>
                </div>

                {/* 2 -- Most-played heroes by TIME (per queue x role) */}
                <div>
                  <SectionTitle>Most-Played Heroes · by Time</SectionTitle>
                  <div className="space-y-3">
                    {QUEUES.map(q => (
                      <QueuePanel key={q} queue={q}>
                        {ROLES.map(r => {
                          const top = topBy(appsFor(q, r), a => a.hero, 'seconds', 5)
                          return (
                            <RoleColumn key={r} role={r}
                              rows={top.map(t => ({
                                label: t.key,
                                value: fmtDuration(t.seconds),
                                icon: heroPortrait(t.key),
                              }))} />
                          )
                        })}
                      </QueuePanel>
                    ))}
                  </div>
                </div>

                {/* 3 -- Game modes played, per queue x role (hero-appearance counts) */}
                <div>
                  <SectionTitle>Game Modes Played · by Queue &amp; Role</SectionTitle>
                  <div className="space-y-3">
                    {QUEUES.map(q => (
                      <QueuePanel key={q} queue={q}>
                        {ROLES.map(r => {
                          const modeTally = topBy(appsFor(q, r), a => a.mode, 'games', 99)
                          return (
                            <RoleColumn key={r} role={r}
                              rows={modeTally.map(t => ({
                                label: capitalize(t.key),
                                value: `${t.games}`,
                              }))} />
                          )
                        })}
                      </QueuePanel>
                    ))}
                  </div>
                </div>

                {/* 4 -- Time played per mode, per queue x role (summed hero play_time) */}
                <div>
                  <SectionTitle>Time Played per Mode · by Queue &amp; Role</SectionTitle>
                  <div className="space-y-3">
                    {QUEUES.map(q => (
                      <QueuePanel key={q} queue={q}>
                        {ROLES.map(r => {
                          const modeTime = topBy(appsFor(q, r), a => a.mode, 'seconds', 99)
                          return (
                            <RoleColumn key={r} role={r}
                              rows={modeTime.map(t => ({
                                label: capitalize(t.key),
                                value: fmtDuration(t.seconds),
                              }))} />
                          )
                        })}
                      </QueuePanel>
                    ))}
                  </div>
                </div>

                {/* 5 -- Top-3 maps per queue x role */}
                <div>
                  <SectionTitle>Top Maps · by Queue &amp; Role</SectionTitle>
                  <div className="space-y-3">
                    {QUEUES.map(q => (
                      <QueuePanel key={q} queue={q}>
                        {ROLES.map(r => {
                          const top = topBy(appsFor(q, r), a => a.map, 'games', 3)
                          return (
                            <RoleColumn key={r} role={r}
                              rows={top.map(t => ({
                                label: t.key,
                                value: `${t.games}`,
                              }))} />
                          )
                        })}
                      </QueuePanel>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Empty state for brand-new users */}
          {allMatches.length === 0 && (
            <div className="text-center py-12 bg-ow-panel rounded-xl border border-ow-line">
              <p className="text-ow-muted text-lg font-display tracking-wider">No matches yet</p>
              <p className="text-ow-faint text-sm mt-2">Upload your first match from your phone to get started.</p>
              <Link href="/upload"
                className="inline-block mt-4 bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold px-6 py-2.5 rounded-lg tracking-wider transition-colors">
                UPLOAD A MATCH
              </Link>
            </div>
          )}
        </>
      )}

      {/* Analytics — surfaced here as well as at /analytics. The grouped menu is
          rendered from the shared source, so it matches the Analytics overview. */}
      <div className="pt-2">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="font-display text-xl tracking-[0.12em] text-ow-fg uppercase">Analytics</h2>
          <Link href="/analytics" className="text-xs text-ow-faint hover:text-ow-orange font-display tracking-wider uppercase">
            open full area →
          </Link>
        </div>
        <AnalyticsMenu compact />
      </div>
    </div>
  )
}
