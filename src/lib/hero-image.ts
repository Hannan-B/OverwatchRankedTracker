// ============================================================
// HERO PORTRAIT PATHS
// ------------------------------------------------------------
// Hero portraits live in public/heroes/ and are served from /heroes/.
// Filenames keep the display name AS-IS but with accents stripped and the
// colon removed, e.g.:
//   "Ana"          -> /heroes/Ana.png
//   "Junker Queen" -> /heroes/Junker Queen.png   (space kept)
//   "D.Va"         -> /heroes/D.Va.png            (dot kept)
//   "Lúcio"        -> /heroes/Lucio.png           (accent stripped)
//   "Torbjörn"     -> /heroes/Torbjorn.png        (accent stripped)
//   "Soldier: 76"  -> /heroes/Soldier 76.png      (colon removed)
//
// One rule covers all 51 heroes, so newly added heroes work automatically
// as long as their file follows the same convention.
// ============================================================

import { baseHeroName } from '@/data/reference'

/** Convert a hero display name to its portrait URL under /heroes/. */
export function heroPortrait(heroName: string): string {
  // (v1.2.0) An era label ("Sombra (DPS era)", Matchups) uses the hero's portrait.
  const cleaned = baseHeroName(heroName)
    .normalize('NFD')                 // split accented chars into base + accent
    .replace(/[\u0300-\u036f]/g, '')  // drop the accent marks (Lúcio -> Lucio)
    .replace(/:/g, '')                // drop colons (Soldier: 76 -> Soldier 76)
  return `/heroes/${cleaned}.png`
}
