'use client'

// ============================================================
// SESSION GROUPING PREVIEW (v1.2.0)
// ------------------------------------------------------------
// Shown once per bulk session, after every screenshot has been read and grouped
// and BEFORE anything is processed or saved. One card per match with its
// screenshots, so a wrong grouping is visible at a glance; leftovers (didn't fit
// exactly one match) and repeats are listed with the reason, and any of them can
// be placed into a match by hand or ignored. Placing re-runs the grouping
// (groupSession's manual placements), so format and leavers update with it.
// ============================================================

import { useState } from 'react'
import Select from '@/components/Select'
import type { Fingerprint } from '@/lib/session-fingerprint'
import { IGNORE, type SessionGrouping, type SessionMatch, type ManualPlacements } from '@/lib/session-grouper'

const NONE = ''

function kindLabel(f: Fingerprint | undefined): string {
  if (!f) return 'Screenshot'
  if (f.kind === 'summary') return 'Summary'
  if (f.kind === 'teams') return 'Teams'
  if (f.kind === 'personal') return f.hero ? `Personal · ${f.hero}` : 'Personal'
  return 'Unrecognised'
}

function matchTitle(m: SessionMatch): string {
  return `${m.dateText ?? 'No date'} · ${m.mapName ?? 'Unknown map'}`
}

function Thumb({ url, label, onOpen }: { url: string | undefined; label: string; onOpen: (u: string) => void }) {
  return (
    <button type="button" onClick={() => url && onOpen(url)} className="shrink-0 text-left group" disabled={!url}>
      <div className="w-28 h-16 rounded bg-ow-dark border border-ow-line overflow-hidden group-hover:border-ow-orange/50">
        {url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="w-full h-full object-cover" loading="lazy" />
        )}
      </div>
      <p className="text-[10px] text-ow-faint mt-1 w-28 truncate">{label}</p>
    </button>
  )
}

export default function SessionPreview({
  grouping,
  fingerprints,
  urlFor,
  manual,
  alreadySaved,
  onPlace,
  onConfirm,
  onCancel,
}: {
  grouping: SessionGrouping
  fingerprints: Map<string, Fingerprint>
  urlFor: (id: string) => string | undefined
  manual: ManualPlacements
  /** Match keys whose date/time is already a saved match — skipped on process. */
  alreadySaved: Set<string>
  onPlace: (id: string, target: string | null) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const [lightbox, setLightbox] = useState<string | null>(null)
  const toProcess = grouping.matches.filter(m => !alreadySaved.has(m.key))
  const held = toProcess.filter(m => m.issues.length > 0).length

  const placeOptions = [
    { value: NONE, label: 'Leave unplaced' },
    ...grouping.matches.map(m => ({ value: m.key, label: matchTitle(m) })),
    { value: IGNORE, label: 'Ignore this screenshot' },
  ]

  const resultClass = (r: SessionMatch['result']) =>
    r === 'victory' ? 'text-ow-victory' : r === 'defeat' ? 'text-ow-defeat' : 'text-ow-draw'

  const LooseRow = ({ id, reason }: { id: string; reason: string }) => (
    <div className="flex items-center gap-4 bg-ow-dark rounded-lg border border-ow-line p-3 flex-wrap">
      <Thumb url={urlFor(id)} label={kindLabel(fingerprints.get(id))} onOpen={setLightbox} />
      <p className="text-xs text-ow-muted flex-1 min-w-[12rem]">{reason}</p>
      <Select<string>
        className="bg-ow-panel border border-ow-line rounded-lg px-3 py-2 text-xs text-ow-fg font-display tracking-wider w-64"
        value={manual[id] ?? NONE}
        onChange={v => onPlace(id, v === NONE ? null : v)}
        options={placeOptions}
        aria-label="Place this screenshot"
      />
    </div>
  )

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="font-display text-3xl tracking-[0.12em] text-ow-fg uppercase">Session preview</h1>
        <p className="text-sm text-ow-muted mt-1">
          {grouping.matches.length} match{grouping.matches.length !== 1 ? 'es' : ''} found
          {alreadySaved.size > 0 && ` · ${alreadySaved.size} already saved (skipped)`}
          {grouping.leftovers.length > 0 && ` · ${grouping.leftovers.length} screenshot${grouping.leftovers.length !== 1 ? 's' : ''} unplaced`}
          . Nothing is saved until you confirm.
        </p>
      </div>

      <div className="space-y-3">
        {grouping.matches.map(m => {
          const skipped = alreadySaved.has(m.key)
          const ids = [m.summaryId, ...m.personalIds, ...(m.teamsId ? [m.teamsId] : [])]
          return (
            <div key={m.key}
              className={`bg-ow-panel rounded-lg border p-4 space-y-3 ${skipped ? 'border-ow-line opacity-60' : m.issues.length ? 'border-ow-defeat/40' : 'border-ow-line'}`}>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-ow-fg font-display">{matchTitle(m)}</span>
                {m.result && <span className={`font-display font-bold text-sm ${resultClass(m.result)}`}>{m.result.toUpperCase()}</span>}
                {m.ead && <span className="text-xs text-ow-muted font-display">{m.ead.e ?? '?'} / {m.ead.a ?? '?'} / {m.ead.d ?? '?'}</span>}
                {m.format && (
                  <span className="text-[10px] font-display font-bold px-2 py-0.5 rounded bg-ow-orange/10 text-ow-orange tracking-wider">
                    {m.format.toUpperCase()}{m.formatCertain ? '' : '?'}
                  </span>
                )}
                {(m.leaver.team || m.leaver.enemy) && (
                  <span className="text-[10px] font-display font-bold px-2 py-0.5 rounded bg-ow-defeat/10 text-ow-defeat tracking-wider">
                    LEAVER · {m.allyRows} V {m.enemyRows}
                  </span>
                )}
                {skipped && <span className="text-[10px] font-display px-2 py-0.5 rounded bg-ow-dark text-ow-faint tracking-wider">ALREADY SAVED</span>}
              </div>
              <div className="flex gap-3 overflow-x-auto pb-1">
                {ids.map(id => <Thumb key={id} url={urlFor(id)} label={kindLabel(fingerprints.get(id))} onOpen={setLightbox} />)}
              </div>
              {!skipped && m.issues.map(x => (
                <p key={x} className="text-xs text-ow-defeat">● {x} — will be held for you to check</p>
              ))}
              {!skipped && m.notes.map(x => <p key={x} className="text-xs text-ow-draw">● {x}</p>)}
            </div>
          )
        })}
      </div>

      {grouping.leftovers.length > 0 && (
        <div className="bg-ow-panel rounded-lg border border-ow-draw/30 p-4 space-y-3">
          <p className="font-display text-sm tracking-wider text-ow-draw">UNPLACED — DIDN&apos;T FIT EXACTLY ONE MATCH</p>
          <p className="text-xs text-ow-faint">Place one into its match, or leave it — it stays uploaded for next time.</p>
          {grouping.leftovers.map(l => <LooseRow key={l.id} id={l.id} reason={l.reason} />)}
        </div>
      )}

      {grouping.duplicates.length > 0 && (
        <div className="bg-ow-panel rounded-lg border border-ow-line p-4 space-y-3">
          <p className="font-display text-sm tracking-wider text-ow-muted">REPEATS &amp; IGNORED</p>
          {grouping.duplicates.map(d => <LooseRow key={d.id} id={d.id} reason={d.reason} />)}
        </div>
      )}

      <div className="flex justify-between gap-3 flex-wrap">
        <button onClick={onCancel}
          className="bg-ow-panel border border-ow-line text-ow-fg font-display px-6 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
          BACK
        </button>
        <button onClick={onConfirm} disabled={toProcess.length === 0}
          className="bg-ow-orange hover:bg-ow-accent disabled:opacity-40 text-ow-dark font-display font-bold px-6 py-2.5 rounded-lg tracking-wider text-sm transition-colors">
          PROCESS {toProcess.length} MATCH{toProcess.length !== 1 ? 'ES' : ''}
          {held > 0 ? ` (${held} WILL BE HELD)` : ''}
        </button>
      </div>

      {lightbox && (
        <button type="button" onClick={() => setLightbox(null)} aria-label="Close"
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 cursor-zoom-out">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" className="max-w-full max-h-full object-contain" />
        </button>
      )}
    </div>
  )
}
