// ============================================================
// PHONE MAP DETECTOR — lightweight, upload-time map identification
//
// Purpose: on the PHONE, at upload time, figure out which map was played
// so we can decide whether to ask the attack/defend question (only hybrid
// & escort maps need it — see needsStartingSide() in @/data/reference).
//
// Why this is separate from ocr-extractor.ts's ocrSummaryPage():
//   ocrSummaryPage runs SIX OCR passes plus template matching plus pixel
//   work — far too heavy for a phone. We only need ONE thing here: the map
//   name. So we crop ONLY the map-name region and run a single Tesseract
//   pass on that one small sliver. Everything else the laptop still does.
//
// Coordinates: identical reference frame to ocr-extractor.ts (PS5 native
// 3840×2160, 16:9). Screenshots are uploaded untouched from the photo
// library, so the aspect ratio always matches and scaling is valid.
//
// Map-name MATCHING reuses findMapName() exported from ocr-extractor.ts,
// so the phone and the laptop can never drift apart on how text → map.
// ============================================================

import Tesseract from 'tesseract.js'
import { findMapName } from '@/lib/ocr-extractor'

// Reference resolution — must match ocr-extractor.ts.
const REF_W = 3840
const REF_H = 2160

// The map-name header crop, at reference resolution.
// Kept in sync with REGIONS.mapName in ocr-extractor.ts.
const MAP_NAME_REGION = { x: 2580, y: 379, w: 470, h: 51 }

interface DetectResult {
  mapName: string | null
  /** Which photo index the map was read from, or -1 if none matched. */
  sourceIndex: number
  /** Human-readable diagnostics for on-screen debugging. */
  debug: string[]
}

function scaleRegion(imgW: number, imgH: number) {
  const sx = imgW / REF_W
  const sy = imgH / REF_H
  return {
    x: Math.round(MAP_NAME_REGION.x * sx),
    y: Math.round(MAP_NAME_REGION.y * sy),
    w: Math.round(MAP_NAME_REGION.w * sx),
    h: Math.round(MAP_NAME_REGION.h * sy),
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image for map detection'))
    img.src = src
  })
}

/**
 * Crop the map-name region from one image and return it scaled-up as a
 * canvas, ready for OCR. Returns null if the image is too small/odd to crop.
 */
function cropMapName(img: HTMLImageElement, scale = 3): HTMLCanvasElement | null {
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) return null

  const r = scaleRegion(w, h)
  // Clamp the crop to the image bounds rather than bailing out — phone
  // screenshots may be a slightly different resolution, and a clamped crop
  // still captures the map-name header in practice.
  const x = Math.max(0, Math.min(r.x, w - 1))
  const y = Math.max(0, Math.min(r.y, h - 1))
  const cw = Math.max(1, Math.min(r.w, w - x))
  const ch = Math.max(1, Math.min(r.h, h - y))

  const crop = document.createElement('canvas')
  crop.width = cw
  crop.height = ch
  const cctx = crop.getContext('2d')
  if (!cctx) return null
  cctx.drawImage(img, x, y, cw, ch, 0, 0, cw, ch)

  // Scale up for cleaner OCR on small text (same trick as ocr-extractor).
  const scaled = document.createElement('canvas')
  scaled.width = cw * scale
  scaled.height = ch * scale
  const sctx = scaled.getContext('2d')
  if (!sctx) return null
  sctx.imageSmoothingEnabled = true
  sctx.drawImage(crop, 0, 0, scaled.width, scaled.height)
  return scaled
}

/**
 * Detect the map from a set of photo object-URLs (the ones the user just
 * picked, before upload). Tries each photo's map-name region; the summary
 * page is the only one with readable text there, so the first valid map
 * match wins. Creates ONE Tesseract worker for the whole batch and always
 * terminates it (important on mobile — avoids a leaked worker).
 *
 * @param photoUrls object-URLs (URL.createObjectURL) for the chosen files
 * @param onProgress optional 0..1 progress callback for a spinner/label
 * @returns the detected map name (or null) and which photo it came from
 */
export async function detectMapFromPhotos(
  photoUrls: string[],
  onProgress?: (fraction: number) => void,
): Promise<DetectResult> {
  const debug: string[] = []
  if (photoUrls.length === 0) return { mapName: null, sourceIndex: -1, debug: ['no photos'] }

  let worker: Tesseract.Worker | null = null
  try {
    debug.push(`creating OCR worker for ${photoUrls.length} photo(s)…`)
    worker = await Tesseract.createWorker('eng')
    debug.push('worker ready')

    for (let i = 0; i < photoUrls.length; i++) {
      onProgress?.(i / photoUrls.length)
      let img: HTMLImageElement
      try {
        img = await loadImage(photoUrls[i])
      } catch {
        debug.push(`photo ${i + 1}: failed to load`)
        continue
      }

      debug.push(`photo ${i + 1}: ${img.naturalWidth}×${img.naturalHeight}`)

      const canvas = cropMapName(img)
      if (!canvas) {
        debug.push(`photo ${i + 1}: crop failed`)
        continue
      }

      let text = ''
      try {
        const { data } = await worker.recognize(canvas)
        text = (data.text || '').trim()
      } catch (e) {
        debug.push(`photo ${i + 1}: OCR error`)
        continue
      }

      debug.push(`photo ${i + 1}: read "${text.slice(0, 40)}"`)

      const map = findMapName(text.toUpperCase())
      if (map) {
        debug.push(`photo ${i + 1}: matched → ${map}`)
        onProgress?.(1)
        return { mapName: map, sourceIndex: i, debug }
      }
    }
    debug.push('no map matched on any photo')
  } catch (e) {
    debug.push(`fatal: ${e instanceof Error ? e.message : String(e)}`)
    console.warn('[phone-map-detect] detection failed:', e)
  } finally {
    if (worker) {
      try { await worker.terminate() } catch { /* ignore */ }
    }
  }

  onProgress?.(1)
  return { mapName: null, sourceIndex: -1, debug }
}
