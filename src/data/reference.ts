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
// HEROES (51)
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
  // Tank — Stalwart (5)
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
  // DPS — Flanker (6)
  { name: 'Anran', role: 'dps', subRole: 'flanker' },
  { name: 'Genji', role: 'dps', subRole: 'flanker' },
  { name: 'Reaper', role: 'dps', subRole: 'flanker' },
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
// MAPS (29)
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
  // Hybrid (7)
  { name: 'Blizzard World', mode: 'hybrid', location: 'USA' },
  { name: 'Eichenwalde', mode: 'hybrid', location: 'Germany' },
  { name: 'Hollywood', mode: 'hybrid', location: 'USA' },
  { name: "King's Row", mode: 'hybrid', location: 'England' },
  { name: 'Midtown', mode: 'hybrid', location: 'USA' },
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
