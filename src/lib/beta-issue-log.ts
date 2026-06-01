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

// ── Aggregation (pure — unit-testable without a DB) ──────────

export interface SeasonStats {
  matchesProcessed: number
  totalQuestionsAsked: number
  totalAutoPassFields: number
  totalConfirmedCorrect: number
  totalCorrected: number
  totalRegionMismatch: number
  totalUnrecognized: number
  /** error rate per FIELD type: corrected / (corrected + confirmed_correct). */
  errorRateByField: Record<string, { corrected: number; confirmed: number; rate: number }>
  /** precision per SIGNAL: how often a flag was a real error. */
  precisionBySignal: Record<string, { corrected: number; confirmed: number; precision: number }>
  /** every distinct unrecognized value seen (new-content ledger). */
  unrecognizedLedger: Array<{ fieldDetail: string; value: string; matchId: string }>
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
    errorRateByField: {},
    precisionBySignal: {},
    unrecognizedLedger: [],
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
  lines.push(`- **Overall error rate: ${pct(overallErrorRate)}** (corrected / fields processed)`)
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
