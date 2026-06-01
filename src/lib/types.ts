// ============================================================
// DATABASE TYPES — matches the Supabase schema
// ============================================================

export type MatchResult = 'victory' | 'defeat' | 'draw'
export type RoleType = 'tank' | 'dps' | 'support'
export type StartingSide = 'attack' | 'defense'
export type MatchFeel = 'stomped_them' | 'close_game' | 'got_stomped'
export type PerformanceFeel = 'carried' | 'did_my_job' | 'struggled'
export type NotableEvent = 'leaver' | 'smurf' | 'thrower' | 'great_teamwork'
export type ImageType = 'summary' | 'teams' | 'personal' | 'scoreboard_closeup'

export interface Season {
  id: number
  name: string
  start_date: string
  end_date: string
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
  match_feel: MatchFeel | null
  performance_feel: PerformanceFeel | null
  notable_events: NotableEvent[] | null
  fun_rating: number | null
  personal_thoughts: string | null
  created_at: string
  updated_at: string
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
  match_feel: MatchFeel | null
  performance_feel: PerformanceFeel | null
  notable_events: NotableEvent[]
  fun_rating: number | null
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
}

/** Step 2 — Which hero is in each row? */
export interface ScoreboardHeroIdentification {
  slot: number        // 1-N ally, (N+1)-2N enemy
  team: 'ally' | 'enemy'
  heroName: string | null
  confidence: number
  portraitDataUrl: string | null // cropped portrait thumbnail
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
