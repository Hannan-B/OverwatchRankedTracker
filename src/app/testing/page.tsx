'use client'

// ============================================================
// TESTING PAGE (Step 6c) — Batch validation harness
// ------------------------------------------------------------
// Calls processMatchPhotos() DIRECTLY — the exact same orchestrator
// the production /process page uses — so results validate production
// behaviour. Files are grouped into matches by their `Test_<N>_`
// filename prefix; each group is one processMatchPhotos() call.
//
// Per the 6c spec + user requirement, this page surfaces per-portrait
// MATCH CONFIDENCE across all three page types (summary, scoreboard,
// hero breakdown). The rich per-portrait fields the user wants —
// margin, runner-up, winning crop (crop N/4), and Phase-1-vs-Pass-1
// agreement — live ONLY in the console logs that Step 6b added, so
// this page installs a console capture wrapper around each match's
// run and parses those lines back into structured confidence tables.
//
// Matches are processed SEQUENTIALLY (one at a time) so captured
// console output never interleaves between concurrent runs, and so
// per-match timings stay clean for the 6b ~2-min validation.
// ============================================================

import { useState, useRef, useCallback } from 'react'
import {
  processMatchPhotos,
  classifyPageType,
  groupPhotosByContent,
  type ProcessedMatch,
  type ProcessingStatus,
  type PageType,
  type ClassifiedPhoto,
} from '@/lib/image-processor'

// ============================================================
// CONSOLE CAPTURE
// ============================================================

interface CapturedLine {
  level: 'log' | 'warn' | 'error'
  text: string
}

/**
 * Install temporary console wrappers that mirror output into `sink`
 * while still passing through to the real console. Returns a restore
 * function. Format args the same way the browser console would for a
 * single-string-ish line so the parsers below see what 6b logged.
 */
function installConsoleCapture(sink: CapturedLine[]): () => void {
  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }

  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return a.message
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')

  console.log = (...args: unknown[]) => {
    sink.push({ level: 'log', text: fmt(args) })
    orig.log(...args)
  }
  console.warn = (...args: unknown[]) => {
    sink.push({ level: 'warn', text: fmt(args) })
    orig.warn(...args)
  }
  console.error = (...args: unknown[]) => {
    sink.push({ level: 'error', text: fmt(args) })
    orig.error(...args)
  }

  return () => {
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
  }
}

// ============================================================
// CONFIDENCE PARSING
// Recover per-portrait confidence from the 6b/6a-iii console lines.
// All regexes are tolerant: a line that doesn't match is simply
// skipped (it stays in the raw log appendix regardless).
// ============================================================

/** One scoreboard portrait's confidence detail, merged from P1 (+P2 if it ran). */
interface ScoreboardPortraitConfidence {
  slot: number
  team: 'ally' | 'enemy' | null
  hero: string
  score: number
  margin: number | null
  runnerUp: string | null
  crop: string | null // e.g. "2/4"
  phase1Hero: string | null
  phase1Score: number | null
  /** Did the Phase-1 cleanest-crop pick agree with the Pass-1 identification? */
  phase1Agrees: boolean | null
  roleCorrected: string | null
  orbApplied: boolean // true if a [P2] line upgraded this slot
}

interface SummaryPortraitConfidence {
  slot: number
  hero: string
  score: number
  ringPx: number | null
}

interface BreakdownPortraitConfidence {
  hero: string
  score: number
  imageIndex: number | null
  assigned: boolean
}

interface ParsedConfidence {
  scoreboard: ScoreboardPortraitConfidence[]
  summary: SummaryPortraitConfidence[]
  breakdown: BreakdownPortraitConfidence[]
}

// --- Scoreboard Pass 1 ---
//   [P1] Slot 3 (ally): Reinhardt (score: 0.5123, margin: 0.0820, runner-up: Orisa, crop: 2/4 [phase1: Reinhardt 0.4410], role-filter: tank)
const P1_RE =
  /\[P1\]\s+Slot\s+(\d+)\s+\((ally|enemy)\):\s+(.+?)\s+\(score:\s*([\d.]+),\s*margin:\s*([\d.]+),\s*runner-up:\s*(.+?),\s*crop:\s*(\d+\/\d+)\s*\[phase1:\s*(.+?)\s+([\d.]+)\]/

// --- Scoreboard Pass 2 (ORB upgrade) ---
//   [P2] Slot 3: Orisa (31.2%) → Reinhardt (44.0%, margin: 0.1100, runner-up: Orisa, crop: 4/4, role-filter: tank)
const P2_RE =
  /\[P2\]\s+Slot\s+(\d+):\s+.+?\s+\([\d.]+%\)\s*(?:→|->)\s*(.+?)\s+\(([\d.]+)%,\s*margin:\s*([\d.]+),\s*runner-up:\s*(.+?),\s*crop:\s*(\d+\/\d+)/

const ROLE_CORRECTED_RE = /ROLE CORRECTED\s*(?:→|->)\s*(\w+)/

// --- Summary portrait ---
//   Summary slot 0 @(355,720): Reinhardt (score 0.4821, ring px=1632)
const SUMMARY_RE =
  /Summary slot\s+(\d+)\s+@\([\d,]+\):\s+(.+?)\s+\(score\s+([\d.]+)(?:,\s*ring px=(\d+))?\)/

// --- Breakdown per-image score line ---
//   Breakdown 2 scores: Mei=0.5210, Reaper=0.3110
const BREAKDOWN_SCORES_RE = /Breakdown\s+(\d+)\s+scores:\s+(.+)/

// --- Breakdown assignment ---
//   Assigned: image 2 → Mei (score: 0.5210)
const BREAKDOWN_ASSIGN_RE =
  /Assigned:\s+image\s+(\d+)\s*(?:→|->)\s*(.+?)\s+\(score:\s*([\d.]+)\)/

function parseConfidence(lines: CapturedLine[]): ParsedConfidence {
  const scoreboard = new Map<number, ScoreboardPortraitConfidence>()
  const summary: SummaryPortraitConfidence[] = []
  const breakdownBest = new Map<string, BreakdownPortraitConfidence>()
  const assignedHeroes = new Set<string>()

  for (const { text } of lines) {
    // Scoreboard Pass 1
    const p1 = text.match(P1_RE)
    if (p1) {
      const slot = parseInt(p1[1], 10)
      const hero = p1[3].trim()
      const phase1Hero = p1[8].trim()
      scoreboard.set(slot, {
        slot,
        team: p1[2] as 'ally' | 'enemy',
        hero,
        score: parseFloat(p1[4]),
        margin: parseFloat(p1[5]),
        runnerUp: p1[6].trim(),
        crop: p1[7],
        phase1Hero,
        phase1Score: parseFloat(p1[9]),
        phase1Agrees: phase1Hero === hero,
        roleCorrected: text.match(ROLE_CORRECTED_RE)?.[1] ?? null,
        orbApplied: false,
      })
      continue
    }

    // Scoreboard Pass 2 — upgrades an existing slot
    const p2 = text.match(P2_RE)
    if (p2) {
      const slot = parseInt(p2[1], 10)
      const existing = scoreboard.get(slot)
      const hero = p2[2].trim()
      const merged: ScoreboardPortraitConfidence = {
        slot,
        team: existing?.team ?? null,
        hero,
        score: parseFloat(p2[3]) / 100, // P2 logs a percentage
        margin: parseFloat(p2[4]),
        runnerUp: p2[5].trim(),
        crop: p2[6],
        // Phase-1 fields carry over from Pass 1 (Phase 1 only runs in Pass 1)
        phase1Hero: existing?.phase1Hero ?? null,
        phase1Score: existing?.phase1Score ?? null,
        phase1Agrees:
          existing?.phase1Hero != null ? existing.phase1Hero === hero : null,
        roleCorrected:
          text.match(ROLE_CORRECTED_RE)?.[1] ?? existing?.roleCorrected ?? null,
        orbApplied: true,
      }
      scoreboard.set(slot, merged)
      continue
    }

    // Summary portrait
    const sm = text.match(SUMMARY_RE)
    if (sm) {
      summary.push({
        slot: parseInt(sm[1], 10),
        hero: sm[2].trim(),
        score: parseFloat(sm[3]),
        ringPx: sm[4] ? parseInt(sm[4], 10) : null,
      })
      continue
    }

    // Breakdown per-image scores: keep the best (hero, score) seen per hero
    const bs = text.match(BREAKDOWN_SCORES_RE)
    if (bs) {
      const imageIndex = parseInt(bs[1], 10) - 1
      const pairs = bs[2].split(',')
      for (const pair of pairs) {
        const m = pair.trim().match(/^(.+?)=([\d.]+|\?)$/)
        if (!m || m[2] === '?') continue
        const hero = m[1].trim()
        const score = parseFloat(m[2])
        const prev = breakdownBest.get(hero)
        if (!prev || score > prev.score) {
          breakdownBest.set(hero, {
            hero,
            score,
            imageIndex,
            assigned: assignedHeroes.has(hero),
          })
        }
      }
      continue
    }

    // Breakdown assignment
    const ba = text.match(BREAKDOWN_ASSIGN_RE)
    if (ba) {
      const hero = ba[2].trim()
      const score = parseFloat(ba[3])
      assignedHeroes.add(hero)
      breakdownBest.set(hero, {
        hero,
        score,
        imageIndex: parseInt(ba[1], 10) - 1,
        assigned: true,
      })
      continue
    }
  }

  return {
    scoreboard: Array.from(scoreboard.values()).sort((a, b) => a.slot - b.slot),
    summary: summary.sort((a, b) => a.slot - b.slot),
    breakdown: Array.from(breakdownBest.values()).sort(
      (a, b) => b.score - a.score,
    ),
  }
}

// ============================================================
// MATCH GROUPING
// ------------------------------------------------------------
// Two strategies, auto-selected:
//
//   A) PREFIX grouping — when filenames carry a usable match label like
//      "Test 1 ..." / "Test_1_..." / "Test-1-...". Fast, no image decode.
//
//   B) CONTENT grouping — for phone uploads whose names are meaningless
//      (IMG_1898, IMG_1899, ...). We classify every image by PAGE CONTENT
//      using the same classifier the pipeline uses, then cut a new match at
//      each summary page. Filenames are never trusted to decide page type.
//
// Either way every group is sorted into canonical order:
//   Summary → Breakdown(s) → Scoreboard
// matching the user's requested review/processing order. The pipeline
// buckets by type internally, so this ordering is for humans + determinism,
// not correctness.
// ============================================================

interface MatchGroup {
  key: string // display key, e.g. "Test 1" (prefix) or "Match 1" (content)
  files: File[]
  /** How this group was formed — surfaced in the UI so grouping is auditable. */
  via: 'prefix' | 'content'
  /** Per-file page type (content mode only); used for canonical ordering + UI labels. */
  pageTypes?: PageType[]
}

/** Canonical order rank for a page type (summary → breakdown → scoreboard). */
const PAGE_TYPE_RANK: Record<string, number> = {
  summary: 0,
  breakdown: 1,
  scoreboard: 2,
  unknown: 3,
}

/**
 * Derive a match-grouping key from a filename, if one is present.
 * Accepts "Test 1", "Test_1", "Test-1", "match 04", etc. — a leading
 * word followed by a separator (space/underscore/hyphen, optional) and a
 * number. Case-insensitive. Returns null when no such label exists (e.g.
 * "IMG_1898" — IMG is a label but there's no match-number semantics we can
 * trust, so we treat camera-roll names as ungrouped → content mode).
 */
function prefixKeyForFilename(name: string): string | null {
  const base = name.replace(/\.[^.]+$/, '')
  // Exclude common camera-roll prefixes that look like <word><sep><number>
  // but are per-photo unique, not per-match labels. Note: underscore is a word
  // character, so we match the prefix followed by a separator or digit rather
  // than relying on a \b boundary (which doesn't exist in "IMG_1898").
  if (/^(IMG|DSC|PXL|DCIM|PHOTO|SCREENSHOT|SCRN)(?=[\s._-]*\d)/i.test(base)) {
    return null
  }
  const m = base.match(/^([A-Za-z]+)[\s._-]*(\d+)/)
  if (!m) return null
  // Normalise to "Word N" for display + stable grouping.
  const word = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  return `${word} ${parseInt(m[2], 10)}`
}

/** Page-type rank from a filename keyword (prefix mode ordering only). */
function pageRankFromName(name: string): number {
  const n = name.toLowerCase()
  if (n.includes('summary')) return PAGE_TYPE_RANK.summary
  if (n.includes('breakdown') || n.includes('hero')) return PAGE_TYPE_RANK.breakdown
  if (n.includes('scoreboard') || n.includes('teams') || n.includes('score')) {
    return PAGE_TYPE_RANK.scoreboard
  }
  return PAGE_TYPE_RANK.unknown
}

/** Best-effort page label from a filename, for the prefix-mode UI preview. */
function pageLabelFromName(name: string): PageType {
  const r = pageRankFromName(name)
  if (r === PAGE_TYPE_RANK.summary) return 'summary'
  if (r === PAGE_TYPE_RANK.breakdown) return 'breakdown'
  if (r === PAGE_TYPE_RANK.scoreboard) return 'scoreboard'
  return 'unknown'
}

/** Natural-ish sort so "Test 2" comes before "Test 10". */
function compareKeys(a: string, b: string): number {
  const na = a.match(/(\d+)/)
  const nb = b.match(/(\d+)/)
  if (na && nb) {
    const pa = a.slice(0, na.index)
    const pb = b.slice(0, nb.index)
    if (pa === pb) return parseInt(na[1], 10) - parseInt(nb[1], 10)
  }
  return a.localeCompare(b)
}

/**
 * STRATEGY A — prefix grouping. Returns null if filenames don't yield a
 * usable grouping (no labels, or every file lands in its own singleton —
 * which signals the names aren't real match labels and we should fall back
 * to content grouping instead of producing one-file "matches").
 */
function groupFilesByPrefix(files: File[]): MatchGroup[] | null {
  const map = new Map<string, File[]>()
  let labelled = 0
  for (const f of files) {
    const key = prefixKeyForFilename(f.name)
    if (key === null) continue
    labelled++
    const arr = map.get(key) ?? []
    arr.push(f)
    map.set(key, arr)
  }

  // Need most files labelled, and at least one real multi-file group. A real
  // match is always ≥2 pages (summary + scoreboard at minimum), so if EVERY
  // group is a singleton the filenames aren't match labels — they're per-photo
  // unique (camera roll). Fall back to content grouping in that case.
  if (labelled < files.length * 0.5) return null
  if (map.size === 0) return null
  const anyMulti = Array.from(map.values()).some((fs) => fs.length > 1)
  if (!anyMulti && files.length > 1) return null

  return Array.from(map.entries())
    .sort((a, b) => compareKeys(a[0], b[0]))
    .map(([key, fs]) => ({
      key,
      via: 'prefix' as const,
      files: fs
        .slice()
        .sort(
          (a, b) =>
            pageRankFromName(a.name) - pageRankFromName(b.name) ||
            a.name.localeCompare(b.name),
        ),
    }))
}

/**
 * STRATEGY B — content grouping (async; classifies each image's pixels).
 * Used for camera-roll uploads. Loads each file, classifies it via the
 * shared pipeline classifier, then groups by content with a summary page
 * starting each match. Each group is returned in canonical page order.
 */
async function groupFilesByContent(files: File[]): Promise<MatchGroup[]> {
  // Classify in capture/filename order so the summary→...→scoreboard
  // sequence within a match is respected when cutting groups.
  const ordered = files
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

  const classified: ClassifiedPhoto<File>[] = []
  for (const f of ordered) {
    const url = URL.createObjectURL(f)
    try {
      const img = await loadImageEl(url)
      const pageType = await classifyPageType(img)
      classified.push({ item: f, pageType })
    } catch {
      classified.push({ item: f, pageType: 'unknown' })
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const grouped = groupPhotosByContent(classified)
  return grouped.map((g, i) => ({
    key: `Match ${i + 1}`,
    via: 'content' as const,
    files: g.map((c) => c.item),
    pageTypes: g.map((c) => c.pageType),
  }))
}

/** Minimal image loader for classification (mirrors the pipeline's loader). */
function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load: ${url}`))
    img.src = url
  })
}

/**
 * Top-level grouping entry point. Tries prefix grouping first (cheap), and
 * falls back to content grouping (classifies pixels) when filenames don't
 * carry usable match labels — i.e. phone uploads.
 */
async function groupFiles(files: File[]): Promise<MatchGroup[]> {
  const byPrefix = groupFilesByPrefix(files)
  if (byPrefix) return byPrefix
  return groupFilesByContent(files)
}

// ============================================================
// PER-MATCH RESULT
// ============================================================

interface MatchTestResult {
  key: string
  filenames: string[]
  result: ProcessedMatch | null
  confidence: ParsedConfidence
  logs: CapturedLine[]
  processingMs: number
  error: string | null
}

// ============================================================
// CONFIDENCE HELPERS (shared by UI + report)
// ============================================================

function confTier(score: number): 'high' | 'mid' | 'low' {
  if (score >= 0.5) return 'high'
  if (score >= 0.35) return 'mid'
  return 'low'
}

const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`
const fmt4 = (v: number | null) => (v === null ? '—' : v.toFixed(4))

/** A correct-looking but fragile match: identified but low margin/score. */
function isFragile(score: number, margin: number | null): boolean {
  if (score < 0.35) return true
  if (margin !== null && margin < 0.05) return true
  return false
}

// ============================================================
// MARKDOWN REPORT
// ============================================================

function generateReport(
  testNumber: number,
  gamertag: string,
  results: MatchTestResult[],
): string {
  const date = new Date().toISOString().split('T')[0]
  const time = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })

  let md = `# Match Extraction — Test Report #${testNumber}\n\n`
  md += `**Date:** ${date} ${time}  \n`
  md += `**Gamertag:** ${gamertag || '—'}  \n`
  md += `**Matches tested:** ${results.length}  \n`
  md += `**Code path:** \`processMatchPhotos()\` (identical to production /process)\n\n`

  // ---- Overall roll-up ----
  const ok = results.filter((r) => r.result && !r.error)
  const totalMs = results.reduce((s, r) => s + r.processingMs, 0)
  const avgMs = results.length ? totalMs / results.length : 0
  md += `## Overall\n\n`
  md += `| Metric | Value |\n|--------|-------|\n`
  md += `| Matches processed | ${ok.length}/${results.length} |\n`
  md += `| Total time | ${(totalMs / 1000).toFixed(1)}s |\n`
  md += `| Avg time / match | ${(avgMs / 1000).toFixed(1)}s |\n`
  const allSb = results.flatMap((r) => r.confidence.scoreboard)
  const fragileSb = allSb.filter((p) => isFragile(p.score, p.margin)).length
  const disagreeSb = allSb.filter((p) => p.phase1Agrees === false).length
  md += `| Scoreboard portraits | ${allSb.length} |\n`
  md += `| — fragile (low score/margin) | ${fragileSb} |\n`
  md += `| — Phase-1 ≠ Pass-1 crop pick | ${disagreeSb} |\n\n`
  md += `> ⚠️ 6b watch-item: any "Phase-1 ≠ Pass-1" row is a slot where the cleanest-crop\n`
  md += `> pick disagreed with the final identification — review before trusting the swap.\n\n`
  md += `---\n\n`

  for (const r of results) {
    md += `## ${r.key}\n\n`
    md += `**Files:** ${r.filenames.join(', ')}  \n`
    md += `**Processing time:** ${(r.processingMs / 1000).toFixed(1)}s\n\n`

    if (r.error) {
      md += `> ❌ **Error:** ${r.error}\n\n---\n\n`
      continue
    }
    const res = r.result
    if (!res) {
      md += `> ⚠️ No result produced.\n\n---\n\n`
      continue
    }

    // ---- Match summary ----
    md += `### Match Summary\n\n`
    md += `| Field | Value |\n|-------|-------|\n`
    md += `| Map | ${res.mapName || '—'} |\n`
    md += `| Result | ${res.result?.toUpperCase() || '—'} |\n`
    md += `| Score | ${res.score || '—'} |\n`
    md += `| Format | ${res.matchFormat || '—'} |\n`
    md += `| E / A / D | ${res.eliminations ?? '—'} / ${res.assists ?? '—'} / ${res.deaths ?? '—'} |\n`
    md += `| Ally comp | ${res.allyComp || '—'} |\n`
    md += `| Enemy comp | ${res.enemyComp || '—'} |\n`
    if (res.correctedRole) md += `| Role auto-corrected → | ${res.correctedRole} |\n`
    md += `\n`

    // ---- Summary portrait confidence ----
    md += `### Summary Portrait Confidence\n\n`
    if (r.confidence.summary.length === 0 && res.heroes.length === 0) {
      md += `_No summary portraits detected._\n\n`
    } else {
      md += `| Slot | Hero | Score | Ring px | Flag |\n`
      md += `|------|------|-------|---------|------|\n`
      for (const s of r.confidence.summary) {
        const flag = isFragile(s.score, null) ? '⚠️ low' : ''
        md += `| ${s.slot} | ${s.hero} | ${fmtPct(s.score)} | ${s.ringPx ?? '—'} | ${flag} |\n`
      }
      // Heroes that ended up in the result (incl. OCR-sourced) for cross-check
      if (res.heroes.length > 0) {
        md += `\n_Heroes in result:_ ${res.heroes
          .map((h) => `${h.name} (${fmtPct(h.confidence)}, ${h.source})`)
          .join(', ')}\n`
      }
      md += `\n`
    }

    // ---- Breakdown portrait confidence ----
    md += `### Hero Breakdown Confidence\n\n`
    if (r.confidence.breakdown.length === 0 && res.heroBreakdowns.length === 0) {
      md += `_No breakdown pages._\n\n`
    } else {
      md += `| Hero | Portrait score | Assigned | Stats found |\n`
      md += `|------|----------------|----------|-------------|\n`
      for (const b of r.confidence.breakdown) {
        const bd = res.heroBreakdowns.find((x) => x.heroName === b.hero)
        const stats = bd ? `${bd.foundStatCount}/${bd.expectedStatCount}` : '—'
        const flag = isFragile(b.score, null) ? ' ⚠️' : ''
        md += `| ${b.hero}${flag} | ${fmtPct(b.score)} | ${b.assigned ? '✓' : '—'} | ${stats} |\n`
      }
      md += `\n`
    }

    // ---- Breakdown stat values (actual extracted stats, not just counts) ----
    if (res.heroBreakdowns.length > 0) {
      md += `### Hero Breakdown Stats\n\n`
      for (const bd of res.heroBreakdowns) {
        const pct = bd.percentPlayed != null ? `${bd.percentPlayed}%` : '—'
        const pt =
          bd.playTimeSeconds != null
            ? `${Math.floor(bd.playTimeSeconds / 60)}:${String(bd.playTimeSeconds % 60).padStart(2, '0')}`
            : '—'
        md += `**${bd.heroName}** — ${pct} played · ${pt} · ${bd.foundStatCount}/${bd.expectedStatCount} stats\n\n`
        if (bd.stats.length === 0) {
          md += `_No stats extracted._\n\n`
          continue
        }
        md += `| Stat | Value | Avg /10min |\n`
        md += `|------|-------|------------|\n`
        for (const s of bd.stats) {
          const unknown = s.statName.startsWith('UNKNOWN') ? ' ⚠️' : ''
          md += `| ${s.statName}${unknown} | ${s.statValue} | ${s.avgPer10Min ?? '—'} |\n`
        }
        md += `\n`
      }
    }

    // ---- Scoreboard portrait confidence (the headline table) ----
    md += `### Scoreboard Portrait Confidence\n\n`
    if (r.confidence.scoreboard.length === 0) {
      md += `_No scoreboard portraits parsed from logs._\n\n`
    } else {
      md += `| Slot | Team | Hero | Score | Margin | Runner-up | Crop | Phase-1 | Agree? | ORB | Flag |\n`
      md += `|------|------|------|-------|--------|-----------|------|---------|--------|-----|------|\n`
      for (const p of r.confidence.scoreboard) {
        const phase1 =
          p.phase1Hero != null
            ? `${p.phase1Hero} ${fmt4(p.phase1Score)}`
            : '—'
        const agree =
          p.phase1Agrees === null ? '—' : p.phase1Agrees ? '✓' : '✗'
        const flags: string[] = []
        if (isFragile(p.score, p.margin)) flags.push('fragile')
        if (p.phase1Agrees === false) flags.push('crop-disagree')
        if (p.roleCorrected) flags.push(`role→${p.roleCorrected}`)
        md += `| ${p.slot} | ${p.team ?? '—'} | ${p.hero} | ${fmtPct(p.score)} | ${fmt4(p.margin)} | ${p.runnerUp ?? '—'} | ${p.crop ?? '—'} | ${phase1} | ${agree} | ${p.orbApplied ? '✓' : '—'} | ${flags.join(', ')} |\n`
      }
      md += `\n`
    }

    // ---- Full scoreboard stats (mirrors MATCH SAVED) ----
    if (res.scoreboard) {
      const sb = res.scoreboard
      const rowsPerTeam = sb.detection.grid?.rowsPerTeam ?? 5
      const teamTable = (team: 'ally' | 'enemy') => {
        let t = `**${team === 'ally' ? 'Ally' : 'Enemy'} Team**\n\n`
        t += `| Player | Hero | Role | E | A | D | DMG | H | MIT |\n`
        t += `|--------|------|------|---|---|---|-----|---|-----|\n`
        for (const s of sb.stats.filter((x) => x.team === team)) {
          const player = sb.players.find((p) => p.slot === s.slot)
          const label = player?.isUser
            ? `**${player.displayName}**`
            : player?.displayName ||
              `${team === 'ally' ? 'Ally' : 'Enemy'} ${team === 'ally' ? s.slot : s.slot - rowsPerTeam}`
          t += `| ${label} | ${s.heroName || '—'} | ${s.role || '—'} | ${s.eliminations ?? '—'} | ${s.assists ?? '—'} | ${s.deaths ?? '—'} | ${s.damage?.toLocaleString() ?? '—'} | ${s.healing?.toLocaleString() ?? '—'} | ${s.mitigation?.toLocaleString() ?? '—'} |\n`
        }
        return t + '\n'
      }
      md += `### Scoreboard Stats\n\n`
      md += teamTable('ally')
      md += teamTable('enemy')
    }

    // ---- Raw console log (full, per user request) ----
    md += `### Raw Console Log\n\n`
    md += '```\n'
    for (const l of r.logs) {
      const prefix = l.level === 'log' ? '' : `[${l.level.toUpperCase()}] `
      md += `${prefix}${l.text}\n`
    }
    md += '```\n\n'
    md += `---\n\n`
  }

  return md
}

// ============================================================
// UI — CONFIDENCE BADGE
// ============================================================

function ConfBadge({ score, margin }: { score: number; margin?: number | null }) {
  const tier = confTier(score)
  const cls =
    tier === 'high'
      ? 'text-ow-victory'
      : tier === 'mid'
        ? 'text-ow-orange'
        : 'text-ow-defeat'
  const fragile = isFragile(score, margin ?? null)
  return (
    <span className={`font-mono ${cls}`}>
      {fmtPct(score)}
      {fragile && <span className="ml-1 text-ow-defeat" title="fragile match">⚠</span>}
    </span>
  )
}

// ============================================================
// UI — RESULT CARD
// ============================================================

function ResultCard({ r }: { r: MatchTestResult }) {
  const [showLog, setShowLog] = useState(false)
  const res = r.result

  return (
    <div className="bg-ow-panel rounded-lg border border-white/5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <span className="text-white font-display font-bold">{r.key}</span>
          {res?.matchFormat && (
            <span className="text-[10px] font-display font-bold px-1.5 py-0.5 rounded bg-ow-orange/10 text-ow-orange">
              {res.matchFormat.toUpperCase()}
            </span>
          )}
          {r.error && (
            <span className="text-[10px] font-display font-bold px-1.5 py-0.5 rounded bg-ow-defeat/15 text-ow-defeat">
              ERROR
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500 font-display">
          {(r.processingMs / 1000).toFixed(1)}s · {r.filenames.length} files
        </span>
      </div>

      {r.error ? (
        <div className="px-5 py-4">
          <p className="text-sm text-ow-defeat">{r.error}</p>
        </div>
      ) : res ? (
        <div className="p-5 space-y-5">
          {/* Match summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">Map</p>
              <p className="text-white font-display text-sm">{res.mapName || '—'}</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">Result</p>
              <p
                className={`font-display font-bold text-sm ${
                  res.result === 'victory'
                    ? 'text-ow-victory'
                    : res.result === 'defeat'
                      ? 'text-ow-defeat'
                      : 'text-slate-300'
                }`}
              >
                {res.result?.toUpperCase() || '—'}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">Score</p>
              <p className="text-white font-display text-sm">{res.score || '—'}</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">E / A / D</p>
              <p className="text-white font-display text-sm">
                {res.eliminations ?? '—'} / {res.assists ?? '—'} / {res.deaths ?? '—'}
              </p>
            </div>
          </div>

          {(res.allyComp || res.enemyComp) && (
            <div className="flex gap-4 text-xs font-display">
              {res.allyComp && (
                <span className="text-blue-400">
                  Ally <span className="text-white font-bold">{res.allyComp}</span>
                </span>
              )}
              {res.enemyComp && (
                <span className="text-red-400">
                  Enemy <span className="text-white font-bold">{res.enemyComp}</span>
                </span>
              )}
              {res.correctedRole && (
                <span className="text-ow-orange">
                  role auto-corrected → <span className="font-bold">{res.correctedRole}</span>
                </span>
              )}
            </div>
          )}

          {/* Summary portrait confidence */}
          {r.confidence.summary.length > 0 && (
            <div>
              <p className="text-[10px] text-slate-400 font-display tracking-wider uppercase mb-2">
                Summary Portraits
              </p>
              <div className="flex flex-wrap gap-2">
                {r.confidence.summary.map((s) => (
                  <span
                    key={s.slot}
                    className="bg-ow-dark rounded px-2.5 py-1 text-xs border border-white/5"
                  >
                    <span className="text-slate-300">{s.hero}</span>{' '}
                    <ConfBadge score={s.score} />
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Breakdown portrait confidence */}
          {r.confidence.breakdown.length > 0 && (
            <div>
              <p className="text-[10px] text-slate-400 font-display tracking-wider uppercase mb-2">
                Hero Breakdown Portraits
              </p>
              <div className="flex flex-wrap gap-2">
                {r.confidence.breakdown.map((b) => {
                  const bd = res.heroBreakdowns.find((x) => x.heroName === b.hero)
                  return (
                    <span
                      key={b.hero}
                      className="bg-ow-dark rounded px-2.5 py-1 text-xs border border-white/5"
                    >
                      <span className="text-slate-300">{b.hero}</span>{' '}
                      <ConfBadge score={b.score} />
                      {bd && (
                        <span className="text-slate-500 ml-1">
                          {bd.foundStatCount}/{bd.expectedStatCount}
                        </span>
                      )}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Scoreboard portrait confidence — the headline table */}
          {r.confidence.scoreboard.length > 0 && (
            <div>
              <p className="text-[10px] text-slate-400 font-display tracking-wider uppercase mb-2">
                Scoreboard Portraits
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                      <th className="text-left py-1.5 px-2">Slot</th>
                      <th className="text-left py-1.5 px-2">Team</th>
                      <th className="text-left py-1.5 px-2">Hero</th>
                      <th className="text-right py-1.5 px-2">Score</th>
                      <th className="text-right py-1.5 px-2">Margin</th>
                      <th className="text-left py-1.5 px-2">Runner-up</th>
                      <th className="text-center py-1.5 px-2">Crop</th>
                      <th className="text-left py-1.5 px-2">Phase-1</th>
                      <th className="text-center py-1.5 px-2">Agree</th>
                      <th className="text-center py-1.5 px-2">ORB</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.confidence.scoreboard.map((p) => (
                      <tr
                        key={p.slot}
                        className={`border-b border-white/5 ${
                          p.phase1Agrees === false ? 'bg-ow-defeat/5' : ''
                        }`}
                      >
                        <td className="py-1.5 px-2 font-mono text-slate-500">{p.slot}</td>
                        <td
                          className={`py-1.5 px-2 ${
                            p.team === 'ally'
                              ? 'text-blue-300'
                              : p.team === 'enemy'
                                ? 'text-red-300'
                                : 'text-slate-500'
                          }`}
                        >
                          {p.team ?? '—'}
                        </td>
                        <td className="py-1.5 px-2 text-slate-200">{p.hero}</td>
                        <td className="py-1.5 px-2 text-right">
                          <ConfBadge score={p.score} margin={p.margin} />
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-slate-400">
                          {fmt4(p.margin)}
                        </td>
                        <td className="py-1.5 px-2 text-slate-500">{p.runnerUp ?? '—'}</td>
                        <td className="py-1.5 px-2 text-center font-mono text-slate-400">
                          {p.crop ?? '—'}
                        </td>
                        <td className="py-1.5 px-2 font-mono text-slate-500">
                          {p.phase1Hero ? `${p.phase1Hero} ${fmt4(p.phase1Score)}` : '—'}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          {p.phase1Agrees === null ? (
                            <span className="text-slate-600">—</span>
                          ) : p.phase1Agrees ? (
                            <span className="text-ow-victory">✓</span>
                          ) : (
                            <span className="text-ow-defeat">✗</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          {p.orbApplied ? (
                            <span className="text-ow-orange">✓</span>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Scoreboard stats (mirrors MATCH SAVED) */}
          {res.scoreboard && <ScoreboardStats sb={res.scoreboard} />}

          {/* Raw log toggle */}
          <div>
            <button
              onClick={() => setShowLog((v) => !v)}
              className="text-xs text-slate-400 hover:text-slate-200 font-display"
            >
              {showLog ? '▼' : '▶'} Raw console log ({r.logs.length} lines)
            </button>
            {showLog && (
              <pre className="mt-2 bg-ow-dark rounded-lg p-3 text-[10px] leading-relaxed text-slate-400 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
                {r.logs
                  .map(
                    (l) =>
                      (l.level === 'log' ? '' : `[${l.level.toUpperCase()}] `) +
                      l.text,
                  )
                  .join('\n')}
              </pre>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ScoreboardStats({
  sb,
}: {
  sb: NonNullable<ProcessedMatch['scoreboard']>
}) {
  const rowsPerTeam = sb.detection.grid?.rowsPerTeam ?? 5
  const Team = ({ team }: { team: 'ally' | 'enemy' }) => (
    <div>
      <p
        className={`text-[10px] font-display tracking-wider uppercase mb-2 ${
          team === 'ally' ? 'text-blue-400' : 'text-red-400'
        }`}
      >
        {team === 'ally' ? 'Ally' : 'Enemy'} Team
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
              <th className="text-left py-1 px-2">Player</th>
              <th className="text-left py-1 px-2">Hero</th>
              <th className="text-left py-1 px-2">Role</th>
              <th className="text-right py-1 px-2">E</th>
              <th className="text-right py-1 px-2">A</th>
              <th className="text-right py-1 px-2">D</th>
              <th className="text-right py-1 px-2">DMG</th>
              <th className="text-right py-1 px-2">H</th>
              <th className="text-right py-1 px-2">MIT</th>
            </tr>
          </thead>
          <tbody>
            {sb.stats
              .filter((s) => s.team === team)
              .map((s) => {
                const player = sb.players.find((p) => p.slot === s.slot)
                return (
                  <tr
                    key={s.slot}
                    className={`border-b border-white/5 ${player?.isUser ? 'bg-ow-orange/5' : ''}`}
                  >
                    <td
                      className={`py-1.5 px-2 font-display ${player?.isUser ? 'text-ow-orange font-bold' : 'text-slate-300'}`}
                    >
                      {player?.displayName ||
                        `${team === 'ally' ? 'Ally' : 'Enemy'} ${team === 'ally' ? s.slot : s.slot - rowsPerTeam}`}
                    </td>
                    <td className="py-1.5 px-2 text-slate-300">{s.heroName || '—'}</td>
                    <td
                      className={`py-1.5 px-2 uppercase font-display text-[10px] font-bold ${
                        s.role === 'tank'
                          ? 'text-blue-300'
                          : s.role === 'dps'
                            ? 'text-red-300'
                            : s.role === 'support'
                              ? 'text-green-300'
                              : 'text-slate-600'
                      }`}
                    >
                      {s.role || '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.eliminations ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.assists ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.deaths ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.damage?.toLocaleString() ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.healing?.toLocaleString() ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.mitigation?.toLocaleString() ?? '—'}</td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>
    </div>
  )
  return (
    <div className="space-y-4">
      <Team team="ally" />
      <Team team="enemy" />
    </div>
  )
}

// ============================================================
// MAIN PAGE
// ============================================================

export default function TestingPage() {
  const [groups, setGroups] = useState<MatchGroup[]>([])
  const [grouping, setGrouping] = useState(false)
  const [results, setResults] = useState<MatchTestResult[]>([])
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState('')
  const [currentStatus, setCurrentStatus] = useState<ProcessingStatus | null>(null)
  const [testNumber, setTestNumber] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [gamertag, setGamertag] = useState('PyroEagles')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    setResults([])
    setError(null)
    setGroups([])
    setGrouping(true)
    try {
      // Content grouping may decode images to classify them; prefix grouping
      // resolves instantly. Either way we await the unified entry point.
      const g = await groupFiles(imageFiles)
      setGroups(g)
      if (g.length === 0) {
        setError('No matches could be formed from the selected images.')
      }
    } catch (err: any) {
      setError(`Grouping failed: ${err?.message || String(err)}`)
    } finally {
      setGrouping(false)
    }
  }, [])

  const processAll = useCallback(async () => {
    if (groups.length === 0) return
    setProcessing(true)
    setError(null)
    setResults([])

    const collected: MatchTestResult[] = []

    // Sequential — never overlap two runs (keeps captured logs + timings clean).
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi]
      setProgress(`Processing match ${gi + 1}/${groups.length}: ${group.key}`)

      const logs: CapturedLine[] = []
      const urls: string[] = []
      const start = Date.now()
      let res: ProcessedMatch | null = null
      let errMsg: string | null = null

      const restore = installConsoleCapture(logs)
      try {
        for (const f of group.files) urls.push(URL.createObjectURL(f))
        // Same call signature the production /process page uses.
        // No role filter (lets the auto-correct path exercise + surface).
        res = await processMatchPhotos(
          urls,
          (status) => setCurrentStatus(status),
          undefined,
          gamertag || undefined,
        )
      } catch (err: any) {
        errMsg = err?.message || String(err)
      } finally {
        restore()
        for (const u of urls) URL.revokeObjectURL(u)
      }

      const elapsed = Date.now() - start
      const confidence = parseConfidence(logs)

      const matchResult: MatchTestResult = {
        key: group.key,
        filenames: group.files.map((f) => f.name),
        result: res,
        confidence,
        logs,
        processingMs: res?.processingTimeMs ?? elapsed,
        error: errMsg,
      }
      collected.push(matchResult)
      setResults([...collected]) // progressive display
    }

    setProcessing(false)
    setProgress('')
    setCurrentStatus(null)
    if (fileRef.current) fileRef.current.value = ''
  }, [groups, gamertag])

  const downloadReport = useCallback(() => {
    const md = generateReport(testNumber, gamertag, results)
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `match-test-${testNumber}-${new Date().toISOString().split('T')[0]}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [testNumber, gamertag, results])

  const startNewTest = useCallback(() => {
    setTestNumber((n) => n + 1)
    setResults([])
    setGroups([])
    setError(null)
  }, [])

  // Roll-up stats
  const done = results.filter((r) => r.result && !r.error).length
  const totalMs = results.reduce((s, r) => s + r.processingMs, 0)
  const avgMs = results.length ? totalMs / results.length : 0
  const allSb = results.flatMap((r) => r.confidence.scoreboard)
  const fragile = allSb.filter((p) => isFragile(p.score, p.margin)).length
  const disagree = allSb.filter((p) => p.phase1Agrees === false).length

  return (
    <div className="min-h-screen bg-ow-dark text-white p-4 sm:p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl text-ow-orange font-display font-bold">
            Match Extraction — Testing
          </h1>
          <span className="text-xs font-mono text-slate-500 bg-ow-panel px-2 py-0.5 rounded">
            Test #{testNumber}
          </span>
        </div>
        <p className="text-xs text-slate-500 -mt-4">
          Calls <code className="text-slate-400">processMatchPhotos()</code> — the same code path
          as production. Files are grouped into matches by <code className="text-slate-400">Test_&lt;N&gt;_</code> prefix.
        </p>

        {/* Gamertag */}
        <div>
          <label className="text-[10px] uppercase tracking-wider text-slate-500 mb-1 block">
            Gamertag
          </label>
          <input
            type="text"
            value={gamertag}
            onChange={(e) => setGamertag(e.target.value)}
            placeholder="Enter gamertag..."
            disabled={processing}
            className="w-full sm:w-72 bg-ow-panel border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-ow-orange/40 focus:outline-none disabled:opacity-50"
          />
        </div>

        {/* Upload */}
        <div className="border border-dashed border-white/10 rounded-xl p-5 text-center hover:border-ow-orange/30 transition-colors">
          <p className="text-sm text-slate-400 mb-3">
            Select all screenshots for one or more matches (summary, breakdown(s), scoreboard).
          </p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*"
            onChange={handleFiles}
            disabled={processing}
            className="text-sm text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-ow-panel file:text-slate-300 hover:file:bg-white/5 file:cursor-pointer disabled:opacity-50"
          />
        </div>

        {/* Grouping in progress (content classification can decode images) */}
        {grouping && (
          <div className="bg-ow-orange/10 border border-ow-orange/30 rounded-lg p-4 flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-ow-orange border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <p className="text-sm text-ow-orange">Grouping screenshots into matches…</p>
          </div>
        )}

        {/* Detected groups preview */}
        {!grouping && groups.length > 0 && results.length === 0 && (
          <div className="bg-ow-panel rounded-lg border border-white/5 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-ow-orange font-display font-bold text-sm">
                {groups.length} MATCH{groups.length !== 1 ? 'ES' : ''} DETECTED
                <span className="ml-2 text-[10px] font-mono text-slate-500">
                  via {groups[0]?.via === 'content' ? 'page-content' : 'filename'} grouping
                </span>
              </p>
              <button
                onClick={processAll}
                disabled={processing}
                className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold px-4 py-2 rounded-lg tracking-wider text-xs transition-colors disabled:opacity-50"
              >
                PROCESS ALL
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Review grouping below before processing. Each group → one processMatchPhotos() call,
              ordered summary → breakdown(s) → scoreboard.
            </p>
            <div className="space-y-2">
              {groups.map((g) => (
                <div key={g.key} className="bg-ow-dark rounded px-3 py-2 border border-white/5">
                  <p className="text-sm text-white font-display">{g.key}</p>
                  <div className="mt-1 space-y-0.5">
                    {g.files.map((f, i) => (
                      <p key={f.name} className="text-[11px] text-slate-500 flex gap-2">
                        <span className="inline-block w-20 shrink-0 uppercase tracking-wide text-slate-600">
                          {g.pageTypes?.[i] ?? pageLabelFromName(f.name)}
                        </span>
                        <span className="truncate">{f.name}</span>
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Processing indicator */}
        {processing && (
          <div className="bg-ow-orange/10 border border-ow-orange/30 rounded-lg p-4 flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-ow-orange border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-ow-orange">{progress}</p>
              {currentStatus && (
                <div className="mt-2 bg-ow-dark rounded-full h-1.5 overflow-hidden max-w-xs">
                  <div
                    className="h-full bg-ow-orange transition-all duration-300 rounded-full"
                    style={{ width: `${currentStatus.progress}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="bg-ow-defeat/10 border border-ow-defeat/30 rounded-lg p-3">
            <p className="text-sm text-ow-defeat">{error}</p>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <>
            {/* Roll-up bar */}
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {[
                { label: 'Matches', value: `${done}/${groups.length}` },
                { label: 'Total', value: `${(totalMs / 1000).toFixed(0)}s` },
                { label: 'Avg/match', value: `${(avgMs / 1000).toFixed(1)}s` },
                { label: 'Fragile', value: `${fragile}`, bad: fragile > 0 },
                { label: 'Crop disagree', value: `${disagree}`, bad: disagree > 0 },
              ].map((item, i) => (
                <div key={i} className="bg-ow-panel border border-white/5 rounded-lg p-3 text-center">
                  <p
                    className={`text-lg font-bold font-mono ${
                      item.bad === undefined
                        ? 'text-slate-200'
                        : item.bad
                          ? 'text-ow-defeat'
                          : 'text-ow-victory'
                    }`}
                  >
                    {item.value}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">{item.label}</p>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <button
                onClick={downloadReport}
                disabled={processing}
                className="bg-ow-orange hover:bg-ow-accent text-ow-dark text-sm px-4 py-2 rounded-lg font-display font-bold tracking-wider transition-colors disabled:opacity-50"
              >
                DOWNLOAD REPORT (.md)
              </button>
              <button
                onClick={startNewTest}
                disabled={processing}
                className="bg-ow-panel border border-white/10 text-slate-300 text-sm px-4 py-2 rounded-lg font-display tracking-wider hover:border-ow-orange/30 transition-colors disabled:opacity-50"
              >
                NEW TEST (#{testNumber + 1})
              </button>
            </div>

            {/* Cards */}
            <div className="space-y-4">
              {results.map((r) => (
                <ResultCard key={r.key} r={r} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
