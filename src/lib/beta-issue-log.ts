// ============================================================
// Step 6f — Issue log (persistence + report generation)
// ------------------------------------------------------------
// Source of truth: a Supabase table `beta_issue_log` (one row per logged event).
// This matches the app's existing persistence model (browser app, no server
// filesystem). Rows are append-only and agent-readable via plain SELECT.
//
// Human view: `generateIssueReportMarkdown()` renders the rows into a grouped
// .md the review page offers as a download. The .md is always regenerated from
// the table, so the two never drift.
//
// Event model (per the 6f design, confirmed at ~200 matches/season):
//   confirmed_correct  — flag fired, user confirmed the read    (true negative; the denominator)
//   corrected          — user fixed it                          (true positive; carries correction)
//   unrecognized       — UNKNOWN label / no catalog entry        (informational)
//   match_summary      — one per match: questionsAsked + autoPassFields
// Per-field auto-passes are NOT logged (only the per-match count) to keep the
// table small and aggregation clean.
// ============================================================

import { supabase } from './supabase'
import type { SignalKind, FieldKind } from './beta-confirmation'

export type IssueEvent =
  | 'confirmed_correct'
  | 'corrected'
  | 'region_mismatch'
  | 'unrecognized'
  | 'match_summary'
  | 'processing_error'   // a batch failed to process (extraction threw); files kept in pending for retry

// Mirrors the `beta_issue_log` table. `id` / `created_at` are DB-assigned.
export interface IssueLogRow {
  id?: number
  created_at?: string
  match_id: string
  event: IssueEvent
  // Present for confirmed_correct / corrected / unrecognized:
  field?: FieldKind | null
  field_detail?: string | null
  signal?: SignalKind | null
  read_value?: string | null         // what the pipeline read
  corrected_value?: string | null    // user's correction (corrected only)
  confidence?: number | null
  format?: '5v5' | '6v6' | null
  // Present for match_summary:
  questions_asked?: number | null
  auto_pass_fields?: number | null
}

// ── Writers ──────────────────────────────────────────────────

/** Append one event. Append-only; never updates existing rows. */
export async function logIssueEvent(row: IssueLogRow): Promise<{ error: unknown }> {
  const { error } = await supabase.from('beta_issue_log').insert(row)
  if (error) console.warn('[beta-log] failed to write event', row.event, error)
  return { error }
}

/** Convenience: log the outcome of a single confirmation question. */
export async function logConfirmationOutcome(args: {
  matchId: string
  format: '5v5' | '6v6'
  field: FieldKind
  fieldDetail: string
  signal: SignalKind
  readValue: string
  confidence?: number
  /** Explicit outcome. If omitted, inferred from correctedValue. */
  outcome?: 'confirmed_correct' | 'corrected' | 'region_mismatch'
  /** undefined/null => confirmed correct; a string => corrected to that value. */
  correctedValue?: string | null
}): Promise<{ error: unknown }> {
  let event: IssueEvent
  if (args.outcome) {
    event = args.outcome
  } else {
    const corrected = args.correctedValue != null && args.correctedValue !== args.readValue
    event = corrected ? 'corrected' : 'confirmed_correct'
  }
  return logIssueEvent({
    match_id: args.matchId,
    event,
    field: args.field,
    field_detail: args.fieldDetail,
    signal: args.signal,
    read_value: args.readValue,
    corrected_value: event === 'corrected' ? args.correctedValue : null,
    confidence: args.confidence ?? null,
    format: args.format,
  })
}

/** Log a per-match rollup (always one per processed match). */
export async function logMatchSummary(args: {
  matchId: string
  format: '5v5' | '6v6'
  questionsAsked: number
  autoPassFields: number
}): Promise<{ error: unknown }> {
  return logIssueEvent({
    match_id: args.matchId,
    event: 'match_summary',
    format: args.format,
    questions_asked: args.questionsAsked,
    auto_pass_fields: args.autoPassFields,
  })
}

/** Log a hard date-OCR failure (step 3a). The summary date couldn't be read or
 *  parsed, so the pipeline fell back to processing time for played_at — which
 *  drives BOTH season assignment and session boundaries, hence worth logging as
 *  a background event. `reason` distinguishes the failure mode; `read_value`
 *  carries whatever raw text (if any) was OCR'd. Logged as a `corrected`-class
 *  event under the `date` field / `date_ocr_fail` signal so it surfaces in the
 *  signal-precision + error-rate tables of the issue report. */
export async function logDateOcrFailure(args: {
  matchId: string
  reason: 'missing' | 'unparseable'
  rawText?: string | null
  format?: '5v5' | '6v6' | null
}): Promise<{ error: unknown }> {
  return logIssueEvent({
    match_id: args.matchId,
    event: 'corrected',           // a real failure (not a confirmed-correct)
    field: 'date',
    field_detail: `date_ocr_${args.reason}`,
    signal: 'date_ocr_fail',
    read_value: args.rawText ?? null,
    corrected_value: null,        // unknown — fell back to process time
    format: args.format ?? null,
  })
}

/** Log a map-detection miss (step 10). Fires when the phone's upload-time map
 *  auto-detect missed AND/OR the laptop's summary OCR produced no usable map, so
 *  the saved match would otherwise carry a null map (and null starting_side).
 *  `phoneMissed` records whether the phone reported the miss; `ocrValue` carries
 *  whatever the laptop OCR read (may be empty / unrecognized). When the reviewer
 *  picks the map in the dropdown, `correctedValue` holds it and `side` the
 *  attack/defend answer (escort/hybrid only). Logged as a `corrected`-class
 *  event under the `map` field / `map_detect_fail` signal so it surfaces in the
 *  signal-precision + error-rate tables, exactly like the date path. */
export async function logMapDetectMiss(args: {
  matchId: string
  phoneMissed: boolean
  ocrValue?: string | null
  correctedValue?: string | null
  side?: 'attack' | 'defense' | null
  format?: '5v5' | '6v6' | null
}): Promise<{ error: unknown }> {
  const detail = args.side
    ? `map_detect_${args.phoneMissed ? 'phone_miss' : 'ocr_miss'}+side_${args.side}`
    : `map_detect_${args.phoneMissed ? 'phone_miss' : 'ocr_miss'}`
  return logIssueEvent({
    match_id: args.matchId,
    event: 'corrected',
    field: 'map',
    field_detail: detail,
    signal: 'map_detect_fail',
    read_value: args.ocrValue ?? null,
    corrected_value: args.correctedValue ?? null,
    format: args.format ?? null,
  })
}

/** Log a match-result conflict (result cross-check). Fires when the summary's
 *  VICTORY/DEFEAT banner could not be read, OR the banner disagrees with the
 *  result derived from the score line, so the reviewer was asked to confirm the
 *  win/loss/draw. `bannerResult` / `scoreDerivedResult` record what each source
 *  said (either may be empty); `correctedValue` is the reviewer's pick (null when
 *  they accepted the pre-filled banner value unchanged). Logged under the
 *  `result` field / `result_conflict` signal so it surfaces in the signal-
 *  precision + error-rate tables, exactly like the date and map paths. The event
 *  is `corrected` ONLY when the reviewer actually changed the result; an
 *  unchanged confirm logs `confirmed_correct` so the precision math counts it as
 *  a true negative, not a real error. A flipped result silently corrupts win-rate
 *  across hero / map / role / season analytics, hence worth tracking every time. */
export async function logResultConflict(args: {
  matchId: string
  bannerResult?: string | null
  scoreDerivedResult?: string | null
  correctedValue?: string | null
  format?: '5v5' | '6v6' | null
}): Promise<{ error: unknown }> {
  const banner = args.bannerResult && args.bannerResult !== '' ? args.bannerResult : 'unreadable'
  const detail = `result_${banner}_vs_score_${args.scoreDerivedResult || 'none'}`
  // A correction only happened if the pick differs from what the banner read.
  // When the banner was unreadable, any pick is effectively a correction (there
  // was no trustworthy read to confirm).
  const bannerReadable = !!(args.bannerResult && args.bannerResult !== '')
  const changed =
    args.correctedValue != null &&
    (!bannerReadable || args.correctedValue.toLowerCase() !== args.bannerResult!.toLowerCase())
  return logIssueEvent({
    match_id: args.matchId,
    event: changed ? 'corrected' : 'confirmed_correct',
    field: 'result',
    field_detail: detail,
    signal: 'result_conflict',
    read_value: args.bannerResult ?? null,
    corrected_value: changed ? args.correctedValue ?? null : null,
    format: args.format ?? null,
  })
}

/** Log a batch that failed to process. The error message is stored in
 *  `read_value` (no new column needed); `field_detail` carries a short reason.
 *  Files for this batch are intentionally LEFT in pending/ for retry, so the
 *  same matchId may appear again later as a success — that's expected. */
export async function logProcessingError(args: {
  matchId: string
  message: string
  format?: '5v5' | '6v6' | null
}): Promise<{ error: unknown }> {
  return logIssueEvent({
    match_id: args.matchId,
    event: 'processing_error',
    field: null,
    field_detail: 'processing',
    read_value: args.message.slice(0, 500),  // guard against giant stack traces
    format: args.format ?? null,
  })
}

// ── Reader ───────────────────────────────────────────────────

export async function fetchIssueLog(): Promise<IssueLogRow[]> {
  const { data, error } = await supabase
    .from('beta_issue_log')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) {
    console.warn('[beta-log] failed to read log', error)
    return []
  }
  return (data ?? []) as IssueLogRow[]
}

// ── Destructive: clear the log (Start New Season) ────────────
//
// Deletes EVERY row in beta_issue_log and NOTHING else — match data lives in
// other tables and is never touched here. PostgREST rejects an unfiltered
// delete as a safety measure, so we use an always-true filter (id >= 0) that
// matches all rows. The caller MUST archive first; this is irreversible.
export async function clearIssueLog(): Promise<{ error: unknown; deleted: boolean }> {
  const { error } = await supabase
    .from('beta_issue_log')
    .delete()
    .gte('id', 0)   // matches all rows; satisfies PostgREST's "must filter" rule
  if (error) {
    console.warn('[beta-log] failed to clear log', error)
    return { error, deleted: false }
  }
  return { error: null, deleted: true }
}

// ── Aggregation (pure — unit-testable without a DB) ──────────

export interface SeasonStats {
  matchesProcessed: number
  totalQuestionsAsked: number
  totalAutoPassFields: number
  totalConfirmedCorrect: number
  totalCorrected: number
  totalRegionMismatch: number
  totalUnrecognized: number
  /** count of batches that failed to process (kept in pending for retry). */
  totalProcessingErrors: number
  /** error rate per FIELD type: corrected / (corrected + confirmed_correct). */
  errorRateByField: Record<string, { corrected: number; confirmed: number; rate: number }>
  /** precision per SIGNAL: how often a flag was a real error. */
  precisionBySignal: Record<string, { corrected: number; confirmed: number; precision: number }>
  /** every distinct unrecognized value seen (new-content ledger). */
  unrecognizedLedger: Array<{ fieldDetail: string; value: string; matchId: string }>
  /** processing failures, with the captured reason. */
  processingErrors: Array<{ matchId: string; message: string }>
}

export function aggregate(rows: IssueLogRow[]): SeasonStats {
  const stats: SeasonStats = {
    matchesProcessed: 0,
    totalQuestionsAsked: 0,
    totalAutoPassFields: 0,
    totalConfirmedCorrect: 0,
    totalCorrected: 0,
    totalRegionMismatch: 0,
    totalUnrecognized: 0,
    totalProcessingErrors: 0,
    errorRateByField: {},
    precisionBySignal: {},
    unrecognizedLedger: [],
    processingErrors: [],
  }

  for (const r of rows) {
    if (r.event === 'match_summary') {
      stats.matchesProcessed += 1
      stats.totalQuestionsAsked += r.questions_asked ?? 0
      stats.totalAutoPassFields += r.auto_pass_fields ?? 0
      continue
    }

    if (r.event === 'unrecognized') {
      stats.totalUnrecognized += 1
      stats.unrecognizedLedger.push({
        fieldDetail: r.field_detail ?? r.field ?? 'unknown',
        value: r.read_value ?? '',
        matchId: r.match_id,
      })
      continue
    }

    if (r.event === 'processing_error') {
      stats.totalProcessingErrors += 1
      stats.processingErrors.push({
        matchId: r.match_id,
        message: r.read_value ?? '(no detail)',
      })
      continue
    }

    const isCorrected = r.event === 'corrected'
    const isConfirmed = r.event === 'confirmed_correct'
    const isMismatch = r.event === 'region_mismatch'
    if (!isCorrected && !isConfirmed && !isMismatch) continue

    if (isCorrected) stats.totalCorrected += 1
    if (isConfirmed) stats.totalConfirmedCorrect += 1
    if (isMismatch) stats.totalRegionMismatch += 1

    const f = r.field ?? 'unknown'
    const fe = (stats.errorRateByField[f] ??= { corrected: 0, confirmed: 0, rate: 0 })
    if (isCorrected || isMismatch) fe.corrected += 1
    if (isConfirmed) fe.confirmed += 1
    fe.rate = fe.corrected + fe.confirmed > 0 ? fe.corrected / (fe.corrected + fe.confirmed) : 0

    const sig = r.signal ?? 'unknown'
    const se = (stats.precisionBySignal[sig] ??= { corrected: 0, confirmed: 0, precision: 0 })
    if (isCorrected || isMismatch) se.corrected += 1
    if (isConfirmed) se.confirmed += 1
    se.precision = se.corrected + se.confirmed > 0 ? se.corrected / (se.corrected + se.confirmed) : 0
  }

  return stats
}

// ── Markdown report (pure) ───────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

export function generateIssueReportMarkdown(rows: IssueLogRow[]): string {
  const s = aggregate(rows)
  const fieldsProcessed = s.totalAutoPassFields + s.totalConfirmedCorrect + s.totalCorrected
  const overallErrorRate = fieldsProcessed > 0 ? s.totalCorrected / fieldsProcessed : 0

  const lines: string[] = []
  lines.push('# Beta Season — Issue Log Report')
  lines.push('')
  lines.push(`> Generated ${new Date().toISOString()} from ${rows.length} log rows.`)
  lines.push('')

  lines.push('## Season totals')
  lines.push('')
  lines.push(`- Matches processed: **${s.matchesProcessed}**`)
  lines.push(`- Questions asked: **${s.totalQuestionsAsked}**` +
    (s.matchesProcessed > 0 ? ` (avg ${(s.totalQuestionsAsked / s.matchesProcessed).toFixed(2)}/match)` : ''))
  lines.push(`- Fields processed (auto-pass + confirmed + corrected): **${fieldsProcessed}**`)
  lines.push(`- Confirmed correct: **${s.totalConfirmedCorrect}**`)
  lines.push(`- Corrected (real errors): **${s.totalCorrected}**`)
  lines.push(`- Wrong-area flags (misplaced highlight): **${s.totalRegionMismatch}**`)
  lines.push(`- Unrecognized events: **${s.totalUnrecognized}**`)
  lines.push(`- Processing failures (kept for retry): **${s.totalProcessingErrors}**`)
  lines.push(`- **Overall error rate: ${pct(overallErrorRate)}** (corrected / fields processed)`)
  lines.push('')

  lines.push('## Processing failures (batches kept in pending for retry)')
  lines.push('')
  if (s.processingErrors.length === 0) {
    lines.push('_None — every batch processed._')
  } else {
    lines.push('| Match | Reason |')
    lines.push('|---|---|')
    for (const e of s.processingErrors) {
      lines.push(`| ${e.matchId} | ${e.message.replace(/\n/g, ' ')} |`)
    }
    lines.push('')
    lines.push('> These batches were skipped during an unattended run and their ' +
      'screenshots remain in storage. Reprocess them from the Process page.')
  }
  lines.push('')

  lines.push('## Error rate by field type')
  lines.push('')
  const fieldKeys = Object.keys(s.errorRateByField).sort()
  if (fieldKeys.length === 0) {
    lines.push('_No confirmation outcomes logged yet._')
  } else {
    lines.push('| Field | Corrected | Confirmed | Error rate |')
    lines.push('|---|---|---|---|')
    for (const k of fieldKeys) {
      const e = s.errorRateByField[k]
      lines.push(`| ${k} | ${e.corrected} | ${e.confirmed} | ${pct(e.rate)} |`)
    }
  }
  lines.push('')

  lines.push('## Signal precision (was a flag a real error?)')
  lines.push('')
  const sigKeys = Object.keys(s.precisionBySignal).sort()
  if (sigKeys.length === 0) {
    lines.push('_No signals logged yet._')
  } else {
    lines.push('| Signal | Corrected | Confirmed | Precision |')
    lines.push('|---|---|---|---|')
    for (const k of sigKeys) {
      const e = s.precisionBySignal[k]
      lines.push(`| ${k} | ${e.corrected} | ${e.confirmed} | ${pct(e.precision)} |`)
    }
    lines.push('')
    lines.push('> Low precision (mostly confirmed-correct) → the threshold for that ' +
      'signal can be relaxed. High precision with few flags → it is catching real errors.')
  }
  lines.push('')

  lines.push('## Corrections (real errors, with source reads)')
  lines.push('')
  const corrections = rows.filter(r => r.event === 'corrected')
  if (corrections.length === 0) {
    lines.push('_No corrections logged — pipeline clean so far._')
  } else {
    lines.push('| Match | Field | Signal | Read | Corrected to |')
    lines.push('|---|---|---|---|---|')
    for (const r of corrections) {
      lines.push(`| ${r.match_id} | ${r.field_detail ?? r.field ?? ''} | ${r.signal ?? ''} ` +
        `| \`${r.read_value ?? ''}\` | \`${r.corrected_value ?? ''}\` |`)
    }
  }
  lines.push('')

  lines.push('## New-content ledger (unrecognized heroes / maps / modes / stats)')
  lines.push('')
  if (s.unrecognizedLedger.length === 0) {
    lines.push('_None seen._')
  } else {
    lines.push('| Match | What | Value |')
    lines.push('|---|---|---|')
    for (const u of s.unrecognizedLedger) {
      lines.push(`| ${u.matchId} | ${u.fieldDetail} | \`${u.value}\` |`)
    }
    lines.push('')
    lines.push('> Each row is a heads-up to add a catalog/reference entry.')
  }
  lines.push('')

  return lines.join('\n')
}

// ── Season archive (report + lossless raw rows) ──────────────
//
// Used by the "Start New Season" reset: the readable report on top, then every
// raw row as JSON so the season is preserved losslessly and can be re-imported
// or re-analysed later. Generated and downloaded BEFORE any rows are cleared.
export function generateSeasonArchiveMarkdown(rows: IssueLogRow[]): string {
  const report = generateIssueReportMarkdown(rows)
  const lines: string[] = []
  lines.push(report.trimEnd())
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## Raw data (lossless archive)')
  lines.push('')
  lines.push(`> All ${rows.length} \`beta_issue_log\` rows at archive time, as JSON. ` +
    'Re-importable; this is the complete record for the season being cleared.')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(rows, null, 2))
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}
