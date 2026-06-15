// ============================================================
// NEW-CONTENT READINESS  (testing-page helper)
// ------------------------------------------------------------
// Given a processed match, work out whether every hero and map it
// contains is fully "wired up" in the code + database, and if not,
// say exactly what is missing and generate the ready-to-paste SQL.
//
// Pure functions only — no React, no DOM. Safe to unit-test.
//
// What it can check from the browser:
//   - hero in HEROES (reference.ts)
//   - hero in HERO_BREAKDOWN_ORDER (stat-meta.ts)
//   - hero in HERO_STAT_CATALOG (hero-stat-catalog.ts)
//   - map in MAPS (reference.ts)
//   - each extracted breakdown stat's resolved format (% / number / time)
//   - whether an extracted stat name is recognised by the system
//
// What it CANNOT check from the browser (DB-side), so it flags as
// "verify in Supabase" and generates SQL instead:
//   - hero in hero_role_ref view (roles for Matchups)
//   - new stat in hero_stats_normalised view
//
// Note on the scoreboard HERO_ROLE_MAP (scoreboard-extractor.ts): that
// is a separate code constant the page imports directly for its own
// check; it is passed into these functions as `scoreboardRoleNames`
// so this helper stays dependency-free.
// ============================================================

import { HEROES, MAPS } from '@/data/reference'
import {
  HERO_BREAKDOWN_ORDER,
  STAT_NORMALISE,
  statFormat,
  normaliseStat,
  type StatFormat,
} from '@/data/stat-meta'
import { HERO_STAT_CATALOG } from '@/data/hero-stat-catalog'

// ---- Minimal shapes of the processed-match data we read -----------------
// (Deliberately structural / loose so this file does not depend on the big
//  image-processor types; the testing page passes the real objects in.)

export interface ReadinessStatInput {
  statName: string
  statValue?: string | null
}

export interface ReadinessBreakdownInput {
  heroName: string
  stats?: ReadinessStatInput[]
}

export interface ReadinessMatchInput {
  mapName?: string | null
  /** heroes identified on the summary page */
  summaryHeroNames?: string[]
  /** heroes identified on the scoreboard */
  scoreboardHeroNames?: string[]
  /** per-hero breakdown results (with their extracted stats) */
  heroBreakdowns?: ReadinessBreakdownInput[]
}

// ---- Lookups built once from the static data ----------------------------

const HERO_NAME_SET = new Set(HEROES.map(h => h.name))
const MAP_NAME_SET = new Set(MAPS.map(m => m.name))
const BREAKDOWN_ORDER_SET = new Set(Object.keys(HERO_BREAKDOWN_ORDER))
const CATALOG_NAME_SET = new Set(HERO_STAT_CATALOG.map(c => c.hero))

// A stat name is "known" if it appears anywhere the system already defines a
// stat: the normalise map (keys = raw spellings, values = canonical targets),
// any hero's breakdown order, or any hero's catalog. A name in NONE of these
// is genuinely new and may not match on the DB side until registered.
// IMPORTANT: being absent from STAT_NORMALISE alone does NOT make a stat
// unknown — percent stats (e.g. "WEAPON ACCURACY") are intentionally not in
// the fold map, since they have no singular/plural variants to fold.
const KNOWN_STAT_NAMES: Set<string> = (() => {
  const s = new Set<string>()
  for (const k of Object.keys(STAT_NORMALISE)) s.add(k.toUpperCase())
  for (const v of Object.values(STAT_NORMALISE)) s.add(v.toUpperCase())
  for (const arr of Object.values(HERO_BREAKDOWN_ORDER)) {
    for (const st of arr) s.add(st.canonical.toUpperCase())
  }
  for (const entry of HERO_STAT_CATALOG) {
    for (const st of entry.stats) s.add(st.name.toUpperCase())
  }
  return s
})()

// ---- Per-hero readiness -------------------------------------------------

export interface HeroStatResolution {
  raw: string
  canonical: string
  format: StatFormat
  /** false when the stat name is recognised by no hero/catalog/normalise entry (genuinely new) */
  known: boolean
}

export interface HeroReadiness {
  heroName: string
  seenOn: ('summary' | 'scoreboard' | 'breakdown')[]
  inHeroes: boolean
  inScoreboardRoleMap: boolean
  inBreakdownOrder: boolean
  inCatalog: boolean
  /** resolved format for each extracted breakdown stat (empty if no breakdown) */
  statResolutions: HeroStatResolution[]
  /** stat names that did not normalise (subset of statResolutions) */
  unknownStatNames: string[]
  /** true when every checkable code-side slot is filled */
  fullyWiredCodeSide: boolean
}

export interface MapReadiness {
  mapName: string
  inMaps: boolean
  /** keyword presence in findMapName cannot be read here; page passes it in */
  detectKeywordKnown: boolean | null
}

export interface MatchReadiness {
  heroes: HeroReadiness[]
  maps: MapReadiness[]
  /** true when nothing new/unwired was found */
  allRecognised: boolean
  /** heroes that are missing from one or more code-side slots */
  newHeroes: HeroReadiness[]
  /** maps missing from MAPS */
  newMaps: MapReadiness[]
}

function uniqueNonEmpty(names: (string | null | undefined)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of names) {
    if (!n) continue
    const trimmed = n.trim()
    if (!trimmed || trimmed === '—') continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Compute readiness for one processed match.
 * @param match        the processed-match data (loose shape)
 * @param opts.scoreboardRoleNames  hero names present in scoreboard-extractor's
 *        HERO_ROLE_MAP (passed by the page so this file stays dependency-free)
 * @param opts.detectableMapNames   map names that findMapName can resolve
 *        (passed by the page; when omitted, keyword status is reported null)
 */
export function computeMatchReadiness(
  match: ReadinessMatchInput,
  opts?: { scoreboardRoleNames?: string[]; detectableMapNames?: string[] },
): MatchReadiness {
  const scoreboardRoleSet = new Set(opts?.scoreboardRoleNames ?? [])
  const detectableMapSet = opts?.detectableMapNames
    ? new Set(opts.detectableMapNames)
    : null

  // Gather where each hero name was seen.
  const seen = new Map<string, Set<'summary' | 'scoreboard' | 'breakdown'>>()
  const note = (name: string, where: 'summary' | 'scoreboard' | 'breakdown') => {
    const key = name.trim()
    if (!key || key === '—') return
    if (!seen.has(key)) seen.set(key, new Set())
    seen.get(key)!.add(where)
  }
  for (const n of uniqueNonEmpty(match.summaryHeroNames ?? [])) note(n, 'summary')
  for (const n of uniqueNonEmpty(match.scoreboardHeroNames ?? [])) note(n, 'scoreboard')
  for (const b of match.heroBreakdowns ?? []) note(b.heroName, 'breakdown')

  const breakdownByHero = new Map<string, ReadinessBreakdownInput>()
  for (const b of match.heroBreakdowns ?? []) {
    if (b.heroName) breakdownByHero.set(b.heroName.trim(), b)
  }

  const heroes: HeroReadiness[] = []
  for (const [heroName, whereSet] of seen) {
    const bd = breakdownByHero.get(heroName)
    const statResolutions: HeroStatResolution[] = []
    const unknownStatNames: string[] = []
    for (const s of bd?.stats ?? []) {
      const raw = (s.statName ?? '').trim()
      if (!raw || raw.startsWith('UNKNOWN')) {
        if (raw) unknownStatNames.push(raw)
        continue
      }
      const upper = raw.toUpperCase()
      const canonical = normaliseStat(raw)
      const known = KNOWN_STAT_NAMES.has(upper) || KNOWN_STAT_NAMES.has(canonical.toUpperCase())
      statResolutions.push({
        raw,
        canonical,
        format: statFormat(canonical),
        known,
      })
      if (!known) unknownStatNames.push(raw)
    }

    const inHeroes = HERO_NAME_SET.has(heroName)
    const inScoreboardRoleMap = scoreboardRoleSet.size > 0
      ? scoreboardRoleSet.has(heroName)
      : inHeroes // fall back to roster presence if page didn't pass the set
    const inBreakdownOrder = BREAKDOWN_ORDER_SET.has(heroName)
    const inCatalog = CATALOG_NAME_SET.has(heroName)

    heroes.push({
      heroName,
      seenOn: Array.from(whereSet),
      inHeroes,
      inScoreboardRoleMap,
      inBreakdownOrder,
      inCatalog,
      statResolutions,
      unknownStatNames,
      fullyWiredCodeSide: inHeroes && inScoreboardRoleMap && inBreakdownOrder && inCatalog,
    })
  }
  heroes.sort((a, b) => a.heroName.localeCompare(b.heroName))

  const maps: MapReadiness[] = uniqueNonEmpty([match.mapName]).map(mapName => ({
    mapName,
    inMaps: MAP_NAME_SET.has(mapName),
    detectKeywordKnown: detectableMapSet ? detectableMapSet.has(mapName) : null,
  }))

  const newHeroes = heroes.filter(h => !h.fullyWiredCodeSide || h.unknownStatNames.length > 0)
  const newMaps = maps.filter(m => !m.inMaps || m.detectKeywordKnown === false)

  return {
    heroes,
    maps,
    newHeroes,
    newMaps,
    allRecognised: newHeroes.length === 0 && newMaps.length === 0,
  }
}

// ---- SQL generation -----------------------------------------------------
// These build copy-paste snippets for the two hardcoded Supabase views.
// They REGENERATE the full view from the current code data so the result is
// always complete and current — the user pastes it straight into the SQL
// editor. (Roles come from HEROES; the user only had to add the hero there.)

/**
 * Full `create or replace view hero_role_ref` built from the current HEROES
 * list. Because HEROES already contains the new hero (the user added it in
 * reference.ts as step 1), this snippet includes it automatically.
 */
export function generateHeroRoleRefSql(): string {
  const rows = HEROES
    .map(h => `  ('${sqlEscape(h.name)}'::text, '${h.role}'::text)`)
    .join(',\n')
  return [
    'create or replace view hero_role_ref as',
    'select hero_name, role',
    'from ( values',
    rows,
    ') t(hero_name, role);',
  ].join('\n')
}

/**
 * A single `WHEN` clause to add into the hero_stats_normalised view for a
 * brand-new stat name. Returns the singular+plural fold to the canonical
 * (plural) form, matching the existing pattern in that view.
 */
export function generateNormaliseWhenClause(canonicalUpper: string): string {
  const canon = canonicalUpper.trim().toUpperCase()
  const singular = canon.endsWith('S') ? canon.slice(0, -1) : canon
  const variants = Array.from(new Set([singular, canon]))
    .map(v => `'${sqlEscape(v)}'`)
    .join(', ')
  return (
    `    when upper(btrim(stat_name)) = any (array[${variants}])\n` +
    `         then '${sqlEscape(canon)}'`
  )
}

/**
 * Convenience: for a hero's unknown stat names, produce the set of WHEN
 * clauses to paste into hero_stats_normalised. De-duplicates by canonical.
 */
export function generateNormaliseClausesForHero(hero: HeroReadiness): string[] {
  const canonicals = new Set<string>()
  for (const name of hero.unknownStatNames) {
    canonicals.add(name.trim().toUpperCase())
  }
  return Array.from(canonicals).map(generateNormaliseWhenClause)
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''")
}
