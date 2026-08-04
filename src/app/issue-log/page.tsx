'use client'

// ============================================================
// Issue Log page (menu tab)
// ------------------------------------------------------------
// Reads beta_issue_log, shows season confidence metrics, lists corrections,
// the new-content ledger, and processing failures (v16). Downloads the .md
// report. Bottom "danger zone": Start New Season — archives (report + raw rows)
// then clears the log rows only (never match data), two-step confirmed.
//
// (v1.0.2) REWORKED FOR THE HERO AUDIT.
// Beta confirmation is sunset. The log now records ONE ROW PER SCOREBOARD SLOT
// (signal 'hero_audit'), confirmed and corrected alike, rather than one row per
// question a confidence gate chose to ask. That changes what the numbers mean:
//
//   · "Confirmed correct" is now ~10-12 per match, not per question. It is the
//     denominator, and it is the reason a real error RATE is computable at all.
//   · Signal precision is near-meaningless now — there is effectively one live
//     signal. It is kept for HISTORICAL rows and labelled as such.
//   · The useful cuts are the new ones below: error rate by scoring scale, by
//     margin band, and the confusion pairs.
//
// ⚠️ Pass 1 and Pass 2 score on DIFFERENT formulas (0.6*structural+0.4*colour
// vs 0.5*orb+0.3*structural+0.2*colour), so `confidence` and `margin` are NOT
// comparable across them. Every cut below that touches those columns splits by
// orb_applied. Pooling them is what made an OpenCV heap leak invisible for four
// full test runs.
// ============================================================

import { useEffect, useState } from 'react'
import {
  fetchIssueLog, aggregate, generateIssueReportMarkdown,
  generateSeasonArchiveMarkdown, clearIssueLog,
  type IssueLogRow, type SeasonStats,
} from '@/lib/beta-issue-log'

function pct(n: number) { return `${(n * 100).toFixed(1)}%` }

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-ow-panel rounded-lg border border-ow-line p-4">
      <p className="text-xs font-display tracking-wider text-ow-faint uppercase">{label}</p>
      <p className="text-2xl text-ow-fg font-bold mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-ow-faint mt-0.5">{hint}</p>}
    </div>
  )
}

// Download a string as a .md file. Returns true if the blob was created and the
// download triggered without throwing; throws are surfaced to the caller so the
// reset can ABORT before deleting anything.
function downloadMarkdown(md: string, filename: string) {
  const blob = new Blob([md], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

type ResetPhase = 'idle' | 'confirm1' | 'confirm2' | 'working'

export default function IssueLogPage() {
  const [rows, setRows] = useState<IssueLogRow[]>([])
  const [stats, setStats] = useState<SeasonStats | null>(null)
  const [loading, setLoading] = useState(true)

  const [resetPhase, setResetPhase] = useState<ResetPhase>('idle')
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetDone, setResetDone] = useState(false)

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    const r = await fetchIssueLog()
    setRows(r)
    setStats(aggregate(r))
    setLoading(false)
  }

  function downloadReport() {
    try {
      downloadMarkdown(
        generateIssueReportMarkdown(rows),
        `beta-issue-report-${new Date().toISOString().slice(0, 10)}.md`,
      )
    } catch (err) {
      console.error('Download failed:', err)
    }
  }

  // Step 1 of the reset: build + download the archive. Only on success do we
  // advance to the final confirm. Any failure aborts (nothing deleted).
  function archiveThenConfirm() {
    setResetError(null)
    try {
      downloadMarkdown(
        generateSeasonArchiveMarkdown(rows),
        `season-archive-${new Date().toISOString().slice(0, 10)}.md`,
      )
      setResetPhase('confirm2')
    } catch (err: any) {
      setResetError(
        'Archive download failed, so nothing was deleted. ' +
        (err?.message ? `(${err.message}) ` : '') +
        'Please try again.',
      )
      setResetPhase('idle')
    }
  }

  // Step 2 of the reset: actually clear the rows (archive already downloaded).
  async function executeReset() {
    setResetPhase('working')
    setResetError(null)
    const { error, deleted } = await clearIssueLog()
    if (error || !deleted) {
      setResetError('Failed to clear the log. No rows were removed — your data is intact.')
      setResetPhase('idle')
      return
    }
    setResetDone(true)
    setResetPhase('idle')
    await load()
  }

  function cancelReset() {
    setResetPhase('idle')
    setResetError(null)
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto py-12 text-center">
        <div className="w-8 h-8 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    )
  }

  const s = stats!
  const fieldsProcessed = s.totalAutoPassFields + s.totalConfirmedCorrect + s.totalCorrected
  const overallErrorRate = fieldsProcessed > 0 ? s.totalCorrected / fieldsProcessed : 0
  const corrections = rows.filter(r => r.event === 'corrected')

  // ── Hero-audit cuts (v1.0.2) ───────────────────────────────
  // Computed here rather than in aggregate() because they are specific to the
  // per-slot grain and would be meaningless against historical rows.
  const auditRows = rows.filter(r => r.signal === 'hero_audit')
  const auditErrors = auditRows.filter(r => r.event === 'corrected')
  const auditErrorRate = auditRows.length > 0 ? auditErrors.length / auditRows.length : 0

  // Split by scoring scale — never pooled.
  const byScale = (['pass2', 'pass1'] as const).map(kind => {
    const want = kind === 'pass2'
    const set = auditRows.filter(r => !!r.orb_applied === want)
    const err = set.filter(r => r.event === 'corrected').length
    return {
      kind,
      label: want ? 'Pass 2 (with ORB)' : 'Pass 1 (no ORB)',
      total: set.length,
      errors: err,
      rate: set.length > 0 ? err / set.length : 0,
    }
  })

  // Error rate by margin band, split by scale. This is the cut that would let a
  // future confidence gate be calibrated from data instead of guessed at.
  const BANDS: Array<[string, number, number]> = [
    ['< 0.03', 0, 0.03], ['0.03 – 0.06', 0.03, 0.06],
    ['0.06 – 0.10', 0.06, 0.10], ['0.10 – 0.20', 0.10, 0.20], ['≥ 0.20', 0.20, Infinity],
  ]
  const marginBands = BANDS.map(([label, lo, hi]) => {
    const set = auditRows.filter(r => typeof r.margin === 'number' && r.margin! >= lo && r.margin! < hi)
    const err = set.filter(r => r.event === 'corrected').length
    return { label, total: set.length, errors: err, rate: set.length > 0 ? err / set.length : 0 }
  }).filter(b => b.total > 0)

  // What gets mistaken for what. The beta's worst offenders were Anran (78%)
  // and Emre (75%); this is how that gets spotted without ground truth.
  const confusionMap = new Map<string, number>()
  for (const r of auditErrors) {
    if (!r.read_value || !r.corrected_value) continue
    const key = `${r.corrected_value} → ${r.read_value}`
    confusionMap.set(key, (confusionMap.get(key) ?? 0) + 1)
  }
  const confusions = [...confusionMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)

  // Bulk-confirmed rows are labels given without looking at that row
  // individually. If their error rate is materially LOWER than individually
  // confirmed rows, they are being rubber-stamped and should be discounted.
  const bulkRows = auditRows.filter(r => (r.field_detail ?? '').includes('· bulk'))
  const bulkShare = auditRows.length > 0 ? bulkRows.length / auditRows.length : 0

  const historicalSignals = Object.entries(s.precisionBySignal).filter(([sig]) => sig !== 'hero_audit')

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-[0.12em] text-ow-fg uppercase">Issue Log</h1>
          <p className="text-sm text-ow-muted mt-1">
            Beta-season extraction confidence · {s.matchesProcessed} match{s.matchesProcessed !== 1 ? 'es' : ''}
          </p>
        </div>
        <button onClick={downloadReport}
          disabled={rows.length === 0}
          className="shrink-0 bg-ow-panel border border-ow-line text-ow-fg font-display
                     px-4 py-2 rounded-lg tracking-wider text-xs hover:border-ow-orange/30
                     disabled:opacity-40 transition-colors">
          ↓ DOWNLOAD .MD
        </button>
      </div>

      {resetDone && (
        <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-4 text-sm text-ow-victory">
          ✓ New season started — the issue log has been cleared. Your archive was downloaded; match data is untouched.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Matches" value={String(s.matchesProcessed)}
          hint={s.matchesProcessed > 0 ? `${(s.totalQuestionsAsked / s.matchesProcessed).toFixed(1)} slots audited/match` : undefined} />
        <StatTile label="Hero error rate" value={pct(auditErrorRate)}
          hint={`${auditErrors.length} wrong / ${auditRows.length} slots audited`} />
        <StatTile label="Slots confirmed" value={String(auditRows.length - auditErrors.length)}
          hint="true negatives — the denominator" />
        <StatTile label="Slots corrected" value={String(auditErrors.length)} hint="real errors caught" />
      </div>

      {auditRows.length === 0 && (
        <div className="bg-ow-panel border border-ow-line rounded-lg p-4 text-sm text-ow-muted">
          No hero-audit rows yet. The cuts below populate once matches are saved through
          the audit panel; the sections after them cover historical beta-confirmation rows.
        </div>
      )}

      {auditRows.length > 0 && (
        <section>
          <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2 uppercase">Error rate by scoring scale</h2>
          <p className="text-xs text-ow-faint mb-3">
            Pass 1 and Pass 2 use different formulas, so their scores are never pooled.
            A sudden collapse in the Pass 2 share means ORB has stopped running.
          </p>
          <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
            {byScale.map(b => (
              <div key={b.kind} className="flex items-center justify-between p-3">
                <span className="text-sm text-ow-muted">{b.label}</span>
                <span className="text-xs text-ow-faint">
                  {b.errors}/{b.total} → <span className="text-ow-fg font-bold">{pct(b.rate)}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {marginBands.length > 0 && (
        <section>
          <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2 uppercase">Error rate by margin</h2>
          <p className="text-xs text-ow-faint mb-3">
            Best-vs-runner-up gap. The only confidence measure comparable across both
            scales — and the cut that lets a future gate be calibrated from data rather
            than guessed at.
          </p>
          <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
            {marginBands.map(b => (
              <div key={b.label} className="flex items-center justify-between p-3">
                <span className="text-sm text-ow-muted font-mono">{b.label}</span>
                <span className="text-xs text-ow-faint">
                  {b.errors}/{b.total} → <span className="text-ow-fg font-bold">{pct(b.rate)}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {confusions.length > 0 && (
        <section>
          <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2 uppercase">
            Confusion pairs ({confusions.length})
          </h2>
          <p className="text-xs text-ow-faint mb-3">
            True hero → what the matcher said. A pair that recurs is a portrait problem,
            not bad luck — the beta&apos;s worst were Anran (78% missed) and Emre (75%).
          </p>
          <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
            {confusions.map(([pair, n]) => (
              <div key={pair} className="flex items-center justify-between p-3 gap-3">
                <span className="text-sm text-ow-muted truncate">{pair}</span>
                <span className="text-xs text-ow-fg font-bold tabular-nums">{n}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {bulkRows.length > 0 && (
        <section>
          <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2 uppercase">Bulk-confirmed slots</h2>
          <div className="bg-ow-panel rounded-lg border border-ow-line p-4">
            <p className="text-sm text-ow-fg">
              {bulkRows.length} of {auditRows.length} slots ({pct(bulkShare)}) were accepted via
              &ldquo;confirm remaining&rdquo; rather than individually.
            </p>
            <p className="text-xs text-ow-faint mt-1">
              A high share is not wrong in itself — most rows are correct. But if these show a
              much LOWER error rate than individually-confirmed ones, they are being
              rubber-stamped and should be discounted rather than trusted as labels.
            </p>
          </div>
        </section>
      )}

      {historicalSignals.length > 0 && (
        <section>
          <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2 uppercase">
            Signal precision (historical)
          </h2>
          <p className="text-xs text-ow-faint mb-3">
            Beta-confirmation rows from before v1.0.2. Retained for reference only — those
            checks are retired, and the hero audit does not use a confidence gate.
          </p>
          <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
            {historicalSignals.sort().map(([sig, e]) => (
              <div key={sig} className="flex items-center justify-between p-3">
                <span className="text-sm text-ow-muted font-mono">{sig}</span>
                <span className="text-xs text-ow-faint">
                  {e.corrected}/{e.corrected + e.confirmed} → <span className="text-ow-fg font-bold">{pct(e.precision)}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2 uppercase">
          Corrections ({corrections.length})
        </h2>
        {corrections.length === 0 ? (
          <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-4 text-sm text-ow-victory">
            No corrections logged — pipeline clean so far.
          </div>
        ) : (
          <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
            {corrections.map((r, i) => (
              <div key={i} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-ow-muted truncate">{r.field_detail ?? r.field}</p>
                  <p className="text-[11px] text-ow-faint font-mono">{r.match_id} · {r.signal}</p>
                </div>
                <div className="text-sm whitespace-nowrap">
                  <span className="text-ow-defeat line-through">{r.read_value}</span>
                  <span className="text-ow-faint mx-1">→</span>
                  <span className="text-ow-victory font-bold">{r.corrected_value}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2 uppercase">
          New-content ledger ({s.unrecognizedLedger.length})
        </h2>
        <p className="text-xs text-ow-faint mb-3">
          Unrecognized heroes / maps / modes / stats — each is a heads-up to add a catalog entry.
        </p>
        {s.unrecognizedLedger.length === 0 ? (
          <p className="text-sm text-ow-faint">None seen.</p>
        ) : (
          <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
            {s.unrecognizedLedger.map((u, i) => (
              <div key={i} className="p-3 flex items-center justify-between gap-3">
                <span className="text-sm text-ow-muted truncate">{u.fieldDetail}</span>
                <span className="text-xs text-ow-faint font-mono">{u.value}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2 uppercase">
          Processing failures ({s.totalProcessingErrors})
        </h2>
        <p className="text-xs text-ow-faint mb-3">
          Batches that couldn&apos;t be processed — their screenshots are kept in storage for retry.
        </p>
        {s.processingErrors.length === 0 ? (
          <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-4 text-sm text-ow-victory">
            None — every batch processed.
          </div>
        ) : (
          <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
            {s.processingErrors.map((e, i) => (
              <div key={i} className="p-3">
                <p className="text-[11px] text-ow-faint font-mono">{e.matchId}</p>
                <p className="text-sm text-ow-defeat/90 mt-0.5">{e.message}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Danger zone: Start New Season ── */}
      <section className="pt-4">
        <div className="bg-ow-defeat/5 border border-ow-defeat/30 rounded-lg p-5 space-y-3">
          <div>
            <h2 className="text-sm font-display tracking-wider text-ow-defeat mb-1 uppercase">Danger zone</h2>
            <p className="text-xs text-ow-muted">
              Start a new season: download a full archive (this report plus every raw row),
              then permanently clear the issue log. This affects the issue log only —
              your matches, heroes, and scoreboard data are never touched.
            </p>
          </div>

          {resetError && (
            <div className="bg-ow-defeat/10 border border-ow-defeat/30 rounded-lg px-4 py-3 text-sm text-ow-defeat">
              {resetError}
            </div>
          )}

          {resetPhase === 'idle' && (
            <button onClick={() => setResetPhase('confirm1')}
              disabled={rows.length === 0}
              className="bg-transparent border border-ow-defeat/40 text-ow-defeat font-display
                         px-4 py-2 rounded-lg tracking-wider text-xs hover:bg-ow-defeat/10
                         disabled:opacity-40 transition-colors">
              START NEW SEASON
            </button>
          )}

          {resetPhase === 'confirm1' && (
            <div className="space-y-3 bg-ow-dark rounded-lg p-4 border border-ow-line">
              <p className="text-sm text-ow-fg font-display tracking-wide">Step 1 of 2 — download the archive</p>
              <p className="text-xs text-ow-muted">
                This will download <span className="text-ow-fg">season-archive-{new Date().toISOString().slice(0, 10)}.md</span>
                {' '}containing all {rows.length} rows. Nothing is deleted yet.
              </p>
              <div className="flex gap-2 flex-wrap">
                <button onClick={archiveThenConfirm}
                  className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                             px-4 py-2 rounded-lg tracking-wider text-xs transition-colors">
                  DOWNLOAD ARCHIVE
                </button>
                <button onClick={cancelReset}
                  className="bg-ow-panel border border-ow-line text-ow-muted font-display
                             px-4 py-2 rounded-lg tracking-wider text-xs hover:border-ow-line transition-colors">
                  CANCEL
                </button>
              </div>
            </div>
          )}

          {resetPhase === 'confirm2' && (
            <div className="space-y-3 bg-ow-dark rounded-lg p-4 border border-ow-defeat/30">
              <p className="text-sm text-ow-defeat font-display tracking-wide">Step 2 of 2 — confirm permanent delete</p>
              <p className="text-xs text-ow-muted">
                Your archive download has been triggered. <span className="text-ow-fg">Check your downloads folder
                and confirm the file is there</span> before continuing — this next step permanently
                clears all {rows.length} issue-log rows and cannot be undone.
              </p>
              <div className="flex gap-2 flex-wrap">
                <button onClick={executeReset}
                  className="bg-ow-defeat hover:bg-ow-defeat/80 text-white font-display font-bold
                             px-4 py-2 rounded-lg tracking-wider text-xs transition-colors">
                  I HAVE THE ARCHIVE — CLEAR THE LOG
                </button>
                <button onClick={cancelReset}
                  className="bg-ow-panel border border-ow-line text-ow-muted font-display
                             px-4 py-2 rounded-lg tracking-wider text-xs hover:border-ow-line transition-colors">
                  CANCEL
                </button>
              </div>
            </div>
          )}

          {resetPhase === 'working' && (
            <div className="flex items-center gap-3 text-sm text-ow-muted font-display tracking-wider">
              <div className="w-5 h-5 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin" />
              CLEARING…
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
