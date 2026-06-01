// ============================================================
// BREAKDOWN OCR v13 — Template Matching Engine
//
// Replaces Tesseract.js for value extraction with direct pixel
// template matching. Python reference: 365/365 (100.0%) accuracy.
//
// Architecture:
//   1. Grid variant auto-detection (A/B via orange/green bar scan)
//   2. Tile presence detection (orange/green bar check)
//   3. Green bar detection (NEW CAREER BEST tiles)
//   4. Value zone extraction + binarization (threshold 120)
//      4a. Multi-threshold retry (130, 140) for low-confidence digits
//   5. Smart segmentation (connected components + merge % and :)
//   6. NCC template matching for digits 0-9
//   7. Size-based classification for comma/period
//   8. Context post-processing (3-digit rule for comma vs period)
//   9. Hero info tile extraction (percent_played + play_time)
//
// STAGE 3 NOTES:
//   - Avg/10 min: currently extracted via Tesseract (unreliable ~60%).
//     To make it a reliable cross-check validator for primary stat values,
//     apply template matching to the avg/10 value zone within each tile
//     (separate Y range, same engine). Not needed at current 365/365 accuracy.
//   - Percent played: can be CALCULATED post-extraction as:
//     percent_played = hero_play_time / sum(all_hero_play_times) * 100
//     This works because each processing batch is from a single match,
//     where hero play times sum to total match duration. No OCR needed.
//
// Keeps from v12: grid detection, tile positions, Tesseract for
// LABEL reading (stat name matching — already 100%)
// ============================================================

import Tesseract from 'tesseract.js'
import { HERO_STAT_LOOKUP } from '@/data/hero-stat-catalog'

// ============================================================
// CONSTANTS
// ============================================================

const ICON_MASK = 380         // Pixels from tile left to mask (eliminates all icons)
const VZ_TOP = 148            // Value zone top (tile-relative, normal tiles)
const VZ_BOTTOM = 228         // Value zone bottom (tile-relative, normal tiles)
const VZ_TOP_GREEN = 110      // Value zone top for NEW CAREER BEST tiles
const VZ_BOTTOM_GREEN = 175   // Value zone bottom for green bar tiles
const THRESH = 120            // Binarization threshold (grayscale > 120 → white)
const TILE_W = 964            // Tile width in pixels
const MIN_BLOB_AREA = 10      // Minimum blob area to keep
const NORM_H = 64             // Normalized height for template matching

// Hero info tile: scan the right portion for white text bands
// The layout differs from stat tiles, so we scan dynamically
const HI_SCAN_LEFT = 340      // After portrait area (was 380, moved left to capture leading "1" in 10+ min times)
const HI_SCAN_BAND_H = 80     // Height of each scan band
const HI_SCAN_STEP = 20       // Step between scan bands

// Grid variants
const VARIANTS: Record<string, { col_starts: number[] }> = {
  A: { col_starts: [790, 1765, 2740] },
  B: { col_starts: [804, 1779, 2754] },
}
const ROW_TOPS = [410, 890, 1370]
const ROW_H = 470

// ============================================================
// TYPES
// ============================================================

export interface BreakdownStat {
  statName: string
  statValue: string
  avgPer10Min: string | null
}

export interface BreakdownOcrResult {
  heroName: string
  percentPlayed: number | null
  playTimeSeconds: number | null
  stats: BreakdownStat[]
  expectedStatCount: number
  foundStatCount: number
  raw: string
}

interface Segment {
  x_min: number
  x_max: number
  y_min: number
  y_max: number
  area: number
  width: number
  height: number
  x_center: number
  type: 'digit' | 'small' | 'colon' | 'percent'
}

// ============================================================
// TEMPLATE DATA — Bit-packed base64, 64px normalized height
// Each template is a binary image (white=1, black=0) packed
// into bytes (MSB first), then base64 encoded.
// ============================================================

const TEMPLATE_DATA: Record<string, { w: number; h: number; b64: string }> = {
  '0': { w: 49, h: 64, b64: 'AAAP+AAAAAB//+AAAAA///AAAAH///8AAAH////AAAP////4AAH////8AAH/////AAH/////wAD/////8AH//////AD//////gD//8H//4B//4A//8A//4AP/+A//4AH//gf/4AA//wP/8AAP/4f/8AAH//P/+AAD//n//AAA//z//AAAf/5//gAAP/8//wAAH/+//4AAD////4AAA////8AAAf///+AAAP////AAAH////gAAD////wAAB////wAAA////4AAAf///+AAAP////AAAH////gAAD////wAAB////4AAA////8AAAf///+AAAP////AAAH////wAAH/+f/4AAD//P/8AAB//n/+AAA//z//gAA//5//wAAf/8//4AAP/4H/+AAP/8D//gAP//Af/+AP//AP//5///gD//////gB//////wA//////4AH/////wAB/////wAA/////4AAP////4AAB////wAAAf///wAAAP///4AAAAf//AAA=' },
  '1': { w: 21, h: 64, b64: '//////////////////////////////////////7///AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4B//AP/4A//' },
  '2': { w: 46, h: 64, b64: 'AAD/4AAAAH///AAAAf//8AAAP///+AAB////+AAf////8AB/////wAP/////gA//////gH/////+Af/////8B//////wf//gf//h//+A//+H//AB//4f/4AB//j//gAD//v/+AAP/+//wAA//7//AAD//v/4AAP/+//gAA//7/+AAD//v/4AAP/+f/AAA//4AAAAD/+AAAAAP/4AAAAB//gAAAAH/+AAAAA//4AAAAH//AAAAA//8AAAAD//wAAAAf/+AAAAD//4AAAAf/+AAAAB//4AAAAP//AAAAB//4AAAAP//gAAAA//4AAAAH//gAAAA//8AAAAD//wAAAA//+AAAAH//gAAAAf/+AAAAD//wAAAAf/+AAAAD//wAAAAf/+AAAAB//4AAAAf//AAAAD//8AAAAP/////8B//////wf//////B//////8H//////w///////H//////9///////3///////f//////8=' },
  '3': { w: 43, h: 64, b64: 'AAD/4AAAAf//wAAAP//4AAA////gAA////8AA/////gAf////wA/////4A/////+Af/////AP/////wP/////4H/+AP//D/+AH//h//AB//z//AAf/5//AAP/8//gAH/+f/gAD//AAAAB//gAAAA//wAAAAf/4AAAAP/8AAAAP/4AAAAH/8AAAAH/+AAAA//+AAAP///AAAH///AAAD///gAAB///AAAA///gAAAf//wAAAP//+AAAH///gAAD///4AAB///8AAAP///gAAAD//wAAAA//4AAAAf/8AAAAH//AAAAB//gAAAA//wAAAAP/4AAAAH///8AAD///+AAB////gAA////wAB////8AA/////AA//9//wA//8//////+H//////D/////+B//////Af/////AP/////gD/////gAf////AAH////AAD////gAAP//+AA=' },
  '4': { w: 51, h: 64, b64: 'AAAAA//gAAAAAP/8AAAAAB//gAAAAAf/8AAAAAH//gAAAAA//8AAAAAP//gAAAAD//8AAAAAf//gAAAAD//8AAAAB///gAAAAf//8AAAAD///gAAAA///8AAAAH///gAAAD///8AAAAf///gAAAH///8AAAA////gAAAf///8AAAD////gAAA////8AAAH/9//gAAA//P/8AAAP/x//gAAH/+P/8AAA//h//gAAP/8P/8AAB/+B//gAAf/wP/8AAD/+B//gAB//gP/8AAP/4B//gAD/8AP/8AAf/gB//gAP/8AP/8AD//AB//gAf/4AP/8AD//AB//gA////////f///////7////////f//////////////////////////////////////////////////////////////////+AAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8AAAAAB//gAAAAAP/8A' },
  '5': { w: 43, h: 64, b64: 'AP////4AH////8AD////+AB/////AA/////gAf////wAP////4AH////8AH////+AD/////AB/////gA/////gAf/gAAAAP/wAAAAH/4AAAAD/8AAAAB/+AAAAB/+AAAAA//AAAAAf/gAAAAP/wAAAAP//8AAAH///+AAD////AAB////4AA/////AA/////wAf////8AP/////AH/////wD/////4B/////+A/wH///AeAAH//4OAAD//8AAAAf/+AAAAH//gAAAD//wAAAA//4AAAAf/8AAAAH/+AAAAD//AAAAB//gAAAA//wAAAAf/4AAAAP/8AAAAP/+wAAAH//cAAAD//PgAAH//n8AAH//z/wAH//5/4AD//w//////4//////4f/////8P/////8H/////4D/////8B/////8A/////8AD////4AB////8AAH///wAA=' },
  '6': { w: 49, h: 64, b64: 'AAAB//wAAAAB//4AAAAA//8AAAAA//8AAAAA//4AAAAA//8AAAAAf/8AAAAAf/+AAAAAP/+AAAAAH/+AAAAAP/+AAAAAP//AAAAAH//AAAAAH//gAAAAH//gAAAAH//gAAAAH//gAAAAD//wAAAAD//wAAAAB//wAAAAD//4AAAAB//4AAAAB////4AAA////8AAAf////wAA//////AA//////wAf/////4AP/////+AP//////wH//////4D//////+B///////D//8AH//5//+AB//8//4AAP/+f/8AAH//v/+AAB////+AAA////+AAAP////AAAH////gAAD////wAAB////4AAA////8AAAf////AAAP////gAAP////wAAH//f/8AAD//v//AAD//n//wAH//z//8AH//4f//gD//wP//////4D//////4B//////8Af/////+AD/////8AB/////8AAf////+AAD////+AAA////4AAAf///8AAAB///8AA=' },
  '7': { w: 50, h: 64, b64: 'f///////3///////9////////f///////n///////5///////+f//////+H///////h///////wf//////8H///////B///////AH//////wAAAAA//4AAAAAP/+AAAAAH//AAAAAB//wAAAAA//8AAAAAf/8AAAAAH//AAAAAD//wAAAAA//4AAAAAf/8AAAAAH//AAAAAD//wAAAAA//wAAAAAf/8AAAAAH//AAAAAH//gAAAAB//wAAAAAf/8AAAAAP/+AAAAAH//gAAAAB//wAAAAAf/8AAAAAP/+AAAAAH//gAAAAB//wAAAAA//4AAAAAP/8AAAAAP//AAAAAD//wAAAAB//4AAAAAf/8AAAAAH//AAAAAD//gAAAAA//4AAAAA//8AAAAAP//AAAAAD//gAAAAB//wAAAAAf/8AAAAAP/+AAAAAD//gAAAAA//gAAAAA//4AAAAAP/+AAAAAH//AAAAAB//wAAAAAf/4AAAAAf/+AAAAAH/+AAAAAB//gAAAAA//4AAAAAA==' },
  '8': { w: 42, h: 64, b64: 'AAD/wAAAA///AAAA///AAAH///4AAf///+AB/////gB/////gB/////wD/////wH/////4H/////4H/////4f/+Af/+f/+AP/+f/8AP/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+f/4AH/+H/8AP/4H/8AP/4H/+Af/4D/////wD/////wD/////wB/////gAf///+AAP///8AAf///+AB/////gD/////wD/////wD/////4H/////4H//A//+f/8AP/+f/8AP/+f/4AH/+//wAD/+//wAD////gAB////gAB////gAB////gAB////wAD////4AH//f/4AH/+f/4AH/+f/8AP/+f//h//+H/////+H/////4H/////4D/////wD/////wB/////gAf////gAP///8AAP///8AAB///4A' },
  '9': { w: 48, h: 64, b64: 'AAAf/gAAAAf//+AAAAf//+AAAB////gAAH////8AAP////8AAf////+AA//////gB//////wD//////wD//////4H//////4H//wB//+f//gA//+f/+AAf/+f/8AAP/+f/4AAH////4AAH////4AAB////wAAB////gAAB////gAAB////gAAB////wAAB////wAAB////wAAB////4AAD////8AAH//f/8AAH//f/+AAP//f/+AAf/+f//wB//+H//wB//+H//////+H//////4D//////4B//////4A//////wAf/////wAH/////gAH/////gAA////+AAAD///+AAAD///+AAAAA//8AAAAB//4AAAAB//4AAAAB//4AAAAH//gAAAAP//AAAAAP//AAAAAP//AAAAAf/+AAAAB//+AAAAB//4AAAAB//4AAAAD//wAAAAH//gAAAAH//gAAAAH//gAAAAf/+AAAAA//+AAAAA//+AAAAA//8AAA' },
  'pct': { w: 77, h: 64, b64: 'AD/4AAAAAP/AAA//8AAAAA/+AAB//4AAAAB/8AAf//8AAAAH/wAA///8AAAA/+AAB///4AAAB/8AAH///8AAAD/4AAP///4AAAP/gAB/4D/4AAA/+AAD/wH/wAAB/8AAH/gH/gAAP/gAAf+AD/AAAf/AAA/8AH+AAA/+AAB/4AP8AAD/4AAD/wAf8AAf/AAAH+AA/4AB/+AAAP8AB/wAD/4AAAf4AB/gAH/wAAA/wAD/AAf/AAAB/gAH+AD/4AAAD/AAP8AH/wAAAH+AAf4Af/gAAAP8AB/wA/+AAAAf4AD/gB/8AAAA/8AH/AH/wAAAB/4AP+A/+AH/AD/wB/4D/8B//wD/gD/wH/4D//gH/gH/gP/g///wP/gf/B/8D///wf/A/+D/4H///gP///4P/gP///gf///wf/A////wf//+B/8B/wP/g///8D/4D/gf/A///wf/Af+Af+Af/8B/8A/8Af+A//4D/4B/4A/8AP+AP/wD/AB/4AAAAf/AH+AA/wAAAD/4Af8AB/gAAAH/wA/4AD/AAAAf/AB/wAH+AAAA/+AD/gAP8AAAB/8AH/AAf4AAAP/gAP+AA/wAAA/+AAf8AB/gAAD/4AA/4AD/AAAH/wAB/wAH+AAAf/gAB/gAP8AAB/8AAD/AB/4AAH/wAAH/AD/wAAP/gAAP+AH/gAA/+AAAf+AP/AAB/8AAAf+A/8AAD/4AAA/8B/4AAf/AAAA////wAB/8AAAA///+AAP/gAAAB///8AAf/AAAAD///4AA/+AAAAD///gAD/4AAAAB//+AAH/wAAAAD//8AAf/AAAAAB//AA==' },
  'colon': { w: 22, h: 64, b64: 'APAAA8AA//AD/8A//8D//wP//w///P//8///z///P//8//////////8///w///D//8P//A//8A//AD/8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAAA8AA//AD/8A//8D//wP//w///P//8///z//////////z///P//8///w///D//8P//A//8A//AD/8A=' },
}

// ============================================================
// TEMPLATE LOADING — Decode bit-packed base64 to float arrays
// ============================================================

interface Template {
  data: Float32Array
  w: number
  h: number
}

let _templates: Record<string, Template> | null = null

function decodeTemplate(entry: { w: number; h: number; b64: string }): Template {
  const { w, h, b64 } = entry
  const totalPixels = w * h

  // Decode base64 to bytes
  const binaryStr = atob(b64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }

  // Unpack bits to float array
  const data = new Float32Array(totalPixels)
  for (let i = 0; i < totalPixels; i++) {
    const byteIdx = Math.floor(i / 8)
    const bitIdx = 7 - (i % 8)
    data[i] = (bytes[byteIdx] >> bitIdx) & 1
  }

  return { data, w, h }
}

function getTemplates(): Record<string, Template> {
  if (!_templates) {
    _templates = {}
    for (const [ch, entry] of Object.entries(TEMPLATE_DATA)) {
      _templates[ch] = decodeTemplate(entry)
    }
  }
  return _templates
}

// ============================================================
// CANVAS HELPERS
// ============================================================

function imageToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  return canvas
}

function getPixelArray(canvas: HTMLCanvasElement): { data: Uint8ClampedArray; width: number; height: number } {
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data: imageData.data, width: canvas.width, height: canvas.height }
}

function getPixelRGB(data: Uint8ClampedArray, width: number, x: number, y: number): [number, number, number] {
  const idx = (y * width + x) * 4
  return [data[idx], data[idx + 1], data[idx + 2]]
}

// ============================================================
// GRID DETECTION
// ============================================================

function detectVariant(data: Uint8ClampedArray, width: number, height: number): 'A' | 'B' {
  const scanRanges: [number, number][] = [[950, 1300], [450, 850]]

  for (const [ys, ye] of scanRanges) {
    for (let y = ys; y < ye && y < height; y++) {
      for (let x = 860; x < 900 && x < width; x++) {
        const [r, g, b] = getPixelRGB(data, width, x, y)
        const isOrange = r > 180 && g > 60 && g < 150 && b < 80
        const isGreen = r < 100 && g > 150 && b < 100
        if (isOrange || isGreen) {
          return x < 878 ? 'A' : 'B'
        }
      }
    }
  }
  return 'B'
}

function checkBar(data: Uint8ClampedArray, width: number, height: number, barX: number, rowTop: number): boolean {
  let count = 0
  for (let y = rowTop + 20; y < rowTop + ROW_H - 20; y += 5) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = barX + dx
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const [r, g, b] = getPixelRGB(data, width, x, y)
        const isOrange = r > 180 && g > 60 && g < 150 && b < 80
        const isGreen = r < 100 && g > 150 && b < 100
        if (isOrange || isGreen) {
          count++
        }
      }
    }
  }
  return count > 10
}

function getStatTiles(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  variant: 'A' | 'B'
): Array<{ x: number; y: number; row: number; col: number; catalogIndex: number }> {
  const cols = VARIANTS[variant].col_starts
  const tiles: Array<{ x: number; y: number; row: number; col: number; catalogIndex: number }> = []

  // The breakdown grid is read ROW-MAJOR (left-to-right across each row, then
  // top-to-bottom), with the hero-info tile occupying R1C1 (ri=0, ci=0). The
  // catalog's stats[] array is stored in this same row-major order, excluding
  // the hero-info tile. So a tile at grid position (ri, ci) corresponds to
  // catalog index = ri * numCols + ci - 1 (the -1 accounts for the skipped
  // hero-info tile). Verified against all 51 heroes' real breakdown screenshots.
  const numCols = cols.length

  for (let ri = 0; ri < ROW_TOPS.length; ri++) {
    for (let ci = 0; ci < cols.length; ci++) {
      if (ri === 0 && ci === 0) continue // Skip hero info tile
      if (checkBar(data, width, height, cols[ci] + 81, ROW_TOPS[ri])) {
        tiles.push({
          x: cols[ci],
          y: ROW_TOPS[ri],
          row: ri,
          col: ci,
          catalogIndex: ri * numCols + ci - 1,
        })
      }
    }
  }
  return tiles
}

// ============================================================
// GREEN BAR DETECTION
// ============================================================

function hasGreenBar(data: Uint8ClampedArray, width: number, tileX: number, tileY: number): boolean {
  let greenCount = 0
  for (let y = tileY + 80; y < tileY + 380; y++) {
    for (let x = tileX + 50; x < tileX + 700; x++) {
      if (x < width && y < (data.length / (width * 4))) {
        const [r, g, b] = getPixelRGB(data, width, x, y)
        if (r < 100 && g > 150 && b < 100) {
          greenCount++
        }
      }
    }
  }
  return greenCount > 2000
}

// ============================================================
// VALUE ZONE EXTRACTION
// ============================================================

function getValueZone(
  data: Uint8ClampedArray,
  width: number,
  tileX: number,
  tileY: number,
  greenBar: boolean,
  threshold: number = THRESH
): Uint8Array {
  const vzTop = greenBar ? VZ_TOP_GREEN : VZ_TOP
  const vzBottom = greenBar ? VZ_BOTTOM_GREEN : VZ_BOTTOM
  const left = tileX + ICON_MASK
  const right = tileX + TILE_W

  const zoneW = right - left
  const zoneH = vzBottom - vzTop
  const binary = new Uint8Array(zoneW * zoneH)

  for (let y = 0; y < zoneH; y++) {
    for (let x = 0; x < zoneW; x++) {
      const srcX = left + x
      const srcY = tileY + vzTop + y
      const [r, g, b] = getPixelRGB(data, width, srcX, srcY)
      const gray = 0.299 * r + 0.587 * g + 0.114 * b
      binary[y * zoneW + x] = gray > threshold ? 255 : 0
    }
  }

  return binary
}

function getCustomZone(
  data: Uint8ClampedArray,
  width: number,
  tileX: number,
  tileY: number,
  zoneTop: number,
  zoneBottom: number,
  zoneLeft: number
): { binary: Uint8Array; w: number; h: number } {
  const left = tileX + zoneLeft
  const right = tileX + TILE_W
  const zoneW = right - left
  const zoneH = zoneBottom - zoneTop
  const binary = new Uint8Array(zoneW * zoneH)

  for (let y = 0; y < zoneH; y++) {
    for (let x = 0; x < zoneW; x++) {
      const srcX = left + x
      const srcY = tileY + zoneTop + y
      const [r, g, b] = getPixelRGB(data, width, srcX, srcY)
      const gray = 0.299 * r + 0.587 * g + 0.114 * b
      binary[y * zoneW + x] = gray > THRESH ? 255 : 0
    }
  }

  return { binary, w: zoneW, h: zoneH }
}

// ============================================================
// CONNECTED COMPONENTS — Flood-fill labeling
// Replaces scipy.ndimage.label for browser environment
// ============================================================

function labelConnectedComponents(
  binary: Uint8Array,
  width: number,
  height: number
): { labels: Int32Array; count: number } {
  const labels = new Int32Array(width * height)
  let nextLabel = 1

  function flood(startX: number, startY: number, label: number) {
    const stack: Array<[number, number]> = [[startX, startY]]
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!
      const idx = cy * width + cx
      if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue
      if (labels[idx] !== 0 || binary[idx] === 0) continue
      labels[idx] = label
      stack.push([cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1])
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (binary[idx] > 0 && labels[idx] === 0) {
        flood(x, y, nextLabel)
        nextLabel++
      }
    }
  }

  return { labels, count: nextLabel - 1 }
}

// ============================================================
// SMART SEGMENTATION
// ============================================================

interface RawBlob {
  x_min: number
  x_max: number
  y_min: number
  y_max: number
  x_center: number
  area: number
  width: number
  height: number
}

function smartSegment(binary: Uint8Array, width: number, height: number): Segment[] {
  const { labels, count } = labelConnectedComponents(binary, width, height)

  // Extract blob bounds
  const raw: RawBlob[] = []
  for (let i = 1; i <= count; i++) {
    let xMin = width, xMax = 0, yMin = height, yMax = 0, area = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (labels[y * width + x] === i) {
          if (x < xMin) xMin = x
          if (x > xMax) xMax = x
          if (y < yMin) yMin = y
          if (y > yMax) yMax = y
          area++
        }
      }
    }
    if (area >= MIN_BLOB_AREA) {
      raw.push({
        x_min: xMin, x_max: xMax, y_min: yMin, y_max: yMax,
        x_center: (xMin + xMax) / 2, area,
        width: xMax - xMin + 1, height: yMax - yMin + 1,
      })
    }
  }

  raw.sort((a, b) => a.x_min - b.x_min)
  if (raw.length === 0) return []

  function makeSeg(blobs: RawBlob[], stype: Segment['type']): Segment {
    const xn = Math.min(...blobs.map(b => b.x_min))
    const xx = Math.max(...blobs.map(b => b.x_max))
    const yn = Math.min(...blobs.map(b => b.y_min))
    const yx = Math.max(...blobs.map(b => b.y_max))
    return {
      x_min: xn, x_max: xx, y_min: yn, y_max: yx,
      area: blobs.reduce((s, b) => s + b.area, 0),
      width: xx - xn + 1, height: yx - yn + 1,
      x_center: (xn + xx) / 2, type: stype,
    }
  }

  const result: Segment[] = []
  const used = new Set<number>()

  // Pass 1: Merge colons (two tiny vertically-aligned dots)
  for (let i = 0; i < raw.length; i++) {
    if (used.has(i)) continue
    const b = raw[i]
    if (b.area < 150 && b.height < 20) {
      for (let j = i + 1; j < Math.min(i + 3, raw.length); j++) {
        if (used.has(j)) continue
        const o = raw[j]
        if (o.area < 150 && o.height < 20 && Math.abs(b.x_center - o.x_center) < 15) {
          result.push(makeSeg([b, o], 'colon'))
          used.add(i)
          used.add(j)
          break
        }
      }
    }
  }

  // Pass 2: Merge percent signs (2-3 small blobs overlapping horizontally)
  let idx = 0
  while (idx < raw.length) {
    if (used.has(idx)) { idx++; continue }
    const b = raw[idx]
    if (b.area < 400) {
      const grp: RawBlob[] = [b]
      const ids = new Set<number>([idx])
      for (let j = idx + 1; j < Math.min(idx + 5, raw.length); j++) {
        if (used.has(j)) continue
        const o = raw[j]
        if (o.area < 400) {
          const gxmax = Math.max(...grp.map(g => g.x_max))
          if (o.x_min <= gxmax + 5) {
            grp.push(o)
            ids.add(j)
          }
        }
      }
      if (grp.length >= 2) {
        const ta = grp.reduce((s, g) => s + g.area, 0)
        const tw = Math.max(...grp.map(g => g.x_max)) - Math.min(...grp.map(g => g.x_min))
        if (ta > 600 && tw < 80) {
          result.push(makeSeg(grp, 'percent'))
          for (const id of ids) used.add(id)
          idx = Math.max(...ids) + 1
          continue
        }
      }
    }
    idx++
  }

  // Pass 3: Remaining blobs
  for (let i = 0; i < raw.length; i++) {
    if (!used.has(i)) {
      const b = raw[i]
      result.push({
        ...b,
        type: b.area >= 400 ? 'digit' : 'small',
      })
    }
  }

  result.sort((a, b) => a.x_min - b.x_min)
  return result
}

// ============================================================
// NCC TEMPLATE MATCHING
// ============================================================

function resizeBinary(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float32Array {
  const dst = new Float32Array(dstW * dstH)
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(Math.floor(x * srcW / dstW), srcW - 1)
      const srcY = Math.min(Math.floor(y * srcH / dstH), srcH - 1)
      dst[y * dstW + x] = src[srcY * srcW + srcX] > 128 ? 1.0 : 0.0
    }
  }
  return dst
}

function resizeFloat(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float32Array {
  const dst = new Float32Array(dstW * dstH)
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(Math.floor(x * srcW / dstW), srcW - 1)
      const srcY = Math.min(Math.floor(y * srcH / dstH), srcH - 1)
      dst[y * dstW + x] = src[srcY * srcW + srcX]
    }
  }
  return dst
}

function matchBlob(
  binary: Uint8Array,
  binaryW: number,
  seg: Segment,
  templates: Record<string, Template>
): { char: string; score: number } {
  // Pre-classified by merge logic
  if (seg.type === 'colon') return { char: ':', score: 0.95 }
  if (seg.type === 'percent') return { char: '%', score: 0.95 }

  // Size-based classification for tiny characters (comma/period)
  if (seg.area < 100) return { char: 'SEP', score: 0.95 }
  if (seg.area < 250 && seg.height < 25) return { char: 'SEP', score: 0.95 }

  // Extract blob pixels
  const blobW = seg.width
  const blobH = seg.height
  if (blobW === 0 || blobH === 0) return { char: '?', score: 0 }

  const blob = new Uint8Array(blobW * blobH)
  for (let y = 0; y < blobH; y++) {
    for (let x = 0; x < blobW; x++) {
      blob[y * blobW + x] = binary[(seg.y_min + y) * binaryW + (seg.x_min + x)]
    }
  }

  // Resize to normalized height
  const scale = NORM_H / blobH
  const newW = Math.max(1, Math.round(blobW * scale))
  const blobNorm = resizeBinary(blob, blobW, blobH, newW, NORM_H)

  let bestChar = '?'
  let bestScore = -1
  let secondChar = '?'
  let secondScore = -1

  // NCC against each digit template
  for (const [ch, tmpl] of Object.entries(templates)) {
    if (ch === 'pct' || ch === 'colon') continue // These are handled by merge logic

    const tmplW = tmpl.w
    const widthRatio = newW / tmplW
    if (widthRatio < 0.4 || widthRatio > 2.5) continue

    // Resize blob to match template dimensions
    const blobMatched = resizeFloat(blobNorm, newW, NORM_H, tmplW, NORM_H)

    // Normalized cross-correlation
    let ab = 0, aa = 0, bb = 0
    for (let i = 0; i < tmplW * NORM_H; i++) {
      ab += blobMatched[i] * tmpl.data[i]
      aa += blobMatched[i] * blobMatched[i]
      bb += tmpl.data[i] * tmpl.data[i]
    }
    const ncc = (aa > 0 && bb > 0) ? ab / Math.sqrt(aa * bb) : 0

    if (ncc > bestScore) {
      secondChar = bestChar
      secondScore = bestScore
      bestScore = ncc
      bestChar = ch
    } else if (ncc > secondScore) {
      secondScore = ncc
      secondChar = ch
    }
  }

  // Structural disambiguation for confusable pairs
  // When the top two NCC candidates are a known confusable pair,
  // use structural properties of the blob to break the tie.
  const confusable29 = (bestChar === '2' && secondChar === '9') || (bestChar === '9' && secondChar === '2')
  if (confusable29 && bestScore - secondScore < 0.15) {
    // Key difference: "2" has a wide flat base (high density in bottom rows)
    // "9" has a narrow descending stroke (low density in bottom rows)
    const bottomZone = Math.floor(blobH * 0.2) // Bottom 20% of blob
    let bottomWhite = 0, bottomTotal = 0
    for (let y = blobH - bottomZone; y < blobH; y++) {
      for (let x = 0; x < blobW; x++) {
        if (blob[y * blobW + x] > 128) bottomWhite++
        bottomTotal++
      }
    }
    const bottomDensity = bottomTotal > 0 ? bottomWhite / bottomTotal : 0

    // "2" typically has bottom density > 0.45 (flat base spans most of width)
    // "9" typically has bottom density < 0.35 (narrow tail on one side)
    const structuralCall = bottomDensity > 0.40 ? '2' : '9'

    if (structuralCall !== bestChar) {
      console.log(`[struct-check] NCC picked "${bestChar}" (${bestScore.toFixed(3)}) vs "${secondChar}" (${secondScore.toFixed(3)}), bottom density=${bottomDensity.toFixed(3)} → overriding to "${structuralCall}"`)
      bestChar = structuralCall
      bestScore = Math.max(bestScore, secondScore) // Use the higher confidence
    }
  }

  return { char: bestChar, score: bestScore }
}

// ============================================================
// VALUE READING — Full pipeline
// ============================================================

function readValue(binary: Uint8Array, width: number, height: number): { value: string; confidence: number } {
  const templates = getTemplates()
  const segs = smartSegment(binary, width, height)

  if (segs.length === 0) return { value: '0', confidence: 1.0 }

  // Match each segment
  const chars: string[] = []
  const scores: number[] = []
  for (const seg of segs) {
    const { char, score } = matchBlob(binary, width, seg, templates)
    chars.push(char)
    scores.push(score)
  }

  // Post-process: resolve SEP → comma or period
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === 'SEP') {
      let digitsAfter = 0
      for (let j = i + 1; j < chars.length; j++) {
        if ('0123456789'.includes(chars[j])) {
          digitsAfter++
        } else {
          break
        }
      }
      result.push(digitsAfter === 3 ? ',' : '.')
    } else {
      result.push(chars[i])
    }
  }

  return {
    value: result.join(''),
    confidence: scores.length > 0 ? Math.min(...scores) : 0,
  }
}

// ============================================================
// MULTI-THRESHOLD VALUE READING — Instability Detection
// Always runs all three thresholds (120, 130, 140) and compares
// digit identities. If a digit changes between thresholds, it's
// ambiguous — majority vote resolves it. This catches high-confidence
// misreads where the binarized pixel shape is on the boundary
// between two digits (e.g., "2" vs "9" depending on threshold).
// ============================================================

const ALL_THRESHOLDS = [THRESH, 130, 140] // 120, 130, 140

function readValueMultiThreshold(
  data: Uint8ClampedArray,
  imgWidth: number,
  tileX: number,
  tileY: number,
  greenBar: boolean
): { value: string; confidence: number } {
  const zoneW = TILE_W - ICON_MASK
  const vzTop = greenBar ? VZ_TOP_GREEN : VZ_TOP
  const vzBottom = greenBar ? VZ_BOTTOM_GREEN : VZ_BOTTOM
  const zoneH = vzBottom - vzTop

  // Run all thresholds
  const results = ALL_THRESHOLDS.map(thresh => {
    const binary = getValueZone(data, imgWidth, tileX, tileY, greenBar, thresh)
    return readValue(binary, zoneW, zoneH)
  })

  const values = results.map(r => r.value)
  const confs = results.map(r => r.confidence)

  // If all three agree, return immediately (common fast path)
  if (values[0] === values[1] && values[1] === values[2]) {
    return results[0]
  }

  // Instability detected — log it
  console.log(`[multi-thresh] Instability detected: ${ALL_THRESHOLDS.map((t, i) => `t${t}="${values[i]}"`).join(', ')}`)

  // If all three have the same length, do character-by-character majority vote
  if (values[0].length === values[1].length && values[1].length === values[2].length) {
    const voted: string[] = []
    for (let i = 0; i < values[0].length; i++) {
      const c0 = values[0][i], c1 = values[1][i], c2 = values[2][i]
      if (c0 === c1 || c0 === c2) {
        voted.push(c0)
      } else if (c1 === c2) {
        voted.push(c1)
      } else {
        // All three disagree — use highest confidence result's character
        const bestIdx = confs.indexOf(Math.max(...confs))
        voted.push(values[bestIdx][i])
      }
    }
    const votedValue = voted.join('')
    const bestConf = Math.max(...confs)
    console.log(`[multi-thresh] Majority vote: "${votedValue}" (best conf=${bestConf.toFixed(3)})`)
    return { value: votedValue, confidence: bestConf }
  }

  // Different lengths — pick the value that appears most often
  const countMap = new Map<string, number>()
  for (const v of values) {
    countMap.set(v, (countMap.get(v) || 0) + 1)
  }
  let bestValue = values[0]
  let bestCount = 0
  for (const [v, count] of countMap) {
    if (count > bestCount) {
      bestCount = count
      bestValue = v
    }
  }
  // Find the confidence from the result that matches bestValue
  const matchIdx = values.indexOf(bestValue)
  console.log(`[multi-thresh] Length mismatch, picked most common: "${bestValue}" (conf=${confs[matchIdx].toFixed(3)})`)
  return { value: bestValue, confidence: confs[matchIdx] }
}

// ============================================================
// HERO INFO TILE — Extract percent_played and play_time
// ============================================================

async function extractHeroInfoValues(
  canvas: HTMLCanvasElement,
  data: Uint8ClampedArray,
  width: number,
  tileX: number,
  tileY: number
): Promise<{ percentPlayed: number | null; playTimeSeconds: number | null }> {
  // Strategy: scan the entire right side of the hero info tile in overlapping
  // horizontal bands. For each band, count white pixels. Where density is high,
  // try to read a value. Classify values as percent (contains %) or time (contains :).
  // Time: use template matching (proven at this font size).
  // Percent: template matching first, then Tesseract fallback (font size differs).

  let percentPlayed: number | null = null
  let playTimeSeconds: number | null = null
  const left = tileX + HI_SCAN_LEFT
  const right = tileX + TILE_W

  console.log(`[hero-info] Scanning tile at (${tileX}, ${tileY}), scan area x=${left}-${right}`)

  // First pass: find white pixel density per row to identify text bands
  const densityByRow: number[] = []
  for (let y = 0; y < ROW_H; y++) {
    let whiteCount = 0
    for (let x = left; x < right; x++) {
      const srcY = tileY + y
      if (srcY >= 0 && srcY < Math.floor(data.length / (width * 4))) {
        const [r, g, b] = getPixelRGB(data, width, x, srcY)
        const gray = 0.299 * r + 0.587 * g + 0.114 * b
        if (gray > THRESH) whiteCount++
      }
    }
    densityByRow.push(whiteCount)
  }

  // Find bands of high density (text rows)
  const textBands: Array<{ startY: number; endY: number; maxDensity: number }> = []
  let inBand = false
  let bandStart = 0
  let bandMaxDensity = 0
  const densityThreshold = 20

  for (let y = 0; y < densityByRow.length; y++) {
    if (densityByRow[y] >= densityThreshold) {
      if (!inBand) {
        inBand = true
        bandStart = y
        bandMaxDensity = densityByRow[y]
      } else {
        bandMaxDensity = Math.max(bandMaxDensity, densityByRow[y])
      }
    } else {
      if (inBand) {
        inBand = false
        const bandHeight = y - bandStart
        if (bandHeight >= 10) {
          textBands.push({ startY: bandStart, endY: y, maxDensity: bandMaxDensity })
        }
      }
    }
  }
  if (inBand) {
    const bandHeight = densityByRow.length - bandStart
    if (bandHeight >= 10) {
      textBands.push({ startY: bandStart, endY: densityByRow.length, maxDensity: bandMaxDensity })
    }
  }

  console.log(`[hero-info] Found ${textBands.length} text bands:`, textBands.map(b =>
    `y=${b.startY}-${b.endY} (h=${b.endY - b.startY}, density=${b.maxDensity})`
  ))

  // Try to read values from each text band using template matching
  for (const band of textBands) {
    const top = Math.max(0, band.startY - 5)
    const bottom = Math.min(ROW_H, band.endY + 5)

    const { binary, w, h } = getCustomZone(data, width, tileX, tileY, top, bottom, HI_SCAN_LEFT)
    const result = readValue(binary, w, h)

    console.log(`[hero-info] Band y=${top}-${bottom}: template read "${result.value}" (conf=${result.confidence.toFixed(3)})`)

    if (!result.value || result.value === '0') continue

    // Check if it's a percent value (exact match)
    if (percentPlayed === null) {
      const pctMatch = result.value.match(/^(\d{1,3})%$/)
      if (pctMatch) {
        percentPlayed = parseInt(pctMatch[1])
        console.log(`[hero-info] Found percent via template: ${percentPlayed}%`)
        continue
      }
    }

    // Check if it's a time value (exact match)
    if (playTimeSeconds === null) {
      const timeMatch = result.value.match(/^(\d{1,2}):(\d{2})$/)
      if (timeMatch) {
        playTimeSeconds = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2])
        console.log(`[hero-info] Found time via template: ${timeMatch[0]}`)
        continue
      }
    }

    if (percentPlayed !== null && playTimeSeconds !== null) break
  }

  // Tesseract fallback for percent_played
  // The hero info tile uses a different (larger) font for the percent value,
  // which breaks template matching. Tesseract handles variable font sizes.
  if (percentPlayed === null) {
    console.log(`[hero-info] Percent not found via template, trying Tesseract...`)
    percentPlayed = await ocrPercentFromTile(canvas, tileX, tileY, textBands)
  }

  // Tesseract fallback for play time if template matching failed
  if (playTimeSeconds === null) {
    console.log(`[hero-info] Time not found via template, trying Tesseract...`)
    playTimeSeconds = await ocrTimeFromTile(canvas, tileX, tileY, textBands)
  }

  console.log(`[hero-info] Final: percent=${percentPlayed}, time=${playTimeSeconds}s`)
  return { percentPlayed, playTimeSeconds }
}

async function ocrPercentFromTile(
  canvas: HTMLCanvasElement,
  tileX: number,
  tileY: number,
  bands: Array<{ startY: number; endY: number; maxDensity: number }>
): Promise<number | null> {
  const w = await getWorker()

  // The percent VALUE lives ABOVE the "PERCENT PLAYED" label (at y≈228-251).
  // Only consider bands that END before y=225 to exclude the label.
  const candidateBands = bands.filter(b => b.startY >= 100 && b.endY <= 225)
  console.log(`[hero-info] Percent candidate bands (y<225):`, candidateBands.map(b =>
    `y=${b.startY}-${b.endY}`
  ))

  for (const band of candidateBands) {
    const top = tileY + Math.max(0, band.startY - 10)
    const bottom = tileY + Math.min(ROW_H, band.endY + 10)
    const bandH = bottom - top

    // Crop from the full tile width (start at tileX, not masked)
    const crop = document.createElement('canvas')
    crop.width = TILE_W
    crop.height = bandH
    const ctx = crop.getContext('2d')!
    ctx.drawImage(canvas, tileX, top, TILE_W, bandH, 0, 0, TILE_W, bandH)

    // Preprocess: grayscale, high contrast
    const imgData = ctx.getImageData(0, 0, crop.width, crop.height)
    const px = imgData.data
    for (let i = 0; i < px.length; i += 4) {
      const gray = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
      const val = gray > 140 ? 255 : 0
      px[i] = px[i + 1] = px[i + 2] = val
    }
    ctx.putImageData(imgData, 0, 0)

    // Scale up 2x for better OCR
    const scaled = document.createElement('canvas')
    scaled.width = crop.width * 2
    scaled.height = crop.height * 2
    const sctx = scaled.getContext('2d')!
    sctx.imageSmoothingEnabled = false
    sctx.drawImage(crop, 0, 0, scaled.width, scaled.height)

    try {
      await w.setParameters({ tessedit_char_whitelist: '0123456789%' })
      const { data } = await w.recognize(scaled)
      const text = data.text.trim()
      console.log(`[hero-info] Tesseract percent band y=${band.startY}-${band.endY}: "${text}"`)

      const pctMatch = text.match(/(\d{1,3})%?/)
      if (pctMatch) {
        const val = parseInt(pctMatch[1])
        if (val >= 1 && val <= 100) {
          console.log(`[hero-info] Found percent via Tesseract: ${val}%`)
          await w.setParameters({ tessedit_char_whitelist: '' })
          return val
        }
      }
    } catch (err) {
      console.warn(`[hero-info] Tesseract percent OCR error:`, err)
    }
  }

  // Broader fallback: OCR the zone y=140-225 across the FULL tile width
  // This catches cases where the percent value is too small/far-left to
  // register as a text band in the right-side density scan
  console.log(`[hero-info] No percent in bands, trying broad scan y=140-225...`)
  try {
    const crop = document.createElement('canvas')
    const cropTop = tileY + 140
    const cropH = 85  // y=140 to y=225
    crop.width = TILE_W
    crop.height = cropH
    const ctx = crop.getContext('2d')!
    ctx.drawImage(canvas, tileX, cropTop, TILE_W, cropH, 0, 0, TILE_W, cropH)

    // Preprocess
    const imgData = ctx.getImageData(0, 0, crop.width, crop.height)
    const px = imgData.data
    for (let i = 0; i < px.length; i += 4) {
      const gray = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
      const val = gray > 140 ? 255 : 0
      px[i] = px[i + 1] = px[i + 2] = val
    }
    ctx.putImageData(imgData, 0, 0)

    const scaled = document.createElement('canvas')
    scaled.width = crop.width * 2
    scaled.height = crop.height * 2
    const sctx = scaled.getContext('2d')!
    sctx.imageSmoothingEnabled = false
    sctx.drawImage(crop, 0, 0, scaled.width, scaled.height)

    await w.setParameters({ tessedit_char_whitelist: '0123456789%' })
    const { data } = await w.recognize(scaled)
    const text = data.text.trim()
    console.log(`[hero-info] Tesseract broad percent scan y=140-225: "${text}"`)

    await w.setParameters({ tessedit_char_whitelist: '' })

    // Handle multiline: try each line, prefer lines with explicit %
    const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0)
    let bestVal: number | null = null

    for (const line of lines) {
      // Prefer explicit % match
      const explicitPct = line.match(/^(\d{1,3})%$/)
      if (explicitPct) {
        const val = parseInt(explicitPct[1])
        if (val >= 1 && val <= 100) {
          console.log(`[hero-info] Found percent via broad Tesseract: ${val}%`)
          return val
        }
      }
      // Fallback: digits only (no %)
      if (bestVal === null) {
        const digitsOnly = line.match(/^(\d{1,3})$/)
        if (digitsOnly) {
          const val = parseInt(digitsOnly[1])
          if (val >= 1 && val <= 100) bestVal = val
        }
      }
    }

    // Also try the full text joined (handles "4\n%" split across lines)
    const joined = text.replace(/\n/g, '')
    const joinedMatch = joined.match(/(\d{1,3})%/)
    if (joinedMatch) {
      const val = parseInt(joinedMatch[1])
      if (val >= 1 && val <= 100) {
        console.log(`[hero-info] Found percent via joined Tesseract: ${val}%`)
        return val
      }
    }

    if (bestVal !== null) {
      console.log(`[hero-info] Found percent via broad Tesseract (no %): ${bestVal}%`)
      return bestVal
    }
  } catch (err) {
    console.warn(`[hero-info] Tesseract broad percent OCR error:`, err)
  }

  // Reset whitelist
  try { const w2 = await getWorker(); await w2.setParameters({ tessedit_char_whitelist: '' }) } catch {}
  return null
}

async function ocrTimeFromTile(
  canvas: HTMLCanvasElement,
  tileX: number,
  tileY: number,
  bands: Array<{ startY: number; endY: number; maxDensity: number }>
): Promise<number | null> {
  const w = await getWorker()

  // Try bands in the lower-middle area (y~260-400) where time typically lives
  const candidateBands = bands.filter(b => b.startY >= 260 && b.startY <= 400)

  for (const band of candidateBands) {
    const top = tileY + Math.max(0, band.startY - 10)
    const bottom = tileY + Math.min(ROW_H, band.endY + 10)
    const bandH = bottom - top

    const crop = document.createElement('canvas')
    crop.width = TILE_W
    crop.height = bandH
    const ctx = crop.getContext('2d')!
    ctx.drawImage(canvas, tileX, top, TILE_W, bandH, 0, 0, TILE_W, bandH)

    // Preprocess
    const imgData = ctx.getImageData(0, 0, crop.width, crop.height)
    const px = imgData.data
    for (let i = 0; i < px.length; i += 4) {
      const gray = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
      const val = gray > 140 ? 255 : 0
      px[i] = px[i + 1] = px[i + 2] = val
    }
    ctx.putImageData(imgData, 0, 0)

    const scaled = document.createElement('canvas')
    scaled.width = crop.width * 2
    scaled.height = crop.height * 2
    const sctx = scaled.getContext('2d')!
    sctx.imageSmoothingEnabled = false
    sctx.drawImage(crop, 0, 0, scaled.width, scaled.height)

    try {
      await w.setParameters({ tessedit_char_whitelist: '0123456789:' })
      const { data } = await w.recognize(scaled)
      const text = data.text.trim()
      console.log(`[hero-info] Tesseract time band y=${band.startY}-${band.endY}: "${text}"`)

      const timeMatch = text.match(/(\d{1,2}):(\d{2})/)
      if (timeMatch) {
        const seconds = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2])
        console.log(`[hero-info] Found time via Tesseract: ${timeMatch[0]}`)
        await w.setParameters({ tessedit_char_whitelist: '' })
        return seconds
      }
    } catch (err) {
      console.warn(`[hero-info] Tesseract time OCR error:`, err)
    }
  }

  try { const w2 = await getWorker(); await w2.setParameters({ tessedit_char_whitelist: '' }) } catch {}
  return null
}

// ============================================================
// TESSERACT — Kept for LABEL reading (stat names) only
// ============================================================

let _worker: Tesseract.Worker | null = null

async function getWorker(): Promise<Tesseract.Worker> {
  if (!_worker) {
    _worker = await Tesseract.createWorker('eng')
  }
  return _worker
}

export async function terminateBreakdownOcr(): Promise<void> {
  if (_worker) {
    await _worker.terminate()
    _worker = null
  }
}

async function ocrTileLabel(
  canvas: HTMLCanvasElement,
  tileX: number,
  tileY: number,
  tileW: number,
  tileH: number
): Promise<string> {
  // Crop the full tile for label OCR
  const crop = document.createElement('canvas')
  crop.width = tileW
  crop.height = tileH
  const ctx = crop.getContext('2d')!
  ctx.drawImage(canvas, tileX, tileY, tileW, tileH, 0, 0, tileW, tileH)

  const w = await getWorker()
  const { data } = await w.recognize(crop)
  return data.text
}

// ============================================================
// COUNT-DEPENDENT STAT GRAMMAR
// ------------------------------------------------------------
// In-game, several stat labels change between singular and plural with
// the tile's value: "FINAL BLOW" at 1, "FINAL BLOWS" otherwise;
// "ENEMY FROZEN" at 1, "ENEMIES FROZEN" otherwise. The catalog stores ONE
// fixed (and inconsistent) form per stat, so two things follow:
//
//   1) MATCHING must be plural-agnostic, or an "ENEMIES FROZEN" screenshot
//      fails to match the catalog's "ENEMY FROZEN" and the tile reads
//      UNKNOWN (observed: Mei tile 1 at value≠1).
//
//   2) The EMITTED statName should reflect the screenshot's grammar
//      (singular at value 1, plural otherwise) rather than the catalog's
//      arbitrary stored form — otherwise the label silently disagrees with
//      what the user sees (observed: ~21 plural-drift labels across 6v6/5v5).
//
// We handle two locations of the count-bearing noun:
//   - trailing head noun: KILL(S) / BLOW(S) / HIT(S) / ASSIST(S)
//   - leading subject:    ENEMY/ENEMIES, PLAYER/PLAYERS  (e.g. "ENEMY FROZEN",
//     "PLAYERS SAVED", "PLAYER KNOCKED BACK")
// A leading ENEMY/PLAYER is only treated as count-bearing when the phrase is
// not a rate/quality stat (so "ENEMY COALESCENCE EFFICIENCY" is left alone).
// ============================================================

/** Stat tails that are never count-dependent (rates, qualities, durations). */
const NON_COUNT_TAILS = new Set([
  'ACCURACY', 'HEALING', 'DAMAGE', 'TIME', 'PERCENTAGE', 'USAGE', 'EFFICIENCY',
  'RATE', 'MULTIPLIER', 'CREATED', 'PROVIDED', 'PREVENTED', 'AMPLIFIED',
  'NEGATED', 'DONE', 'GAINED', 'ENERGY', 'AURA', 'UPTIME',
])

const LEADING_COUNT_WORDS = new Set(['ENEMY', 'ENEMIES', 'PLAYER', 'PLAYERS'])
const TRAILING_SINGULAR = new Set(['KILL', 'BLOW', 'HIT', 'ASSIST'])
const TRAILING_PLURAL = new Set(['KILLS', 'BLOWS', 'HITS', 'ASSISTS'])

const TO_SINGULAR: Record<string, string> = {
  ENEMIES: 'ENEMY', PLAYERS: 'PLAYER',
  KILLS: 'KILL', BLOWS: 'BLOW', HITS: 'HIT', ASSISTS: 'ASSIST',
}
const TO_PLURAL: Record<string, string> = {
  ENEMY: 'ENEMIES', PLAYER: 'PLAYERS',
  KILL: 'KILLS', BLOW: 'BLOWS', HIT: 'HITS', ASSIST: 'ASSISTS',
}

/**
 * Return the count-correct display form of a (catalog) stat name given the
 * tile's extracted value. Singular when the value is exactly 1, plural
 * otherwise. Non-count stats are returned unchanged. Operates on the
 * UPPER-CASE catalog form (the only form we store).
 */
function applyCountGrammar(statName: string, statValue: string): string {
  // Determine singular vs plural from the numeric value. Non-numeric values
  // (e.g. accuracy "%", time "MM:SS") never reach a count-bearing noun, but
  // guard anyway: treat unparseable as plural (the safer default form).
  const numeric = parseInt(statValue.replace(/[^\d-]/g, ''), 10)
  const isOne = numeric === 1

  const words = statName.split(/\s+/)
  if (words.length === 0) return statName
  const tail = words[words.length - 1]

  if (TRAILING_SINGULAR.has(tail) || TRAILING_PLURAL.has(tail)) {
    words[words.length - 1] = isOne
      ? (TO_SINGULAR[tail] ?? tail)
      : (TO_PLURAL[tail] ?? tail)
  } else if (LEADING_COUNT_WORDS.has(words[0]) && !NON_COUNT_TAILS.has(tail)) {
    words[0] = isOne
      ? (TO_SINGULAR[words[0]] ?? words[0])
      : (TO_PLURAL[words[0]] ?? words[0])
  }
  return words.join(' ')
}

/**
 * Normalize a single word to a canonical form for plural-agnostic matching:
 * fold the known count-bearing inflections to their singular root so that
 * "ENEMIES"/"ENEMY", "KILLS"/"KILL", etc. compare equal. Other words are
 * returned unchanged (upper-cased, alphanumerics only).
 */
function normalizePluralWord(word: string): string {
  const w = word.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (TO_SINGULAR[w]) return TO_SINGULAR[w]
  return w
}

// ============================================================
// STAT LABEL MATCHING
// ============================================================

function fuzzyWordMatch(ocrWord: string, expected: string): boolean {
  const a = ocrWord.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const b = expected.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (a === b) return true
  if (a.length < 2 || b.length < 2) return false
  if (b.length >= 4) {
    let diffs = 0
    const maxLen = Math.max(a.length, b.length)
    const minLen = Math.min(a.length, b.length)
    if (maxLen - minLen > 1) return false
    for (let i = 0; i < minLen; i++) {
      if (a[i] !== b[i]) diffs++
    }
    diffs += maxLen - minLen
    if (diffs <= 1) return true
  }
  return false
}

function matchStatLabel(ocrText: string, expectedStats: string[]): string | null {
  const upperText = ocrText.toUpperCase()
  // Try exact substring match first
  for (const stat of expectedStats) {
    if (upperText.includes(stat)) return stat
  }

  // Plural-agnostic comparison: fold count-bearing inflections to a canonical
  // root on BOTH sides so "ENEMIES FROZEN" matches catalog "ENEMY FROZEN"
  // (and any singular/plural OCR matches any singular/plural catalog form).
  const ocrWords = upperText.split(/\s+/)
  const ocrNorm = ocrWords.map(normalizePluralWord)

  // Exact (normalized) word-sequence containment: every catalog word has a
  // normalized OCR word equal to it. Prefer the MOST SPECIFIC (longest) such
  // catalog stat so a stacked pair like "ICICLE ACCURACY" vs
  // "ICICLE CRITICAL ACCURACY" never resolves to the shorter one when the
  // longer also fully matches (6a-ii stacked-accuracy guard).
  let bestContain: string | null = null
  let bestContainLen = -1
  for (const stat of expectedStats) {
    const statNorm = stat.split(/\s+/).map(normalizePluralWord)
    const allPresent = statNorm.every((sw) => ocrNorm.includes(sw))
    if (allPresent && statNorm.length > bestContainLen) {
      bestContain = stat
      bestContainLen = statNorm.length
    }
  }
  if (bestContain) return bestContain

  // Try fuzzy word-by-word matching (now also plural-normalized).
  for (const stat of expectedStats) {
    const statWords = stat.split(/\s+/)
    let matchCount = 0
    for (const sw of statWords) {
      const swNorm = normalizePluralWord(sw)
      for (let oi = 0; oi < ocrWords.length; oi++) {
        // match either on the normalized root (handles plurals) or via the
        // original fuzzy single-edit tolerance (handles OCR noise).
        if (ocrNorm[oi] === swNorm || fuzzyWordMatch(ocrWords[oi], sw)) {
          matchCount++
          break
        }
      }
    }
    if (matchCount >= statWords.length * 0.7) return stat
  }
  return null
}

// ============================================================
// AVG/10 MIN EXTRACTION from label OCR text
// ============================================================

function extractAvgPer10(text: string): string | null {
  // Look for patterns like "AVG PER 10 MIN" on a line, then find the
  // numeric value on a NEARBY line (above or below), not on the label line itself
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  for (let i = 0; i < lines.length; i++) {
    const upper = lines[i].toUpperCase()
    if (upper.includes('AVG') && (upper.includes('PER') || upper.includes('MIN'))) {
      // Found the label line. Look for a numeric value on adjacent lines
      // Check the line above first (value is typically above label)
      for (const offset of [-1, -2, 1, 2]) {
        const adjIdx = i + offset
        if (adjIdx >= 0 && adjIdx < lines.length) {
          const adjLine = lines[adjIdx].trim()
          // Must be a standalone number, not part of the label
          const adjUpper = adjLine.toUpperCase()
          if (adjUpper.includes('AVG') || adjUpper.includes('PER') || adjUpper.includes('MIN')) continue
          const numMatch = adjLine.match(/^[\d,]+\.?\d*%?$/)
          if (numMatch) return numMatch[0].replace(/,/g, '')
        }
      }

      // If no adjacent line has a standalone number, try extracting from the same line
      // but exclude "10" which is part of the label
      const cleanedLine = lines[i]
        .replace(/AVG\s*(PER)?\s*10\s*MIN/i, '')
        .replace(/PER\s*10\s*MIN/i, '')
        .replace(/10\s*MIN/i, '')
        .trim()
      if (cleanedLine) {
        const numMatch = cleanedLine.match(/[\d,]+\.?\d*%?/)
        if (numMatch && numMatch[0] !== '10') return numMatch[0].replace(/,/g, '')
      }
    }
  }
  return null
}

// ============================================================
// MAIN EXPORT — Process one hero breakdown screenshot
// ============================================================

export async function ocrBreakdownPage(
  img: HTMLImageElement,
  heroName: string
): Promise<BreakdownOcrResult> {
  const result: BreakdownOcrResult = {
    heroName,
    percentPlayed: null,
    playTimeSeconds: null,
    stats: [],
    expectedStatCount: 0,
    foundStatCount: 0,
    raw: '',
  }

  // Look up expected stats
  const catalogEntry = HERO_STAT_LOOKUP.get(heroName)
  const expectedStats = catalogEntry ? catalogEntry.stats.map(s => s.name) : []
  result.expectedStatCount = expectedStats.length

  // Get image pixel data
  const canvas = imageToCanvas(img)
  const { data, width, height } = getPixelArray(canvas)

  // Detect grid variant
  const variant = detectVariant(data, width, height)
  console.log(`[breakdown-ocr] Grid variant: ${variant}`)

  // Get hero info tile position (R1C1)
  const cols = VARIANTS[variant].col_starts
  const heroTileX = cols[0]
  const heroTileY = ROW_TOPS[0]

  // Extract hero info values (percent_played, play_time)
  const heroInfo = await extractHeroInfoValues(canvas, data, width, heroTileX, heroTileY)
  result.percentPlayed = heroInfo.percentPlayed
  result.playTimeSeconds = heroInfo.playTimeSeconds
  console.log(`[breakdown-ocr] Percent played: ${result.percentPlayed}%, Play time: ${result.playTimeSeconds}s`)

  // Get stat tiles
  const tiles = getStatTiles(data, width, height, variant)
  console.log(`[breakdown-ocr] Found ${tiles.length} stat tiles`)

  // Process each stat tile
  const matchedStats = new Set<string>()

  for (let i = 0; i < tiles.length; i++) {
    const { x: tx, y: ty, row, col, catalogIndex } = tiles[i]

    // Template matching for value (with multi-threshold retry for edge cases)
    const green = hasGreenBar(data, width, tx, ty)
    const { value, confidence } = readValueMultiThreshold(data, width, tx, ty, green)

    // OCR for label (stat name matching)
    const labelText = await ocrTileLabel(canvas, tx, ty, TILE_W, ROW_H)
    result.raw += `--- Tile ${i} R${row + 1}C${col + 1} (${tx},${ty}) green=${green} ---\nValue: ${value} (conf=${confidence.toFixed(3)})\nLabel OCR:\n${labelText}\n\n`

    // Match label against expected stats
    const unmatchedStats = expectedStats.filter(s => !matchedStats.has(s))
    const matchedLabel = matchStatLabel(labelText, unmatchedStats)

    // Extract avg/10 min from label text
    const avgPer10 = extractAvgPer10(labelText)

    if (matchedLabel) {
      matchedStats.add(matchedLabel)
      result.stats.push({
        statName: applyCountGrammar(matchedLabel, value),
        statValue: value,
        avgPer10Min: avgPer10,
      })
    } else {
      // Coordinate-based fallback: map this tile to its catalog stat by its
      // actual (row, col) grid position rather than by sequential emission index.
      // This is robust to interior gaps — if a tile in the middle of the grid is
      // absent (bar check fails), the remaining tiles still resolve to the correct
      // catalog entry because each carries its own row-major catalogIndex.
      // (Sequential indexing would shift every subsequent tile by one after a gap.)
      if (
        catalogIndex >= 0 &&
        catalogIndex < expectedStats.length &&
        !matchedStats.has(expectedStats[catalogIndex])
      ) {
        matchedStats.add(expectedStats[catalogIndex])
        result.stats.push({
          statName: applyCountGrammar(expectedStats[catalogIndex], value),
          statValue: value,
          avgPer10Min: avgPer10,
        })
      } else {
        result.stats.push({
          statName: `UNKNOWN_TILE_R${row + 1}C${col + 1}`,
          statValue: value,
          avgPer10Min: avgPer10,
        })
      }
    }

    console.log(`[breakdown-ocr] Tile ${i} R${row + 1}C${col + 1} (catalogIndex=${catalogIndex}): "${matchedLabel || 'UNKNOWN'}" = ${value} (conf=${confidence.toFixed(3)})${green ? ' [GREEN BAR]' : ''}`)
  }

  result.foundStatCount = result.stats.filter(s => !s.statName.startsWith('UNKNOWN')).length

  return result
}

// ============================================================
// EXPORTED GRID-VARIANT / PORTRAIT-LOCATION API
// Lets image-processor.ts locate the R1C1 hero portrait on a breakdown
// page using the SAME variant detection the OCR uses, so the two never
// disagree about the grid layout (single source of truth).
//
// The portrait sits at a FIXED location in every breakdown screenshot.
// Its center-x is tied to the grid's first column start:
//   center_x = col_starts[0] + R1C1_PORTRAIT_DX   (959 for A, 973 for B)
//   center_y = R1C1_PORTRAIT_CY                    (644, same for both)
// These offsets were measured directly from 3840x2160 screenshots:
//   - 16 screenshots, every hero, both formats (all variant A in the test set)
//   - verified by fitting the orange ring: it clusters tightly (std ~4.4px)
//     about this fixed center regardless of how long the orange arc is.
// We crop by this FIXED center, NEVER by detecting the (variable-length)
// orange play-time arc.
//
// NOTE: variant B's center-x (973) is derived arithmetically (col_starts[0]
// shift of +14). No variant-B screenshot was available to measure directly;
// confirm against a real B capture if one is ever obtained.
// ============================================================

// Measured offset from the grid's first-column start (col_starts[0]) to the
// portrait center-x: 959 - 790 = 169 (variant A) and 973 - 804 = 169 (variant B).
const R1C1_PORTRAIT_DX = 169
// Measured portrait center-y on the breakdown page (identical for A and B).
const R1C1_PORTRAIT_CY = 644
// Half-size of the square art crop. Portrait art inner radius ~99px; the
// orange ring sits at r102-118. 95 stays safely inside the art on all sides.
const PORTRAIT_ART_HALF = 95

export interface BreakdownPortraitLocation {
  variant: 'A' | 'B'
  centerX: number
  centerY: number
  /** Square art-crop box [x, y, width, height], safe inside the ring. */
  cropBox: { x: number; y: number; w: number; h: number }
}

/**
 * Detect the breakdown grid variant for an image and return the fixed
 * R1C1 portrait center + a safe square art-crop box. Uses the same
 * detectVariant() as the stat OCR, so layout decisions never diverge.
 */
export function getBreakdownPortraitLocation(
  img: HTMLImageElement
): BreakdownPortraitLocation {
  const canvas = imageToCanvas(img)
  const { data, width, height } = getPixelArray(canvas)
  const variant = detectVariant(data, width, height)
  const centerX = VARIANTS[variant].col_starts[0] + R1C1_PORTRAIT_DX
  const centerY = R1C1_PORTRAIT_CY
  return {
    variant,
    centerX,
    centerY,
    cropBox: {
      x: centerX - PORTRAIT_ART_HALF,
      y: centerY - PORTRAIT_ART_HALF,
      w: PORTRAIT_ART_HALF * 2,
      h: PORTRAIT_ART_HALF * 2,
    },
  }
}

// ============================================================
// EXPORTED TEMPLATE MATCHING API
// Used by ocr-extractor.ts for summary page digit extraction.
// Provides access to the proven template matching engine without
// exposing internal implementation details.
// ============================================================

/**
 * Read a numeric value from a rectangular region of an image.
 * Binarizes the region at the given threshold, then runs the full
 * template matching pipeline (connected components → smart segmentation
 * → NCC matching → post-processing).
 *
 * @param data - Full image pixel data (RGBA Uint8ClampedArray)
 * @param imgWidth - Full image width
 * @param cropX - Left edge of region to read
 * @param cropY - Top edge of region to read
 * @param cropW - Width of region
 * @param cropH - Height of region
 * @param threshold - Binarization threshold (default 120)
 * @returns { value, confidence } — e.g. { value: "30", confidence: 0.95 }
 */
export function readRegionValue(
  data: Uint8ClampedArray,
  imgWidth: number,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
  threshold: number = THRESH
): { value: string; confidence: number } {
  const binary = new Uint8Array(cropW * cropH)

  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcX = cropX + x
      const srcY = cropY + y
      const idx = (srcY * imgWidth + srcX) * 4
      const r = data[idx], g = data[idx + 1], b = data[idx + 2]
      const gray = 0.299 * r + 0.587 * g + 0.114 * b
      binary[y * cropW + x] = gray > threshold ? 255 : 0
    }
  }

  return readValue(binary, cropW, cropH)
}

/**
 * Read a numeric value using multi-threshold voting (120, 130, 140).
 * Runs readRegionValue at three thresholds and uses majority vote
 * to resolve ambiguous digits (e.g. "2" vs "9" at boundary thresholds).
 *
 * Same parameters as readRegionValue minus threshold.
 */
export function readRegionValueMultiThreshold(
  data: Uint8ClampedArray,
  imgWidth: number,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number
): { value: string; confidence: number } {
  const results = ALL_THRESHOLDS.map(thresh =>
    readRegionValue(data, imgWidth, cropX, cropY, cropW, cropH, thresh)
  )

  const values = results.map(r => r.value)
  const confs = results.map(r => r.confidence)

  // If all three agree, return immediately
  if (values[0] === values[1] && values[1] === values[2]) {
    return results[0]
  }

  // Instability detected — majority vote
  console.log(`[template-api] Instability: ${ALL_THRESHOLDS.map((t, i) => `t${t}="${values[i]}"`).join(', ')}`)

  if (values[0].length === values[1].length && values[1].length === values[2].length) {
    const voted: string[] = []
    for (let i = 0; i < values[0].length; i++) {
      const c0 = values[0][i], c1 = values[1][i], c2 = values[2][i]
      if (c0 === c1 || c0 === c2) voted.push(c0)
      else if (c1 === c2) voted.push(c1)
      else voted.push(values[confs.indexOf(Math.max(...confs))][i])
    }
    return { value: voted.join(''), confidence: Math.max(...confs) }
  }

  // Different lengths — pick most common
  const countMap = new Map<string, number>()
  for (const v of values) countMap.set(v, (countMap.get(v) || 0) + 1)
  let bestValue = values[0], bestCount = 0
  for (const [v, count] of countMap) {
    if (count > bestCount) { bestCount = count; bestValue = v }
  }
  const matchIdx = values.indexOf(bestValue)
  return { value: bestValue, confidence: confs[matchIdx] }
}
