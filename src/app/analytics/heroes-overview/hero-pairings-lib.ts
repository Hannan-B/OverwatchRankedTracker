// ============================================================
// HERO-PAIRINGS LIB — your OWN self-played hero combinations
// ------------------------------------------------------------
// Pure logic, no React (testable in isolation, mirrors matchups-lib style).
//
// THE QUESTION THIS ANSWERS:
//   "In a given queue/mode, do I win more as Reaper+Mei or Reaper+Cassidy?"
// i.e. combinations of heroes that *I personally play* within one match, and
// how those combinations perform — distinct from the Matchups page (which is
// about OTHER people's heroes relative to my one anchor).
//
// GRAIN & WEIGHTING:
//   Input is hero_match_facts rows — one row per hero I played >=60s in a
//   match. Multiple rows share a match_id. A "lineup" for a match is the SET of
//   heroes I played that game whose percent_played >= the chosen threshold.
//   Every combo is GAMES-WEIGHTED: a match contributes its single result once
//   to each combo it supports (never double-counted across my hero rows).
//
// COMBO MODES:
//   • co-occurrence: combo C is credited a game if C ⊆ lineup. A 3-hero lineup
//     credits all its sub-combos (its pairs, its trios, the solos).
//   • exact: combo C is credited only if C === lineup exactly.
//
// LIFT (the centrepiece):
//   Each combo's win rate is read against the SOLO baseline of its heroes.
//   "Adding Mei to my Reaper games moved my win rate 58% → 64% (+6)."
// ============================================================

export type Result = 'victory' | 'defeat' | 'draw'
export const CONFIDENCE_MIN_GAMES = 5

// One hero I played in one match (a hero_match_facts row, trimmed to what we
// need). percent_played is 0..100; null is treated as 0 (unknown stint).
export interface HeroPlayRow {
  match_id: number
  hero_name: string
  percent_played: number | null
  result: Result
  match_format: '5v5' | '6v6'
  game_mode: string | null
  map: string | null
  starting_side: 'attack' | 'defense' | null
}

// Filters shared with the rest of analytics (queue/mode/map). Queue's role
// component can't be enforced on hero grain (no role column) — handled by the
// page's hero scoping, same as the builder. Format + mode + map apply here.
export interface ComboFilters {
  format: '5v5' | '6v6' | 'all'
  mode: string | 'all'
  map: string | 'all'
}

// A match reduced to: my lineup (heroes >= threshold) + its result + dims.
export interface MatchLineup {
  match_id: number
  heroes: string[]   // sorted, distinct, >= threshold
  result: Result
}

// ---- Build per-match lineups from raw rows -----------------------------
// Applies the filters and the percent_played threshold, then groups by match.
// A hero counts toward the lineup iff percent_played >= thresholdPct.
export function buildLineups(
  rows: HeroPlayRow[],
  filters: ComboFilters,
  thresholdPct: number,
): MatchLineup[] {
  const byMatch = new Map<number, { heroes: Set<string>; result: Result }>()
  for (const r of rows) {
    if (filters.format !== 'all' && r.match_format !== filters.format) continue
    if (filters.mode !== 'all' && r.game_mode !== filters.mode) continue
    if (filters.map !== 'all' && r.map !== filters.map) continue
    const pct = r.percent_played == null ? 0 : r.percent_played
    if (pct < thresholdPct) continue
    if (!byMatch.has(r.match_id)) byMatch.set(r.match_id, { heroes: new Set(), result: r.result })
    byMatch.get(r.match_id)!.heroes.add(r.hero_name)
  }
  const out: MatchLineup[] = []
  for (const [match_id, v] of byMatch) {
    if (v.heroes.size === 0) continue
    out.push({ match_id, heroes: Array.from(v.heroes).sort(), result: v.result })
  }
  return out
}

// Win rate from W/L (draws excluded from denominator). null when no decisive.
function rate(wins: number, losses: number): number | null {
  const decisive = wins + losses
  return decisive > 0 ? Math.round((wins / decisive) * 10000) / 100 : null
}

// ---- Solo baselines -----------------------------------------------------
// For each hero, the win rate across all games where that hero was in my
// lineup (co-occurrence solo). This is the diagonal of the matrix and the
// baseline that lift is measured against.
export interface HeroStat {
  hero: string
  wins: number
  losses: number
  draws: number
  games: number
  winRate: number | null
  lowConfidence: boolean
}

export function soloBaselines(lineups: MatchLineup[]): Map<string, HeroStat> {
  const m = new Map<string, HeroStat>()
  for (const lu of lineups) {
    for (const hero of lu.heroes) {
      if (!m.has(hero)) m.set(hero, { hero, wins: 0, losses: 0, draws: 0, games: 0, winRate: null, lowConfidence: true })
      const s = m.get(hero)!
      if (lu.result === 'victory') s.wins++
      else if (lu.result === 'defeat') s.losses++
      else s.draws++
    }
  }
  for (const s of m.values()) {
    s.games = s.wins + s.losses + s.draws
    s.winRate = rate(s.wins, s.losses)
    s.lowConfidence = s.games < CONFIDENCE_MIN_GAMES
  }
  return m
}

// ---- Combos -------------------------------------------------------------
// A combo is an unordered set of heroes (key = sorted names joined). We track
// each combo's record + the lift vs its heroes' solo baselines.
export interface ComboStat {
  heroes: string[]       // sorted
  key: string
  size: number
  wins: number
  losses: number
  draws: number
  games: number
  winRate: number | null
  lowConfidence: boolean
  // Lift vs the AVERAGE solo win rate of the combo's members (null if any
  // member has no solo rate). Positive = the combo wins more than its heroes do
  // individually on average.
  lift: number | null
}

const SEP = '\u241F' // unit-separator, safe inside hero names join
export function comboKey(heroes: string[]): string {
  return [...heroes].sort().join(SEP)
}

// All non-empty subsets of a sorted hero list, of size >= minSize. Used for
// co-occurrence: a lineup credits every subset. Capped by maxSize to avoid a
// combinatorial blow-up on absurd lineups (a single match never has many of
// MY heroes, but guard anyway).
export function subsets(heroes: string[], minSize: number, maxSize: number): string[][] {
  const out: string[][] = []
  const n = heroes.length
  for (let mask = 1; mask < (1 << n); mask++) {
    const pick: string[] = []
    for (let i = 0; i < n; i++) if (mask & (1 << i)) pick.push(heroes[i])
    if (pick.length >= minSize && pick.length <= maxSize) out.push(pick)
  }
  return out
}

export type ComboMode = 'cooccurrence' | 'exact'

// Aggregate combos across lineups.
//   • minSize: 1 includes solos; 2 = pairs and up.
//   • mode: co-occurrence (subsets) vs exact (whole lineup only).
export function aggregateCombos(
  lineups: MatchLineup[],
  solo: Map<string, HeroStat>,
  mode: ComboMode,
  minSize: number,
  maxSize = 6,
): ComboStat[] {
  const m = new Map<string, ComboStat>()
  const credit = (heroes: string[], result: Result) => {
    const key = comboKey(heroes)
    if (!m.has(key)) {
      m.set(key, {
        heroes: [...heroes].sort(), key, size: heroes.length,
        wins: 0, losses: 0, draws: 0, games: 0, winRate: null, lowConfidence: true, lift: null,
      })
    }
    const c = m.get(key)!
    if (result === 'victory') c.wins++
    else if (result === 'defeat') c.losses++
    else c.draws++
  }

  for (const lu of lineups) {
    if (mode === 'exact') {
      if (lu.heroes.length >= minSize && lu.heroes.length <= maxSize) credit(lu.heroes, lu.result)
    } else {
      for (const sub of subsets(lu.heroes, minSize, maxSize)) credit(sub, lu.result)
    }
  }

  for (const c of m.values()) {
    c.games = c.wins + c.losses + c.draws
    c.winRate = rate(c.wins, c.losses)
    c.lowConfidence = c.games < CONFIDENCE_MIN_GAMES
    // lift vs average solo baseline of members
    const solos = c.heroes.map(h => solo.get(h)?.winRate).filter((v): v is number => v != null)
    if (c.winRate != null && solos.length === c.heroes.length && solos.length > 0) {
      const avgSolo = solos.reduce((a, b) => a + b, 0) / solos.length
      c.lift = Math.round((c.winRate - avgSolo) * 100) / 100
    } else {
      c.lift = null
    }
  }
  return Array.from(m.values())
}

// ---- Lift drill-down: "what does adding a hero do?" ---------------------
// Given a BASE combo (already in my lineups), for each candidate hero NOT in
// the base, the win rate of base∪{candidate} and the delta vs the base's own
// win rate. Answers "I'm playing Reaper+Mei — should I add Cassidy?" directly.
export interface LiftRow {
  hero: string             // the added hero
  baseWinRate: number | null
  combinedWinRate: number | null
  delta: number | null     // combinedWinRate − baseWinRate
  games: number            // games of base∪{hero}
  lowConfidence: boolean
}

export function liftFromBase(
  lineups: MatchLineup[],
  base: string[],
): { baseStat: ComboStat | null; rows: LiftRow[] } {
  const baseSet = new Set(base)
  // base record (co-occurrence: games where base ⊆ lineup)
  let bw = 0, bl = 0, bd = 0
  const candidates = new Map<string, { w: number; l: number; d: number }>()
  for (const lu of lineups) {
    const has = base.every(h => lu.heroes.includes(h))
    if (!has) continue
    if (lu.result === 'victory') bw++; else if (lu.result === 'defeat') bl++; else bd++
    // candidates: heroes in this lineup not already in base
    for (const h of lu.heroes) {
      if (baseSet.has(h)) continue
      if (!candidates.has(h)) candidates.set(h, { w: 0, l: 0, d: 0 })
      const c = candidates.get(h)!
      if (lu.result === 'victory') c.w++; else if (lu.result === 'defeat') c.l++; else c.d++
    }
  }
  const baseWinRate = rate(bw, bl)
  const baseGames = bw + bl + bd
  const baseStat: ComboStat | null = base.length
    ? {
        heroes: [...base].sort(), key: comboKey(base), size: base.length,
        wins: bw, losses: bl, draws: bd, games: baseGames,
        winRate: baseWinRate, lowConfidence: baseGames < CONFIDENCE_MIN_GAMES, lift: null,
      }
    : null

  const rows: LiftRow[] = []
  for (const [hero, c] of candidates) {
    const combined = rate(c.w, c.l)
    const games = c.w + c.l + c.d
    rows.push({
      hero,
      baseWinRate,
      combinedWinRate: combined,
      delta: combined != null && baseWinRate != null ? Math.round((combined - baseWinRate) * 100) / 100 : null,
      games,
      lowConfidence: games < CONFIDENCE_MIN_GAMES,
    })
  }
  // sort by delta desc (biggest positive swing first), nulls last
  rows.sort((a, b) => {
    if (a.delta == null && b.delta == null) return b.games - a.games
    if (a.delta == null) return 1
    if (b.delta == null) return -1
    return b.delta - a.delta || b.games - a.games
  })
  return { baseStat, rows }
}

// ---- Pairing matrix (mirrors the Matchups page matrix) ------------------
// Heroes I play on both axes. cell[A][B] = my win rate in games where BOTH A
// and B were in my lineup (co-occurrence). Diagonal[A] = A's solo rate.
// Games-weighted, 2-decimal, <5 games flagged, null when no decisive games.
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
  heroes: string[]
  cells: MatrixCell[][]   // [row][col]
}

export function pairingMatrix(lineups: MatchLineup[], heroes: string[]): PairingMatrix {
  const order = [...heroes]
  const idx = new Map(order.map((h, i) => [h, i]))
  const cells: MatrixCell[][] = order.map((rh, i) =>
    order.map((ch, j) => ({
      rowHero: rh, colHero: ch, wins: 0, losses: 0, draws: 0, games: 0,
      winRate: null, lowConfidence: true, isDiagonal: i === j,
    }))
  )
  const bump = (i: number, j: number, result: Result) => {
    const c = cells[i][j]
    if (result === 'victory') c.wins++
    else if (result === 'defeat') c.losses++
    else c.draws++
  }
  for (const lu of lineups) {
    const present = lu.heroes.filter(h => idx.has(h))
    // diagonal: each present hero credited once for its solo presence
    for (const h of present) {
      const i = idx.get(h)!
      bump(i, i, lu.result)
    }
    // off-diagonal: each unordered pair present, both [i][j] and [j][i]
    for (let a = 0; a < present.length; a++) {
      for (let b = a + 1; b < present.length; b++) {
        const i = idx.get(present[a])!
        const j = idx.get(present[b])!
        bump(i, j, lu.result)
        bump(j, i, lu.result)
      }
    }
  }
  for (const row of cells) {
    for (const c of row) {
      c.games = c.wins + c.losses + c.draws
      c.winRate = rate(c.wins, c.losses)
      c.lowConfidence = c.games < CONFIDENCE_MIN_GAMES
    }
  }
  return { heroes: order, cells }
}

// Heroes I've actually played (>= threshold somewhere), most-played first —
// for populating axis pickers and default selections.
export function playedHeroes(lineups: MatchLineup[]): { hero: string; games: number }[] {
  const m = new Map<string, number>()
  for (const lu of lineups) for (const h of lu.heroes) m.set(h, (m.get(h) ?? 0) + 1)
  return Array.from(m.entries())
    .map(([hero, games]) => ({ hero, games }))
    .sort((a, b) => b.games - a.games || a.hero.localeCompare(b.hero))
}
