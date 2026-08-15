'use client'

// ============================================================
// Step 6f — Issue Log page (menu tab)
// Reads beta_issue_log, shows season confidence metrics, lists corrections and
// the new-content ledger, and downloads the .md report (generated from rows).
// ============================================================

import { useEffect, useState } from 'react'
import {
  fetchIssueLog, aggregate, generateIssueReportMarkdown, TILE_CHECK_EVERY,
  generateSeasonArchiveMarkdown, clearIssueLog,
  type IssueLogRow, type SeasonStats,
} from '@/lib/beta-issue-log'
import { RETIRED_TILE_BY_HERO } from '@/data/hero-stat-catalog'

function pct(n: number) { return `${(n * 100).toFixed(1)}%` }

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-ow-panel rounded-lg border border-ow-line p-4">
      <p className="text-xs font-display tracking-wider text-ow-faint">{label}</p>
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
        <div className="w-8 h-8 border-3 border-ow-orange border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    )
  }

  const s = stats!
  const fieldsProcessed = s.totalAutoPassFields + s.totalConfirmedCorrect + s.totalCorrected
  const overallErrorRate = fieldsProcessed > 0 ? s.totalCorrected / fieldsProcessed : 0
  const corrections = rows.filter(r => r.event === 'corrected')

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl text-ow-orange">Issue Log</h1>
          <p className="text-sm text-ow-muted mt-1">Beta-season extraction confidence</p>
        </div>
        <button onClick={downloadReport}
          disabled={rows.length === 0}
          className="bg-ow-panel border border-ow-line text-ow-fg font-display
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
        <StatTile label="MATCHES" value={String(s.matchesProcessed)}
          hint={s.matchesProcessed > 0 ? `${(s.totalQuestionsAsked / s.matchesProcessed).toFixed(2)} questions/match` : undefined} />
        <StatTile label="OVERALL ERROR RATE" value={pct(overallErrorRate)}
          hint={`${s.totalCorrected} corrected / ${fieldsProcessed} fields`} />
        <StatTile label="CONFIRMED CORRECT" value={String(s.totalConfirmedCorrect)} hint="true negatives (the denominator)" />
        <StatTile label="CORRECTED" value={String(s.totalCorrected)} hint="real errors caught" />
      </div>

      <section>
        <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2">SIGNAL PRECISION</h2>
        <p className="text-xs text-ow-faint mb-3">
          How often each flag was a real error. Low precision → relax that threshold; it’s over-firing.
        </p>
        <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
          {Object.keys(s.precisionBySignal).length === 0 ? (
            <p className="p-4 text-sm text-ow-faint">No signals logged yet.</p>
          ) : Object.entries(s.precisionBySignal).sort().map(([sig, e]) => (
            <div key={sig} className="flex items-center justify-between p-3">
              <span className="text-sm text-ow-muted font-mono">{sig}</span>
              <span className="text-xs text-ow-faint">
                {e.corrected}/{e.corrected + e.confirmed} → <span className="text-ow-fg font-bold">{pct(e.precision)}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2">
          CORRECTIONS ({corrections.length})
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
        <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2">
          TILE-CEILING WATCH ({s.tileCheck.asked}/{s.tileCheck.sightings})
        </h2>
        <p className="text-xs text-ow-faint mb-3">
          {Object.keys(RETIRED_TILE_BY_HERO).length} tanks lost their ultimate tile when
          PLAYERS PROTECTED arrived. One sighting in {TILE_CHECK_EVERY} asks whether it came
          back. Every sighting is logged, including the ones not asked about {'\u2014'} a run
          of {'\u201c'}still gone{'\u201d'} only means something against the number of chances.
        </p>
        {s.tileCheck.sightings === 0 ? (
          <p className="text-sm text-ow-faint">No affected heroes played yet.</p>
        ) : (
          <>
            <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
              {Object.entries(s.tileCheck.byHero).sort().map(([hero, h]) => (
                <div key={hero} className="flex items-center justify-between p-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ow-muted truncate">{hero}</p>
                    <p className="text-[11px] text-ow-faint">
                      {h.sightings} sighting{h.sightings === 1 ? '' : 's'} {'\u00b7'} {h.asked} checked
                    </p>
                  </div>
                  <span className={`text-xs font-display tracking-wider whitespace-nowrap
                    ${h.seen > 0 ? 'text-ow-defeat' : h.asked > 0 ? 'text-ow-victory' : 'text-ow-faint'}`}>
                    {h.seen > 0 ? `TILE BACK \u00d7${h.seen}` : h.asked > 0 ? 'STILL GONE' : 'NOT YET CHECKED'}
                  </span>
                </div>
              ))}
            </div>
            {s.tileCheck.asked === 0 ? (
              <p className="text-xs text-ow-faint mt-2">
                Nothing verified yet {'\u2014'} that is not the same as the ceiling holding.
              </p>
            ) : s.tileCheck.anomalies.length > 0 ? (
              <div className="bg-ow-defeat/10 border border-ow-defeat/30 rounded-lg p-3 mt-2">
                <p className="text-sm text-ow-defeat font-display tracking-wider">
                  A RETIRED TILE CAME BACK
                </p>
                <p className="text-xs text-ow-defeat/80 mt-0.5">
                  The catalog is stale for {s.tileCheck.anomalies.map(a => a.hero).join(', ')}.
                  Re-check tileCount and stats in hero-stat-catalog.ts.
                </p>
              </div>
            ) : (
              <p className="text-xs text-ow-faint mt-2">
                {s.tileCheck.notSeen} confirmation{s.tileCheck.notSeen === 1 ? '' : 's'} that the
                ceiling still holds.
              </p>
            )}
          </>
        )}
      </section>

      <section>
        <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2">
          TABLE GEOMETRY
        </h2>
        <p className="text-xs text-ow-faint mb-3">
          The scoreboard table is centred, so when its width changes the left edge moves by
          half as much and every fixed x-coordinate drifts with it. 6v6 coordinates are now
          DERIVED from the measured edge; 5v5 are still hardcoded because its spread was
          small. Spread is the number to watch.
        </p>
        {Object.keys(s.tableGeometry).length === 0 ? (
          <p className="text-sm text-ow-faint">No scoreboards measured yet.</p>
        ) : (
          <>
            <div className="bg-ow-panel rounded-lg border border-ow-line divide-y divide-ow-line/60">
              {Object.entries(s.tableGeometry).sort().map(([fmt, g]) => {
                const leftSpread = g.leftMax - g.leftMin
                const derived = fmt === '6v6'
                return (
                  <div key={fmt} className="p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-ow-muted">
                        {fmt}{' '}
                        <span className="text-[11px] text-ow-faint">
                          {derived ? '(derived)' : '(hardcoded)'}
                        </span>
                      </p>
                      <p className="text-[11px] text-ow-faint font-mono">
                        {g.n} board{g.n === 1 ? '' : 's'} {'\u00b7'} left {g.leftMin}
                        {'\u2013'}{g.leftMax} {'\u00b7'} width {g.widthMin}{'\u2013'}{g.widthMax}
                      </p>
                    </div>
                    <span className={`text-xs font-display tracking-wider whitespace-nowrap
                      ${derived ? 'text-ow-muted' : leftSpread > 15 ? 'text-ow-defeat' : 'text-ow-victory'}`}>
                      {leftSpread}px SPREAD
                    </span>
                  </div>
                )
              })}
            </div>
            {(s.tableGeometry['5v5']?.leftMax ?? 0) - (s.tableGeometry['5v5']?.leftMin ?? 0) > 15 && (
              <div className="bg-ow-defeat/10 border border-ow-defeat/30 rounded-lg p-3 mt-2">
                <p className="text-sm text-ow-defeat font-display tracking-wider">
                  5v5 IS NOW DRIFTING
                </p>
                <p className="text-xs text-ow-defeat/80 mt-0.5">
                  Its coordinates are still hardcoded. Derive them from the table edge the way
                  6v6 does {'\u2014'} see KNOWN-FAILURE-MODES.md {'\u00a7'}14.
                </p>
              </div>
            )}
          </>
        )}
      </section>

      <section>
        <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2">
          NEW-CONTENT LEDGER ({s.unrecognizedLedger.length})
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
        <h2 className="text-sm font-display tracking-wider text-ow-muted mb-2">
          PROCESSING FAILURES ({s.totalProcessingErrors})
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
