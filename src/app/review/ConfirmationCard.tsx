'use client'

// ============================================================
// Step 6f — ConfirmationCard (with source-image highlight)
// Shows the source screenshot the value came from, with a highlight box over
// the exact region (when grid coordinates are available). Three actions:
//   CORRECT      — the read is right
//   FIX IT       — type the right value
//   WRONG AREA   — the highlighted box is in the wrong place (region_mismatch)
// ============================================================

import { useState, useEffect } from 'react'
import type { ConfirmationCandidate } from '@/lib/beta-confirmation'
import Select from '@/components/Select'

export type ConfirmOutcome = 'confirmed_correct' | 'corrected' | 'region_mismatch'

export interface ConfirmationResult {
  candidate: ConfirmationCandidate
  outcome: ConfirmOutcome
  /** set only when outcome === 'corrected' */
  correctedValue: string | null
  /** Step 10: the attack/defend answer, set only for a map question whose chosen
   *  map needs a starting side (escort / hybrid). Null/undefined otherwise. */
  sideValue?: 'attack' | 'defense' | null
}

const SIGNAL_LABEL: Record<string, string> = {
  unrecognized: 'Unrecognized',
  map_detect_fail: 'Map not detected',
  vote_split: 'Uncertain read',
  avg_crosscheck_fail: 'Doesn\u2019t add up',
  low_hero_conf: 'Low confidence',
  phase_disagreement: 'Conflicting reads',
  low_user_margin: 'Close call',
  sampled_summary: 'Spot-check',
}

/** The orange highlight box, expressed as fractions (0..1) of the image, so the
 *  SAME markup scales correctly at any rendered size (inline card or lightbox). */
function HighlightBox({ box, dim }: {
  box: NonNullable<NonNullable<ConfirmationCandidate['region']>['box']>
  /** how dark to make the surrounding mask (inline uses a lighter veil). */
  dim: number
}) {
  return (
    <div
      className="absolute border-2 border-ow-orange rounded-sm pointer-events-none"
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.w * 100}%`,
        height: `${box.h * 100}%`,
        boxShadow: `0 0 0 9999px rgba(0,0,0,${dim})`,
      }}
    />
  )
}

/** Full-screen overlay showing the source image fit-to-viewport with the
 *  highlight box preserved. Closes on backdrop click, Escape, or the X button.
 *  Clicking the IMAGE itself does not close (so you can inspect it). */
function Lightbox({ region, onClose }: {
  region: NonNullable<ConfirmationCandidate['region']>
  onClose: () => void
}) {
  // Escape-to-close + lock background scroll while open; both cleaned up on close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    // Backdrop: clicking it (outside the image) closes. Fixed full-screen.
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
    >
      {/* Close button (top-right of the viewport). */}
      <button
        onClick={onClose}
        aria-label="Close enlarged image"
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center
                   rounded-full bg-ow-panel/80 hover:bg-ow-panel text-ow-fg
                   border border-ow-line text-xl leading-none transition-colors">
          {'\u2715'}
      </button>

      {/* Image wrapper: stopPropagation so clicking the image doesn't close.
          Fit-to-screen — the whole image is visible, scaled as large as fits. */}
      <div
        onClick={e => e.stopPropagation()}
        className="relative inline-block max-w-full max-h-full"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={region.imageUrl}
          alt="source screenshot enlarged"
          className="block max-w-full max-h-[88vh] object-contain rounded"
        />
        {region.box && <HighlightBox box={region.box} dim={0.55} />}
      </div>
    </div>
  )
}

function HighlightImage({ region }: { region: NonNullable<ConfirmationCandidate['region']> }) {
  const box = region.box
  const [zoomed, setZoomed] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        aria-label="Enlarge source screenshot"
        title="Click to enlarge"
        className="relative block w-full rounded overflow-hidden bg-ow-dark
                   border border-ow-line cursor-zoom-in group">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={region.imageUrl} alt="source screenshot" className="w-full object-contain max-h-72" />
        {box && <HighlightBox box={box} dim={0.45} />}
        {/* subtle hint that the image is clickable */}
        <span className="absolute bottom-1 right-1 text-[10px] font-display tracking-wider
                         px-1.5 py-0.5 rounded bg-black/60 text-slate-200 opacity-0
                         group-hover:opacity-100 transition-opacity pointer-events-none">
          CLICK TO ENLARGE
        </span>
      </button>
      {zoomed && <Lightbox region={region} onClose={() => setZoomed(false)} />}
    </>
  )
}

export function ConfirmationCard({
  candidate,
  onResolve,
  sideNeededFor,
}: {
  candidate: ConfirmationCandidate
  onResolve: (r: ConfirmationResult) => void
  /** Step 10: given a chosen value (a map name), returns true when it needs a
   *  starting side (escort / hybrid). Supplied by the review page, which owns
   *  the map→mode lookup. When absent, no side follow-up is ever shown. */
  sideNeededFor?: ((value: string) => boolean) | undefined
}) {
  const isPicker = Array.isArray(candidate.options) && candidate.options.length > 0
  const [editing, setEditing] = useState(false)
  const [fixValue, setFixValue] = useState(
    isPicker ? (candidate.options!.includes(candidate.extractedValue) ? candidate.extractedValue : '') : candidate.extractedValue,
  )
  const [done, setDone] = useState<null | ConfirmOutcome>(null)
  // Step 10: when a chosen map needs a side, hold the pending corrected value
  // and show the attack/defend buttons; the card only resolves once a side is
  // picked. pendingMap is null when no side step is in progress.
  const [pendingMap, setPendingMap] = useState<string | null>(null)

  function resolve(outcome: ConfirmOutcome, correctedValue: string | null = null, sideValue: 'attack' | 'defense' | null = null) {
    setDone(outcome)
    onResolve({ candidate, outcome, correctedValue, sideValue })
  }

  // Free-text / dropdown "FIX IT" submit. For a map pick whose value needs a
  // side, divert into the attack/defend step instead of resolving immediately.
  function submitFix() {
    const v = fixValue.trim()
    if (v === '') return
    const changed = v !== candidate.extractedValue
    if (candidate.requiresSideFollowUp && sideNeededFor?.(v)) {
      setPendingMap(v)
      return
    }
    resolve('corrected', changed ? v : null)
  }

  // Step 10: attack/defend chosen for a map that needed one.
  function submitSide(side: 'attack' | 'defense') {
    const v = (pendingMap ?? '').trim()
    const changed = v !== candidate.extractedValue
    resolve('corrected', changed ? v : null, side)
    setPendingMap(null)
  }

  return (
    <div className="bg-ow-panel rounded-lg border border-ow-line p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-display tracking-wider text-ow-muted">
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
        <span className="text-xs text-ow-faint font-display tracking-wider">READ AS</span>
        <span className="text-xl text-ow-fg font-bold tabular-nums">{candidate.extractedValue}</span>
      </div>

      {candidate.note && (
        <p className="text-xs text-ow-faint leading-snug">{candidate.note}</p>
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
      ) : pendingMap ? (
        // Step 10 — attack/defend follow-up for a map that needs a starting side.
        <div className="space-y-2">
          <p className="text-xs text-ow-muted">
            <span className="text-ow-fg font-bold">{pendingMap}</span> needs a starting side — which did you play first?
          </p>
          <div className="flex gap-2">
            <button onClick={() => submitSide('attack')}
              className="flex-1 bg-ow-orange/20 hover:bg-ow-orange/30 text-ow-orange
                         border border-ow-orange/30 font-display font-bold py-2 rounded
                         text-sm tracking-wider transition-colors">
              ATTACK
            </button>
            <button onClick={() => submitSide('defense')}
              className="flex-1 bg-ow-accent/20 hover:bg-ow-accent/30 text-ow-accent
                         border border-ow-accent/30 font-display font-bold py-2 rounded
                         text-sm tracking-wider transition-colors">
              DEFEND
            </button>
          </div>
        </div>
      ) : isPicker ? (
        // Step 10 — map dropdown. No "CORRECT" path: the map is unknown, so the
        // user must pick. Choosing a side-needing map diverts to the side step.
        <div className="flex gap-2">
          <Select<string>
            value={fixValue}
            onChange={setFixValue}
            placeholder={'Select map\u2026'}
            className="flex-1"
            options={candidate.options!.map(opt => ({ value: opt, label: opt }))}
          />
          <button onClick={submitFix} disabled={fixValue.trim() === ''}
            className="bg-ow-orange hover:bg-ow-accent disabled:opacity-40 disabled:cursor-not-allowed
                       text-ow-dark font-display font-bold px-4 rounded text-sm tracking-wider transition-colors">
            NEXT
          </button>
        </div>
      ) : editing ? (
        <div className="flex gap-2">
          <input
            value={fixValue}
            onChange={e => setFixValue(e.target.value)}
            autoFocus
            className="flex-1 bg-ow-dark border border-ow-orange/40 rounded px-3 py-2
                       text-ow-fg text-sm focus:outline-none focus:border-ow-orange"
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
              className="flex-1 bg-ow-dark hover:bg-white/5 text-ow-muted border border-ow-line
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
  sideNeededFor,
}: {
  candidates: ConfirmationCandidate[]
  onComplete: (results: ConfirmationResult[]) => void
  /** Step 10: forwarded to each card so a map pick can decide whether to ask
   *  for a starting side. Owned by the review page (map→mode lookup). */
  sideNeededFor?: ((value: string) => boolean) | undefined
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
      <p className="text-sm text-ow-muted">
        {candidates.length} quick {candidates.length === 1 ? 'check' : 'checks'} before saving.
      </p>
      {candidates.map(c => (
        <ConfirmationCard key={c.id} candidate={c} onResolve={handleResolve} sideNeededFor={sideNeededFor} />
      ))}
    </div>
  )
}
