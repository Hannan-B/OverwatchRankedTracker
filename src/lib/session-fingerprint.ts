// ============================================================
// SESSION FINGERPRINTS — what bulk session upload reads from each screenshot
// before grouping (v1.2.0)
// ------------------------------------------------------------
// A session is a whole play session's match-history screenshots, uploaded at
// once in ANY order. Before the full pipeline runs, every screenshot is read
// once for just enough to decide which match it belongs to:
//
//   Summary  — map, result, score, date/time, game length, the user's E/A/D,
//              and each filled hero slot's % played + play time.
//   Personal — % played + play time of its hero, and the left SIDEBAR: every
//              hero played that match, in order, with this page's highlighted.
//   Teams    — rows per side (a permanent leaver's row is dropped), the user's
//              highlighted row and its E/A/D.
//
// No hero portrait matching happens here — that is the expensive part of the
// pipeline and runs once per grouped match afterwards. Page type comes from the
// active nav tab only (classifyByTabs), so a Teams page with no enemy rows left
// still classifies.
//
// Browser-only (canvas + Tesseract). The grouping itself is pure, in
// session-grouper.ts, so it can be tested on fingerprints alone.
// ============================================================

import { HEROES } from '@/data/reference'
import { classifyByTabs, summarySlotsFilled } from '@/lib/image-processor'
import { ocrSummaryPage, ocrImageRegion, terminateOcr } from '@/lib/ocr-extractor'
import {
  readHeroTiles,
  getBreakdownHeroTileOrigin,
  summaryHeroTileOrigin,
  terminateBreakdownOcr,
} from '@/lib/breakdown-ocr'
import { measureTeamsPage } from '@/lib/scoreboard-extractor'

export interface Ead { e: number | null; a: number | null; d: number | null }

export interface SummarySlot { percentPlayed: number | null; playTimeSeconds: number | null }

export type Fingerprint =
  | {
      kind: 'summary'
      id: string
      mapName: string | null
      result: 'victory' | 'defeat' | 'draw' | null
      score: string | null
      /** Raw date text as on screen, e.g. "10/07/26 - 00:21" — the match key. */
      dateText: string | null
      /** ISO timestamp parsed from dateText, or null. */
      playedAt: string | null
      gameLengthSeconds: number | null
      ead: Ead | null
      /** One entry per FILLED hero slot, top to bottom (max 3). */
      slots: SummarySlot[]
    }
  | {
      kind: 'personal'
      id: string
      percentPlayed: number | null
      playTimeSeconds: number | null
      /** Hero names on the sidebar, in order (canonical HEROES names; null
       *  where a button's text didn't match a hero). */
      sidebar: (string | null)[]
      /** Index into `sidebar` of the highlighted (this page's) hero. */
      highlighted: number | null
      /** This page's hero, from the highlighted sidebar button. */
      hero: string | null
    }
  | {
      kind: 'teams'
      id: string
      allyRows: number
      enemyRows: number
      pitch: number | null
      userRowIndex: number | null
      userEad: Ead | null
    }
  | { kind: 'unknown'; id: string; reason: string }

// ── Hero-name matching for sidebar OCR ──────────────────────────────────────

/** Upper-case, accents stripped, letters/digits only: "Lúcio" → "LUCIO",
 *  "Soldier: 76" → "SOLDIER76", "D.Va" → "DVA". */
export function heroKey(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

const HERO_KEYS = HEROES.map(h => ({ name: h.name, key: heroKey(h.name) }))

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return dp[a.length][b.length]
}

/** Best HEROES name for an OCR'd label, or null. Exact key first, then the
 *  closest within 1 edit (names ≤ 5 letters) or 2 edits (longer), unique. */
export function matchHeroName(text: string): string | null {
  const k = heroKey(text)
  if (k.length < 2) return null
  const exact = HERO_KEYS.find(h => h.key === k)
  if (exact) return exact.name
  const scored = HERO_KEYS
    .map(h => ({ name: h.name, d: editDistance(k, h.key), len: h.key.length }))
    .filter(h => h.d <= (h.len <= 5 ? 1 : 2))
    .sort((a, b) => a.d - b.d)
  if (scored.length === 0) return null
  if (scored.length > 1 && scored[1].d === scored[0].d) return null
  return scored[0].name
}

// ── Personal-page sidebar ───────────────────────────────────────────────────
// Measured on the Season 5 + older screenshots (3840×2160): buttons span
// x 100–740, the first at y 534–634, then every 150px. The highlighted button
// is ≥ 94% bright blue, every other button 0%. A hero list ends at the
// "ALL HEROES" button; a one-hero match shows an EMPTY second button first.

const SIDEBAR_X0 = 110
const SIDEBAR_W = 620
const SIDEBAR_Y0 = 534
const SIDEBAR_PITCH = 150
const SIDEBAR_BTN_H = 100
const SIDEBAR_MAX = 8

function readPixels(img: HTMLImageElement): { data: Uint8ClampedArray; width: number } {
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width }
}

async function readSidebar(img: HTMLImageElement): Promise<{ sidebar: (string | null)[]; highlighted: number | null }> {
  const { data, width } = readPixels(img)
  const sidebar: (string | null)[] = []
  let highlighted: number | null = null

  for (let k = 0; k < SIDEBAR_MAX; k++) {
    const y0 = SIDEBAR_Y0 + SIDEBAR_PITCH * k
    let n = 0, blue = 0, text = 0
    for (let y = y0 + 10; y < y0 + SIDEBAR_BTN_H - 10; y += 2) {
      for (let x = SIDEBAR_X0; x < SIDEBAR_X0 + SIDEBAR_W; x += 3) {
        const i = (y * width + x) * 4
        const r = data[i], g = data[i + 1], b = data[i + 2]
        n++
        if (b > 90 && b - r > 55 && g >= r && b > g) blue++
        if (Math.min(r, g, b) > 180) text++
      }
    }
    const isHighlighted = blue / n >= 0.8
    if (text / n < 0.01) {
      // No text: the empty filler button of a one-hero match, or past the list.
      if (k === 0) break
      continue
    }
    // White text on every button (dark grey, or bright blue when highlighted):
    // recolour to black-on-white, or the highlighted one doesn't read at all.
    const label = await ocrImageRegion(img, { x: SIDEBAR_X0, y: y0, w: SIDEBAR_W, h: SIDEBAR_BTN_H }, 2, true)
    if (heroKey(label).includes('ALLHEROES')) break
    if (isHighlighted) highlighted = sidebar.length
    sidebar.push(matchHeroName(label))
  }
  return { sidebar, highlighted }
}

// ── Per-page fingerprints ───────────────────────────────────────────────────

export async function fingerprintImage(id: string, img: HTMLImageElement): Promise<Fingerprint> {
  if (img.naturalWidth !== 3840 || img.naturalHeight !== 2160) {
    return { kind: 'unknown', id, reason: `Unexpected size ${img.naturalWidth}×${img.naturalHeight} (expected 3840×2160)` }
  }
  const page = classifyByTabs(img)

  if (page === 'summary') {
    const ocr = await ocrSummaryPage(img)
    const filled = summarySlotsFilled(img)
    const origins = filled.map((f, s) => (f ? summaryHeroTileOrigin(s) : null)).filter((o): o is { x: number; y: number } => o != null)
    const tiles = await readHeroTiles(img, origins)
    return {
      kind: 'summary',
      id,
      mapName: ocr.mapName,
      result: ocr.result,
      score: ocr.score,
      // Just the date/time, not the whole OCR'd line: on a Summary with no
      // FINAL SCORE line the date box reads "GAME MODE: …", which must not
      // become a key two different matches could share.
      dateText: ocr.matchDateText?.match(/\d{1,2}\/\d{1,2}\/\d{2,4}\s*-\s*\d{1,2}:\d{2}/)?.[0] ?? null,
      playedAt: ocr.matchTimestamp ? ocr.matchTimestamp.toISOString() : null,
      gameLengthSeconds: ocr.gameLengthSeconds,
      ead: { e: ocr.eliminations, a: ocr.assists, d: ocr.deaths },
      slots: tiles.map(t => ({ percentPlayed: t.percentPlayed, playTimeSeconds: t.playTimeSeconds })),
    }
  }

  if (page === 'personal') {
    const [tile] = await readHeroTiles(img, [getBreakdownHeroTileOrigin(img)])
    const { sidebar, highlighted } = await readSidebar(img)
    return {
      kind: 'personal',
      id,
      percentPlayed: tile?.percentPlayed ?? null,
      playTimeSeconds: tile?.playTimeSeconds ?? null,
      sidebar,
      highlighted,
      hero: highlighted != null ? sidebar[highlighted] ?? null : null,
    }
  }

  if (page === 'teams') {
    const m = measureTeamsPage(img)
    return {
      kind: 'teams',
      id,
      allyRows: m.allyRows,
      enemyRows: m.enemyRows,
      pitch: m.pitch,
      userRowIndex: m.userRowIndex,
      userEad: m.userEad,
    }
  }

  return { kind: 'unknown', id, reason: 'Not a match-history Summary, Teams or Personal page' }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load ${url}`))
    img.src = url
  })
}

/** Fingerprint a whole session. `photos` are { id, url } — id is whatever the
 *  caller uses to find the file again (a storage path, a file name). */
export async function fingerprintSession(
  photos: { id: string; url: string }[],
  onProgress?: (done: number, total: number) => void,
): Promise<Fingerprint[]> {
  const out: Fingerprint[] = []
  try {
    for (let i = 0; i < photos.length; i++) {
      onProgress?.(i, photos.length)
      try {
        const img = await loadImage(photos[i].url)
        out.push(await fingerprintImage(photos[i].id, img))
      } catch (e) {
        out.push({ kind: 'unknown', id: photos[i].id, reason: e instanceof Error ? e.message : 'Could not read image' })
      }
    }
    onProgress?.(photos.length, photos.length)
  } finally {
    await terminateOcr()
    await terminateBreakdownOcr()
  }
  return out
}
