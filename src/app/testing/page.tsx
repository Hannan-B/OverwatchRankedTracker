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

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import {
  processMatchPhotos,
  classifyPageType,
  groupPhotosByContent,
  type ProcessedMatch,
  type ProcessingStatus,
  type PageType,
  type ClassifiedPhoto,
} from '@/lib/image-processor'
import {
  computeMatchReadiness,
  generateHeroRoleRefSql,
  generateNormaliseClausesForHero,
  type HeroReadiness,
  type MatchReadiness,
} from '@/lib/new-content-readiness'
import { SCOREBOARD_ROLE_HERO_NAMES } from '@/lib/scoreboard-extractor'
import { findMapName } from '@/lib/ocr-extractor'
import { fingerprintSession } from '@/lib/session-fingerprint'
import { groupSession } from '@/lib/session-grouper'
import { sessionExtraHeroes } from '@/lib/session-match'

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

/** Per-match ORB worker health, parsed from the Pass-2 summary line. */
interface OrbHealth {
  ok: number
  failed: number
  fallbacks: number
  restarts: number
  disabled: boolean
}

/** (v1.1.3) Icon-classifier accuracy for one match.
 *
 *  overrideRolesFromHeroes() rewrites every role to the identified hero's own
 *  role, so by the time anything downstream looks, role and hero agree BY
 *  CONSTRUCTION and the agreement means nothing. This is the only place the
 *  icon classifier's real hit-rate is visible. */
interface IconRoleAccuracy {
  agreed: number
  total: number
  overridden: number
  noIcon: number
}

interface ParsedConfidence {
  scoreboard: ScoreboardPortraitConfidence[]
  summary: SummaryPortraitConfidence[]
  breakdown: BreakdownPortraitConfidence[]
  /** null when the match produced no Pass-2 block at all. */
  orbHealth: OrbHealth | null
  /** null on builds before v1.1.3, which did not emit the line. */
  iconRole: IconRoleAccuracy | null
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

// --- ORB worker health (emitted once per match after Pass 2) ---
//   Step 2 Pass 2 complete: ORB HEALTH ok=1204 failed=0 fallbacks=0 restarts=0 disabled=false
const ORB_HEALTH_RE =
  /ORB HEALTH\s+ok=(\d+)\s+failed=(\d+)\s+fallbacks=(\d+)\s+restarts=(\d+)\s+disabled=(true|false)/

// --- Icon role accuracy (v1.1.3, emitted once per match) ---
//   ICON ROLE ACCURACY: 8/10 agreed, 2 overridden, 0 no-icon
const ICON_ROLE_RE =
  /ICON ROLE ACCURACY:\s+(\d+)\/(\d+)\s+agreed,\s+(\d+)\s+overridden,\s+(\d+)\s+no-icon/

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
  let orbHealth: OrbHealth | null = null
  let iconRole: IconRoleAccuracy | null = null

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

    // Icon role accuracy
    const ir = text.match(ICON_ROLE_RE)
    if (ir) {
      iconRole = {
        agreed: parseInt(ir[1], 10),
        total: parseInt(ir[2], 10),
        overridden: parseInt(ir[3], 10),
        noIcon: parseInt(ir[4], 10),
      }
      continue
    }

    // ORB worker health
    const oh = text.match(ORB_HEALTH_RE)
    if (oh) {
      orbHealth = {
        ok: parseInt(oh[1], 10),
        failed: parseInt(oh[2], 10),
        fallbacks: parseInt(oh[3], 10),
        restarts: parseInt(oh[4], 10),
        disabled: oh[5] === 'true',
      }
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
    orbHealth,
    iconRole,
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
  /** Session mode: heroes beyond the Summary's top 3, from the sidebar. */
  extraHeroes?: string[]
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

/** Blob URLs a processed match keeps for on-screen display (summary, each hero
 *  breakdown, scoreboard). These must NOT be revoked until the result card is
 *  removed, or the <img> tags fail with "WebKitBlobResource error 1". */
function displayedImageUrls(res: ProcessedMatch | null): string[] {
  if (!res) return []
  const urls: string[] = []
  if (res.summaryImageUrl) urls.push(res.summaryImageUrl)
  for (const bd of res.heroBreakdowns) if (bd.imageUrl) urls.push(bd.imageUrl)
  if (res.scoreboard?.imageUrl) urls.push(res.scoreboard.imageUrl)
  return urls
}

/** Revoke the displayed blob URLs across a set of results (called when results
 *  are cleared, e.g. starting a new test), so the kept screenshots don't leak. */
function revokeResultImageUrls(results: MatchTestResult[]): void {
  for (const r of results) {
    for (const u of displayedImageUrls(r.result)) {
      try { URL.revokeObjectURL(u) } catch { /* already revoked */ }
    }
  }
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
/** ⚠️ (v1.1.3) THE 0.35 THRESHOLD IS CALIBRATED ON THE PASS-1 SCALE ONLY.
 *
 *  Pass-2 rows carry an ORB-scale score, and this applies the same number to
 *  both. So an ORB row at 0.36 counts as healthy while a Pass-1 row at 0.34
 *  counts as fragile, and the two are not comparable quantities.
 *
 *  Left UNCHANGED on purpose. Picking a second threshold would mean inventing a
 *  number with nothing to calibrate it against, which is how AUTO_CORRECT_MIN_LEAD
 *  went in at 0.05 and had to be re-derived from 87 logged decisions. The
 *  Overall table now reports the two populations separately so the mixture is at
 *  least visible; calibrate an ORB threshold from logged data before changing
 *  anything here. */
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
  // (v1.1.3) Split by scale. A single mean over both is meaningless, and the
  // fragile count silently mixes them too — see the isFragile note below.
  const p1 = allSb.filter((p) => !p.orbApplied)
  const orb = allSb.filter((p) => p.orbApplied)
  const meanOf = (xs: ScoreboardPortraitConfidence[]) =>
    xs.length === 0 ? '—' : `${((xs.reduce((a, x) => a + x.score, 0) / xs.length) * 100).toFixed(1)}%`
  md += `| Scoreboard portraits | ${allSb.length} |\n`
  md += `| — scored on Pass-1 scale | ${p1.length} (mean ${meanOf(p1)}) |\n`
  md += `| — scored on ORB scale | ${orb.length} (mean ${meanOf(orb)}) |\n`
  md += `| — fragile (low score/margin) | ${fragileSb} |\n`
  md += `| — Phase-1 ≠ Pass-1 crop pick | ${disagreeSb} |\n\n`

  // ---- Icon-classifier accuracy (v1.1.3) ----
  const irs = results.map((r) => r.confidence.iconRole).filter((x): x is IconRoleAccuracy => x != null)
  if (irs.length > 0) {
    const tot = irs.reduce((a, x) => a + x.total, 0)
    const agreed = irs.reduce((a, x) => a + x.agreed, 0)
    const over = irs.reduce((a, x) => a + x.overridden, 0)
    const none = irs.reduce((a, x) => a + x.noIcon, 0)
    md += `| Icon role agreed with hero | ${agreed}/${tot} (${((agreed / Math.max(tot, 1)) * 100).toFixed(1)}%) |\n`
    md += `| — overridden by hero lookup | ${over} |\n`
    md += `| — no icon found | ${none} |\n\n`
    md += `> Icon accuracy is otherwise INVISIBLE: overrideRolesFromHeroes() rewrites\n`
    md += `> every role to the identified hero's own role, after which role and hero\n`
    md += `> agree by construction. An override is the icon classifier being wrong OR\n`
    md += `> the portrait matcher being wrong — it cannot distinguish them, but a\n`
    md += `> rising count means one of the two is degrading.\n\n`
  } else {
    md += `> ⚠️ No ICON ROLE ACCURACY lines found. Either this build predates v1.1.3\n`
    md += `> or the log line stopped being emitted — the same failure that left the\n`
    md += `> ORB counters reading 0 on every run until v1.1.3.\n\n`
  }

  // ---- ORB health roll-up ----
  // A run where ORB died partway through is two different algorithms reported
  // as one. That must be the first thing visible in the report, not something
  // reconstructed from the raw console log weeks later.
  const healths = results
    .map((r) => r.confidence.orbHealth)
    .filter((h): h is OrbHealth => h != null)
  // ok / failed / restarts are SESSION-CUMULATIVE counters from opencv-loader:
  // each match reports the running total, so summing them across matches
  // multiplies the figure. Take the last match's value instead.
  // fallbacks IS per-match (reset by resetOrbFailureCount) and must be summed.
  const orbFallbacks = healths.reduce((s, h) => s + h.fallbacks, 0)
  const last = healths.length > 0 ? healths[healths.length - 1] : null
  const orbRestarts = last?.restarts ?? 0
  const orbFailedCalls = last?.failed ?? 0
  const orbOkCalls = last?.ok ?? 0
  const orbDisabled = healths.some((h) => h.disabled)
  const degradedMatches = results.filter(
    (r) => (r.confidence.orbHealth?.fallbacks ?? 0) > 0 || r.confidence.orbHealth?.disabled === true,
  ).length
  md += `| ORB calls (ok / failed) | ${orbOkCalls} / ${orbFailedCalls} |\n`
  md += `| ORB fallbacks (structural+colour only) | ${orbFallbacks} |\n`
  md += `| ORB worker restarts | ${orbRestarts} |\n`
  md += `| Matches with degraded ORB | ${degradedMatches}/${results.length} |\n\n`

  if (orbFallbacks > 0 || orbDisabled || orbRestarts > 0) {
    md += `> 🛑 **THIS RUN IS NOT A SINGLE CONFIGURATION.** ${orbFallbacks} portrait\n`
    md += `> comparison(s) across ${degradedMatches} match(es) fell back to structural+colour\n`
    md += `> because ORB was unavailable, while the Score column still reports the ORB scale.\n`
    md += `> Degraded scores are roughly HALF the healthy ones and are not comparable.\n`
    md += `> Fix the worker and re-run before drawing any conclusion from this report.\n\n`
  } else if (healths.length > 0) {
    md += `> ✅ ORB healthy across all matches (${orbOkCalls} successful calls, 0 fallbacks).\n\n`
  }

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
      // ⚠️ (v1.1.3) SCALE is not decoration. Pass 1 scores on
      // 0.6*structural + 0.4*colour; Pass 2 rescores the same slot on
      // 0.5*orb + 0.3*structural + 0.2*colour and OVERWRITES confidence and
      // margin with it. scoreboard-extractor says outright that the two must
      // never be pooled — and until now this table put them in one column with
      // only a ✓ to tell them apart.
      //
      // That is not hypothetical. Between test runs #1 and #2 three slots
      // appeared to collapse (margin 0.29 -> 0.06, 0.29 -> 0.07, 0.23 -> 0.03).
      // Nothing had degraded: a 1px table shift nudged each one's Pass-1 score
      // just over ORB_THRESHOLD, so it skipped Pass 2 and was printed on the
      // other ruler. Same hero, different scale, and an evening lost to it.
      md += `| Slot | Team | Hero | Scale | Score | Margin | Runner-up | Crop | Phase-1 | Agree? | Flag |\n`
      md += `|------|------|------|-------|-------|--------|-----------|------|---------|--------|------|\n`
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
        const scale = p.orbApplied ? 'ORB' : 'P1'
        md += `| ${p.slot} | ${p.team ?? '—'} | ${p.hero} | ${scale} | ${fmtPct(p.score)} | ${fmt4(p.margin)} | ${p.runnerUp ?? '—'} | ${p.crop ?? '—'} | ${phase1} | ${agree} | ${flags.join(', ')} |\n`
      }
      md += `\n`
      md += `> **Scale column:** \`P1\` and \`ORB\` rows are scored by DIFFERENT formulas.\n`
      md += `> Never average, sort, threshold or compare Score/Margin across the two.\n`
      md += `> A slot moving between scales between runs changes its number by ~10 points\n`
      md += `> with nothing whatsoever wrong.\n\n`
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

// ============================================================
// ENLARGEABLE SOURCE IMAGE  (click thumbnail → fit-to-screen overlay)
// Mirrors the /process ConfirmationCard lightbox behaviour: click to enlarge,
// close on backdrop / Escape / X, background scroll locked, click-image-to-keep.
// ============================================================

function EnlargeableImage({ src, label }: { src: string; label: string }) {
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    if (!zoomed) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setZoomed(false)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [zoomed])

  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        aria-label={`Enlarge ${label}`}
        title="Click to enlarge"
        className="relative block w-full rounded overflow-hidden bg-ow-dark border border-ow-line cursor-zoom-in group"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={label} className="w-full object-contain max-h-64" />
        <span className="absolute bottom-1 right-1 text-[10px] font-display tracking-wider px-1.5 py-0.5 rounded bg-black/60 text-slate-200 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          CLICK TO ENLARGE
        </span>
      </button>
      {zoomed && (
        <div
          onClick={() => setZoomed(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
        >
          <button
            onClick={() => setZoomed(false)}
            aria-label="Close enlarged image"
            className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-ow-panel/80 hover:bg-ow-panel text-ow-fg border border-ow-line text-xl leading-none transition-colors"
          >
            {'\u2715'}
          </button>
          <div onClick={(e) => e.stopPropagation()} className="relative inline-block max-w-full max-h-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={`${label} enlarged`} className="block max-w-full max-h-[88vh] object-contain rounded" />
          </div>
        </div>
      )}
    </>
  )
}

// ============================================================
// NEW-CONTENT READINESS PANEL
// Shows whether every hero/map in this match is fully wired up; for anything
// new, lists exactly what's missing + generates the Supabase SQL to paste.
// ============================================================

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => { setCopied(true); setTimeout(() => setCopied(false), 1500) },
          () => {},
        )
      }}
      className="text-[10px] font-display tracking-wider px-2 py-1 rounded bg-ow-dark border border-ow-line text-ow-muted hover:border-ow-orange/40 transition-colors"
    >
      {copied ? '\u2713 COPIED' : label}
    </button>
  )
}

function Check({ ok }: { ok: boolean }) {
  return ok
    ? <span className="text-ow-victory">{'\u2713'}</span>
    : <span className="text-ow-defeat font-bold">{'\u2717'}</span>
}

function HeroReadinessRow({ h }: { h: HeroReadiness }) {
  const fmtColor: Record<string, string> = {
    percent: 'text-ow-orange',
    time: 'text-blue-300',
    number: 'text-ow-muted',
  }
  const normaliseClauses = h.unknownStatNames.length > 0
    ? generateNormaliseClausesForHero(h)
    : []
  return (
    <div className="bg-ow-dark rounded border border-ow-line p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-display font-bold text-ow-fg">{h.heroName}</span>
        <span className="text-[10px] text-ow-faint uppercase tracking-wider">
          seen on {h.seenOn.join(' + ')}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5"><Check ok={h.inHeroes} /> <span className="text-ow-muted">HEROES list</span></span>
        <span className="flex items-center gap-1.5"><Check ok={h.inScoreboardRoleMap} /> <span className="text-ow-muted">Scoreboard role</span></span>
        <span className="flex items-center gap-1.5"><Check ok={h.inBreakdownOrder} /> <span className="text-ow-muted">Breakdown order</span></span>
        <span className="flex items-center gap-1.5"><Check ok={h.inCatalog} /> <span className="text-ow-muted">Stat catalog</span></span>
      </div>

      {/* Resolved stat formats */}
      {h.statResolutions.length > 0 && (
        <div className="pt-1">
          <p className="text-[10px] text-ow-faint uppercase tracking-wider mb-1">Breakdown stats (resolved format)</p>
          <div className="flex flex-wrap gap-1.5">
            {h.statResolutions.map((s) => (
              <span key={s.raw} className="text-[11px] bg-ow-panel rounded px-2 py-0.5 border border-ow-line">
                <span className="text-ow-fg">{s.canonical}</span>{' '}
                <span className={fmtColor[s.format] ?? 'text-ow-muted'}>{s.format}</span>
                {!s.known && <span className="text-ow-defeat ml-1" title="Not recognised — needs registering">{'\u26a0'}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Generated SQL for a hero missing its DB role */}
      {!h.inHeroes && (
        <p className="text-[11px] text-ow-defeat/90">
          Add to <code className="text-ow-orange">HEROES</code> in reference.ts first (step 1) — then run the role SQL below.
        </p>
      )}
      {h.unknownStatNames.length > 0 && (
        <div className="pt-1 space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-ow-faint uppercase tracking-wider">
              New stat names — also add to <code className="text-ow-orange">hero_stats_normalised</code> (SQL)
            </p>
            <CopyButton text={normaliseClauses.join('\n')} label="COPY WHEN CLAUSES" />
          </div>
          <pre className="text-[10px] bg-ow-panel border border-ow-line rounded p-2 overflow-x-auto text-ow-muted whitespace-pre">{normaliseClauses.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}

function ReadinessPanel({ readiness }: { readiness: MatchReadiness }) {
  const { allRecognised, newHeroes, newMaps, heroes, maps } = readiness
  // Only show the per-hero detail for heroes that need attention; known heroes
  // are summarised. This keeps a normal match (all known) quiet.
  const heroesToShow = newHeroes.length > 0 ? newHeroes : []

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${
      allRecognised ? 'bg-ow-victory/5 border-ow-victory/30' : 'bg-ow-orange/5 border-ow-orange/40'
    }`}>
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none">{allRecognised ? '\u2713' : '\u26a0'}</span>
        <p className={`text-sm font-display tracking-wider font-bold ${
          allRecognised ? 'text-ow-victory' : 'text-ow-orange'
        }`}>
          {allRecognised ? 'ALL HEROES & MAPS RECOGNISED' : 'NEW CONTENT DETECTED — SETUP NEEDED'}
        </p>
      </div>

      {!allRecognised && (
        <p className="text-xs text-ow-muted">
          {heroes.length} hero{heroes.length !== 1 ? 'es' : ''}, {maps.length} map{maps.length !== 1 ? 's' : ''} seen ·{' '}
          {newHeroes.length} hero{newHeroes.length !== 1 ? 'es' : ''} and {newMaps.length} map{newMaps.length !== 1 ? 's' : ''} need attention.
        </p>
      )}

      {/* New / incomplete heroes */}
      {heroesToShow.length > 0 && (
        <div className="space-y-2">
          {heroesToShow.map((h) => <HeroReadinessRow key={h.heroName} h={h} />)}
          <div className="flex items-center justify-between bg-ow-dark rounded border border-ow-line p-2">
            <span className="text-[11px] text-ow-muted">
              Run this once in Supabase so new heroes have a role in Matchups (<code className="text-ow-orange">hero_role_ref</code> + <code className="text-ow-orange">hero_role_history</code>):
            </span>
            <CopyButton text={generateHeroRoleRefSql()} label="COPY hero role SQL" />
          </div>
        </div>
      )}

      {/* New maps */}
      {newMaps.length > 0 && (
        <div className="space-y-1">
          {newMaps.map((m) => (
            <div key={m.mapName} className="bg-ow-dark rounded border border-ow-line p-2 text-xs flex items-center gap-3">
              <span className="font-display font-bold text-ow-fg">{m.mapName}</span>
              <span className="flex items-center gap-1.5"><Check ok={m.inMaps} /> <span className="text-ow-muted">MAPS list</span></span>
              {m.detectKeywordKnown !== null && (
                <span className="flex items-center gap-1.5"><Check ok={m.detectKeywordKnown} /> <span className="text-ow-muted">Detect keyword</span></span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ResultCard({ r }: { r: MatchTestResult }) {
  const [showLog, setShowLog] = useState(false)
  const res = r.result

  // New-content readiness: cross-reference every hero/map this match contains
  // against the code + DB registration points. Memoised on the result.
  const readiness = useMemo<MatchReadiness | null>(() => {
    if (!res) return null
    const summaryHeroNames = res.heroes.map((h) => h.name)
    const scoreboardHeroNames = (res.scoreboard?.stats ?? [])
      .map((s) => s.heroName)
      .filter((n): n is string => !!n)
    const detectableMapNames = res.mapName && findMapName(res.mapName.toUpperCase()) === res.mapName
      ? [res.mapName]
      : []
    return computeMatchReadiness(
      {
        mapName: res.mapName,
        summaryHeroNames,
        scoreboardHeroNames,
        heroBreakdowns: res.heroBreakdowns.map((b) => ({
          heroName: b.heroName,
          stats: b.stats.map((s) => ({ statName: s.statName, statValue: s.statValue })),
        })),
      },
      { scoreboardRoleNames: SCOREBOARD_ROLE_HERO_NAMES, detectableMapNames },
    )
  }, [res])

  return (
    <div className="bg-ow-panel rounded-lg border border-ow-line overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-ow-line">
        <div className="flex items-center gap-3">
          <span className="text-ow-fg font-display font-bold">{r.key}</span>
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
        <span className="text-xs text-ow-faint font-display">
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
              <p className="text-[10px] text-ow-faint uppercase tracking-wider">Map</p>
              <p className="text-ow-fg font-display text-sm">{res.mapName || '—'}</p>
            </div>
            <div>
              <p className="text-[10px] text-ow-faint uppercase tracking-wider">Result</p>
              <p
                className={`font-display font-bold text-sm ${
                  res.result === 'victory'
                    ? 'text-ow-victory'
                    : res.result === 'defeat'
                      ? 'text-ow-defeat'
                      : 'text-ow-muted'
                }`}
              >
                {res.result?.toUpperCase() || '—'}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-ow-faint uppercase tracking-wider">Score</p>
              <p className="text-ow-fg font-display text-sm">{res.score || '—'}</p>
            </div>
            <div>
              <p className="text-[10px] text-ow-faint uppercase tracking-wider">E / A / D</p>
              <p className="text-ow-fg font-display text-sm">
                {res.eliminations ?? '—'} / {res.assists ?? '—'} / {res.deaths ?? '—'}
              </p>
            </div>
          </div>

          {(res.allyComp || res.enemyComp) && (
            <div className="flex gap-4 text-xs font-display">
              {res.allyComp && (
                <span className="text-blue-400">
                  Ally <span className="text-ow-fg font-bold">{res.allyComp}</span>
                </span>
              )}
              {res.enemyComp && (
                <span className="text-red-400">
                  Enemy <span className="text-ow-fg font-bold">{res.enemyComp}</span>
                </span>
              )}
              {res.correctedRole && (
                <span className="text-ow-orange">
                  role auto-corrected → <span className="font-bold">{res.correctedRole}</span>
                </span>
              )}
            </div>
          )}

          {/* New-content readiness (heroes / maps wired up?) */}
          {readiness && <ReadinessPanel readiness={readiness} />}

          {/* Summary source screenshot (click to enlarge) */}
          {res.summaryImageUrl && (
            <div>
              <p className="text-[10px] text-ow-muted font-display tracking-wider uppercase mb-2">
                Summary Screenshot
              </p>
              <EnlargeableImage src={res.summaryImageUrl} label="summary screenshot" />
            </div>
          )}

          {/* Summary portrait confidence */}
          {r.confidence.summary.length > 0 && (
            <div>
              <p className="text-[10px] text-ow-muted font-display tracking-wider uppercase mb-2">
                Summary Portraits
              </p>
              <div className="flex flex-wrap gap-2">
                {r.confidence.summary.map((s) => (
                  <span
                    key={s.slot}
                    className="bg-ow-dark rounded px-2.5 py-1 text-xs border border-ow-line"
                  >
                    <span className="text-ow-muted">{s.hero}</span>{' '}
                    <ConfBadge score={s.score} />
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Breakdown portrait confidence */}
          {r.confidence.breakdown.length > 0 && (
            <div>
              <p className="text-[10px] text-ow-muted font-display tracking-wider uppercase mb-2">
                Hero Breakdown Portraits
              </p>
              <div className="flex flex-wrap gap-2">
                {r.confidence.breakdown.map((b) => {
                  const bd = res.heroBreakdowns.find((x) => x.heroName === b.hero)
                  return (
                    <span
                      key={b.hero}
                      className="bg-ow-dark rounded px-2.5 py-1 text-xs border border-ow-line"
                    >
                      <span className="text-ow-muted">{b.hero}</span>{' '}
                      <ConfBadge score={b.score} />
                      {bd && (
                        <span className="text-ow-faint ml-1">
                          {bd.foundStatCount}/{bd.expectedStatCount}
                        </span>
                      )}
                    </span>
                  )
                })}
              </div>
            </div>
          )}

          {/* Hero breakdown — screenshot beside extracted stats (per hero) */}
          {res.heroBreakdowns.length > 0 && (
            <div className="space-y-3">
              <p className="text-[10px] text-ow-muted font-display tracking-wider uppercase">
                Hero Breakdown — Screenshot vs Data
              </p>
              {res.heroBreakdowns.map((bd) => {
                const pct = bd.percentPlayed != null ? `${bd.percentPlayed}%` : '—'
                const pt = bd.playTimeSeconds != null
                  ? `${Math.floor(bd.playTimeSeconds / 60)}:${String(bd.playTimeSeconds % 60).padStart(2, '0')}`
                  : '—'
                return (
                  <div key={bd.heroName} className="grid md:grid-cols-2 gap-3 bg-ow-dark rounded border border-ow-line p-3">
                    <div>
                      <p className="text-sm font-display font-bold text-ow-fg mb-1">{bd.heroName}</p>
                      <p className="text-[11px] text-ow-faint mb-2">
                        {pct} played · {pt} · {bd.foundStatCount}/{bd.expectedStatCount} stats
                      </p>
                      {bd.imageUrl
                        ? <EnlargeableImage src={bd.imageUrl} label={`${bd.heroName} breakdown screenshot`} />
                        : <p className="text-[11px] text-ow-faint">(no source image)</p>}
                    </div>
                    <div>
                      {bd.stats.length === 0 ? (
                        <p className="text-[11px] text-ow-faint">No stats extracted.</p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-ow-faint text-[10px] uppercase tracking-wider border-b border-ow-line">
                              <th className="text-left py-1 px-1.5">Stat</th>
                              <th className="text-right py-1 px-1.5">Value</th>
                              <th className="text-right py-1 px-1.5">/10min</th>
                            </tr>
                          </thead>
                          <tbody>
                            {bd.stats.map((s) => {
                              const unknown = s.statName.startsWith('UNKNOWN')
                              return (
                                <tr key={s.statName} className="border-b border-ow-line/60">
                                  <td className="py-1 px-1.5 text-ow-fg">
                                    {s.statName}
                                    {unknown && <span className="text-ow-defeat ml-1">{'\u26a0'}</span>}
                                  </td>
                                  <td className="py-1 px-1.5 text-right font-mono text-ow-muted">{s.statValue}</td>
                                  <td className="py-1 px-1.5 text-right font-mono text-ow-faint">{s.avgPer10Min ?? '—'}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Scoreboard portrait confidence — the headline table */}
          {r.confidence.scoreboard.length > 0 && (
            <div>
              <p className="text-[10px] text-ow-muted font-display tracking-wider uppercase mb-2">
                Scoreboard Portraits
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-ow-faint text-[10px] uppercase tracking-wider border-b border-ow-line">
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
                        className={`border-b border-ow-line ${
                          p.phase1Agrees === false ? 'bg-ow-defeat/5' : ''
                        }`}
                      >
                        <td className="py-1.5 px-2 font-mono text-ow-faint">{p.slot}</td>
                        <td
                          className={`py-1.5 px-2 ${
                            p.team === 'ally'
                              ? 'text-blue-300'
                              : p.team === 'enemy'
                                ? 'text-red-300'
                                : 'text-ow-faint'
                          }`}
                        >
                          {p.team ?? '—'}
                        </td>
                        <td className="py-1.5 px-2 text-ow-fg">{p.hero}</td>
                        <td className="py-1.5 px-2 text-right">
                          <ConfBadge score={p.score} margin={p.margin} />
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-ow-muted">
                          {fmt4(p.margin)}
                        </td>
                        <td className="py-1.5 px-2 text-ow-faint">{p.runnerUp ?? '—'}</td>
                        <td className="py-1.5 px-2 text-center font-mono text-ow-muted">
                          {p.crop ?? '—'}
                        </td>
                        <td className="py-1.5 px-2 font-mono text-ow-faint">
                          {p.phase1Hero ? `${p.phase1Hero} ${fmt4(p.phase1Score)}` : '—'}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          {p.phase1Agrees === null ? (
                            <span className="text-ow-faint">—</span>
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
                            <span className="text-ow-faint">—</span>
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
          {/* Scoreboard source screenshot (click to enlarge) */}
          {res.scoreboard?.imageUrl && (
            <div>
              <p className="text-[10px] text-ow-muted font-display tracking-wider uppercase mb-2">
                Scoreboard Screenshot
              </p>
              <EnlargeableImage src={res.scoreboard.imageUrl} label="scoreboard screenshot" />
            </div>
          )}

          {/* Scoreboard stats (mirrors MATCH SAVED) */}
          {res.scoreboard && <ScoreboardStats sb={res.scoreboard} />}

          {/* Raw log toggle */}
          <div>
            <button
              onClick={() => setShowLog((v) => !v)}
              className="text-xs text-ow-muted hover:text-ow-fg font-display"
            >
              {showLog ? '▼' : '▶'} Raw console log ({r.logs.length} lines)
            </button>
            {showLog && (
              <pre className="mt-2 bg-ow-dark rounded-lg p-3 text-[10px] leading-relaxed text-ow-muted overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
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
            <tr className="text-ow-faint text-[10px] uppercase tracking-wider border-b border-ow-line">
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
                    className={`border-b border-ow-line ${player?.isUser ? 'bg-ow-orange/5' : ''}`}
                  >
                    <td
                      className={`py-1.5 px-2 font-display ${player?.isUser ? 'text-ow-orange font-bold' : 'text-ow-muted'}`}
                    >
                      {player?.displayName ||
                        `${team === 'ally' ? 'Ally' : 'Enemy'} ${team === 'ally' ? s.slot : s.slot - rowsPerTeam}`}
                    </td>
                    <td className="py-1.5 px-2 text-ow-muted">{s.heroName || '—'}</td>
                    <td
                      className={`py-1.5 px-2 uppercase font-display text-[10px] font-bold ${
                        s.role === 'tank'
                          ? 'text-blue-300'
                          : s.role === 'dps'
                            ? 'text-red-300'
                            : s.role === 'support'
                              ? 'text-green-300'
                              : 'text-ow-faint'
                      }`}
                    >
                      {s.role || '—'}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-ow-muted">{s.eliminations ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-ow-muted">{s.assists ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-ow-muted">{s.deaths ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-ow-muted">{s.damage?.toLocaleString() ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-ow-muted">{s.healing?.toLocaleString() ?? '—'}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-ow-muted">{s.mitigation?.toLocaleString() ?? '—'}</td>
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

// (v1.2.0) Session mode — groups an order-free session with the SAME reader and
// grouper bulk upload uses (session-fingerprint / session-grouper), then hands
// each match to the normal PROCESS ALL. Nothing is written to the database.
async function groupFilesAsSession(files: File[]): Promise<{ groups: MatchGroup[]; info: SessionTestInfo }> {
  const urls = new Map(files.map(f => [f.name, URL.createObjectURL(f)]))
  try {
    const fps = await fingerprintSession(files.map(f => ({ id: f.name, url: urls.get(f.name)! })))
    const g = groupSession(fps)
    const byName = new Map(files.map(f => [f.name, f]))
    const groups: MatchGroup[] = g.matches.map((m, i) => {
      const leaverGame = m.leaver.team || m.leaver.enemy
      const ids = [m.summaryId, ...m.personalIds, ...(!leaverGame && m.teamsId ? [m.teamsId] : [])]
      return {
        key: `Session ${i + 1} · ${m.dateText ?? 'no date'} · ${m.mapName ?? 'unknown map'}`,
        via: 'content' as const,
        files: ids.map(id => byName.get(id)!).filter(Boolean),
        pageTypes: ids.map(id => (id === m.summaryId ? 'summary' : id === m.teamsId ? 'scoreboard' : 'breakdown')) as PageType[],
        extraHeroes: sessionExtraHeroes(m),
      }
    })
    const fpById = new Map(fps.map(f => [f.id, f]))
    const pageValues = (id: string): string => {
      const f = fpById.get(id)
      if (!f) return id
      if (f.kind === 'summary') return `${id}: summary slots ${f.slots.map(s => `${s.percentPlayed ?? '?'}%/${s.playTimeSeconds ?? '?'}s`).join(', ')} · date "${f.dateText ?? '—'}"`
      if (f.kind === 'personal') return `${id}: ${f.hero ?? '?'} ${f.percentPlayed ?? '?'}%/${f.playTimeSeconds ?? '?'}s · sidebar [${f.sidebar.map(n => n ?? '?').join(', ')}]`
      if (f.kind === 'teams') return `${id}: teams ${f.allyRows} v ${f.enemyRows}, pitch ${f.pitch ?? '?'}, your row ${f.userRowIndex ?? '?'} = ${f.userEad ? `${f.userEad.e}/${f.userEad.a}/${f.userEad.d}` : '?'}`
      return `${id}: ${f.reason}`
    }
    const info: SessionTestInfo = {
      perGroup: g.matches.map(m => ({
        values: [m.summaryId, ...m.personalIds, ...(m.teamsId ? [m.teamsId] : [])].map(pageValues),
        format: m.format ? `${m.format}${m.formatCertain ? '' : '?'}` : '—',
        rows: m.allyRows != null ? `${m.allyRows} v ${m.enemyRows}` : '—',
        ead: m.ead ? `${m.ead.e}/${m.ead.a}/${m.ead.d}` : '—',
        issues: m.issues,
        notes: m.notes,
      })),
      leftovers: g.leftovers,
      duplicates: g.duplicates,
    }
    return { groups, info }
  } finally {
    urls.forEach(u => URL.revokeObjectURL(u))
  }
}

interface SessionTestInfo {
  perGroup: { values: string[]; format: string; rows: string; ead: string; issues: string[]; notes: string[] }[]
  leftovers: { id: string; reason: string }[]
  duplicates: { id: string; reason: string }[]
}

export default function TestingPage() {
  const [groups, setGroups] = useState<MatchGroup[]>([])
  const [sessionMode, setSessionMode] = useState(false)
  const [sessionInfo, setSessionInfo] = useState<SessionTestInfo | null>(null)
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
    setSessionInfo(null)
    setGrouping(true)
    try {
      if (sessionMode) {
        const { groups: sg, info } = await groupFilesAsSession(imageFiles)
        setGroups(sg)
        setSessionInfo(info)
        if (sg.length === 0) setError('No Summary page found — a session match needs its Summary.')
        return
      }
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
  }, [sessionMode])

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
          undefined,
          group.extraHeroes,
        )
      } catch (err: any) {
        errMsg = err?.message || String(err)
      } finally {
        restore()
        // Revoke only the blob URLs the result does NOT keep for display.
        // The displayed ones (summary / breakdown / scoreboard screenshots) must
        // stay valid until the result card is gone, or the <img> tags break with
        // "WebKitBlobResource error 1". Those are revoked when results are cleared
        // (startNewTest) via revokeResultImageUrls().
        const keep = new Set(displayedImageUrls(res))
        for (const u of urls) {
          if (!keep.has(u)) URL.revokeObjectURL(u)
        }
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
    revokeResultImageUrls(results)
    setTestNumber((n) => n + 1)
    setResults([])
    setGroups([])
    setError(null)
  }, [results])

  // Roll-up stats
  const done = results.filter((r) => r.result && !r.error).length
  const totalMs = results.reduce((s, r) => s + r.processingMs, 0)
  const avgMs = results.length ? totalMs / results.length : 0
  const allSb = results.flatMap((r) => r.confidence.scoreboard)
  const fragile = allSb.filter((p) => isFragile(p.score, p.margin)).length
  const disagree = allSb.filter((p) => p.phase1Agrees === false).length

  return (
    <div className="min-h-screen bg-ow-dark text-ow-fg p-4 sm:p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl text-ow-orange font-display font-bold">
            Match Extraction — Testing
          </h1>
          <span className="text-xs font-mono text-ow-faint bg-ow-panel px-2 py-0.5 rounded">
            Test #{testNumber}
          </span>
        </div>
        <p className="text-xs text-ow-faint -mt-4">
          Calls <code className="text-ow-muted">processMatchPhotos()</code> — the same code path
          as production. Files are grouped into matches by <code className="text-ow-muted">Test_&lt;N&gt;_</code> prefix.
        </p>

        {/* Gamertag */}
        <div>
          <label className="text-[10px] uppercase tracking-wider text-ow-faint mb-1 block">
            Gamertag
          </label>
          <input
            type="text"
            value={gamertag}
            onChange={(e) => setGamertag(e.target.value)}
            placeholder="Enter gamertag..."
            disabled={processing}
            className="w-full sm:w-72 bg-ow-panel border border-ow-line rounded-lg px-3 py-2 text-sm text-ow-fg placeholder-ow-faint focus:border-ow-orange/40 focus:outline-none disabled:opacity-50"
          />
        </div>

        {/* Upload */}
        <div className="border border-dashed border-ow-line rounded-xl p-5 text-center hover:border-ow-orange/30 transition-colors">
          <p className="text-sm text-ow-muted mb-3">
            Select all screenshots for one or more matches (summary, breakdown(s), scoreboard).
          </p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*"
            onChange={handleFiles}
            disabled={processing}
            className="text-sm text-ow-muted file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-ow-panel file:text-ow-muted hover:file:bg-white/5 file:cursor-pointer disabled:opacity-50"
          />
          <label className="flex items-center justify-center gap-2 mt-3 text-xs text-ow-muted cursor-pointer">
            <input type="checkbox" checked={sessionMode} disabled={processing}
              onChange={e => setSessionMode(e.target.checked)} />
            Session mode (order-free) — group a whole session by page content, like bulk upload
          </label>
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
          <div className="bg-ow-panel rounded-lg border border-ow-line p-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-ow-orange font-display font-bold text-sm">
                {groups.length} MATCH{groups.length !== 1 ? 'ES' : ''} DETECTED
                <span className="ml-2 text-[10px] font-mono text-ow-faint">
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
            <p className="text-xs text-ow-faint">
              Review grouping below before processing. Each group → one processMatchPhotos() call,
              ordered summary → breakdown(s) → scoreboard.
            </p>
            <div className="space-y-2">
              {groups.map((g) => (
                <div key={g.key} className="bg-ow-dark rounded px-3 py-2 border border-ow-line">
                  <p className="text-sm text-ow-fg font-display">{g.key}</p>
                  {sessionInfo?.perGroup[groups.indexOf(g)] && (() => {
                    const si = sessionInfo.perGroup[groups.indexOf(g)]
                    return (
                      <div className="mt-1 space-y-0.5">
                        <p className="text-[11px] text-ow-muted">E/A/D {si.ead} · {si.format} · rows {si.rows}</p>
                        {si.values.map(v => <p key={v} className="text-[10px] font-mono text-ow-faint">{v}</p>)}
                        {si.issues.map(x => <p key={x} className="text-[11px] text-ow-defeat">● held: {x}</p>)}
                        {si.notes.map(x => <p key={x} className="text-[11px] text-ow-draw">● {x}</p>)}
                      </div>
                    )
                  })()}
                  <div className="mt-1 space-y-0.5">
                    {g.files.map((f, i) => (
                      <p key={f.name} className="text-[11px] text-ow-faint flex gap-2">
                        <span className="inline-block w-20 shrink-0 uppercase tracking-wide text-ow-faint">
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

        {/* (v1.2.0) Session mode: what didn't fit */}
        {!grouping && sessionInfo && (sessionInfo.leftovers.length > 0 || sessionInfo.duplicates.length > 0) && results.length === 0 && (
          <div className="bg-ow-panel rounded-lg border border-ow-draw/30 p-5 space-y-1">
            <p className="text-ow-draw font-display font-bold text-sm">NOT PLACED</p>
            {sessionInfo.leftovers.map(l => <p key={l.id} className="text-[11px] text-ow-muted"><span className="text-ow-fg">{l.id}</span> — {l.reason}</p>)}
            {sessionInfo.duplicates.map(l => <p key={l.id} className="text-[11px] text-ow-faint"><span className="text-ow-muted">{l.id}</span> — {l.reason}</p>)}
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
                <div key={i} className="bg-ow-panel border border-ow-line rounded-lg p-3 text-center">
                  <p
                    className={`text-lg font-bold font-mono ${
                      item.bad === undefined
                        ? 'text-ow-fg'
                        : item.bad
                          ? 'text-ow-defeat'
                          : 'text-ow-victory'
                    }`}
                  >
                    {item.value}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider text-ow-faint mt-0.5">{item.label}</p>
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
                className="bg-ow-panel border border-ow-line text-ow-muted text-sm px-4 py-2 rounded-lg font-display tracking-wider hover:border-ow-orange/30 transition-colors disabled:opacity-50"
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
