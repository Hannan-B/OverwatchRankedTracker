'use client'

// ============================================================
// Step 6f — Issue Log page (menu tab)
// Reads beta_issue_log, shows season confidence metrics, lists corrections,
// the new-content ledger, and processing failures (v16). Downloads the .md
// report. Bottom "danger zone": Start New Season — archives (report + raw rows)
// then clears the log rows only (never match data), two-step confirmed.
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
    <div className="bg-ow-panel rounded-lg border border-white/10 p-4">
      <p className="text-xs font-display tracking-wider text-slate-500 uppercase">{label}</p>
      <p className="text-2xl text-white font-bold mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>}
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

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-[0.12em] text-slate-100 uppercase">Issue Log</h1>
          <p className="text-sm text-slate-400 mt-1">
            Beta-season extraction confidence · {s.matchesProcessed} match{s.matchesProcessed !== 1 ? 'es' : ''}
          </p>
        </div>
        <button onClick={downloadReport}
          disabled={rows.length === 0}
          className="shrink-0 bg-ow-panel border border-white/10 text-white font-display
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
          hint={s.matchesProcessed > 0 ? `${(s.totalQuestionsAsked / s.matchesProcessed).toFixed(2)} questions/match` : undefined} />
        <StatTile label="Overall error rate" value={pct(overallErrorRate)}
          hint={`${s.totalCorrected} corrected / ${fieldsProcessed} fields`} />
        <StatTile label="Confirmed correct" value={String(s.totalConfirmedCorrect)} hint="true negatives (the denominator)" />
        <StatTile label="Corrected" value={String(s.totalCorrected)} hint="real errors caught" />
      </div>

      <section>
        <h2 className="text-sm font-display tracking-wider text-slate-300 mb-2 uppercase">Signal precision</h2>
        <p className="text-xs text-slate-500 mb-3">
          How often each flag was a real error. Low precision → relax that threshold; it&apos;s over-firing.
        </p>
        <div className="bg-ow-panel rounded-lg border border-white/10 divide-y divide-white/5">
          {Object.keys(s.precisionBySignal).length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No signals logged yet.</p>
          ) : Object.entries(s.precisionBySignal).sort().map(([sig, e]) => (
            <div key={sig} className="flex items-center justify-between p-3">
              <span className="text-sm text-slate-300 font-mono">{sig}</span>
              <span className="text-xs text-slate-500">
                {e.corrected}/{e.corrected + e.confirmed} → <span className="text-white font-bold">{pct(e.precision)}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-display tracking-wider text-slate-300 mb-2 uppercase">
          Corrections ({corrections.length})
        </h2>
        {corrections.length === 0 ? (
          <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-4 text-sm text-ow-victory">
            No corrections logged — pipeline clean so far.
          </div>
        ) : (
          <div className="bg-ow-panel rounded-lg border border-white/10 divide-y divide-white/5">
            {corrections.map((r, i) => (
              <div key={i} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-slate-300 truncate">{r.field_detail ?? r.field}</p>
                  <p className="text-[11px] text-slate-500 font-mono">{r.match_id} · {r.signal}</p>
                </div>
                <div className="text-sm whitespace-nowrap">
                  <span className="text-ow-defeat line-through">{r.read_value}</span>
                  <span className="text-slate-500 mx-1">→</span>
                  <span className="text-ow-victory font-bold">{r.corrected_value}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-display tracking-wider text-slate-300 mb-2 uppercase">
          New-content ledger ({s.unrecognizedLedger.length})
        </h2>
        <p className="text-xs text-slate-500 mb-3">
          Unrecognized heroes / maps / modes / stats — each is a heads-up to add a catalog entry.
        </p>
        {s.unrecognizedLedger.length === 0 ? (
          <p className="text-sm text-slate-500">None seen.</p>
        ) : (
          <div className="bg-ow-panel rounded-lg border border-white/10 divide-y divide-white/5">
            {s.unrecognizedLedger.map((u, i) => (
              <div key={i} className="p-3 flex items-center justify-between gap-3">
                <span className="text-sm text-slate-300 truncate">{u.fieldDetail}</span>
                <span className="text-xs text-slate-500 font-mono">{u.value}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-display tracking-wider text-slate-300 mb-2 uppercase">
          Processing failures ({s.totalProcessingErrors})
        </h2>
        <p className="text-xs text-slate-500 mb-3">
          Batches that couldn&apos;t be processed — their screenshots are kept in storage for retry.
        </p>
        {s.processingErrors.length === 0 ? (
          <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-4 text-sm text-ow-victory">
            None — every batch processed.
          </div>
        ) : (
          <div className="bg-ow-panel rounded-lg border border-white/10 divide-y divide-white/5">
            {s.processingErrors.map((e, i) => (
              <div key={i} className="p-3">
                <p className="text-[11px] text-slate-500 font-mono">{e.matchId}</p>
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
            <p className="text-xs text-slate-400">
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
            <div className="space-y-3 bg-ow-dark rounded-lg p-4 border border-white/10">
              <p className="text-sm text-slate-200 font-display tracking-wide">Step 1 of 2 — download the archive</p>
              <p className="text-xs text-slate-400">
                This will download <span className="text-slate-200">season-archive-{new Date().toISOString().slice(0, 10)}.md</span>
                {' '}containing all {rows.length} rows. Nothing is deleted yet.
              </p>
              <div className="flex gap-2 flex-wrap">
                <button onClick={archiveThenConfirm}
                  className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                             px-4 py-2 rounded-lg tracking-wider text-xs transition-colors">
                  DOWNLOAD ARCHIVE
                </button>
                <button onClick={cancelReset}
                  className="bg-ow-panel border border-white/10 text-slate-300 font-display
                             px-4 py-2 rounded-lg tracking-wider text-xs hover:border-white/20 transition-colors">
                  CANCEL
                </button>
              </div>
            </div>
          )}

          {resetPhase === 'confirm2' && (
            <div className="space-y-3 bg-ow-dark rounded-lg p-4 border border-ow-defeat/30">
              <p className="text-sm text-ow-defeat font-display tracking-wide">Step 2 of 2 — confirm permanent delete</p>
              <p className="text-xs text-slate-400">
                Your archive download has been triggered. <span className="text-slate-200">Check your downloads folder
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
                  className="bg-ow-panel border border-white/10 text-slate-300 font-display
                             px-4 py-2 rounded-lg tracking-wider text-xs hover:border-white/20 transition-colors">
                  CANCEL
                </button>
              </div>
            </div>
          )}

          {resetPhase === 'working' && (
            <div className="flex items-center gap-3 text-sm text-slate-300 font-display tracking-wider">
              <div className="w-5 h-5 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin" />
              CLEARING…
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
