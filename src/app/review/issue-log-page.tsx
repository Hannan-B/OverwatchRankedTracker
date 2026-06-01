'use client'

// ============================================================
// Step 6f — Issue Log page (menu tab)
// Reads beta_issue_log, shows season confidence metrics, lists corrections and
// the new-content ledger, and downloads the .md report (generated from rows).
// ============================================================

import { useEffect, useState } from 'react'
import {
  fetchIssueLog, aggregate, generateIssueReportMarkdown,
  type IssueLogRow, type SeasonStats,
} from '@/lib/beta-issue-log'

function pct(n: number) { return `${(n * 100).toFixed(1)}%` }

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-ow-panel rounded-lg border border-white/5 p-4">
      <p className="text-xs font-display tracking-wider text-slate-500">{label}</p>
      <p className="text-2xl text-white font-bold mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>}
    </div>
  )
}

export default function IssueLogPage() {
  const [rows, setRows] = useState<IssueLogRow[]>([])
  const [stats, setStats] = useState<SeasonStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchIssueLog().then(r => {
      setRows(r)
      setStats(aggregate(r))
      setLoading(false)
    })
  }, [])

  function downloadReport() {
    const md = generateIssueReportMarkdown(rows)
    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `beta-issue-report-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
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
          <p className="text-sm text-slate-400 mt-1">Beta-season extraction confidence</p>
        </div>
        <button onClick={downloadReport}
          disabled={rows.length === 0}
          className="bg-ow-panel border border-white/10 text-white font-display
                     px-4 py-2 rounded-lg tracking-wider text-xs hover:border-ow-orange/30
                     disabled:opacity-40 transition-colors">
          ↓ DOWNLOAD .MD
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatTile label="MATCHES" value={String(s.matchesProcessed)}
          hint={s.matchesProcessed > 0 ? `${(s.totalQuestionsAsked / s.matchesProcessed).toFixed(2)} questions/match` : undefined} />
        <StatTile label="OVERALL ERROR RATE" value={pct(overallErrorRate)}
          hint={`${s.totalCorrected} corrected / ${fieldsProcessed} fields`} />
        <StatTile label="CONFIRMED CORRECT" value={String(s.totalConfirmedCorrect)} hint="true negatives (the denominator)" />
        <StatTile label="CORRECTED" value={String(s.totalCorrected)} hint="real errors caught" />
      </div>

      <section>
        <h2 className="text-sm font-display tracking-wider text-slate-300 mb-2">SIGNAL PRECISION</h2>
        <p className="text-xs text-slate-500 mb-3">
          How often each flag was a real error. Low precision → relax that threshold; it’s over-firing.
        </p>
        <div className="bg-ow-panel rounded-lg border border-white/5 divide-y divide-white/5">
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
        <h2 className="text-sm font-display tracking-wider text-slate-300 mb-2">
          CORRECTIONS ({corrections.length})
        </h2>
        {corrections.length === 0 ? (
          <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-4 text-sm text-ow-victory">
            No corrections logged — pipeline clean so far.
          </div>
        ) : (
          <div className="bg-ow-panel rounded-lg border border-white/5 divide-y divide-white/5">
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
        <h2 className="text-sm font-display tracking-wider text-slate-300 mb-2">
          NEW-CONTENT LEDGER ({s.unrecognizedLedger.length})
        </h2>
        <p className="text-xs text-slate-500 mb-3">
          Unrecognized heroes / maps / modes / stats — each is a heads-up to add a catalog entry.
        </p>
        {s.unrecognizedLedger.length === 0 ? (
          <p className="text-sm text-slate-500">None seen.</p>
        ) : (
          <div className="bg-ow-panel rounded-lg border border-white/5 divide-y divide-white/5">
            {s.unrecognizedLedger.map((u, i) => (
              <div key={i} className="p-3 flex items-center justify-between gap-3">
                <span className="text-sm text-slate-300 truncate">{u.fieldDetail}</span>
                <span className="text-xs text-slate-500 font-mono">{u.value}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
