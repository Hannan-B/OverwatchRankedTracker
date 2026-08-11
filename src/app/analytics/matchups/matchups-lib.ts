// ============================================================
// /analytics/matchups — aggregation lib (surface 2)
// ------------------------------------------------------------
// Heavy SQL math lives in the matchup_* views (matchups-views.sql).
// This lib does the JS layer the established pattern calls for:
//   • shape the rows the page fetches
//   • aggregate to win-rate cells, GAMES-WEIGHTED by distinct match_id
//   • the combination engine: co-occurrence (subset) vs exact-comp
//   • top-N-per-role, draw-safe win rate, the 5-game confidence flag
//
// It deliberately holds NO React and NO supabase import so it can be
// compiled to JS and unit-checked against real *_rows.sql exports —
// the same validation approach used for builder-lib.ts.
// ============================================================

// ---- Row shapes (what the page selects from the views) -------------

// One row per (match, other player) — from `matchup_pairs`.
export interface PairRow {
  match_id: number
  anchor_hero: string
  anchor_role: Role
  anchor_is_mixed: boolean
  anchor_pct: number | null       // primary hero's % of match
  anchor_seconds: number | null   // primary hero's playtime (seconds)
  relation: Relation            // 'ally' | 'enemy'
  other_hero: string
  other_role: Role
  role_slot_index: number       // 1st/2nd dps etc. within (relation, role)
  role_icon_disagrees: boolean
  is_alpha: boolean
  season_id: number | null
  map: string | null
  game_mode: string | null
  match_format: Format          // '5v5' | '6v6'
  user_role_played: Role | null
  result: Result                // 'victory' | 'defeat' | 'draw'
  played_at: string | null
}

// One row per (match, relation) — from `matchup_team_sets`.
export interface TeamSetRow {
  match_id: number
  anchor_hero: string
  anchor_role: Role
  anchor_pct: number | null
  anchor_seconds: number | null
  relation: Relation
  hero_set: string[]            // sorted; the OTHER heroes on that team
  roles_present: Role[]
  member_count: number
  n_tank: number
  n_dps: number
  n_support: number
  match_format: Format
  is_alpha: boolean
  season_id: number | null
  map: string | null
  game_mode: string | null
  user_role_played: Role | null
  result: Result
  played_at: string | null
}

export type Role = 'tank' | 'dps' | 'support'
export type Relation = 'ally' | 'enemy'
export type Format = '5v5' | '6v6'
export type Result = 'victory' | 'defeat' | 'draw'

// ---- Filters (mirrors AnalyticsFilterState's relevant fields) ------
// We accept the shared filter state but only read what matchups uses.
//
// (v1.1.0 Phase 2) mode and map became ARRAYS, matching the shared state, and
// `seasons` was ADDED — this surface previously ignored the season filter
// entirely, which was harmless only while one season existed.
//
// ⚠️ EMPTY ARRAY = NO FILTER, exactly as in AnalyticsFilterState. The old
// sentinel here was the string 'all' while the shared state used '' for map and
// hero, and reconciling the two in toMatchupFilters is what produced the v1.0.1
// empty-page bug ('' ?? 'all' stayed '', so every row was rejected). There is
// no sentinel left to translate: the bridge now copies arrays across unchanged.
export type AttributionMode = 'all' | 'min1' | 'pct95'
export interface MatchupFilters {
  /** Single-select, unchanged: 5v5 and 6v6 never mix. */
  queue: 'all' | 'tank' | 'dps' | 'support' | '6v6'
  /** [] = all modes. OR within the list. */
  modes: string[]
  /** [] = all maps. OR within the list. */
  maps: string[]
  /** [] = All Time. Rows carry season_id; a null one shows only under All Time. */
  seasons: number[]
  // how strictly to count a game as "me playing the anchor hero":
  //   all   = attribute to primary hero regardless of playtime
  //   min1  = require >=60s on the primary hero
  //   pct95 = require >=95% of the match on the primary hero
  attribution: AttributionMode
  // The threshold VALUES the toggle applies. Adjustable (step 9): the toggle
  // still picks the MODE (all / min-seconds / min-pct); these set the numbers.
  // Optional + defaulted so existing callers are unchanged (95% / 60s).
  pctThreshold?: number   // used when attribution === 'pct95' (default 95)
  secThreshold?: number   // used when attribution === 'min1'  (default 60)
  // anchor hero is matchups-specific (the surface's defining control),
  // not part of the shared filter bar's semantics.
}

// The min games below which a cell is DIMMED (confidence rule), not hidden.
export const CONFIDENCE_MIN_GAMES = 5

// ---- Win rate, draw-safe ------------------------------------------
export interface Cell {
  hero: string
  role: Role
  wins: number
  losses: number
  draws: number
  games: number          // total incl. draws
  decisive: number       // wins + losses (the win-rate denominator)
  winRate: number | null // 0..100, 2dp; null when no decisive games
  lowConfidence: boolean // games < CONFIDENCE_MIN_GAMES
  anyRoleDisagreement: boolean
}

function emptyCell(hero: string, role: Role): Cell {
  return {
    hero, role, wins: 0, losses: 0, draws: 0, games: 0, decisive: 0,
    winRate: null, lowConfidence: true, anyRoleDisagreement: false,
  }
}

function finalizeCell(c: Cell): Cell {
  c.decisive = c.wins + c.losses
  c.games = c.wins + c.losses + c.draws
  c.winRate = c.decisive > 0
    ? Math.round((100 * c.wins / c.decisive) * 100) / 100   // 2dp
    : null
  c.lowConfidence = c.games < CONFIDENCE_MIN_GAMES
  return c
}

// ---- Queue → (format, role) mapping --------------------------------
// Queue carries the 5v5/6v6 split: a 5v5 role pins format=5v5 + that
// role; '6v6' pins format=6v6 (role-agnostic); 'all' pins nothing.
function queuePredicate(q: MatchupFilters['queue']): (r: { match_format: Format; user_role_played: Role | null }) => boolean {
  if (q === 'all') return () => true
  if (q === '6v6') return (r) => r.match_format === '6v6'
  // a 5v5 role queue
  return (r) => r.match_format === '5v5' && r.user_role_played === q
}

export function passesFilters(
  r: {
    match_format: Format; user_role_played: Role | null
    game_mode: string | null; map: string | null
    season_id?: number | null
    anchor_pct?: number | null; anchor_seconds?: number | null
  },
  f: MatchupFilters,
): boolean {
  if (!queuePredicate(f.queue)(r)) return false
  // Mode / Map / Season — OR within each list, AND between them. [] = no filter.
  // A row whose value is null belongs to none of the ticked options, so ticking
  // any of them excludes it; it shows only under the empty (all) selection.
  if (f.modes.length > 0 && !(r.game_mode != null && f.modes.includes(r.game_mode))) return false
  if (f.maps.length > 0 && !(r.map != null && f.maps.includes(r.map))) return false
  if (f.seasons.length > 0 && !(r.season_id != null && f.seasons.includes(r.season_id))) return false
  // attribution: how committed was I to the primary (anchor) hero?
  // If the playtime fields are absent (older data / null), we DON'T
  // exclude — absence shouldn't silently drop games. 'all' never filters.
  if (f.attribution === 'pct95') {
    const pct = f.pctThreshold ?? 95
    if (r.anchor_pct != null && r.anchor_pct < pct) return false
  } else if (f.attribution === 'min1') {
    const secs = f.secThreshold ?? 60
    if (r.anchor_seconds != null && r.anchor_seconds < secs) return false
  }
  return true
}

// ====================================================================
// SINGLE-HERO AGGREGATION  (the four ranked lists)
// ====================================================================
// Given pair rows already filtered to ONE anchor hero (or null = the
// general, non-anchored view), one relation, and the active filters,
// produce per-other-hero cells. Games-weighted by distinct match_id:
// a hero is counted once per match even if it (somehow) recurs.
export function aggregateSingles(
  rows: PairRow[],
  relation: Relation,
  filters: MatchupFilters,
  anchorHero: string | null,        // null = general view (any anchor)
): Cell[] {
  const byHero = new Map<string, { cell: Cell; seen: Set<string> }>()

  for (const r of rows) {
    if (r.relation !== relation) continue
    if (anchorHero !== null && r.anchor_hero !== anchorHero) continue
    if (!passesFilters(r, filters)) continue

    let entry = byHero.get(r.other_hero)
    if (!entry) {
      entry = { cell: emptyCell(r.other_hero, r.other_role), seen: new Set() }
      byHero.set(r.other_hero, entry)
    }
    // distinct match_id guard (games-weighting)
    if (entry.seen.has(String(r.match_id))) continue
    entry.seen.add(String(r.match_id))

    if (r.result === 'victory') entry.cell.wins++
    else if (r.result === 'defeat') entry.cell.losses++
    else entry.cell.draws++
    if (r.role_icon_disagrees) entry.cell.anyRoleDisagreement = true
  }

  return [...byHero.values()].map((e) => finalizeCell(e.cell))
}

// ====================================================================
// STANDOUTS  (v1.1.0 Phase 5) — impressed allies / troublesome enemies
// ====================================================================
// Subjective post-match picks, rendered as two lists of five tiles.
//
// WHY THESE LIVE ON THIS PAGE: the denominator. "I struggled with Sombra"
// is meaningless as a raw count — what matters is "flagged in 4 of the 12
// matches where Sombra was on the enemy team". Games-where-hero-appeared-
// by-relation is exactly what aggregateSingles() already produces, so the
// rate is a join rather than a second aggregation that could drift from
// the win rates sitting beside it.
//
// SCOPE follows the page: pass the same `filters` and `anchorHero` used for
// the ranked lists and the tiles re-scope with them for free. anchorHero
// null = every game; a hero = only games where that hero was played.
//
// THE TWO LISTS ARE NEVER MERGED. You flag an ally who IMPRESSED and an
// enemy who gave TROUBLE — there is no "ally who played badly" pick, so
// they are not mirror images and must not be presented as one scale.
export type StandoutKind = 'impressed_ally' | 'struggled_enemy'

// One match_standouts row, trimmed to what this file needs.
export interface StandoutRow {
  match_id: number
  kind: StandoutKind
  slot: number
  hero_name: string | null   // null until resolved at save time
}

export interface StandoutCell {
  hero: string
  role: Role
  picks: number            // matches where this hero was flagged
  appearances: number      // matches where this hero appeared, same relation
  rate: number | null      // picks / appearances as 0..100, 2dp
  winRate: number | null   // carried across so the tile can sit beside it
  lowConfidence: boolean   // appearances < CONFIDENCE_MIN_GAMES — dim, don't hide
}

/**
 * Rank standout picks for one kind.
 *
 * `cells` must be the aggregateSingles() output for the MATCHING relation —
 * 'ally' for impressed_ally, 'enemy' for struggled_enemy — computed with the
 * same filters and anchor. That is where both the denominator and the win rate
 * come from, so the tiles cannot disagree with the lists above them.
 *
 * ⚠️ SELF-PICKS ARE DROPPED. Ally slots are 1–5 (1–6 in 6v6) and include YOUR
 * OWN slot, so a pick can resolve to a hero you were playing. Those have no
 * denominator here — aggregateSingles emits cells for OTHER heroes, never
 * yours — and would render as a tile with picks over zero appearances.
 * `userHeroesByMatch` supplies your heroes per match so they can be excluded.
 * A match can hold SEVERAL of your heroes (a swap game), hence a set per match.
 *
 * A hero can be flagged at most once per match per kind — the table's
 * unique (match_id, kind, slot) allows two slots to resolve to the same hero
 * only across teams, so picks are deduped by match anyway.
 */
export function aggregateStandouts(
  standouts: StandoutRow[],
  kind: StandoutKind,
  cells: Cell[],
  inScopeMatchIds: Set<number>,
  userHeroesByMatch: Map<number, Set<string>>,
): StandoutCell[] {
  const byHero = new Map<string, Set<number>>()

  for (const s of standouts) {
    if (s.kind !== kind) continue
    if (s.hero_name == null) continue          // unresolved pick — not chartable
    if (!inScopeMatchIds.has(s.match_id)) continue
    // Self-pick guard — see the warning above.
    if (userHeroesByMatch.get(s.match_id)?.has(s.hero_name)) continue
    let seen = byHero.get(s.hero_name)
    if (!seen) { seen = new Set(); byHero.set(s.hero_name, seen) }
    seen.add(s.match_id)                        // distinct matches, not raw rows
  }

  const cellByHero = new Map(cells.map(c => [c.hero, c]))
  const out: StandoutCell[] = []
  for (const [hero, matchIds] of byHero) {
    const c = cellByHero.get(hero)
    // No matching cell means the hero was flagged in a game that the current
    // filters exclude from the pair rows. Skip rather than show a rate over an
    // unknown denominator.
    if (!c) continue
    const picks = matchIds.size
    out.push({
      hero,
      role: c.role,
      picks,
      appearances: c.games,
      rate: c.games > 0 ? Math.round((100 * picks / c.games) * 100) / 100 : null,
      winRate: c.winRate,
      lowConfidence: c.games < CONFIDENCE_MIN_GAMES,
    })
  }

  // Rate first (that is the question being asked), then picks as the tiebreak
  // so a 2-of-3 does not outrank a 7-of-12 on volume alone.
  out.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.picks - a.picks || a.hero.localeCompare(b.hero))
  return out
}

/** Distinct match ids among pair rows passing the filters (and anchor, if set).
 *  This is the standouts' scope: it inherits alpha exclusion, the queue/mode/map
 *  /season filters and the anchor from the same rows the lists are built from. */
export function inScopeMatchIds(
  rows: PairRow[],
  filters: MatchupFilters,
  anchorHero: string | null,
): Set<number> {
  const out = new Set<number>()
  for (const r of rows) {
    if (anchorHero !== null && r.anchor_hero !== anchorHero) continue
    if (!passesFilters(r, filters)) continue
    out.add(r.match_id)
  }
  return out
}

/** Your own heroes per match, for the self-pick guard. Built from every pair
 *  row regardless of filters: whether a hero was YOURS is a fact about the
 *  match, not a function of the current view. */
export function userHeroesByMatch(rows: PairRow[]): Map<number, Set<string>> {
  const m = new Map<number, Set<string>>()
  for (const r of rows) {
    let s = m.get(r.match_id)
    if (!s) { s = new Set(); m.set(r.match_id, s) }
    s.add(r.anchor_hero)
  }
  return m
}

// ---- Ranking: best / worst, top-N per role -------------------------
// Sort key: win rate (desc for "best", asc for "worst"), then games as
// the tiebreak so larger samples surface above tiny ones at equal rate.
// Cells with no decisive games (winRate null) sink to the bottom.
export type Direction = 'best' | 'worst'

export function rankTopNPerRole(
  cells: Cell[],
  direction: Direction,
  n = 5,
  applyFloor?: { minWinRate?: number },  // optional separate win-rate floor
): Record<Role, Cell[]> {
  const out: Record<Role, Cell[]> = { tank: [], dps: [], support: [] }
  const roles: Role[] = ['tank', 'dps', 'support']

  for (const role of roles) {
    let pool = cells.filter((c) => c.role === role)

    if (applyFloor?.minWinRate != null) {
      pool = pool.filter((c) => c.winRate != null && (
        direction === 'best'
          ? c.winRate >= applyFloor.minWinRate!
          : c.winRate <= applyFloor.minWinRate!
      ))
    }

    pool.sort((a, b) => {
      // nulls last regardless of direction
      if (a.winRate == null && b.winRate == null) return b.games - a.games
      if (a.winRate == null) return 1
      if (b.winRate == null) return -1
      const byRate = direction === 'best'
        ? b.winRate - a.winRate
        : a.winRate - b.winRate
      if (byRate !== 0) return byRate
      return b.games - a.games   // larger sample wins ties
    })

    out[role] = pool.slice(0, n)
  }
  return out
}

// ====================================================================
// COMBINATION ENGINE  (pairs → full complement)
// ====================================================================
// Mode meanings (explained in the UI too):
//   • co-occurrence (loose): games where the selected heroes were ALL
//     present on that team — others allowed alongside them.
//   • exact comp (strict): games where the team (excluding the user)
//     was EXACTLY the selected heroes — nobody else.
export type ComboMode = 'cooccurrence' | 'exact'

function sortedEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function isSubset(selected: string[], set: string[]): boolean {
  const s = new Set(set)
  return selected.every((h) => s.has(h))
}

export interface ComboResult extends Cell {
  selection: string[]
  mode: ComboMode
  matchIds: number[]
}

// Aggregate win rate over team-set rows that MATCH the selection under
// the chosen mode. `selected` is the set of OTHER heroes (teammates or
// enemies) the user picked. Games-weighted by distinct match_id.
export function aggregateCombo(
  rows: TeamSetRow[],
  relation: Relation,
  filters: MatchupFilters,
  anchorHero: string | null,
  selected: string[],
  mode: ComboMode,
): ComboResult {
  const sortedSel = [...selected].sort()
  const cell = emptyCell(sortedSel.join(' + '), 'dps') // role N/A for combos
  const seen = new Set<string>()
  const matchIds: number[] = []

  for (const r of rows) {
    if (r.relation !== relation) continue
    if (anchorHero !== null && r.anchor_hero !== anchorHero) continue
    if (!passesFilters(r, filters)) continue

    const matches = mode === 'exact'
      ? sortedEq(r.hero_set, sortedSel)
      : isSubset(sortedSel, r.hero_set)
    if (!matches) continue

    if (seen.has(String(r.match_id))) continue
    seen.add(String(r.match_id))
    matchIds.push(r.match_id)

    if (r.result === 'victory') cell.wins++
    else if (r.result === 'defeat') cell.losses++
    else cell.draws++
  }

  const final = finalizeCell(cell) as ComboResult
  final.selection = sortedSel
  final.mode = mode
  final.matchIds = matchIds
  return final
}

// ====================================================================
// QUEUE → ROLE SCOPING + SLOT SHAPE
// ====================================================================
// The Queue filter fixes the user's role in 5v5. These helpers let the
// page scope the anchor-hero picker and shape the scoreboard slots.

// The role the Queue pins, or null when it pins nothing (All / 6v6).
export function queueFixedRole(q: MatchupFilters['queue']): Role | null {
  return q === 'tank' || q === 'dps' || q === 'support' ? q : null
}

// How many of each role sit on ONE team (including the user), by format.
// 5v5 = 1-2-2; 6v6 default = 2-2-2 (caller may override for 6v6).
export interface SlotShape { tank: number; dps: number; support: number }
export function teamSlotShape(format: Format, sixSixShape?: SlotShape): SlotShape {
  if (format === '6v6') return sixSixShape ?? { tank: 2, dps: 2, support: 2 }
  return { tank: 1, dps: 2, support: 2 }
}

// The OTHER-slots shape (the team minus the user's own slot) given the
// user's role. This is what the scoreboard picker offers to fill.
export function otherSlotShape(
  format: Format,
  userRole: Role,
  sixSixShape?: SlotShape,
): SlotShape {
  const full = teamSlotShape(format, sixSixShape)
  return { ...full, [userRole]: full[userRole] - 1 }
}

// ====================================================================
// BOTH-TEAMS COMBO  (ally set AND enemy set in the same match)
// ====================================================================
// Win rate over matches where the chosen ally heroes were ALL on the
// user's team AND the chosen enemy heroes were ALL on the enemy team
// (each side under its own co-occurrence/exact rule). Joins the two
// team-set relations by match_id.
export interface BothResult extends Cell {
  allySelection: string[]
  enemySelection: string[]
  matchIds: number[]
}

export function aggregateBoth(
  rows: TeamSetRow[],
  filters: MatchupFilters,
  anchorHero: string | null,
  allySel: string[],
  enemySel: string[],
  allyMode: ComboMode,
  enemyMode: ComboMode,
): BothResult {
  const allySorted = [...allySel].sort()
  const enemySorted = [...enemySel].sort()

  // index ally & enemy team-sets by match
  const allyByMatch = new Map<number, TeamSetRow>()
  const enemyByMatch = new Map<number, TeamSetRow>()
  for (const r of rows) {
    if (anchorHero !== null && r.anchor_hero !== anchorHero) continue
    if (!passesFilters(r, filters)) continue
    if (r.relation === 'ally') allyByMatch.set(r.match_id, r)
    else enemyByMatch.set(r.match_id, r)
  }

  const cell = emptyCell('both', 'dps')
  const matchIds: number[] = []

  for (const [mid, allyRow] of allyByMatch) {
    const enemyRow = enemyByMatch.get(mid)
    if (!enemyRow) continue

    const allyOk = allySorted.length === 0 ? true : (allyMode === 'exact'
      ? sortedEq(allyRow.hero_set, allySorted)
      : isSubset(allySorted, allyRow.hero_set))
    const enemyOk = enemySorted.length === 0 ? true : (enemyMode === 'exact'
      ? sortedEq(enemyRow.hero_set, enemySorted)
      : isSubset(enemySorted, enemyRow.hero_set))
    if (!allyOk || !enemyOk) continue

    matchIds.push(mid)
    if (allyRow.result === 'victory') cell.wins++
    else if (allyRow.result === 'defeat') cell.losses++
    else cell.draws++
  }

  const final = finalizeCell(cell) as BothResult
  final.allySelection = allySorted
  final.enemySelection = enemySorted
  final.matchIds = matchIds
  return final
}

// ---- 6v6 2-2-2 conformance (drives the UI caveat) ------------------
// For 6v6 ally team-sets, how many deviated from the assumed 2-2-2
// once the user is added back? We can't see the user's hero in the set
// (it's excluded), but we know their role; add it back.
//
// USES `user_role_played`, NOT `anchor_role`.
// matchup_user emits ONE ROW PER HERO PLAYED (changed from a single
// longest-played anchor per match). anchor_role is therefore per-HERO:
// a 6v6 open-queue match where tank was played and then DPS produces two
// ally rows with DIFFERENT anchor_role values. The distinct-match_id guard
// below keeps whichever row arrives FIRST, and Postgres row order is not
// stable -- so the same match could count as conforming on one load and
// deviating on the next.
//
// user_role_played comes from matches.role_played: exactly one value per
// match by construction, and it means "the role I queued". Both it and the
// old anchor_role are approximations when two roles were genuinely played
// in one open-queue game, but only this one is deterministic.
export function conformance222(rows: TeamSetRow[]): { conforming: number; deviating: number; total: number } {
  let conforming = 0, deviating = 0, total = 0
  const seen = new Set<number>()
  for (const r of rows) {
    if (r.match_format !== '6v6' || r.relation !== 'ally') continue
    if (seen.has(r.match_id)) continue
    seen.add(r.match_id)
    total++
    const t = r.n_tank + (r.user_role_played === 'tank' ? 1 : 0)
    const d = r.n_dps + (r.user_role_played === 'dps' ? 1 : 0)
    const s = r.n_support + (r.user_role_played === 'support' ? 1 : 0)
    if (t === 2 && d === 2 && s === 2) conforming++
    else deviating++
  }
  return { conforming, deviating, total }
}

// ====================================================================
// PAIRING MATRIX  (the combination-lab grid)
// ====================================================================
// A grid of pairwise win rates among selected heroes.
//
//  • Same-relation (ally×ally or enemy×enemy): a SYMMETRIC square. Each
//    off-diagonal cell = win rate in games where BOTH heroes shared that
//    team (co-occurrence pair). The DIAGONAL = that hero's solo rate on
//    that team. rows === cols === selection.
//  • Cross-relation (ally rows × enemy cols, for "Both"): each cell =
//    win rate in games where the ally hero was on the user's team AND
//    the enemy hero was on the enemy team. No diagonal meaning.
//
// All cells games-weighted by distinct match_id; null winRate when no
// decisive games; lowConfidence under CONFIDENCE_MIN_GAMES.

export interface MatrixCell {
  rowHero: string
  colHero: string
  wins: number
  losses: number
  draws: number
  games: number
  winRate: number | null
  lowConfidence: boolean
  isDiagonal: boolean
}

export interface PairingMatrix {
  rowHeroes: string[]
  colHeroes: string[]
  cells: MatrixCell[][]   // [rowIndex][colIndex]
}

function mkMatrixCell(rowHero: string, colHero: string, isDiagonal: boolean): MatrixCell {
  return { rowHero, colHero, wins: 0, losses: 0, draws: 0, games: 0, winRate: null, lowConfidence: true, isDiagonal }
}
function tallyResult(cell: MatrixCell, result: Result) {
  if (result === 'victory') cell.wins++
  else if (result === 'defeat') cell.losses++
  else cell.draws++
}
function finalizeMatrixCell(c: MatrixCell): MatrixCell {
  const decisive = c.wins + c.losses
  c.games = c.wins + c.losses + c.draws
  c.winRate = decisive > 0 ? Math.round((100 * c.wins / decisive) * 100) / 100 : null
  c.lowConfidence = c.games < CONFIDENCE_MIN_GAMES
  return c
}

// Same-relation square matrix (ally×ally or enemy×enemy).
export function pairingMatrixSameRelation(
  rows: TeamSetRow[],
  relation: Relation,
  filters: MatchupFilters,
  anchorHero: string | null,
  selection: string[],
): PairingMatrix {
  const heroes = [...selection]
  const cells: MatrixCell[][] = heroes.map((rh) =>
    heroes.map((ch) => mkMatrixCell(rh, ch, rh === ch)))
  // dedup per (i,j) cell by match
  const seen: Set<string>[][] = heroes.map(() => heroes.map(() => new Set<string>()))

  for (const r of rows) {
    if (r.relation !== relation) continue
    if (anchorHero !== null && r.anchor_hero !== anchorHero) continue
    if (!passesFilters(r, filters)) continue
    const present = new Set(r.hero_set)
    for (let i = 0; i < heroes.length; i++) {
      const hi = heroes[i]
      if (!present.has(hi)) continue
      for (let j = 0; j < heroes.length; j++) {
        const hj = heroes[j]
        // diagonal: hero present at all; off-diagonal: both present
        if (i === j ? present.has(hi) : present.has(hj)) {
          const key = String(r.match_id)
          if (seen[i][j].has(key)) continue
          seen[i][j].add(key)
          tallyResult(cells[i][j], r.result)
        }
      }
    }
  }
  for (const row of cells) for (const c of row) finalizeMatrixCell(c)
  return { rowHeroes: heroes, colHeroes: heroes, cells }
}

// Cross-relation rectangle: ally heroes (rows) × enemy heroes (cols).
export function pairingMatrixCross(
  rows: TeamSetRow[],
  filters: MatchupFilters,
  anchorHero: string | null,
  allySel: string[],
  enemySel: string[],
): PairingMatrix {
  const allyByMatch = new Map<number, TeamSetRow>()
  const enemyByMatch = new Map<number, TeamSetRow>()
  for (const r of rows) {
    if (anchorHero !== null && r.anchor_hero !== anchorHero) continue
    if (!passesFilters(r, filters)) continue
    if (r.relation === 'ally') allyByMatch.set(r.match_id, r)
    else enemyByMatch.set(r.match_id, r)
  }

  const cells: MatrixCell[][] = allySel.map((rh) =>
    enemySel.map((ch) => mkMatrixCell(rh, ch, false)))

  for (const [mid, allyRow] of allyByMatch) {
    const enemyRow = enemyByMatch.get(mid)
    if (!enemyRow) continue
    const allyPresent = new Set(allyRow.hero_set)
    const enemyPresent = new Set(enemyRow.hero_set)
    for (let i = 0; i < allySel.length; i++) {
      if (!allyPresent.has(allySel[i])) continue
      for (let j = 0; j < enemySel.length; j++) {
        if (!enemyPresent.has(enemySel[j])) continue
        tallyResult(cells[i][j], allyRow.result)
      }
    }
  }
  for (const row of cells) for (const c of row) finalizeMatrixCell(c)
  return { rowHeroes: allySel, colHeroes: enemySel, cells }
}

// ====================================================================
// LIFT DRILL-DOWN  (combination explorer)
// ====================================================================
// Starting from a base set (your anchor hero + any added so far),
// compute the win rate of the base, then for each candidate hero the
// win rate of base+candidate and the DELTA (lift) vs the base.
// Candidates are constrained by remaining ROLE SLOTS:
//   • the team shape (1-2-2 for 5v5; the 6v6 shape for 6v6)
//   • minus the user's own slot on the ally side (anchor role)
//   • minus roles already filled by the current set
// Same games-weighting + confidence rule as everywhere else.

export interface LiftBase {
  set: string[]
  cell: Cell        // win rate of the base set (co-occurrence)
}
export interface LiftCandidate {
  hero: string
  role: Role
  cell: Cell        // win rate of base + this hero
  delta: number | null   // cell.winRate - base.winRate, null if either null
}
export interface LiftView {
  base: LiftBase
  candidates: LiftCandidate[]   // ranked: biggest positive lift first
  full: boolean                 // true when all slots are filled (no candidates)
}

// Count how many of each role a set of heroes occupies (by hero role).
function roleCounts(heroes: string[], heroRole: (h: string) => Role | null): SlotShape {
  const c: SlotShape = { tank: 0, dps: 0, support: 0 }
  for (const h of heroes) { const r = heroRole(h); if (r) c[r]++ }
  return c
}

// Which roles still have open slots, given the team shape and what the
// current set already fills. On the ally side, pass the user's role so
// their own slot is reserved (subtracted from the shape).
export function openRoles(
  shape: SlotShape,
  currentSet: string[],
  heroRole: (h: string) => Role | null,
  userRole: Role | null,   // null on enemy side (user not on that team)
): Role[] {
  const filled = roleCounts(currentSet, heroRole)
  const reserve: SlotShape = { tank: 0, dps: 0, support: 0 }
  if (userRole) reserve[userRole] = 1
  const out: Role[] = []
  for (const role of ['tank', 'dps', 'support'] as Role[]) {
    if (shape[role] - reserve[role] - filled[role] > 0) out.push(role)
  }
  return out
}

export function computeLift(
  rows: TeamSetRow[],
  relation: Relation,
  filters: MatchupFilters,
  anchorHero: string | null,
  baseSet: string[],            // heroes already chosen (excl. user on ally side)
  shape: SlotShape,             // team shape (1-2-2 or 6v6 shape)
  userRole: Role | null,        // user's role on ally side; null on enemy
  heroRole: (h: string) => Role | null,
  allHeroes: { name: string; role: Role }[],
): LiftView {
  const base = aggregateCombo(rows, relation, filters, anchorHero, baseSet, 'cooccurrence')
  const baseCell: Cell = {
    hero: baseSet.join(' + ') || '(base)', role: 'dps',
    wins: base.wins, losses: base.losses, draws: base.draws, games: base.games,
    decisive: base.decisive, winRate: base.winRate, lowConfidence: base.lowConfidence,
    anyRoleDisagreement: false,
  }

  const open = openRoles(shape, baseSet, heroRole, userRole)
  const chosen = new Set(baseSet)

  const candidates: LiftCandidate[] = allHeroes
    .filter((h) => open.includes(h.role) && !chosen.has(h.name))
    .map((h) => {
      const c = aggregateCombo(rows, relation, filters, anchorHero, [...baseSet, h.name], 'cooccurrence')
      const cell: Cell = {
        hero: h.name, role: h.role,
        wins: c.wins, losses: c.losses, draws: c.draws, games: c.games,
        decisive: c.decisive, winRate: c.winRate, lowConfidence: c.lowConfidence,
        anyRoleDisagreement: false,
      }
      const delta = (cell.winRate == null || baseCell.winRate == null)
        ? null : Math.round((cell.winRate - baseCell.winRate) * 100) / 100
      return { hero: h.name, role: h.role, cell, delta }
    })
    .sort((a, b) => {
      if (a.delta == null && b.delta == null) return b.cell.games - a.cell.games
      if (a.delta == null) return 1
      if (b.delta == null) return -1
      if (b.delta !== a.delta) return b.delta - a.delta
      return b.cell.games - a.cell.games
    })

  return { base: { set: baseSet, cell: baseCell }, candidates, full: open.length === 0 }
}

// ---- Interleaved both-sides lift ----------------------------------
// One combined ally+enemy base (win rate where the ally set was with
// you AND the enemy set was against you). Candidates from BOTH sides are
// ranked together; each candidate's delta is measured against the same
// combined base. Each candidate is tagged with the side it would join.
export interface LiftCandidateBoth extends LiftCandidate {
  relation: Relation
}
export interface LiftViewBoth {
  base: LiftBase
  candidates: LiftCandidateBoth[]
  full: boolean
}

function cellFromCombo(c: { wins: number; losses: number; draws: number; games: number; decisive: number; winRate: number | null; lowConfidence: boolean }, label: string, role: Role): Cell {
  return {
    hero: label, role,
    wins: c.wins, losses: c.losses, draws: c.draws, games: c.games,
    decisive: c.decisive, winRate: c.winRate, lowConfidence: c.lowConfidence,
    anyRoleDisagreement: false,
  }
}

export function computeLiftBoth(
  rows: TeamSetRow[],
  filters: MatchupFilters,
  anchorHero: string | null,
  allyBase: string[],
  enemyBase: string[],
  allyShape: SlotShape,
  enemyShape: SlotShape,
  userRole: Role | null,        // user's role (ally side reserve)
  heroRole: (h: string) => Role | null,
  allHeroes: { name: string; role: Role }[],
): LiftViewBoth {
  const base = aggregateBoth(rows, filters, anchorHero, allyBase, enemyBase, 'cooccurrence', 'cooccurrence')
  const baseLabel = [...allyBase, ...enemyBase].join(' + ') || '(base)'
  const baseCell = cellFromCombo(base, baseLabel, 'dps')

  const allyOpen = openRoles(allyShape, allyBase, heroRole, userRole)
  const enemyOpen = openRoles(enemyShape, enemyBase, heroRole, null)
  const allyChosen = new Set(allyBase)
  const enemyChosen = new Set(enemyBase)

  const cands: LiftCandidateBoth[] = []

  for (const h of allHeroes) {
    if (allyOpen.includes(h.role) && !allyChosen.has(h.name)) {
      const c = aggregateBoth(rows, filters, anchorHero, [...allyBase, h.name], enemyBase, 'cooccurrence', 'cooccurrence')
      const cell = cellFromCombo(c, h.name, h.role)
      const delta = (cell.winRate == null || baseCell.winRate == null)
        ? null : Math.round((cell.winRate - baseCell.winRate) * 100) / 100
      cands.push({ hero: h.name, role: h.role, cell, delta, relation: 'ally' })
    }
    if (enemyOpen.includes(h.role) && !enemyChosen.has(h.name)) {
      const c = aggregateBoth(rows, filters, anchorHero, allyBase, [...enemyBase, h.name], 'cooccurrence', 'cooccurrence')
      const cell = cellFromCombo(c, h.name, h.role)
      const delta = (cell.winRate == null || baseCell.winRate == null)
        ? null : Math.round((cell.winRate - baseCell.winRate) * 100) / 100
      cands.push({ hero: h.name, role: h.role, cell, delta, relation: 'enemy' })
    }
  }

  cands.sort((a, b) => {
    if (a.delta == null && b.delta == null) return b.cell.games - a.cell.games
    if (a.delta == null) return 1
    if (b.delta == null) return -1
    if (b.delta !== a.delta) return b.delta - a.delta
    return b.cell.games - a.cell.games
  })

  return {
    base: { set: [...allyBase, ...enemyBase], cell: baseCell },
    candidates: cands,
    full: allyOpen.length === 0 && enemyOpen.length === 0,
  }
}
