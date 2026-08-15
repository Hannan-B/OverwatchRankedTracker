// ============================================================
// DATABASE TYPES — matches the Supabase schema
// ============================================================

export type MatchResult = 'victory' | 'defeat' | 'draw'
export type RoleType = 'tank' | 'dps' | 'support'
export type StartingSide = 'attack' | 'defense'
export type ImageType = 'summary' | 'teams' | 'personal' | 'scoreboard_closeup'

// ── Question scale version 1 — FROZEN (v1.1.0) ──────────────────
// Still exported because Season 3 and earlier are stored on these enums and
// must stay readable. They are NO LONGER WRITTEN: the phone stopped emitting
// them when the question set was rebuilt. Do not map version-2 answers onto
// these, and never pool the two scales — see seasons.question_scale_version.
export type MatchFeel = 'stomped_them' | 'close_game' | 'got_stomped'
export type PerformanceFeel = 'carried' | 'did_my_job' | 'struggled'

// ── Question scale version 2 (v1.1.0) ───────────────────────────
// The new answers are plain smallints, not enums, so there is no union to
// declare for them — matchup_feel 1-5, performance_rating 1-5, fun_rating_6
// 1-6, each with a CHECK constraint in the database. The labels live in
// upload/page.tsx (capture) and feel-lib.ts (display); duplicating them as a
// type here would be a third copy to drift.

/** Three-state leaver detail. Postgres enum `leaver_type`.
 *  `none`     — no leaver; scoreboard written, counts everywhere.
 *  `left`     — never came back. NO scoreboard rows exist: the board is a row
 *               short, so it is geometrically asymmetric and slot N may not be
 *               the player the extractor believes it is.
 *  `returned` — came back. The board has its full complement of rows at
 *               screenshot time, so the geometry is intact and only the NUMBERS
 *               are skewed. Scoreboard IS written, then excluded from
 *               scoreboard-derived surfaces at read time. */
export type LeaverType = 'none' | 'left' | 'returned'

/** Which kind of post-match pick a `match_standouts` row records. */
export type StandoutKind = 'impressed_ally' | 'struggled_enemy'

export interface Season {
  id: number
  name: string
  start_date: string
  end_date: string
  /** Which feel/question scale this season was played under. 1 = original
   *  (match_feel, performance_feel, fun_rating 1-5, tilt_mood, tempo,
   *  coordination). 2 = v1.1.0 (matchup_feel, performance_rating,
   *  fun_rating_6; tilt/tempo/coordination retired).
   *
   *  A scale holds for an ENTIRE season and changes only at a boundary, so
   *  charts ask the season what scale it used rather than hardcoding "season 3
   *  onwards" — which breaks silently the next time the questions change, and
   *  they are expected to keep changing. NOT NULL, defaults to 1. */
  question_scale_version: number
  created_at: string
}

export interface Match {
  id: number
  played_at: string
  season_id: number | null
  map: string
  game_mode: string | null
  result: MatchResult
  score: string | null
  role_played: RoleType
  roles_played: RoleType[] | null          // Array for 6v6 multi-role; single-element for 5v5
  match_format: '5v5' | '6v6'             // Which format this match was played in
  ally_team_comp: string | null            // e.g. "2-2-2", "1-4-1" (tank-dps-support)
  enemy_team_comp: string | null           // same format
  game_length_seconds: number | null
  starting_side: StartingSide | null
  total_eliminations: number | null
  total_assists: number | null
  total_deaths: number | null
  elims_per_10_min: number | null
  assists_per_10_min: number | null
  deaths_per_10_min: number | null
  personal_thoughts: string | null
  is_alpha: boolean
  created_at: string
  updated_at: string

  // ── FEEL — scale version 1, FROZEN (see seasons.question_scale_version) ──
  // Written for Season 3 and earlier. The phone no longer emits any of these.
  // They keep their historical values and stay fully queryable; nothing here
  // is dropped. Never pool them with the version-2 fields below.
  match_feel: MatchFeel | null
  performance_feel: PerformanceFeel | null
  /** 1-5, CHECK-constrained. Superseded by fun_rating_6 — a separate column
   *  rather than a widened CHECK, because sharing one column would make a
   *  stored `5` permanently ambiguous between the two scales. */
  fun_rating: number | null
  /** RETIRED. The answer depends on whether the session is over, which isn't
   *  known when answering. Loss carry-over is derived from played_at instead. */
  tilt_mood: string | null
  /** RETIRED. Any single value for a multi-round game is a lie, and the stored
   *  answers were entered without thought. Kept for historical seasons only. */
  team_tempo: string | null
  team_coordination: string | null
  enemy_tempo: string | null
  enemy_coordination: string | null

  // ── FEEL — scale version 2 (v1.1.0) ──
  /** 1-5: Outclassed / Behind / Even / Ahead / Dominant. Measures TEAM
   *  STRENGTH, not result — "Behind" plus a victory is legitimate. Keeps its
   *  midpoint deliberately: "evenly matched" is the exact state the founding
   *  hypothesis is about. Replaces match_feel; there is NO mapping between them. */
  matchup_feel: number | null
  /** 1-5: Off my game / Below par / Did my job / Played well / Carried.
   *  Replaces performance_feel; no mapping. */
  performance_rating: number | null
  /** 1-6, deliberately NO midpoint so every answer must lean: Miserable / Bad /
   *  Poor / Good / Great / Brilliant. Replaces fun_rating; no mapping. */
  fun_rating_6: number | null

  // ── LEAVERS + THROWERS ──
  /** NOT NULL, default 'none'. Kept in sync with team_leaver — the boolean is
   *  read in many places (builder-lib's variable registry, combat_facts, the
   *  Home leaver displays) and is deliberately NOT dropped in this patch. */
  team_leaver_type: LeaverType
  enemy_leaver_type: LeaverType
  /** NOT NULL, default false. `true` for BOTH 'left' and 'returned'. */
  team_leaver: boolean
  enemy_leaver: boolean
  /** A thrown game produces a complete, valid scoreboard — the numbers are
   *  simply bad. So thrower exclusion is a read-time PREFERENCE, never a
   *  write-time filter, unlike the leaver rules above. */
  team_thrower: boolean
  enemy_thrower: boolean
}

export interface HeroPerformance {
  id: number
  match_id: number
  hero_name: string
  percent_played: number | null
  play_time_seconds: number | null
  eliminations: number | null
  assists: number | null
  deaths: number | null
  display_order: number
  created_at: string
}

export interface HeroStat {
  id: number
  hero_performance_id: number
  stat_name: string
  stat_value: string
  avg_per_10_min: string | null
  created_at: string
}

export interface MatchImage {
  id: number
  match_id: number
  image_type: ImageType
  storage_path: string
  hero_name: string | null
  created_at: string
}

export interface UserSettings {
  id: number
  gamertag: string | null
  default_role: RoleType | null
  created_at: string
  updated_at: string
}

export interface ScoreboardPlayer {
  id: number
  match_id: number
  slot: number          // 1-10 (5v5) or 1-12 (6v6)
  team: 'ally' | 'enemy'
  hero_name: string | null
  role: RoleType | null
  is_user: boolean
  user_match_method: 'ocr_auto' | 'ocr_confirmed' | 'manual_select' | 'hero_match' | null
  eliminations: number | null
  assists: number | null
  deaths: number | null
  damage: number | null
  healing: number | null
  mitigation: number | null
  created_at: string
}

/** A post-match subjective pick: an ally who impressed, or an enemy who gave
 *  trouble. Captured ON THE PHONE immediately after the match, because
 *  /process can run three days later — by which point the answer is invented
 *  rather than recalled.
 *
 *  SLOT IS THE CAPTURED FACT; hero_name is RESOLVED AT SAVE TIME, after the
 *  hero audit has run. The hero behind a slot is not trustworthy until
 *  HeroAuditPanel has been through it, and a corrected misidentification must
 *  carry through to the pick — so hero_name stays nullable and a resolution
 *  failure leaves the pick recorded rather than lost.
 *
 *  Slot convention mirrors scoreboard_players: 5v5 ally 1-5 / enemy 6-10;
 *  6v6 ally 1-6 / enemy 7-12. `team` is deliberately not stored — slot is
 *  unique within a match, so team comes free from the scoreboard.
 *
 *  No rows are ever written for a permanent-leaver game: there is no
 *  scoreboard, so the capture step is skipped entirely. An explicit "nothing
 *  stood out" also writes no rows. */
export interface MatchStandout {
  id: number
  match_id: number
  kind: StandoutKind
  slot: number
  hero_name: string | null
  created_at: string
}

// ============================================================
// VIEW TYPES — for dashboard queries
// ============================================================

export interface MatchOverview {
  id: number
  played_at: string
  season_name: string | null
  map: string
  game_mode: string | null
  result: MatchResult
  score: string | null
  role_played: RoleType
  game_length_seconds: number | null
  total_eliminations: number | null
  total_assists: number | null
  total_deaths: number | null
  fun_rating: number | null
  match_feel: MatchFeel | null
  heroes_played: string[]
}

export interface HeroAnalytics {
  hero_name: string
  times_played: number
  wins: number
  losses: number
  draws: number
  win_rate: number
  avg_percent_played: number
  role_played: RoleType
}

export interface MapAnalytics {
  map: string
  game_mode: string | null
  matches_played: number
  wins: number
  losses: number
  win_rate: number
  role_played: RoleType
}

// ============================================================
// FORM TYPES — for match entry
// ============================================================

export interface MatchFormData {
  map: string
  game_mode: string
  result: MatchResult
  score: string
  role_played: RoleType
  roles_played: RoleType[]                 // Array for 6v6 multi-role; single-element for 5v5
  match_format: '5v5' | '6v6'
  game_length_seconds: number | null
  starting_side: StartingSide | null
  total_eliminations: number | null
  total_assists: number | null
  total_deaths: number | null
  // ── Feel, scale version 2 ──
  // The manual entry form writes the SAME columns as the phone. It does not
  // read the current season's version and switch: the phone hardcodes version
  // 2, so a season-aware form would let the two capture routes disagree. The
  // mismatch warning lives on the Settings season badge instead.
  /** 1-5: Outclassed / Behind / Even / Ahead / Dominant. */
  matchup_feel: number | null
  /** 1-5: Off my game / Below par / Did my job / Played well / Carried. */
  performance_rating: number | null
  /** 1-6, no midpoint: Miserable / Bad / Poor / Good / Great / Brilliant. */
  fun_rating_6: number | null
  personal_thoughts: string
  heroes: HeroFormData[]
}

export interface HeroFormData {
  hero_name: string
  percent_played: number | null
  play_time_seconds: number | null
  display_order: number
  stats: HeroStatFormData[]
}

export interface HeroStatFormData {
  stat_name: string
  stat_value: string
  avg_per_10_min: string | null
}

// ============================================================
// SCOREBOARD EXTRACTION TYPES
// ============================================================

/** Grid row layout extracted during scoreboard detection */
export interface ScoreboardGridRow {
  slot: number          // 1-5/6 ally, 6-10/7-12 enemy (depends on format)
  team: 'ally' | 'enemy'
  topY: number
  centerY: number
  bottomY: number
}

/** Full grid layout for a scoreboard image */
export interface ScoreboardGrid {
  ally: { startY: number; endY: number; rowHeight: number }
  enemy: { startY: number; endY: number; rowHeight: number }
  rows: ScoreboardGridRow[]
  rowsPerTeam: number  // 5 for 5v5, 6 for 6v6
  columns: {
    roleIcon:  { x: number }
    portrait:  { startX: number; endX: number }
    username:  { startX: number; endX: number }
    E:   { startX: number; endX: number; centerX: number }
    A:   { startX: number; endX: number; centerX: number }
    D:   { startX: number; endX: number; centerX: number }
    DMG: { startX: number; endX: number; centerX: number }
    H:   { startX: number; endX: number; centerX: number }
    MIT: { startX: number; endX: number; centerX: number }
  }
}

/** Step 1 — Is this image a scoreboard? */
export interface ScoreboardDetectionResult {
  imageType: 'scoreboard' | 'summary' | 'breakdown' | 'unknown'
  confidence: number
  signals: string[]
  grid: ScoreboardGrid | null
  format: '5v5' | '6v6' | null  // Derived from row count auto-detection
  // ── Table geometry (v1.1.1) ──
  // The scoreboard table is CENTRED at x~1919.5 on every board of both formats,
  // but its WIDTH varies with content, so the left edge moves by half the width
  // change. Measured over ten boards: 5v5 width 1690-1699 (edge moves 4px, which
  // is why its hardcoded constants have always worked); 6v6 width 1462-1517
  // (edge moves 27px, which is why they have not).
  //
  // Everything inside the table sits at a FIXED offset from this edge — the role
  // icon at +10/11, the portrait at +52/54 — so `tableLeft` is the anchor every
  // x-constant should be derived from. Carried here rather than passed as an
  // argument because classifyRoles / identifyHeroes / extractStats already
  // receive the detection result, so no signature changes.
  //
  // Optional: null when the scan fails or the image is not a scoreboard. A
  // consumer MUST fall back to its hardcoded constant rather than assume 0.
  // See KNOWN-FAILURE-MODES.md §14.
  tableLeft?: number | null
  tableWidth?: number | null
}

/** Step 2 — Which hero is in each row? */
export interface ScoreboardHeroIdentification {
  slot: number        // 1-N ally, (N+1)-2N enemy
  team: 'ally' | 'enemy'
  heroName: string | null
  confidence: number
  portraitDataUrl: string | null // cropped portrait thumbnail
  // ── Match diagnostics (v1.0.2) ──
  // The matcher computes all of these and, until now, printed them to the
  // console and discarded them — the /testing report could only recover them
  // by regexing its own log output. They are carried here so the per-slot
  // hero audit can store them alongside the user's verdict, turning a season
  // of logged matches into a labelled dataset.
  /** best-vs-runner-up score gap. The only confidence measure that survives
   *  the two scoring scales (Pass 1 no-ORB vs Pass 2 with-ORB). */
  margin?: number
  /** second-placed hero, i.e. what it would have said instead. */
  runnerUp?: string | null
  /** true when Pass 2 (ORB) produced this result — also marks which scale
   *  `confidence` is on, since the two are not comparable. */
  orbApplied?: boolean
  /** 1-based crop variant that won, of the multi-crop net. */
  cropIndex?: number
  /** Phase-1 cleanest-crop pick and its score, for the crop-selection check. */
  phase1Hero?: string | null
  phase1Score?: number
}

/** Step 3 — Which player is the user? */
export interface ScoreboardPlayerLabel {
  slot: number
  team: 'ally' | 'enemy'
  heroName: string | null
  isUser: boolean
  userMatchMethod: 'ocr_auto' | 'ocr_confirmed' | 'manual_select' | 'hero_match' | null
  positionalLabel: string | null  // e.g. "Ally DPS 1", "Enemy Support 2"
  displayName: string | null      // gamertag for user, positionalLabel for others
}

/** User identification candidate (one per ally slot) */
export interface ScoreboardUserCandidate {
  slot: number
  heroName: string | null
  heroPortraitUrl: string | null  // 64×64 hero portrait thumbnail
  gamertagCropUrl: string | null  // raw gamertag crop from scoreboard
  ocrSimilarity: number
}

/** OCR analysis result — may need manual confirmation */
export interface ScoreboardOcrAnalysis {
  resolved: boolean               // true = Tier 1 auto-accepted
  userSlot: number | null         // set when resolved
  bestCandidate: {
    slot: number
    similarity: number
    margin: number
  }
  candidates: ScoreboardUserCandidate[]     // all 5 ally slots
}

/** Step 4 — What role is each player? */
export interface ScoreboardRoleClassification {
  slot: number
  team: 'ally' | 'enemy'
  heroName: string | null
  role: 'tank' | 'dps' | 'support' | null
  source: 'hero_lookup' | 'icon_detection' | null
}

/** Step 5 — What are the stats for each player? */
export interface ScoreboardPlayerStats {
  slot: number
  team: 'ally' | 'enemy'
  heroName: string | null
  role: 'tank' | 'dps' | 'support' | null
  isUser: boolean
  eliminations: number | null
  assists: number | null
  deaths: number | null
  damage: number | null
  healing: number | null
  mitigation: number | null
}
