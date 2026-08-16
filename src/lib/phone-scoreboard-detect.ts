// ============================================================
// PHONE SCOREBOARD DETECTOR — which photo is the scoreboard, and
// the two team crops for the standout picks.
//
// Purpose: on the PHONE, at upload time, work out which of the photos the
// user just picked is the SCOREBOARD, then cut it into an ally block and an
// enemy block so the standout questions can show the team being asked about.
//
// Until v1.1.3 the standouts step showed no image at all. upload/page.tsx
// said why: "the phone does not classify which uploaded photo IS the
// scoreboard". So the user picked a slot NUMBER from memory, minutes after
// the match, with nothing on screen to check it against.
//
// WHY THIS IS CHEAP ENOUGH FOR A PHONE
// It reads NINE PIXELS. No OCR, no OpenCV, no worker, no model. The same
// signal test detectScoreboard() uses on the laptop: the ally block is team
// blue, the enemy block is team red, and there is a dark gap between them
// where the VS divider sits. A summary or breakdown page has none of that
// arrangement. Compare with detectMapFromPhotos() in phone-map-detect.ts,
// which runs a full Tesseract pass per photo — this is free next to it.
//
// Coordinates: same reference frame as ocr-extractor.ts and
// scoreboard-extractor.ts (PS5 native 3840x2160, 16:9). Photos come out of
// the library untouched, so scaling by width/height is valid.
//
// ⚠️ WHAT THIS DELIBERATELY DOES NOT DO
// It does not detect the FORMAT. The upload flow already asked for 5v5/6v6 in
// step one, so the answer is known for free. Re-deriving it here would mean a
// second copy of the VS-gap threshold, and the phone and the laptop could then
// disagree about the same board — the exact drift phone-map-detect.ts avoids
// by importing findMapName() rather than reimplementing it.
//
// It also does not detect the table edge or crop portraits. The crops below
// are generous quadrants, on purpose: the table is centre-anchored and its
// width varies with content (see scoreboard-extractor's TABLE_LEFT_BASELINE
// note — the 5v5 left edge moves up to 37px). A padded quadrant tolerates
// that without measuring anything. Tight crops are the laptop's job.
// ============================================================

/** Team-colour predicates. Kept byte-identical to scoreboard-extractor.ts —
 *  if those ever change, change these in the same commit. */
const isBlue = (r: number, g: number, b: number) => r < 40 && g > 60 && b > 90
const isRed  = (r: number, g: number, b: number) => r > 70 && g < 50 && b < 70
const isDark = (r: number, g: number, b: number) => r < 35 && g < 45 && b < 65

const REF_W = 3840
const REF_H = 2160

/** Single column to probe, in the flat fill between the gamertag and the E
 *  column. Sits inside the table on every board measured, both formats. */
const PROBE_X = 1800

/** Ally rows — inside the blue block on every board (block spans ~469-1184). */
const BLUE_Y = [550, 700, 850]
/** Enemy rows — inside the red block (block spans ~1312-2060). */
const RED_Y = [1450, 1600, 1750]
/** The VS gap.
 *
 *  ⚠️ These were 1180/1220/1260 in the first draft and 9 of 27 boards failed:
 *  the ally block runs as low as y=1184 on tall 6v6 boards, so y=1180 was
 *  still inside it. The guaranteed gap across all 27 measured boards is
 *  1184-1312. These three sit inside that with margin. Do not move them
 *  without re-measuring the widest ally block in the corpus. */
const GAP_Y = [1200, 1240, 1290]

/** Minimum width of the team-coloured band on an ally row. Measured 1484-1699
 *  across 27 boards. A summary or breakdown page has no such band, which is
 *  what makes this a discriminator and not just a sanity check. */
const MIN_TABLE_SPAN = 1200

/** Quadrant crops as fractions of the frame, per format. Measured on 25
 *  boards; padded so the table can drift inside them without clipping a row. */
const CROPS = {
  '5v5': { x0: 0.272, x1: 0.728, ally: [0.215, 0.545], enemy: [0.614, 0.968] },
  '6v6': { x0: 0.301, x1: 0.698, ally: [0.212, 0.541], enemy: [0.600, 0.970] },
} as const

export interface ScoreboardCrops {
  /** Index into the photo array that the scoreboard was found at. */
  sourceIndex: number
  /** Data URL of the ally block only. */
  ally: string
  /** Data URL of the enemy block only. */
  enemy: string
  debug: string[]
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image for scoreboard detection'))
    img.src = src
  })
}

/** Read one pixel from an already-drawn canvas context. */
function px(data: ImageData, x: number, y: number): [number, number, number] {
  const i = (y * data.width + x) * 4
  return [data.data[i], data.data[i + 1], data.data[i + 2]]
}

/** Does this image look like a scoreboard? Nine probes plus a width check. */
function looksLikeScoreboard(data: ImageData, debug: string[], label: string): boolean {
  const w = data.width
  const h = data.height
  const sx = Math.round((PROBE_X * w) / REF_W)
  const sy = (y: number) => Math.round((y * h) / REF_H)
  if (sx < 0 || sx >= w) return false

  const blue = BLUE_Y.filter(y => isBlue(...px(data, sx, sy(y)))).length
  const red = RED_Y.filter(y => isRed(...px(data, sx, sy(y)))).length
  const gap = GAP_Y.filter(y => isDark(...px(data, sx, sy(y)))).length

  // All nine. A weaker rule (2 of 3) would pass every board too, but the whole
  // value here is REJECTING the summary and breakdown pages, and there is no
  // corpus of those to tune against — so keep the test strict and let a miss
  // fall back to the numeric grid rather than risk cropping the wrong photo.
  if (blue < 3 || red < 3 || gap < 3) {
    debug.push(`${label}: not a scoreboard (blue ${blue}/3, red ${red}/3, gap ${gap}/3)`)
    return false
  }

  // Second, independent condition: a wide continuous band of team colour.
  const y = sy(700)
  let first = -1
  let last = -1
  for (let x = Math.round((600 * w) / REF_W); x < Math.round((3300 * w) / REF_W); x++) {
    const [r, g, b] = px(data, x, y)
    if (isBlue(r, g, b) || isRed(r, g, b)) {
      if (first < 0) first = x
      last = x
    }
  }
  const span = first < 0 ? 0 : ((last - first) * REF_W) / w
  if (span < MIN_TABLE_SPAN) {
    debug.push(`${label}: colour band only ${Math.round(span)}px wide`)
    return false
  }

  debug.push(`${label}: scoreboard (band ${Math.round(span)}px)`)
  return true
}

function cropToDataUrl(
  img: HTMLImageElement, x0: number, x1: number, y0: number, y1: number,
): string | null {
  const w = img.naturalWidth
  const h = img.naturalHeight
  const sx = Math.round(x0 * w)
  const sy = Math.round(y0 * h)
  const sw = Math.max(1, Math.round((x1 - x0) * w))
  const sh = Math.max(1, Math.round((y1 - y0) * h))
  const c = document.createElement('canvas')
  c.width = sw
  c.height = sh
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  // JPEG, not PNG: these are photographic crops roughly 1750x760, and a PNG
  // would be several megabytes held in a data URL on a phone.
  return c.toDataURL('image/jpeg', 0.85)
}

/**
 * Find the scoreboard among the photos the user just picked and return the
 * ally and enemy blocks as data URLs.
 *
 * Returns null when no photo passes — which is not an error. The caller shows
 * the numeric slot grid on its own, exactly as it did before v1.1.3. The step
 * must never be blocked by this: a missing crop costs a convenience, a blocked
 * step costs the answer entirely.
 *
 * @param photoUrls object-URLs for the chosen files
 * @param format    from step one of the wizard — NOT re-derived here
 */
export async function detectScoreboardCrops(
  photoUrls: string[],
  format: '5v5' | '6v6',
): Promise<ScoreboardCrops | null> {
  const debug: string[] = []
  if (photoUrls.length === 0) return null

  for (let i = 0; i < photoUrls.length; i++) {
    let img: HTMLImageElement
    try {
      img = await loadImage(photoUrls[i])
    } catch {
      debug.push(`photo ${i + 1}: failed to load`)
      continue
    }

    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) continue

    // Probing needs pixel access, so the image has to go through a canvas
    // once. Drawn at full size because the probes are absolute coordinates;
    // downscaling first would blur the thin VS gap into its neighbours.
    const probe = document.createElement('canvas')
    probe.width = w
    probe.height = h
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    if (!pctx) continue
    pctx.drawImage(img, 0, 0)

    let data: ImageData
    try {
      data = pctx.getImageData(0, 0, w, h)
    } catch {
      debug.push(`photo ${i + 1}: pixel read blocked`)
      continue
    }

    if (!looksLikeScoreboard(data, debug, `photo ${i + 1}`)) continue

    const c = CROPS[format]
    const ally = cropToDataUrl(img, c.x0, c.x1, c.ally[0], c.ally[1])
    const enemy = cropToDataUrl(img, c.x0, c.x1, c.enemy[0], c.enemy[1])
    if (!ally || !enemy) {
      debug.push(`photo ${i + 1}: crop failed`)
      continue
    }

    debug.push(`photo ${i + 1}: cropped as ${format}`)
    return { sourceIndex: i, ally, enemy, debug }
  }

  debug.push('no scoreboard found among the photos')
  return null
}
