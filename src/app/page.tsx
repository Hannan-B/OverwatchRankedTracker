'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { matchQuery } from '@/lib/alpha'
import { formatBritishDate } from '@/lib/date-format'
import Link from 'next/link'
import { AnalyticsMenu } from '@/components/AnalyticsNav'
import MultiSelect from '@/components/MultiSelect'
import { currentSeasonId } from '@/lib/season-util'
import { HEROES } from '@/data/reference'
import { isExcludedGame, loadExclusionPrefs, EXCLUSION_COLS } from '@/lib/leaver'
// (v1.1.0 Phase 5) The session-boundary rule is IMPORTED, never redefined. The
// Time page owns 45 minutes and the divergence from Builder's 60 is deliberate —
// see the header note in time-lib. Home shares the constant so the two pages can
// never disagree about where a session ends.
import { SESSION_GAP_MS } from '@/app/analytics/time/time-lib'

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
  // (v1.1.0 Phase 5) NOTHING ON THIS PAGE READS THESE BOOLEANS ANY MORE — the
  // leaver grids read the type columns. They are still selected (they are part of
  // EXCLUSION_COLS) and still typed here because `isExcludedGame` reads them for
  // its degraded path, and dropping them from the row type would quietly change
  // what that function sees. Do not reintroduce them into a display: the booleans
  // cannot distinguish permanent from returned, which is the whole axis below.
  team_leaver: boolean | null
  enemy_leaver: boolean | null
  // Needed by the excluded-games policy AND by the leaver grids. NOT NULL enums
  // in the DB ('none' | 'left' | 'returned'), so 'none' is the no-leaver value.
  team_leaver_type: string | null
  enemy_leaver_type: string | null
  team_thrower: boolean | null
  enemy_thrower: boolean | null
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

// (v1.1.0 Phase 5) Minimum games before a win rate is shown at all. A 3-game win
// rate is noise wearing a percentage sign, and empty data is worse than absent
// data. Applies to four independent buckets — Tank 5v5, DPS 5v5, Support 5v5,
// 6v6 — each gated on its own count.
//
// SCOPE — deliberately different on the two gated surfaces, because they answer
// to different scopes:
//   • Win-rate cards   — gate against the CURRENT SELECTION (PATCH-SPEC §10).
//                        The gate exists because a small sample is noise, and
//                        that is a property of the games ON SCREEN.
//   • Season Breakdown — gate against the CURRENT SEASON, because that block is
//                        season-locked and ignores the selection entirely. There
//                        is no selection for it to count against.
// These are the same rule applied to two different row sets, not two rules.
const GATE_MIN_GAMES = 10

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

// ---- most recent session (v1.1.0 Phase 5) ----
// Replaces the old fixed "last 5" window. Walks BACKWARDS from the newest match
// and stops at the first gap of SESSION_GAP_MINUTES or more.
//
// Equivalent to taking the final entry of time-lib's buildSessions(): the
// boundary test sits BETWEEN two consecutive matches, so it reads identically
// forwards or backwards. Walking the tail avoids grouping every session in
// history to use only the last one.
//
// ⚠️ WHY NOT CALL buildSessions() DIRECTLY: its `TimeMatch` requires
// `id: number`, `season_id: number` and `game_length_seconds`. Home's MatchRow
// declares id and season_id as STRINGS and never selects game length, so it does
// not satisfy the interface. time-lib is the one that matches the database
// (`matches.id` is a bigint) — Home's typing is the wrong one, and correcting it
// touches the byId map, the `recent` state shape and every React key on the page.
// That is a separate change; asserting a type Home already has wrong would only
// bury it. The WALK is therefore local while the RULE stays shared.
//
// Rows without a usable timestamp are dropped, matching sortChronological. This
// also closes a latent ordering fault: Postgres orders NULLS FIRST on DESC, so a
// null-`played_at` match would otherwise sit at the top of the descending list
// and be read as the newest game.
//
// Returns newest -> oldest, matching every other row slice on this page.
function mostRecentSession(rows: MatchRow[]): MatchRow[] {
  const timed = rows
    .map(m => ({ m, ms: m.played_at ? new Date(m.played_at).getTime() : NaN }))
    .filter(x => Number.isFinite(x.ms))
    .sort((a, b) => b.ms - a.ms) // sorted here rather than trusting query order
  if (timed.length === 0) return []
  const out: MatchRow[] = [timed[0].m]
  for (let i = 1; i < timed.length; i++) {
    if (timed[i - 1].ms - timed[i].ms >= SESSION_GAP_MS) break
    out.push(timed[i].m)
  }
  return out
}

// ============================================================
// LEAVERS (v1.1.0 Phase 5) — read the TYPE columns, never the booleans
// ============================================================
// `matches.team_leaver_type` / `enemy_leaver_type` are a NOT NULL enum
// ('none' | 'left' | 'returned'), so the no-leaver value is the STRING 'none',
// not null. Testing `!= null` therefore matches every row and is always true —
// that is why these predicates compare against the values explicitly.
//
// The booleans still exist and still agree with the types (verified at
// migration: every boolean matches its seeded type), but the types are strictly
// more informative, so the leaver displays read only those. Mixing the two
// axes — boolean for the ally/enemy split, type for returned/permanent — would
// leave two sources that could drift apart in one grid.
//
// ⚠️ On all pre-Season-4 data every leaver is 'left'. `returned` is genuinely
// zero everywhere, exactly like `starting_side`. The returned row and column
// below will read 0 until a returned leaver is recorded. That is correct, not
// a rendering fault, and the UI says so rather than leaving it ambiguous.
function hasPermanentLeaver(m: MatchRow): boolean {
  return m.team_leaver_type === 'left' || m.enemy_leaver_type === 'left'
}
function hasReturnedLeaver(m: MatchRow): boolean {
  return m.team_leaver_type === 'returned' || m.enemy_leaver_type === 'returned'
}
function hasAnyLeaver(m: MatchRow): boolean {
  return hasPermanentLeaver(m) || hasReturnedLeaver(m)
}

// ---- the four win-rate grid rows (§11.1) ----
// NESTED SUPERSETS, not isolated slices. Each row is the baseline PLUS one
// category, so reading down a column shows how far that category drags the
// number away from clean games.
//
// Rows 2 and 3 are defined as EXCLUSIONS rather than unions, which decides the
// one ambiguous case: a match carrying BOTH a returner and a permanent leaver.
// A permanent leaver discards the scoreboard, so that game is a permanent-leaver
// game whatever else happened in it — it lands in row 3 and row 4 only.
// Nesting therefore holds: row1 ⊂ row2 ⊂ row4 and row1 ⊂ row3 ⊂ row4.
const LEAVER_GRID_ROWS: Array<{
  label: string
  note: string
  test: (m: MatchRow) => boolean
}> = [
  { label: 'No leaver', note: 'clean baseline', test: m => !hasAnyLeaver(m) },
  { label: '+ Returned', note: 'baseline + returned-leaver games', test: m => !hasPermanentLeaver(m) },
  { label: '+ Permanent', note: 'baseline + permanent-leaver games', test: m => !hasReturnedLeaver(m) },
  { label: 'All matches', note: 'every game, leavers and throwers included', test: () => true },
]

// ---- leaver counts for the 3x3 (§11.2) ----
// ROWS (ally / enemy / both) are mutually exclusive: which side lost someone.
// COLUMNS (returned / permanent) are NOT: the "both" row can hold a match with a
// returner on one team and a permanent leaver on the other, which counts in each
// column but is ONE match.
//
// `total` is therefore DISTINCT MATCHES, not returned + permanent. Only the
// "both" row can differ, but the rule is stated for all three so the display
// never has to explain a special case.
interface LeaverCell { returned: number; permanent: number; total: number }
interface LeaverCounts { ally: LeaverCell; enemy: LeaverCell; both: LeaverCell }
function leaverCounts(rows: MatchRow[]): LeaverCounts {
  const blank = (): LeaverCell => ({ returned: 0, permanent: 0, total: 0 })
  const out: LeaverCounts = { ally: blank(), enemy: blank(), both: blank() }
  for (const r of rows) {
    const t = r.team_leaver_type
    const e = r.enemy_leaver_type
    const tHas = t === 'left' || t === 'returned'
    const eHas = e === 'left' || e === 'returned'
    if (!tHas && !eHas) continue
    const cell = tHas && eHas ? out.both : tHas ? out.ally : out.enemy
    if (t === 'returned' || e === 'returned') cell.returned++
    if (t === 'left' || e === 'left') cell.permanent++
    cell.total++
  }
  return out
}

// ---- one career-profile win-rate card ----
// `rows` drives the win rate + record and respects the excluded-games switches.
//
// (v1.1.0 Phase 5) The per-card leaver line is GONE. Leaver information now
// lives entirely in the two grids below, so these cards are the clean
// non-leaver-adjacent baseline the grids are read against.
//
// The gate counts the SAME rows the card displays, so the card can never say
// "not enough games" above a number derived from a different set.
function WinRateCard({ title, rows }: { title: string; rows: MatchRow[] }) {
  const { pct, w, l, total } = winRate(rows)
  const gated = total > 0 && total < GATE_MIN_GAMES
  const tone = total === 0 || gated ? 'text-ow-faint'
    : pct >= 50 ? 'text-ow-victory' : 'text-ow-defeat'
  return (
    <div className="bg-ow-panel rounded-xl p-4 border border-ow-line relative overflow-hidden">
      <div aria-hidden className="absolute inset-0 opacity-40 pointer-events-none"
        style={{ background: 'radial-gradient(80% 60% at 50% 0%, rgba(249,158,26,0.06), transparent 70%)' }} />
      <p className="relative text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase">{title}</p>
      <p className={`relative text-3xl font-display font-bold mt-1 ${tone}`}>
        {total === 0 || gated ? '—' : `${pct}%`}
      </p>
      <p className="relative text-xs text-ow-faint mt-1">
        {total === 0
          ? 'No games'
          : gated
            ? `${total} of ${GATE_MIN_GAMES} games`
            : `${w}W – ${l}L · ${total} games`}
      </p>
      {/* The gated card states WHY it is blank and how far off it is, so a low
          count reads as "not yet" rather than as a broken card. */}
      <p className="relative text-[10px] text-ow-faint font-display tracking-wider uppercase mt-1.5">
        {gated ? 'Too few games to rate' : '\u00A0'}
      </p>
    </div>
  )
}

// ---- §11.1 win-rate grid: 4 categories across, 4 leaver rows down ----
// Reads UNFILTERED rows. This is a dedicated leaver display, which `leaver.ts`
// exempts from the excluded-games switches by omission — it is about these games,
// so hiding them would blank the panel exactly when it has something to say.
//
// The baseline row lives INSIDE the grid rather than being read off the cards
// above. The cards respect the Settings switches, so with "show permanent
// leavers" on they stop being a clean baseline and the comparison silently
// changes meaning. A self-contained grid reads the same whatever those switches
// are set to.
function LeaverWinRateGrid({
  categories,
}: { categories: Array<{ label: string; rows: MatchRow[] }> }) {
  return (
    <div className="bg-ow-panel rounded-xl p-5 border border-ow-line">
      <p className="text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase mb-1">
        Win Rate by Leaver Category
      </p>
      <p className="text-xs text-ow-faint mb-4">
        Each row is the baseline <span className="text-ow-muted">plus</span> that category, not the
        category on its own — read down a column to see how far it drags the number.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr>
              <th className="text-[10px] text-ow-faint font-display tracking-wider uppercase font-normal pb-2 pr-3" />
              {categories.map(c => (
                <th key={c.label}
                  className="text-[10px] text-ow-faint font-display tracking-wider uppercase font-normal pb-2 px-2 text-right whitespace-nowrap">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LEAVER_GRID_ROWS.map(row => (
              <tr key={row.label} className="border-t border-ow-line">
                <td className="py-2 pr-3 align-top">
                  <p className="text-xs text-ow-muted whitespace-nowrap">{row.label}</p>
                  <p className="text-[10px] text-ow-faint">{row.note}</p>
                </td>
                {categories.map(c => {
                  const { pct, total } = winRate(c.rows.filter(row.test))
                  return (
                    <td key={c.label} className="py-2 px-2 text-right align-top">
                      <p className={`text-sm font-display font-bold tabular-nums ${
                        total === 0 ? 'text-ow-faint' : pct >= 50 ? 'text-ow-victory' : 'text-ow-defeat'
                      }`}>
                        {total === 0 ? '—' : `${pct}%`}
                      </p>
                      <p className="text-[10px] text-ow-faint tabular-nums">{total}</p>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Until a returned leaver is recorded, rows 1 and 2 are identical by
          construction. Saying so stops two matching rows reading as a bug. */}
      <p className="text-[10px] text-ow-faint mt-3">
        No returned leaver has been recorded yet, so
        {' '}<span className="text-ow-muted">No leaver</span> and
        {' '}<span className="text-ow-muted">+ Returned</span> currently match.
      </p>
    </div>
  )
}

// ---- §11.2 counts grid: which side lost someone x what kind ----
// Aggregated across ALL queues, per the spec. Rows are mutually exclusive;
// columns are not — see leaverCounts() for why `total` will not equal
// returned + permanent.
function LeaverCountsGrid({ rows, scopeLabel }: { rows: MatchRow[]; scopeLabel: string }) {
  const c = leaverCounts(rows)
  const grandTotal = c.ally.total + c.enemy.total + c.both.total
  const bands: Array<{ label: string; cell: LeaverCell }> = [
    { label: 'Ally team', cell: c.ally },
    { label: 'Enemy team', cell: c.enemy },
    { label: 'Both teams', cell: c.both },
  ]
  return (
    <div className="bg-ow-panel rounded-xl p-5 border border-ow-line">
      <p className="text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase mb-3">
        Leaver Games <span className="text-ow-faint normal-case tracking-normal">· {scopeLabel}</span>
      </p>
      <div className="flex items-baseline gap-2 mb-4">
        <span className="text-4xl font-display font-bold text-ow-fg tabular-nums">{grandTotal}</span>
        <span className="text-sm text-ow-faint">total</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr>
              <th className="pb-2 pr-3" />
              {['Returned', 'Permanent', 'Total'].map(h => (
                <th key={h}
                  className="text-[10px] text-ow-faint font-display tracking-wider uppercase font-normal pb-2 px-2 text-right">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bands.map(b => (
              <tr key={b.label} className="border-t border-ow-line">
                <td className="py-2 pr-3 text-xs text-ow-muted whitespace-nowrap">{b.label}</td>
                <td className="py-2 px-2 text-right text-sm font-display text-ow-muted tabular-nums">{b.cell.returned}</td>
                <td className="py-2 px-2 text-right text-sm font-display text-ow-muted tabular-nums">{b.cell.permanent}</td>
                <td className="py-2 px-2 text-right text-sm font-display font-bold text-ow-fg tabular-nums">{b.cell.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Required by §11.2 — without this the rows read as an arithmetic error. */}
      <p className="text-[10px] text-ow-faint mt-3">
        Total counts distinct matches. One match can hold a returner on one side and a
        permanent leaver on the other, so it appears in both columns but is counted once —
        the rows will not always sum.
      </p>
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
//
// `games` counts DISTINCT MATCHES, not appearances. An Appearance is one
// hero_performances row, so a match where two heroes were played emits two
// appearances. Counting those directly inflated any tally keyed by a MATCH
// attribute -- "Game Modes Played" and "Top Maps" both ran ~1.8x too high
// (327 appearances over ~179 matches). Hero-keyed tallies were unaffected
// (a hero cannot appear twice in one match), so deduping is safe everywhere
// and no call site changes.
//
// `seconds` still SUMS every appearance -- that is correct. Two heroes played
// on one map really is the sum of both hero play-times on that map.
//
// NOTE (correct, do not "fix"): in 6v6 open queue a match where tank was played
// and then DPS counts once under EACH role, so role columns will not sum to the
// match total. That match genuinely was played in both roles.
interface Tally { key: string; games: number; seconds: number }
function topBy(
  apps: Appearance[],
  keyOf: (a: Appearance) => string | null,
  metric: 'games' | 'seconds',
  n: number,
): Tally[] {
  const acc = new Map<string, Tally>()
  const seenMatches = new Map<string, Set<string>>()
  for (const a of apps) {
    const k = keyOf(a)
    if (!k) continue
    const t = acc.get(k) ?? { key: k, games: 0, seconds: 0 }
    let ids = seenMatches.get(k)
    if (!ids) { ids = new Set<string>(); seenMatches.set(k, ids) }
    if (!ids.has(a.matchId)) {
      ids.add(a.matchId)
      t.games += 1
    }
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
//
// (v1.1.0 Phase 5) `gateHave` applies the 10-game gate. When it is a number below
// GATE_MIN_GAMES the column shows the shortfall INSTEAD of its rows. It counts
// MATCHES, not hero appearances — a 6v6 match where tank was played and then DPS
// yields two appearances but is one game, and gating on appearances would let a
// bucket through on half the real sample. Pass undefined to leave a column
// ungated.
function RoleColumn({
  role, rows, gateHave,
}: {
  role: Role
  rows: Array<{ label: string; value: string; icon?: string }>
  gateHave?: number
}) {
  const gated = gateHave != null && gateHave < GATE_MIN_GAMES
  return (
    <div className="bg-ow-dark/50 rounded-lg p-3">
      <p className="text-[10px] text-ow-faint font-display tracking-wider uppercase mb-2">{ROLE_LABEL[role]}</p>
      {gated ? (
        <p className="text-xs text-ow-faint">
          {gateHave} of {GATE_MIN_GAMES} games
        </p>
      ) : rows.length === 0 ? (
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
  // Re-render trigger once the excluded-games prefs are loaded (they gate the
  // win-rate cards and the overview).
  const [, setLeaverReady] = useState(false)
  const seasonDefaulted = useRef(false)

  const loadData = useCallback(async () => {
    setLoading(true)

    // Excluded-games prefs into the sync cache FIRST — isExcludedGame reads it
    // synchronously and starts fully hidden, so anything filtered before this
    // resolves would drop every flagged game regardless of the switches.
    await loadExclusionPrefs()
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
      'id, result, role_played, match_format, season_id, played_at, map, game_mode, ' + EXCLUSION_COLS,
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

  // `scoped` stays UNFILTERED — the dedicated leaver displays (per-card leaver
  // line + the big Leaver Games box) read from it so they always show leaver
  // counts regardless of the Settings toggle.
  //
  // `scopedVisible` applies the excluded-games policy (both leaver kinds plus
  // throwers) and feeds the GENERAL surfaces — win-rate cards, games-played
  // totals, last-5, recent-form pips. Mirrors overviewVisible in the #14 block.
  const scopedVisible = scoped.filter(m => !isExcludedGame(m))

  // Four category sets — VISIBLE (toggle-respecting) for win rate + totals.
  const tank5 = scopedVisible.filter(m => m.match_format === '5v5' && m.role_played === 'tank')
  const dps5 = scopedVisible.filter(m => m.match_format === '5v5' && m.role_played === 'dps')
  const sup5 = scopedVisible.filter(m => m.match_format === '5v5' && m.role_played === 'support')
  const six = scopedVisible.filter(m => m.match_format === '6v6')

  // (v1.1.0 Phase 5) The same four category sets, UNFILTERED — now the COLUMNS of
  // the §11.1 win-rate grid. They previously fed the per-card leaver lines, which
  // this phase removed; the sets survive because the grid needs exactly the same
  // four splits over the unfiltered rows.
  const leaverGridCategories = [
    { label: 'Tank 5v5', rows: scoped.filter(m => m.match_format === '5v5' && m.role_played === 'tank') },
    { label: 'DPS 5v5', rows: scoped.filter(m => m.match_format === '5v5' && m.role_played === 'dps') },
    { label: 'Support 5v5', rows: scoped.filter(m => m.match_format === '5v5' && m.role_played === 'support') },
    { label: '6v6', rows: scoped.filter(m => m.match_format === '6v6') },
  ]

  // (v1.1.0 Phase 5) Most recent session, replacing the fixed last-5 window.
  // Reads scopedVisible, so it honours both the season selection and the
  // excluded-games switches — the same rows the last-5 box used.
  //
  // NO MINIMUM GAME COUNT, by decision: a one-game session shows that game's
  // result as 100%/0%. The count sits directly under the figure so a small
  // sample is visible rather than implied.
  const sessionMatches = mostRecentSession(scopedVisible)
  const session = winRate(sessionMatches)
  // Session START — the OLDEST match in the session, i.e. when you sat down.
  const sessionStartedAt = sessionMatches.length > 0
    ? sessionMatches[sessionMatches.length - 1].played_at
    : null
  const last10 = scopedVisible.slice(0, 10)

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
  // Current-season matches, then apply the excluded-games policy (matching the
  // rest of the performance surfaces). Alpha is already excluded upstream:
  // allMatches is fetched via matchQuery, so live never includes alpha here.
  const overviewMatches = curSeasonId == null
    ? []
    : allMatches.filter(m =>
        m.season_id != null && Number(m.season_id) === curSeasonId)
  const overviewVisible = overviewMatches.filter(m => !isExcludedGame(m))

  const appearances = buildAppearances(overviewVisible, heroPerf)

  // (v1.1.0 Phase 5) Gate counts for the Season Breakdown — CURRENT-SEASON match
  // counts, because this block is season-locked and has no selection to count
  // against. Counted from `overviewVisible` (the same rows the tables are built
  // from) so a gated column can never contradict the data behind it.
  //
  // The 5v5 role columns gate independently. The 6v6 panel gates AS A WHOLE on
  // total 6v6 games, because the settled gate has four buckets and 6v6 is one of
  // them — while the breakdown splits 6v6 into three role columns. Gating those
  // three separately would invent buckets the decision does not have, and would
  // walk straight into the open-queue trap: a 6v6 match counts under EVERY role
  // played in it, so per-role 6v6 counts do not sum to the match total.
  const gateFor = (q: Queue, r: Role): number =>
    q === '6v6'
      ? overviewVisible.filter(m => m.match_format === '6v6').length
      : overviewVisible.filter(m => m.match_format === '5v5' && m.role_played === r).length

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

        {/* Season multi-select. (v1.1.0 Phase 2) Was a row of pill buttons; now the
            same <MultiSelect> every analytics page uses, so one control behaves one
            way app-wide. The STATE is unchanged — Home keeps its own seasonSel and
            its seasonDefaulted seeding rather than adopting AnalyticsFilterState,
            because Home has no queue/mode/map filters and no filter bar to mount.
            [] = All Time, exactly as before. */}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-ow-muted font-display tracking-wider uppercase">Season</span>
          <MultiSelect<string>
            value={seasonSel}
            onChange={setSeasonSel}
            options={seasons.map(s => ({ value: s.id, label: s.name }))}
            allLabel="All Time"
            noun="seasons"
            aria-label="Season"
          />
        </label>
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
                <span className="text-4xl font-display font-bold text-ow-fg">{scopedVisible.length}</span>
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

            {/* Most recent session (v1.1.0 Phase 5) — a variable window ended by a
                45-minute gap, not a fixed count of 5. The date matters here in a way
                it did not before: with a past season selected, the most recent session
                can be months old, and a bare percentage would read as current form. */}
            <div className="bg-ow-panel rounded-xl p-5 border border-ow-line flex flex-col justify-center">
              <p className="text-[11px] text-ow-muted font-display tracking-[0.15em] uppercase">Most Recent Session</p>
              <p className={`text-4xl font-display font-bold mt-1 ${session.total === 0 ? 'text-ow-faint' : session.pct >= 50 ? 'text-ow-victory' : 'text-ow-defeat'}`}>
                {session.total === 0 ? '—' : `${session.pct}%`}
              </p>
              <p className="text-xs text-ow-faint mt-1">
                {session.total === 0
                  ? 'No recent games'
                  : `${session.w}W – ${session.l}L · ${session.total} ${session.total === 1 ? 'game' : 'games'}`}
              </p>
              {sessionStartedAt && (
                <p className="text-[10px] text-ow-faint font-display tracking-wider uppercase mt-1.5">
                  {formatBritishDate(sessionStartedAt)}
                </p>
              )}
            </div>
          </div>

          {/* (v1.1.0 Phase 5) The single leaver box became two grids: win rates by
              leaver category (§11.1) and match counts by side and type (§11.2).
              Both read UNFILTERED `scoped` — they are dedicated leaver displays and
              are exempt from the excluded-games switches by omission, exactly as
              the old box was. */}
          <LeaverWinRateGrid categories={leaverGridCategories} />
          <LeaverCountsGrid rows={scoped} scopeLabel={scopeLabel} />

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
                            <RoleColumn key={r} role={r} gateHave={gateFor(q, r)}
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
                            <RoleColumn key={r} role={r} gateHave={gateFor(q, r)}
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

                {/* 3 -- Game modes played, per queue x role (DISTINCT MATCH counts) */}
                <div>
                  <SectionTitle>Game Modes Played · by Queue &amp; Role</SectionTitle>
                  <div className="space-y-3">
                    {QUEUES.map(q => (
                      <QueuePanel key={q} queue={q}>
                        {ROLES.map(r => {
                          const modeTally = topBy(appsFor(q, r), a => a.mode, 'games', 99)
                          return (
                            <RoleColumn key={r} role={r} gateHave={gateFor(q, r)}
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
                            <RoleColumn key={r} role={r} gateHave={gateFor(q, r)}
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
                            <RoleColumn key={r} role={r} gateHave={gateFor(q, r)}
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
