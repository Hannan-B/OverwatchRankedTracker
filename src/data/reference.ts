// ============================================================
// HERO, MAP, AND SEASON REFERENCE DATA
// ============================================================

export type TankSubRole = 'initiator' | 'bruiser' | 'stalwart'
export type DpsSubRole = 'sharpshooter' | 'flanker' | 'specialist' | 'recon'
export type SupportSubRole = 'tactician' | 'medic' | 'survivor'
export type SubRole = TankSubRole | DpsSubRole | SupportSubRole

export type HeroRole = 'tank' | 'dps' | 'support'

/** A role the hero held BEFORE its current one. `until` is the first date
 *  (YYYY-MM-DD, compared against the UTC date of `played_at` — the same day
 *  boundary `get_season_for_date` uses) on which the hero no longer had it. */
export interface PastRole {
  role: HeroRole
  subRole: SubRole
  until: string
}

export interface Hero {
  name: string
  /** The hero's CURRENT role. For anything tied to a specific match, use
   *  heroRoleAt(name, playedAt) instead — a hero's role can change. */
  role: HeroRole
  subRole: SubRole
  /** Earlier roles, oldest first. Absent for heroes that have never changed. */
  previously?: PastRole[]
}

export interface GameMap {
  name: string
  mode: GameMode
  location: string
}

export type GameMode = 'escort' | 'control' | 'hybrid' | 'push' | 'flashpoint'

// ============================================================
// HEROES (54)
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
  // DPS — Recon (3)
  { name: 'Echo', role: 'dps', subRole: 'recon' },
  { name: 'Freja', role: 'dps', subRole: 'recon' },
  { name: 'Pharah', role: 'dps', subRole: 'recon' },

  // Support — Tactician (6)
  { name: 'Ana', role: 'support', subRole: 'tactician' },
  { name: 'Baptiste', role: 'support', subRole: 'tactician' },
  { name: 'Jetpack Cat', role: 'support', subRole: 'tactician' },
  { name: 'Lúcio', role: 'support', subRole: 'tactician' },
  // Moved from DPS (recon) when Season 5 started on 2026-10-06.
  { name: 'Sombra', role: 'support', subRole: 'tactician',
    previously: [{ role: 'dps', subRole: 'recon', until: '2026-10-06' }] },
  { name: 'Zenyatta', role: 'support', subRole: 'tactician' },
  // Support — Medic (4)
  { name: 'Kiriko', role: 'support', subRole: 'medic' },
  { name: 'Lifeweaver', role: 'support', subRole: 'medic' },
  { name: 'Mercy', role: 'support', subRole: 'medic' },
  { name: 'Moira', role: 'support', subRole: 'medic' },
  // Support — Survivor (6)
  { name: 'Brigitte', role: 'support', subRole: 'survivor' },
  { name: 'Doctrine', role: 'support', subRole: 'survivor' },
  { name: 'Illari', role: 'support', subRole: 'survivor' },
  { name: 'Juno', role: 'support', subRole: 'survivor' },
  { name: 'Mizuki', role: 'support', subRole: 'survivor' },
  { name: 'Wuyang', role: 'support', subRole: 'survivor' },
]

// ============================================================
// MAPS (31)
// ============================================================

export const MAPS: GameMap[] = [
  // Escort (9)
  { name: 'Circuit Royal', mode: 'escort', location: 'Monte Carlo' },
  { name: 'Dorado', mode: 'escort', location: 'Mexico' },
  { name: 'Grímsvötn', mode: 'escort', location: 'Iceland' },
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

// ============================================================
// ROLE AT A POINT IN TIME
// ============================================================
// A hero's role is a property of the MATCH, not of the hero: Sombra was DPS
// until Season 5 and support from it. Anything that attaches a role to a
// specific game (saving a scoreboard, bucketing appearances, choosing a
// damage-vs-healing share) must ask for the role ON THAT DATE. The SQL side
// mirrors this in hero_role_ref's valid_from / valid_to columns.

const HERO_BY_NAME = new Map(HEROES.map(h => [h.name, h]))

/** UTC calendar date (YYYY-MM-DD) of a played_at value, or null. */
function utcDate(playedAt: string | Date | null | undefined): string | null {
  if (!playedAt) return null
  const d = typeof playedAt === 'string' ? new Date(playedAt) : playedAt
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** The hero's role on the date of `playedAt`. With no date, the current role.
 *  Undefined for a name that isn't a known hero. */
export function heroRoleAt(name: string, playedAt?: string | Date | null): HeroRole | undefined {
  const hero = HERO_BY_NAME.get(name)
  if (!hero) return undefined
  const day = utcDate(playedAt)
  if (day && hero.previously) {
    for (const past of hero.previously) if (day < past.until) return past.role
  }
  return hero.role
}

/** Every role the hero has held, oldest first, with the date range it applied
 *  (`from`/`until` null = open-ended). One entry for heroes that never changed. */
export function heroRoleEras(name: string): { role: HeroRole; subRole: SubRole; from: string | null; until: string | null }[] {
  const hero = HERO_BY_NAME.get(name)
  if (!hero) return []
  const eras: { role: HeroRole; subRole: SubRole; from: string | null; until: string | null }[] = []
  let from: string | null = null
  for (const past of hero.previously ?? []) {
    eras.push({ role: past.role, subRole: past.subRole, from, until: past.until })
    from = past.until
  }
  eras.push({ role: hero.role, subRole: hero.subRole, from, until: null })
  return eras
}

const ERA_ROLE_WORD: Record<HeroRole, string> = { tank: 'Tank', dps: 'DPS', support: 'Support' }
const ERA_SUFFIX = / \((Tank|DPS|Support) era\)$/

/** The hero's name AS IT WAS on `playedAt`: the plain name while it held its
 *  current role, "Sombra (DPS era)" in an earlier one. For surfaces that key
 *  by hero name and must keep a hero's eras apart (Matchups). */
export function heroEraName(name: string, playedAt?: string | Date | null): string {
  const hero = HERO_BY_NAME.get(name)
  const role = heroRoleAt(name, playedAt)
  if (!hero || !role || role === hero.role) return name
  return `${name} (${ERA_ROLE_WORD[role]} era)`
}

/** Strip an era label: "Sombra (DPS era)" -> "Sombra". Plain names pass through. */
export function baseHeroName(display: string): string {
  return display.replace(ERA_SUFFIX, '')
}

/** Role for a hero DISPLAY name: the era's role for an era name, else the
 *  hero's current role. */
export function heroDisplayRole(display: string): HeroRole | undefined {
  const m = display.match(ERA_SUFFIX)
  if (m) return (Object.keys(ERA_ROLE_WORD) as HeroRole[]).find(r => ERA_ROLE_WORD[r] === m[1])
  return HERO_BY_NAME.get(display)?.role
}

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
