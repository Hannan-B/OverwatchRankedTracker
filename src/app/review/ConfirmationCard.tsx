'use client'

// ============================================================
// Step 6f — ConfirmationCard (with source-image highlight)
// Shows the source screenshot the value came from, with a highlight box over
// the exact region (when grid coordinates are available). Three actions:
//   CORRECT      — the read is right
//   FIX IT       — type the right value
//   WRONG AREA   — the highlighted box is in the wrong place (region_mismatch)
// ============================================================

import { useState } from 'react'
import type { ConfirmationCandidate } from '@/lib/beta-confirmation'

export type ConfirmOutcome = 'confirmed_correct' | 'corrected' | 'region_mismatch'

export interface ConfirmationResult {
  candidate: ConfirmationCandidate
  outcome: ConfirmOutcome
  /** set only when outcome === 'corrected' */
  correctedValue: string | null
}

const SIGNAL_LABEL: Record<string, string> = {
  unrecognized: 'Unrecognized',
  vote_split: 'Uncertain read',
  avg_crosscheck_fail: 'Doesn\u2019t add up',
  low_hero_conf: 'Low confidence',
  phase_disagreement: 'Conflicting reads',
  low_user_margin: 'Close call',
  sampled_summary: 'Spot-check',
}

function HighlightImage({ region }: { region: NonNullable<ConfirmationCandidate['region']> }) {
  const box = region.box
  return (
    <div className="relative rounded overflow-hidden bg-ow-dark border border-white/10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={region.imageUrl} alt="source screenshot" className="w-full object-contain max-h-72" />
      {box && (
        <div
          className="absolute border-2 border-ow-orange rounded-sm pointer-events-none"
          style={{
            left: `${box.x * 100}%`,
            top: `${box.y * 100}%`,
            width: `${box.w * 100}%`,
            height: `${box.h * 100}%`,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
          }}
        />
      )}
    </div>
  )
}

export function ConfirmationCard({
  candidate,
  onResolve,
}: {
  candidate: ConfirmationCandidate
  onResolve: (r: ConfirmationResult) => void
}) {
  const [editing, setEditing] = useState(false)
  const [fixValue, setFixValue] = useState(candidate.extractedValue)
  const [done, setDone] = useState<null | ConfirmOutcome>(null)

  function resolve(outcome: ConfirmOutcome, correctedValue: string | null = null) {
    setDone(outcome)
    onResolve({ candidate, outcome, correctedValue })
  }

  function submitFix() {
    const v = fixValue.trim()
    resolve('corrected', v === candidate.extractedValue ? null : v)
  }

  return (
    <div className="bg-ow-panel rounded-lg border border-white/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-display tracking-wider text-slate-300">
          {candidate.fieldDetail}
        </span>
        <span className="text-[10px] font-display tracking-wider px-2 py-0.5 rounded
                         bg-ow-dark text-ow-orange/80 border border-ow-orange/20 uppercase">
          {SIGNAL_LABEL[candidate.signal] ?? candidate.signal}
        </span>
      </div>

      {candidate.region ? (
        <HighlightImage region={candidate.region} />
      ) : (
        <p className="text-xs text-ow-defeat/80">
          (No source image available for this field.)
        </p>
      )}

      <div className="flex items-baseline gap-2">
        <span className="text-xs text-slate-500 font-display tracking-wider">READ AS</span>
        <span className="text-xl text-white font-bold tabular-nums">{candidate.extractedValue}</span>
      </div>

      {candidate.note && (
        <p className="text-xs text-slate-500 leading-snug">{candidate.note}</p>
      )}

      {done ? (
        <div className={`text-sm font-display tracking-wider ${
          done === 'confirmed_correct' ? 'text-ow-victory'
          : done === 'corrected' ? 'text-ow-orange'
          : 'text-ow-defeat'
        }`}>
          {done === 'confirmed_correct' ? '\u2713 CONFIRMED'
            : done === 'corrected' ? '\u2713 FIXED'
            : '\u2691 FLAGGED \u2014 WRONG AREA'}
        </div>
      ) : editing ? (
        <div className="flex gap-2">
          <input
            value={fixValue}
            onChange={e => setFixValue(e.target.value)}
            autoFocus
            className="flex-1 bg-ow-dark border border-ow-orange/40 rounded px-3 py-2
                       text-white text-sm focus:outline-none focus:border-ow-orange"
          />
          <button onClick={submitFix}
            className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                       px-4 rounded text-sm tracking-wider transition-colors">
            SAVE
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <button onClick={() => resolve('confirmed_correct')}
              className="flex-1 bg-ow-victory/20 hover:bg-ow-victory/30 text-ow-victory
                         border border-ow-victory/30 font-display font-bold py-2 rounded
                         text-sm tracking-wider transition-colors">
              CORRECT
            </button>
            <button onClick={() => setEditing(true)}
              className="flex-1 bg-ow-dark hover:bg-white/5 text-slate-300 border border-white/10
                         font-display py-2 rounded text-sm tracking-wider transition-colors">
              FIX IT
            </button>
          </div>
          {candidate.region?.box && (
            <button onClick={() => resolve('region_mismatch')}
              className="w-full bg-transparent hover:bg-ow-defeat/10 text-ow-defeat/80
                         border border-ow-defeat/30 font-display py-1.5 rounded
                         text-xs tracking-wider transition-colors">
              THIS ISN\u2019T THE HIGHLIGHTED AREA
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ConfirmationPanel({
  candidates,
  onComplete,
}: {
  candidates: ConfirmationCandidate[]
  onComplete: (results: ConfirmationResult[]) => void
}) {
  const [results, setResults] = useState<ConfirmationResult[]>([])

  function handleResolve(r: ConfirmationResult) {
    const next = [...results.filter(x => x.candidate.id !== r.candidate.id), r]
    setResults(next)
    if (next.length === candidates.length) onComplete(next)
  }

  if (candidates.length === 0) {
    return (
      <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-6 text-center">
        <span className="text-2xl block mb-1">\u2713</span>
        <p className="text-ow-victory font-display tracking-wider text-sm">
          NOTHING TO CONFIRM \u2014 CLEAN READ
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-400">
        {candidates.length} quick {candidates.length === 1 ? 'check' : 'checks'} before saving.
      </p>
      {candidates.map(c => (
        <ConfirmationCard key={c.id} candidate={c} onResolve={handleResolve} />
      ))}
    </div>
  )
}
