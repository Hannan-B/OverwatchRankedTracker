// ============================================================
// HERO, MAP, AND SEASON REFERENCE DATA
// ============================================================

export type TankSubRole = 'initiator' | 'bruiser' | 'stalwart'
export type DpsSubRole = 'sharpshooter' | 'flanker' | 'specialist' | 'recon'
export type SupportSubRole = 'tactician' | 'medic' | 'survivor'
export type SubRole = TankSubRole | DpsSubRole | SupportSubRole

export interface Hero {
  name: string
  role: 'tank' | 'dps' | 'support'
  subRole: SubRole
}

export interface GameMap {
  name: string
  mode: GameMode
  location: string
}

export type GameMode = 'escort' | 'control' | 'hybrid' | 'push' | 'flashpoint'

// ============================================================
// HEROES (53)
// ============================================================

export const HEROES: Hero[] = [
  // Tank — Initiator (5)
  { name: 'D.Va', role: 'tank', subRole: 'initiator' },
  { name: 'Doomfist', role: 'tank', subRole: 'initiator' },
  { name: 'Hazard', role: 'tank', subRole: 'initiator' },
  { name: 'Winston', role: 'tank', subRole: 'initiator' },
  { name: 'Wrecking Ball', role: 'tank', subRole: 'initiator' },
  // Tank — Bruiser (4)
  { name: 'Mauga', role: 'tank', subRole: 'bruiser' },
  { name: 'Orisa', role: 'tank', subRole: 'bruiser' },
  { name: 'Roadhog', role: 'tank', subRole: 'bruiser' },
  { name: 'Zarya', role: 'tank', subRole: 'bruiser' },
  // Tank — Stalwart (6)
  { name: 'D.Mon', role: 'tank', subRole: 'stalwart' },
  { name: 'Domina', role: 'tank', subRole: 'stalwart' },
  { name: 'Junker Queen', role: 'tank', subRole: 'stalwart' },
  { name: 'Ramattra', role: 'tank', subRole: 'stalwart' },
  { name: 'Reinhardt', role: 'tank', subRole: 'stalwart' },
  { name: 'Sigma', role: 'tank', subRole: 'stalwart' },

  // DPS — Sharpshooter (6)
  { name: 'Ashe', role: 'dps', subRole: 'sharpshooter' },
  { name: 'Cassidy', role: 'dps', subRole: 'sharpshooter' },
  { name: 'Hanzo', role: 'dps', subRole: 'sharpshooter' },
  { name: 'Sierra', role: 'dps', subRole: 'sharpshooter' },
  { name: 'Sojourn', role: 'dps', subRole: 'sharpshooter' },
  { name: 'Widowmaker', role: 'dps', subRole: 'sharpshooter' },
  // DPS — Flanker (7)
  { name: 'Anran', role: 'dps', subRole: 'flanker' },
  { name: 'Genji', role: 'dps', subRole: 'flanker' },
  { name: 'Reaper', role: 'dps', subRole: 'flanker' },
  { name: 'Shion', role: 'dps', subRole: 'flanker' },
  { name: 'Tracer', role: 'dps', subRole: 'flanker' },
  { name: 'Vendetta', role: 'dps', subRole: 'flanker' },
  { name: 'Venture', role: 'dps', subRole: 'flanker' },
  // DPS — Specialist (7)
  { name: 'Bastion', role: 'dps', subRole: 'specialist' },
  { name: 'Emre', role: 'dps', subRole: 'specialist' },
  { name: 'Junkrat', role: 'dps', subRole: 'specialist' },
  { name: 'Mei', role: 'dps', subRole: 'specialist' },
  { name: 'Soldier: 76', role: 'dps', subRole: 'specialist' },
  { name: 'Symmetra', role: 'dps', subRole: 'specialist' },
  { name: 'Torbjörn', role: 'dps', subRole: 'specialist' },
  // DPS — Recon (4)
  { name: 'Echo', role: 'dps', subRole: 'recon' },
  { name: 'Freja', role: 'dps', subRole: 'recon' },
  { name: 'Pharah', role: 'dps', subRole: 'recon' },
  { name: 'Sombra', role: 'dps', subRole: 'recon' },

  // Support — Tactician (5)
  { name: 'Ana', role: 'support', subRole: 'tactician' },
  { name: 'Baptiste', role: 'support', subRole: 'tactician' },
  { name: 'Jetpack Cat', role: 'support', subRole: 'tactician' },
  { name: 'Lúcio', role: 'support', subRole: 'tactician' },
  { name: 'Zenyatta', role: 'support', subRole: 'tactician' },
  // Support — Medic (4)
  { name: 'Kiriko', role: 'support', subRole: 'medic' },
  { name: 'Lifeweaver', role: 'support', subRole: 'medic' },
  { name: 'Mercy', role: 'support', subRole: 'medic' },
  { name: 'Moira', role: 'support', subRole: 'medic' },
  // Support — Survivor (5)
  { name: 'Brigitte', role: 'support', subRole: 'survivor' },
  { name: 'Illari', role: 'support', subRole: 'survivor' },
  { name: 'Juno', role: 'support', subRole: 'survivor' },
  { name: 'Mizuki', role: 'support', subRole: 'survivor' },
  { name: 'Wuyang', role: 'support', subRole: 'survivor' },
]

// ============================================================
// MAPS (30)
// ============================================================

export const MAPS: GameMap[] = [
  // Escort (8)
  { name: 'Circuit Royal', mode: 'escort', location: 'Monte Carlo' },
  { name: 'Dorado', mode: 'escort', location: 'Mexico' },
  { name: 'Havana', mode: 'escort', location: 'Cuba' },
  { name: 'Junkertown', mode: 'escort', location: 'Australia' },
  { name: 'Rialto', mode: 'escort', location: 'Italy' },
  { name: 'Route 66', mode: 'escort', location: 'USA' },
  { name: 'Shambali Monastery', mode: 'escort', location: 'Nepal' },
  { name: 'Watchpoint: Gibraltar', mode: 'escort', location: 'Gibraltar' },
  // Control (7)
  { name: 'Antarctic Peninsula', mode: 'control', location: 'Antarctica' },
  { name: 'Busan', mode: 'control', location: 'South Korea' },
  { name: 'Ilios', mode: 'control', location: 'Greece' },
  { name: 'Lijiang Tower', mode: 'control', location: 'China' },
  { name: 'Nepal', mode: 'control', location: 'Nepal' },
  { name: 'Oasis', mode: 'control', location: 'Iraq' },
  { name: 'Samoa', mode: 'control', location: 'Samoa' },
  // Hybrid (8)
  { name: 'Blizzard World', mode: 'hybrid', location: 'USA' },
  { name: 'Eichenwalde', mode: 'hybrid', location: 'Germany' },
  { name: 'Hollywood', mode: 'hybrid', location: 'USA' },
  { name: "King's Row", mode: 'hybrid', location: 'England' },
  { name: 'Midtown', mode: 'hybrid', location: 'USA' },
  { name: 'Neon Junction', mode: 'hybrid', location: 'Japan' },
  { name: 'Numbani', mode: 'hybrid', location: 'Nigeria' },
  { name: 'Paraíso', mode: 'hybrid', location: 'Brazil' },
  // Push (4)
  { name: 'Colosseo', mode: 'push', location: 'Italy' },
  { name: 'Esperança', mode: 'push', location: 'Portugal' },
  { name: 'New Queen Street', mode: 'push', location: 'Canada' },
  { name: 'Runasapi', mode: 'push', location: 'Peru' },
  // Flashpoint (3)
  { name: 'New Junk City', mode: 'flashpoint', location: 'Australia' },
  { name: 'Suravasa', mode: 'flashpoint', location: 'India' },
  { name: 'Aatlis', mode: 'flashpoint', location: 'Morocco' },
]

// ============================================================
// GAME MODE CONFIG
// ============================================================

export const GAME_MODE_CONFIG: Record<GameMode, { symmetric: boolean; needsStartingSide: boolean }> = {
  escort:     { symmetric: false, needsStartingSide: true },
  control:    { symmetric: true,  needsStartingSide: false },
  hybrid:     { symmetric: false, needsStartingSide: true },
  push:       { symmetric: true,  needsStartingSide: false },
  flashpoint: { symmetric: true,  needsStartingSide: false },
}

// ============================================================
// QUESTION SCALE VERSION
// ============================================================
// Which version of the post-match question set the app currently WRITES.
//
// THE RULE: a feel/question scale holds for an ENTIRE SEASON and changes only
// at a season boundary. Every season carries its own version in
// `seasons.question_scale_version`, and Settings stamps THIS constant onto
// each newly created season. Charts then ask the season what scale it used
// instead of hardcoding "season 4 onwards" -- which breaks silently the next
// time the questions change, and they are expected to keep changing.
//
// ⚠️ WHEN YOU CHANGE THE QUESTIONS AGAIN:
//   1. Add the new columns to `matches` (never alter the old ones).
//   2. Bump this constant in the SAME commit as the question change, so the
//      two cannot drift apart.
//   3. Start the new scale at a season boundary, never mid-season.
// Seasons created BEFORE that deploy keep their old version and stay readable
// forever -- nothing is migrated, and the two scales are never pooled.
export const CURRENT_QUESTION_SCALE = 2

// Human-readable description of each scale, for the Settings display.
export const QUESTION_SCALE_LABELS: Record<number, string> = {
  1: 'Original — match feel, performance feel, fun 1–5, tilt, tempo, coordination',
  2: 'v1.1.0 — match-up 1–5, performance 1–5, fun 1–6; tilt/tempo/coordination retired',
}

// ============================================================
// HELPERS
// ============================================================

export const getHeroesByRole = (role: 'tank' | 'dps' | 'support') =>
  HEROES.filter(h => h.role === role).sort((a, b) => a.name.localeCompare(b.name))

export const getMapsByMode = (mode: GameMode) =>
  MAPS.filter(m => m.mode === mode).sort((a, b) => a.name.localeCompare(b.name))

export const getGameModeForMap = (mapName: string): GameMode | undefined =>
  MAPS.find(m => m.name === mapName)?.mode

export const needsStartingSide = (mapName: string): boolean => {
  const mode = getGameModeForMap(mapName)
  return mode ? GAME_MODE_CONFIG[mode].needsStartingSide : false
}
