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
