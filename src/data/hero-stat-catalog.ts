// ============================================================
// HERO STAT CATALOG — Expected stat tiles for each hero
// Built from 51 hero breakdown screenshots (May 2026)
// Used for validation: confirms OCR found the right stats
// NOT required for extraction — the generic extractor works
// without this, but this enables accuracy checking.
// ============================================================

export interface HeroStatDefinition {
  name: string          // ALL CAPS stat name as shown on screen
  hasAvgPer10?: boolean // whether this stat typically shows AVG PER 10 MIN
}

export interface HeroStatCatalogEntry {
  hero: string
  tileCount: number     // number of stat tiles (excluding hero info tile)
  stats: HeroStatDefinition[]
}

export const HERO_STAT_CATALOG: HeroStatCatalogEntry[] = [
  // ============================================================
  // TANK (14 heroes)
  // ============================================================
  {
    hero: 'D.Va',
    tileCount: 7,
    stats: [
      { name: 'MICRO MISSILE KILL', hasAvgPer10: true },
      { name: 'CALL MECH KILLS' },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'KNOCKBACK KILL', hasAvgPer10: true },
      { name: 'SELF-DESTRUCT KILLS' },
      { name: 'WEAPON ACCURACY' },
      { name: 'ULTIMATES NEGATED' },
    ],
  },
  {
    hero: 'Doomfist',
    tileCount: 6,
    stats: [
      { name: 'ROCKET PUNCH KILL', hasAvgPer10: true },
      { name: 'METEOR STRIKE KILLS' },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'SEISMIC SLAM KILLS', hasAvgPer10: true },
      { name: 'WEAPON ACCURACY' },
      { name: 'OVERHEALTH CREATED', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Domina',
    tileCount: 8,
    stats: [
      { name: 'WEAPON SHOT ACCURACY' },
      { name: 'CRYSTAL CHARGE DAMAGE' },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'KNOCKBACK KILL', hasAvgPer10: true },
      { name: 'SELF HEALING', hasAvgPer10: true },
      { name: 'WEAPON BEAM ACCURACY' },
      { name: 'ENVIRONMENTAL KILLS' },
      { name: 'PANOPTICON HITS' },
    ],
  },
  {
    hero: 'Hazard',
    tileCount: 6,
    stats: [
      { name: 'DOWNPOUR KILLS' },
      { name: 'ENVIRONMENTAL KILLS' },
      { name: 'OBJ CONTEST TIME' },
      { name: 'VIOLENT LEAP DAMAGE DONE' },
      { name: 'WEAPON ACCURACY' },
      { name: 'SPIKE GUARD DAMAGE DONE' },
    ],
  },
  {
    hero: 'Junker Queen',
    tileCount: 8,
    stats: [
      { name: 'JAGGED BLADE KILLS', hasAvgPer10: true },
      { name: 'WOUND UPTIME PERCENTAGE' },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'JAGGED BLADE ACCURACY' },
      { name: 'SELF HEALING', hasAvgPer10: true },
      { name: 'WEAPON ACCURACY' },
      { name: 'CARNAGE KILL', hasAvgPer10: true },
      { name: 'RAMPAGE KILLS' },
    ],
  },
  {
    hero: 'Mauga',
    tileCount: 7,
    stats: [
      { name: 'CRITICAL HIT DAMAGE', hasAvgPer10: true },
      { name: 'OVERHEALTH CREATED', hasAvgPer10: true },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'OVERRUN KILL', hasAvgPer10: true },
      { name: 'CAGE FIGHT KILLS' },
      { name: 'WEAPON ACCURACY' },
      { name: 'SELF HEALING', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Orisa',
    tileCount: 7,
    stats: [
      { name: 'ENERGY JAVELIN KILLS', hasAvgPer10: true },
      { name: 'ULTIMATES NEGATED', hasAvgPer10: true },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'ENERGY JAVELIN ACCURACY', hasAvgPer10: true },
      { name: 'TERRA SURGE KILLS', hasAvgPer10: true },
      { name: 'WEAPON ACCURACY', hasAvgPer10: true },
      { name: 'JAVELIN SPIN KILLS', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Ramattra',
    tileCount: 7,
    stats: [
      { name: 'PUMMEL ACCURACY' },
      { name: 'ANNIHILATION EFFICIENCY' },
      { name: 'OBJ CONTEST TIME' },
      { name: 'PUMMEL KILLS', hasAvgPer10: true },
      { name: 'ANNIHILATION KILLS' },
      { name: 'WEAPON ACCURACY' },
      { name: 'RAVENOUS VORTEX KILLS' },
    ],
  },
  {
    hero: 'Reinhardt',
    tileCount: 8,
    stats: [
      { name: 'FIRE STRIKE KILL', hasAvgPer10: true },
      { name: 'EARTHSHATTER DIRECT HITS' },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'FIRE STRIKE ACCURACY' },
      { name: 'EARTHSHATTER STUNS' },
      { name: 'CHARGE KILLS' },
      { name: 'KNOCKBACK KILLS' },
      { name: 'EARTHSHATTER KILLS' },
    ],
  },
  {
    hero: 'Roadhog',
    tileCount: 6,
    stats: [
      { name: 'CHAIN HOOK KILLS', hasAvgPer10: true },
      { name: 'WHOLE HOG KILLS', hasAvgPer10: true },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'CHAIN HOOK ACCURACY' },
      { name: 'WEAPON ACCURACY' },
      { name: 'SELF HEALING', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Sigma',
    tileCount: 8,
    stats: [
      { name: 'DIRECT HIT ACCURACY' },
      { name: 'OVERHEALTH CREATED' },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'ACCRETION KILLS' },
      { name: 'ULTIMATES NEGATED' },
      { name: 'WEAPON ACCURACY' },
      { name: 'ACCRETION ACCURACY' },
      { name: 'GRAVITIC FLUX KILLS' },
    ],
  },
  {
    hero: 'Winston',
    tileCount: 5,
    stats: [
      { name: 'SECONDARY FIRE ACCURACY' },
      { name: 'OBJ CONTEST TIME' },
      { name: 'JUMP PACK KILLS', hasAvgPer10: true },
      { name: 'PRIMARY FIRE ACCURACY' },
      { name: 'PRIMAL RAGE KILLS' },
    ],
  },
  {
    hero: 'Wrecking Ball',
    tileCount: 8,
    stats: [
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'PILEDRIVER KILLS', hasAvgPer10: true },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'GRAPPLING CLAW KILL', hasAvgPer10: true },
      { name: 'KNOCKBACK KILLS', hasAvgPer10: true },
      { name: 'WEAPON ACCURACY' },
      { name: 'ADAPTIVE SHIELDING CREATED', hasAvgPer10: true },
      { name: 'MINEFIELD KILLS', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Zarya',
    tileCount: 6,
    stats: [
      { name: 'SECONDARY FIRE ACCURACY' },
      { name: 'GRAVITON SURGE KILLS' },
      { name: 'OBJ CONTEST TIME', hasAvgPer10: true },
      { name: 'HIGH ENERGY KILLS' },
      { name: 'PRIMARY FIRE ACCURACY' },
      { name: 'AVERAGE ENERGY' },
    ],
  },

  // ============================================================
  // DPS (23 heroes)
  // ============================================================
  {
    hero: 'Anran',
    tileCount: 8,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'ENEMIES IGNITED', hasAvgPer10: true },
      { name: 'SOLO KILL', hasAvgPer10: true },
      { name: 'FAN THE FLAMES ACCURACY' },
      { name: 'DANCING BLAZE KILLS' },
      { name: 'FINAL BLOWS' },
      { name: 'CRITICAL HIT DAMAGE' },
      { name: 'ULTIMATE KILLS', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Ashe',
    tileCount: 7,
    stats: [
      { name: 'SCOPED ACCURACY' },
      { name: 'DYNAMITE KILLS', hasAvgPer10: true },
      { name: 'FINAL BLOWS', hasAvgPer10: true },
      { name: 'SCOPED CRITICAL HIT ACCURACY' },
      { name: 'BOB KILLS', hasAvgPer10: true },
      { name: 'SOLO KILL', hasAvgPer10: true },
      { name: 'LONG RANGE FINAL BLOWS', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Bastion',
    tileCount: 7,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'TACTICAL GRENADE KILLS' },
      { name: 'FINAL BLOW', hasAvgPer10: true },
      { name: 'RECON KILL', hasAvgPer10: true },
      { name: 'ARTILLERY KILLS' },
      { name: 'SOLO KILL', hasAvgPer10: true },
      { name: 'ASSAULT KILL', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Cassidy',
    tileCount: 7,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'FLASHBANG KILLS' },
      { name: 'FINAL BLOW', hasAvgPer10: true },
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'DEADEYE KILLS' },
      { name: 'SOLO KILLS' },
      { name: 'CRITICAL HIT KILLS' },
    ],
  },
  {
    hero: 'Echo',
    tileCount: 8,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'STICKY BOMBS DIRECT HIT ACCURACY' },
      { name: 'FINAL BLOW', hasAvgPer10: true },
      { name: 'FOCUSING BEAM ACCURACY' },
      { name: 'STICKY BOMBS KILL' },
      { name: 'SOLO KILLS' },
      { name: 'FOCUSING BEAM KILLS' },
      { name: 'DUPLICATE KILLS' },
    ],
  },
  {
    hero: 'Emre',
    tileCount: 8,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'SIPHON BLASTER DAMAGE DONE', hasAvgPer10: true },
      { name: 'FINAL BLOW', hasAvgPer10: true },
      { name: 'SCOPED ACCURACY' },
      { name: 'CYBER FRAG DAMAGE DONE', hasAvgPer10: true },
      { name: 'SOLO KILLS' },
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'OVERRIDE PROTOCOL KILLS' },
    ],
  },
  {
    hero: 'Freja',
    tileCount: 7,
    stats: [
      { name: 'WEAPON ACCURACY', hasAvgPer10: true },
      { name: 'BOLA SHOT DAMAGE DONE', hasAvgPer10: true },
      { name: 'FINAL BLOWS', hasAvgPer10: true },
      { name: 'TAKE AIM ACCURACY', hasAvgPer10: true },
      { name: 'BONUS ULT CHARGE GAINED', hasAvgPer10: true },
      { name: 'SOLO KILLS', hasAvgPer10: true },
      { name: 'TAKE AIM KILLS', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Genji',
    tileCount: 7,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'ULTIMATES REFLECTED' },
      { name: 'FINAL BLOWS' },
      { name: 'SWIFT STRIKE RESETS' },
      { name: 'DRAGONBLADE KILLS' },
      { name: 'SOLO KILLS' },
      { name: 'DAMAGE REFLECTED' },
    ],
  },
  {
    hero: 'Hanzo',
    tileCount: 8,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'STORM ARROW KILL', hasAvgPer10: true },
      { name: 'FINAL BLOW', hasAvgPer10: true },
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'RECON ASSIST', hasAvgPer10: true },
      { name: 'SOLO KILLS' },
      { name: 'LONG RANGE FINAL BLOWS' },
      { name: 'DRAGONSTRIKE KILLS' },
    ],
  },
  {
    hero: 'Junkrat',
    tileCount: 7,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'ENEMIES TRAPPED' },
      { name: 'FINAL BLOWS' },
      { name: 'DIRECT HIT ACCURACY' },
      { name: 'RIP-TIRE KILLS' },
      { name: 'SOLO KILLS' },
      { name: 'CONCUSSION MINE KILLS' },
    ],
  },
  {
    hero: 'Mei',
    tileCount: 7,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'ENEMY FROZEN', hasAvgPer10: true },
      { name: 'FINAL BLOWS', hasAvgPer10: true },
      { name: 'ICICLE ACCURACY' },
      { name: 'BLIZZARD KILLS' },
      { name: 'SOLO KILL', hasAvgPer10: true },
      { name: 'ICICLE CRITICAL ACCURACY' },
    ],
  },
  {
    hero: 'Pharah',
    tileCount: 8,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'AIRTIME PERCENTAGE' },
      { name: 'FINAL BLOWS' },
      { name: 'DIRECT HIT ACCURACY' },
      { name: 'KNOCKBACK KILLS' },
      { name: 'SOLO KILLS' },
      { name: 'LONG RANGE FINAL BLOWS' },
      { name: 'BARRAGE KILLS' },
    ],
  },
  {
    hero: 'Reaper',
    tileCount: 6,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'DEATH BLOSSOM KILLS', hasAvgPer10: true },
      { name: 'FINAL BLOWS', hasAvgPer10: true },
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'SOLO KILLS', hasAvgPer10: true },
      { name: 'SELF HEALING', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Sierra',
    tileCount: 7,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'TREMOR CHARGE KILLS' },
      { name: 'FINAL BLOWS', hasAvgPer10: true },
      { name: 'TRACKING SHOT ACCURACY' },
      { name: 'TRAILBLAZER KILLS' },
      { name: 'SOLO KILLS' },
      { name: 'TRACKING KILLS' },
    ],
  },
  {
    hero: 'Sojourn',
    tileCount: 8,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'CHARGED SHOT KILLS', hasAvgPer10: true },
      { name: 'FINAL BLOWS', hasAvgPer10: true },
      { name: 'CHARGED SHOT ACCURACY' },
      { name: 'DISRUPTOR SHOT KILL', hasAvgPer10: true },
      { name: 'SOLO KILLS' },
      { name: 'CHARGED SHOT CRITICAL ACCURACY' },
      { name: 'OVERCLOCK KILLS' },
    ],
  },
  {
    hero: 'Soldier: 76',
    tileCount: 8,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'LONG RANGE FINAL BLOWS' },
      { name: 'FINAL BLOWS', hasAvgPer10: true },
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'HELIX ROCKET KILL', hasAvgPer10: true },
      { name: 'SOLO KILLS' },
      { name: 'HELIX ROCKET ACCURACY' },
      { name: 'TACTICAL VISOR KILLS' },
    ],
  },
  {
    hero: 'Sombra',
    tileCount: 8,
    stats: [
      { name: 'WEAPON ACCURACY', hasAvgPer10: true },
      { name: 'VIRUS KILLS', hasAvgPer10: true },
      { name: 'FINAL BLOWS', hasAvgPer10: true },
      { name: 'ENEMIES HACKED', hasAvgPer10: true },
      { name: 'LOW HEALTH TELEPORTS', hasAvgPer10: true },
      { name: 'SOLO KILLS', hasAvgPer10: true },
      { name: 'VIRUS ACCURACY', hasAvgPer10: true },
      { name: 'EMP KILLS', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Symmetra',
    tileCount: 7,
    stats: [
      { name: 'PRIMARY FIRE ACCURACY' },
      { name: 'SENTRY TURRET KILLS' },
      { name: 'FINAL BLOWS' },
      { name: 'SECONDARY FIRE ACCURACY' },
      { name: 'PLAYER TELEPORTED', hasAvgPer10: true },
      { name: 'SOLO KILLS' },
      { name: 'AVERAGE DAMAGE MULTIPLIER' },
    ],
  },
  {
    hero: 'Torbjörn',
    tileCount: 7,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'TURRET KILLS', hasAvgPer10: true },
      { name: 'FINAL BLOWS' },
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'MOLTEN CORE KILLS' },
      { name: 'SOLO KILLS' },
      { name: 'HAMMER KILLS' },
    ],
  },
  {
    hero: 'Tracer',
    tileCount: 7,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'PULSE BOMB KILLS' },
      { name: 'FINAL BLOWS' },
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'PULSE BOMB ATTACH RATE' },
      { name: 'SOLO KILLS' },
      { name: 'LOW HEALTH RECALLS' },
    ],
  },
  {
    hero: 'Vendetta',
    tileCount: 8,
    stats: [
      { name: 'CRITICAL HITS' },
      { name: 'PROJECTED EDGE KILLS' },
      { name: 'FINAL BLOWS' },
      { name: 'WHIRLWIND DASH KILLS' },
      { name: 'SUNDERING BLADE KILLS' },
      { name: 'SOLO KILLS' },
      { name: 'PROJECTED EDGE ACCURACY' },
      { name: 'ONSLAUGHT UPTIME PERCENTAGE' },
    ],
  },
  {
    hero: 'Venture',
    tileCount: 8,
    stats: [
      { name: 'WEAPON ACCURACY' },
      { name: 'BURROW KILLS' },
      { name: 'FINAL BLOWS' },
      { name: 'DIRECT HIT ACCURACY' },
      { name: 'SHIELDS CREATED', hasAvgPer10: true },
      { name: 'SOLO KILLS' },
      { name: 'DRILL DASH KILLS' },
      { name: 'TECTONIC SHOCK KILLS' },
    ],
  },
  {
    hero: 'Widowmaker',
    tileCount: 7,
    stats: [
      { name: 'SCOPED ACCURACY' },
      { name: 'RECON ASSISTS' },
      { name: 'FINAL BLOWS' },
      { name: 'SCOPED CRITICAL HIT ACCURACY' },
      { name: 'VENOM MINE KILLS' },
      { name: 'SOLO KILLS' },
      { name: 'SCOPED CRITICAL HIT KILLS' },
    ],
  },

  // ============================================================
  // SUPPORT (14 heroes)
  // ============================================================
  {
    hero: 'Ana',
    tileCount: 8,
    stats: [
      { name: 'BIOTIC GRENADE KILLS' },
      { name: 'HEALING AMPLIFIED' },
      { name: 'PLAYERS SAVED' },
      { name: 'ENEMIES SLEPT' },
      { name: 'HEALING PREVENTED' },
      { name: 'SCOPED ACCURACY' },
      { name: 'SLEEP DART ACCURACY' },
      { name: 'NANO BOOST ASSISTS' },
    ],
  },
  {
    hero: 'Baptiste',
    tileCount: 7,
    stats: [
      { name: 'HEALING ACCURACY' },
      { name: 'IMMORTALITY FIELD DEATH PREVENTED', hasAvgPer10: true },
      { name: 'PLAYERS SAVED', hasAvgPer10: true },
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'AMPLIFICATION MATRIX ASSISTS' },
      { name: 'WEAPON ACCURACY' },
      { name: 'DAMAGE AMPLIFIED', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Brigitte',
    tileCount: 6,
    stats: [
      { name: 'PLAYERS KNOCKED BACK', hasAvgPer10: true },
      { name: 'INSPIRE UPTIME PERCENTAGE', hasAvgPer10: true },
      { name: 'PLAYERS SAVED', hasAvgPer10: true },
      { name: 'KNOCKBACK KILLS', hasAvgPer10: true },
      { name: 'WHIPSHOT ACCURACY', hasAvgPer10: true },
      { name: 'OVERHEALTH PROVIDED', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Illari',
    tileCount: 7,
    stats: [
      { name: 'SECONDARY FIRE ACCURACY', hasAvgPer10: true },
      { name: 'ULTIMATE DAMAGE', hasAvgPer10: true },
      { name: 'PLAYERS SAVED', hasAvgPer10: true },
      { name: 'PYLON UPTIME PERCENTAGE', hasAvgPer10: true },
      { name: 'SUNSTRUCK DETONATIONS', hasAvgPer10: true },
      { name: 'PRIMARY FIRE ACCURACY', hasAvgPer10: true },
      { name: 'PYLON HEALING', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Jetpack Cat',
    tileCount: 6,
    stats: [
      { name: 'KNOCKBACK KILLS' },
      { name: 'PURR HEALING' },
      { name: 'PLAYER SAVED', hasAvgPer10: true },
      { name: 'LIFELINE HEALING' },
      { name: 'WEAPON ACCURACY' },
      { name: 'LIFELINE USAGE' },
    ],
  },
  {
    hero: 'Juno',
    tileCount: 7,
    stats: [
      { name: 'PULSAR TORPEDOES DAMAGE' },
      { name: 'DAMAGE AMPLIFIED' },
      { name: 'PLAYERS SAVED' },
      { name: 'PULSAR TORPEDOES HEALING' },
      { name: 'ORBITAL RAY ASSISTS' },
      { name: 'WEAPON ACCURACY' },
      { name: 'ORBITAL RAY HEALING' },
    ],
  },
  {
    hero: 'Kiriko',
    tileCount: 6,
    stats: [
      { name: 'CRITICAL HIT ACCURACY' },
      { name: 'KITSUNE RUSH ASSISTS' },
      { name: 'PLAYER SAVED', hasAvgPer10: true },
      { name: 'KUNAI KILL', hasAvgPer10: true },
      { name: 'WEAPON ACCURACY' },
      { name: 'NEGATIVE EFFECTS CLEANSED' },
    ],
  },
  {
    hero: 'Lifeweaver',
    tileCount: 6,
    stats: [
      { name: 'THORN VOLLEY KILL', hasAvgPer10: true },
      { name: 'SELF HEALING', hasAvgPer10: true },
      { name: 'PLAYERS SAVED' },
      { name: 'LIFE GRIP DEATHS PREVENTED' },
      { name: 'WEAPON ACCURACY' },
      { name: 'TREE OF LIFE HEALING' },
    ],
  },
  {
    hero: 'Lúcio',
    tileCount: 8,
    stats: [
      { name: 'HEALING BOOST USAGE' },
      { name: 'KNOCKBACK KILL', hasAvgPer10: true },
      { name: 'PLAYERS SAVED' },
      { name: 'SPEED BOOST USAGE' },
      { name: 'ENVIRONMENTAL KILLS' },
      { name: 'WEAPON ACCURACY' },
      { name: 'PLAYER KNOCKED BACK', hasAvgPer10: true },
      { name: 'SOUND BARRIERS PROVIDED' },
    ],
  },
  {
    hero: 'Mercy',
    tileCount: 8,
    stats: [
      { name: 'DAMAGE AMPLIFIED', hasAvgPer10: true },
      { name: 'PLAYERS RESURRECTED' },
      { name: 'PLAYER SAVED', hasAvgPer10: true },
      { name: 'OFFENSIVE BEAM USAGE' },
      { name: 'VALKYRIE HEALING DONE' },
      { name: 'BLASTER KILLS' },
      { name: 'HEALING BEAM USAGE' },
      { name: 'VALKYRIE DAMAGE DONE' },
    ],
  },
  {
    hero: 'Mizuki',
    tileCount: 8,
    stats: [
      { name: 'HEALING KASA HEALING' },
      { name: 'ENEMIES HINDERED' },
      { name: 'PLAYER SAVED', hasAvgPer10: true },
      { name: 'REMEDY AURA HEALING' },
      { name: 'BINDING CHAIN ACCURACY' },
      { name: 'WEAPON ACCURACY' },
      { name: 'AVERAGE AURA' },
      { name: 'ULTIMATES NEGATED' },
    ],
  },
  {
    hero: 'Moira',
    tileCount: 7,
    stats: [
      { name: 'BIOTIC ORB KILLS', hasAvgPer10: true },
      { name: 'ENEMY COALESCENCE EFFICIENCY' },
      { name: 'PLAYERS SAVED' },
      { name: 'BIOTIC ORB HEALING', hasAvgPer10: true },
      { name: 'COALESCENCE KILLS' },
      { name: 'SECONDARY FIRE ACCURACY' },
      { name: 'ALLY COALESCENCE EFFICIENCY' },
    ],
  },
  {
    hero: 'Wuyang',
    tileCount: 7,
    stats: [
      { name: 'DIRECT HIT ACCURACY' },
      { name: 'GUARDIAN WAVE KILLS' },
      { name: 'PLAYERS SAVED' },
      { name: 'EMPOWERED RESTORATIVE STREAM HEALING' },
      { name: 'TIDAL BLAST KILLS' },
      { name: 'WEAPON ACCURACY' },
      { name: 'HEALING AMPLIFIED', hasAvgPer10: true },
    ],
  },
  {
    hero: 'Zenyatta',
    tileCount: 7,
    stats: [
      { name: 'CHARGED VOLLEY ACCURACY' },
      { name: 'TRANSCENDENCE EFFICIENCY' },
      { name: 'PLAYERS SAVED', hasAvgPer10: true },
      { name: 'CHARGED VOLLEY KILLS', hasAvgPer10: true },
      { name: 'TRANSCENDENCE HEALING', hasAvgPer10: true },
      { name: 'WEAPON ACCURACY' },
      { name: 'DAMAGE AMPLIFIED', hasAvgPer10: true },
    ],
  },
]

// Quick lookup: hero name -> catalog entry
export const HERO_STAT_LOOKUP = new Map<string, HeroStatCatalogEntry>()
for (const entry of HERO_STAT_CATALOG) {
  HERO_STAT_LOOKUP.set(entry.hero, entry)
}

// Get expected stat names for a hero (for validation)
export function getExpectedStats(heroName: string): string[] {
  const entry = HERO_STAT_LOOKUP.get(heroName)
  return entry ? entry.stats.map(s => s.name) : []
}

// Get expected tile count for a hero
export function getExpectedTileCount(heroName: string): number {
  const entry = HERO_STAT_LOOKUP.get(heroName)
  return entry ? entry.tileCount : 0
}
