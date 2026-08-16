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
// Types are declared LOCALLY rather than imported from beta-confirmation.
// That module is sunset (v1.0.2) — the confidence-gated question flow was
// replaced by the per-slot hero audit — so the issue log must not depend on
// it. Both columns are unconstrained `text` in Postgres, so widening this
// union never needs a migration.
export type SignalKind =
  | 'hero_audit'          // per-slot verdict from the hero audit (the live signal)
  | 'tile_check'          // v1.1.1 season-4 watch: did a retired ultimate tile come back?
  | 'table_geometry'      // v1.1.1: measured scoreboard table position (not an error)
  | 'duplicate_hero'      // coherence: same hero twice on ONE team
  | 'user_hero_absent'    // coherence: user's row hero not among heroes played
  // ── Retired with beta confirmation. Kept so historical rows still type. ──
  | 'unrecognized' | 'date_ocr_fail' | 'map_detect_fail' | 'result_conflict'
  | 'vote_split' | 'avg_crosscheck_fail' | 'low_hero_conf' | 'phase_disagreement'
  | 'low_user_margin' | 'sampled_summary'

export type FieldKind =
  | 'hero_id'
  | 'breakdown_tile'      // v1.1.1 — the 8-tile-ceiling watch (see TILE_WATCH)
  | 'table_geometry'      // v1.1.1 — scoreboard table left edge + width
  // ── Retired with beta confirmation. Kept for historical rows. ──
  | 'scoreboard' | 'breakdown_stat' | 'summary' | 'username'
  | 'date' | 'map' | 'result' | 'side'

/** Signals still written by the live pipeline. Everything else is history. */
export const LIVE_SIGNALS: ReadonlySet<string> = new Set<SignalKind>([
  'hero_audit', 'duplicate_hero', 'user_hero_absent', 'tile_check', 'table_geometry',
])

export type IssueEvent =
  | 'confirmed_correct'
  | 'corrected'
  | 'region_mismatch'
  | 'unrecognized'
  | 'match_summary'
  | 'processing_error'   // a batch failed to process (extraction threw); files kept in pending for retry
  | 'tile_check'         // v1.1.1 — breakdown tile-ceiling watch; NOT an error event (see below)
  | 'table_geometry'     // v1.1.1 — scoreboard table measurement; NOT an error event

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
  // Present for hero-audit rows (one per scoreboard slot):
  slot?: number | null
  margin?: number | null
  runner_up?: string | null
  /** Which scoring scale `confidence` and `margin` are on. Pass 1 and Pass 2
   *  use different formulas, so pooling them is a category error. */
  orb_applied?: boolean | null
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

/** Log a full hero audit — ONE ROW PER SCOREBOARD SLOT.
 *  ------------------------------------------------------------
 *  This is the point of the v1.0.2 rework. The old flow logged only the slots
 *  a confidence gate chose to ask about, which could measure how often a flag
 *  was right but never how many errors went unflagged. Of the 71 wrong heroes
 *  in the beta database, 60 were never questioned at all.
 *
 *  Every slot now carries a human verdict, so `confirmed_hero` is a TRUTH
 *  LABEL and score / margin / orb_applied are features measurable against it.
 *  At ~400 matches a season that is ~4,800 labelled slots, against the 324 the
 *  manual ground-truth exercise produced.
 *
 *  Rows are inserted in one batch: 12 sequential inserts per match would be
 *  12 round-trips, and a partial failure would leave a half-audited match that
 *  looks complete. */
export async function logHeroAudit(args: {
  matchId: string
  format: '5v5' | '6v6'
  rows: Array<{
    slot: number
    team: 'ally' | 'enemy'
    role: string | null
    isUser: boolean
    readHero: string | null
    confirmedHero: string | null
    corrected: boolean
    /** Accepted via the bulk button rather than individually — recorded so
     *  bulk labels can be weighted down later if they prove unreliable. */
    bulk: boolean
    score: number
    margin: number | null
    runnerUp: string | null
    orbApplied: boolean
  }>
  reviewSeconds: number
}): Promise<{ error: unknown }> {
  const payload: IssueLogRow[] = args.rows.map(r => ({
    match_id: args.matchId,
    event: r.corrected ? 'corrected' : 'confirmed_correct',
    field: 'hero_id',
    // field_detail carries the position and how the verdict was given, so a
    // row is interpretable without joining anything.
    field_detail:
      `slot ${r.slot} · ${r.team} ${r.role ?? '?'}` +
      `${r.isUser ? ' · user' : ''}${r.bulk ? ' · bulk' : ''}` +
      ` · ${args.reviewSeconds}s review`,
    signal: 'hero_audit',
    read_value: r.readHero,
    // Written on EVERY row, not just corrections. A confirmed row's value is
    // the truth label — omitting it would discard the negative examples, which
    // are what make an error rate computable.
    corrected_value: r.confirmedHero,
    confidence: r.score,
    format: args.format,
    slot: r.slot,
    margin: r.margin,
    runner_up: r.runnerUp,
    orb_applied: r.orbApplied,
  }))

  const { error } = await supabase.from('beta_issue_log').insert(payload)
  if (error) console.warn('[beta-log] hero audit insert failed', error)
  return { error }
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

// ── Tile-ceiling watch (v1.1.1) ──────────────────────────────
//
// WHY THIS EXISTS
// The breakdown screen holds a hard maximum of 8 stat tiles (a 3x3 grid, less
// the hero-info card). The season that added D.Mon added PLAYERS PROTECTED to
// every tank; five tanks were already at 8, so the game DROPPED that hero's
// ultimate tile to fit. That is a hypothesis about how the game behaves, not a
// fact we control, so it needs watching rather than documenting once.
//
// The check asks one question — is the retired tile back? — and records the
// answer. Crucially it records the SKIPPED occurrences too: one row per
// sighting, not one row per question. A run of 'not_seen' only means something
// against a known number of chances, and counting the chances is also what
// drives the every-Nth cadence without any separate stored counter.
//
// These rows are deliberately NOT part of the error-rate or signal-precision
// maths. A tile-ceiling change is a fact about the game, not a pipeline
// mistake, and pooling it would corrupt both figures.

/** Ask on every Nth sighting of an affected hero. */
export const TILE_CHECK_EVERY = 3

export type TileCheckAnswer = 'seen' | 'not_seen' | 'skipped'

/** Pure cadence rule: ask when this sighting's NUMBER is a multiple of N.
 *
 *  ⚠️ (v1.1.3) The argument is the SIGHTING NUMBER — 1 for the first sighting
 *  ever, 2 for the second, and so on. It is NOT the count of prior rows.
 *
 *  The body was always correct. The caller in /process was passing
 *  `countTileCheckSightings()`, i.e. the number of sightings BEFORE this one,
 *  which is one less. The first sighting ever therefore arrived as 0, satisfied
 *  `0 % 3 === 0`, and the question fired on sightings 1, 4, 7 instead of 3, 6,
 *  9. Nothing here changed except this comment and the parameter name; the fix
 *  is at the call site.
 *
 *  ⚠️ A single match can contain SEVERAL sightings — logTileCheck() writes one
 *  row per watched hero played, so playing three of them advances the counter by
 *  three. The caller must therefore evaluate this per hero, as
 *  `shouldAskTileCheck(priorCount + i + 1)` for the i-th watched hero, or a
 *  match that steps the counter 0 -> 3 jumps clean over the third sighting and
 *  never asks. Do not "simplify" it back to one call per match. */
export function shouldAskTileCheck(sightingNumber: number): boolean {
  return sightingNumber % TILE_CHECK_EVERY === 0
}

/** How many sightings have been logged. Cheap COUNT — does not pull the log.
 *
 *  Group-wide across ALL watched heroes, which is intended: the cadence is
 *  "every third sighting of any affected hero", not every third sighting of
 *  each one. Returns the count BEFORE this match, so the first sighting of this
 *  match is `count + 1` — see shouldAskTileCheck(). */
export async function countTileCheckSightings(): Promise<number> {
  const { count, error } = await supabase
    .from('beta_issue_log')
    .select('id', { count: 'exact', head: true })
    .eq('event', 'tile_check')
  if (error) {
    console.warn('[beta-log] tile-check count failed', error)
    return 0
  }
  return count ?? 0
}

/** Record one sighting of an affected hero's breakdown.
 *  `answer: 'skipped'` for the sightings we did not ask about — they are the
 *  denominator, and dropping them would make a later 'seen' uninterpretable. */
export async function logTileCheck(args: {
  matchId: string
  format: '5v5' | '6v6'
  hero: string
  retiredTile: string
  answer: TileCheckAnswer
}): Promise<{ error: unknown }> {
  return logIssueEvent({
    match_id: args.matchId,
    event: 'tile_check',
    field: 'breakdown_tile',
    field_detail: args.hero,
    signal: 'tile_check',
    read_value: args.retiredTile,
    corrected_value: args.answer,
    format: args.format,
  })
}

// ── Table geometry (v1.1.1) ──────────────────────────────────
//
// WHY THIS EXISTS
// The scoreboard table is CENTRED at x~1919.5 but its WIDTH varies with
// content, so the left edge moves and every absolute x-constant in
// scoreboard-extractor.ts drifts with it. On 6v6 that reached 27px and broke
// role-icon classification and portrait cropping at the same time. 5v5 was
// recorded as staying within 4px — see the correction below, it does not.
//
// ⚠️ (v1.1.3) THE 5v5 PARAGRAPH THAT USED TO BE HERE WAS WRONG, and the "stayed
// within 4px" figure above with it. That was measured on seven boards which all
// happened to have long gamertags, therefore wide tables, therefore a left edge
// sitting exactly on the hardcoded constants. The sample could not have
// disagreed with them. Re-measured over 25 boards, real 5v5 matches span
// 1071-1108 — a 37px drift, larger than the 6v6 one this log was built for. It
// put the portrait crop on the role-icon box and every hero on those boards read
// as the same wrong hero.
//
// BOTH formats are now derived from the measured edge. This LOG is the separate
// half: it records what was measured on every scoreboard so "how much does it
// actually vary" stops depending on how many screenshots someone kept. Three
// saved boards is not a range; a season of matches is.
//
// The log now has ONE remaining consumer-facing job: the stat columns
// (E/A/D/DMG/H/MIT) are still read from unshifted constants. Measured on the
// widest (1698) and narrowest (1623) 5v5 boards every digit still lands inside
// its cell, worst case 27px of clearance — but the table is centred, so those
// columns march left as it narrows and the clearance runs out around width 1569.
// `width` here is the only advance warning. scoreboard-extractor warns below
// 1600; these rows are the history behind that warning.
//
// NOT an error event: excluded from error-rate and signal-precision maths, for
// the same reason as tile_check. A layout measurement is a fact about the game.

export async function logTableGeometry(args: {
  matchId: string
  format: '5v5' | '6v6'
  tableLeft: number
  tableWidth: number
}): Promise<{ error: unknown }> {
  return logIssueEvent({
    match_id: args.matchId,
    event: 'table_geometry',
    field: 'table_geometry',
    field_detail: `left=${args.tableLeft} width=${args.tableWidth}`,
    signal: 'table_geometry',
    read_value: String(args.tableLeft),
    corrected_value: String(args.tableWidth),
    format: args.format,
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
  /** v1.1.1 tile-ceiling watch. Sightings = every occurrence incl. skipped;
   *  asked = the ones a question was put to. `anomalies` are the ones that
   *  answered 'seen', i.e. a retired tile reappeared and the catalog is stale. */
  tileCheck: {
    sightings: number
    asked: number
    notSeen: number
    anomalies: Array<{ hero: string; tile: string; matchId: string; at: string | null }>
    byHero: Record<string, { sightings: number; asked: number; seen: number }>
  }
  /** v1.1.1 table-geometry watch, per format. `spread` is the whole point:
   *  5v5 measured 4px and 6v6 27px over the boards that exposed this. */
  tableGeometry: Record<string, {
    n: number
    leftMin: number; leftMax: number
    widthMin: number; widthMax: number
  }>
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
    tileCheck: { sightings: 0, asked: 0, notSeen: 0, anomalies: [], byHero: {} },
    tableGeometry: {},
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

    // Table geometry. Like tile_check, `continue`d out before the error maths:
    // a layout measurement is not a pipeline mistake and would corrupt both the
    // error rate and signal precision if pooled.
    if (r.event === 'table_geometry') {
      const left = Number(r.read_value)
      const width = Number(r.corrected_value)
      if (Number.isFinite(left) && Number.isFinite(width)) {
        const f = r.format ?? 'unknown'
        const g = (stats.tableGeometry[f] ??= {
          n: 0,
          leftMin: left, leftMax: left,
          widthMin: width, widthMax: width,
        })
        g.n += 1
        g.leftMin = Math.min(g.leftMin, left)
        g.leftMax = Math.max(g.leftMax, left)
        g.widthMin = Math.min(g.widthMin, width)
        g.widthMax = Math.max(g.widthMax, width)
      }
      continue
    }

    // Tile-ceiling watch. Handled BEFORE the corrected/confirmed maths and
    // `continue`d out of it — see the note on logTileCheck: these are not
    // pipeline errors and must not enter error-rate or precision.
    if (r.event === 'tile_check') {
      const hero = r.field_detail ?? 'unknown'
      const answer = (r.corrected_value ?? 'skipped') as TileCheckAnswer
      const h = (stats.tileCheck.byHero[hero] ??= { sightings: 0, asked: 0, seen: 0 })
      stats.tileCheck.sightings += 1
      h.sightings += 1
      if (answer !== 'skipped') {
        stats.tileCheck.asked += 1
        h.asked += 1
      }
      if (answer === 'not_seen') stats.tileCheck.notSeen += 1
      if (answer === 'seen') {
        h.seen += 1
        stats.tileCheck.anomalies.push({
          hero,
          tile: r.read_value ?? '(unknown tile)',
          matchId: r.match_id,
          at: r.created_at ?? null,
        })
      }
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

  lines.push('## Table geometry (v1.1.1)')
  lines.push('')
  const geo = Object.entries(s.tableGeometry).sort()
  if (geo.length === 0) {
    lines.push('_No scoreboards measured yet._')
  } else {
    lines.push('| Format | Boards | Left edge | Spread | Width | Spread |')
    lines.push('|---|---|---|---|---|---|')
    for (const [f, g] of geo) {
      lines.push(
        `| ${f} | ${g.n} | ${g.leftMin}-${g.leftMax} | ${g.leftMax - g.leftMin}px ` +
        `| ${g.widthMin}-${g.widthMax} | ${g.widthMax - g.widthMin}px |`,
      )
    }
    lines.push('')
    lines.push('> The table is centred, so the left edge moves by half the width change.')
    lines.push('> BOTH formats derive their x-constants from the left edge (v1.1.3).')
    lines.push('> Watch WIDTH, not spread: the stat columns are still unanchored and')
    lines.push('> start clipping around a 5v5 width of 1569. Observed minimum so far 1623.')
  }
  lines.push('')

  lines.push('## Tile-ceiling watch (v1.1.1)')
  lines.push('')
  if (s.tileCheck.sightings === 0) {
    lines.push('_No affected heroes played yet._')
  } else {
    lines.push(
      `${s.tileCheck.sightings} sightings · ${s.tileCheck.asked} checked ` +
      `(every ${TILE_CHECK_EVERY}th) · ${s.tileCheck.notSeen} confirmed still absent.`,
    )
    lines.push('')
    lines.push('| Hero | Sightings | Checked | Retired tile seen |')
    lines.push('|---|---|---|---|')
    for (const [hero, h] of Object.entries(s.tileCheck.byHero).sort()) {
      lines.push(`| ${hero} | ${h.sightings} | ${h.asked} | ${h.seen} |`)
    }
    lines.push('')
    if (s.tileCheck.anomalies.length === 0) {
      lines.push('> No retired tile has reappeared. The 8-tile ceiling held all season.')
      lines.push('> If `Checked` is 0 across the board, nothing was actually verified —')
      lines.push('> that is not the same result.')
    } else {
      lines.push('> ⚠️ A retired tile came back. The catalog is stale for these heroes.')
      lines.push('')
      lines.push('| Hero | Tile | Match | When |')
      lines.push('|---|---|---|---|')
      for (const a of s.tileCheck.anomalies) {
        lines.push(`| ${a.hero} | \`${a.tile}\` | ${a.matchId} | ${a.at ?? '—'} |`)
      }
    }
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
