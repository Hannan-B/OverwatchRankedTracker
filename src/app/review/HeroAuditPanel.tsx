'use client'

// ============================================================
// HERO AUDIT PANEL (v1.0.2) — replaces beta confirmation
// ------------------------------------------------------------
// WHY THIS EXISTS
//
// Beta confirmation asked about a SUBSET of slots, chosen by a confidence
// gate. That can only ever measure PRECISION — how often a flag was a real
// error. It can never measure RECALL, because the errors it misses are
// invisible by construction. That was the actual failure: of the 71 wrong
// heroes in the beta database, 60 were never questioned. The matcher was
// confident and wrong, so no threshold would have surfaced them.
//
// This panel shows EVERY slot. A verdict on all 10/12 rows is a truth label
// whether the matcher was confident or not, so real accuracy becomes
// measurable, and a season of ~400 matches yields ~4,800 labelled slots
// against the 324 the manual ground-truth exercise produced.
//
// TWO DESIGN RULES THAT LOOK LIKE FRICTION AND ARE NOT
//
// 1. No row is pre-accepted. Every row starts 'pending'. If rows arrived
//    already confirmed, a row nobody looked at would record identically to
//    one checked carefully, and the dataset would be worthless.
// 2. Rows render in STRICT scoreboard order, slot 1 to 10/12, allies then
//    enemies — never re-sorted by margin. The list must line up positionally
//    with the image above it, or you cannot compare them row by row. Flagged
//    rows therefore stay in place and are called out by the banner rather
//    than floating to the top.
// ============================================================

import { useState, useEffect, useMemo, useRef } from 'react'
import type { ScoreboardHeroIdentification, ScoreboardPlayerStats } from '@/lib/types'

export interface HeroAuditRow {
  slot: number
  team: 'ally' | 'enemy'
  /** Role from the row ICON — independent of the portrait match, so it stays
   *  trustworthy even when the hero is wrong. Display only: the hero search is
   *  deliberately NOT filtered by it, or a misread icon would hide the right
   *  answer entirely. */
  role: 'tank' | 'dps' | 'support' | null
  isUser: boolean
  readHero: string | null
  confirmedHero: string | null
  portraitDataUrl: string | null
  // Diagnostics — stored with the verdict, not displayed. A number beside a
  // portrait invites deferring to the machine instead of looking at the image.
  score: number
  margin: number | null
  runnerUp: string | null
  orbApplied: boolean
  cropIndex: number | null
  phase1Hero: string | null
  phase1Score: number | null
  flag: 'duplicate' | 'not_played' | null
  verdict: 'pending' | 'confirmed' | 'corrected'
  /** Confirmed via the bulk button rather than individually. Recorded so bulk
   *  labels can be weighted down later if they prove unreliable. */
  bulk: boolean
}

export interface HeroAuditResult {
  rows: HeroAuditRow[]
  correctedSlots: number[]
  bulkConfirmedSlots: number[]
  /** Seconds from mount to submit, so a run of two-second confirmations is
   *  identifiable afterwards rather than silently trusted. */
  reviewSeconds: number
}

/** Deterministic coherence checks — facts about the game a correct read cannot
 *  violate, needing no threshold and no ground truth. Measured on the 6v6
 *  ground-truth set: 4 real errors caught, 0 false positives across 324 slots.
 *
 *  Deliberately NOT included: any rule about team ROLE SHAPE. 6v6 here is open
 *  queue (Test 23's enemy team is 2-3-1), so a "must be 2-2-2" check would
 *  manufacture errors. Cross-team duplicates are LEGAL — Test 23 has Anran and
 *  Bastion on both sides — which is why duplicates are grouped per team. */
export function flagRows(rows: HeroAuditRow[], heroesPlayed: string[]): HeroAuditRow[] {
  const played = new Set(heroesPlayed.filter(Boolean).map(h => h.toLowerCase()))
  return rows.map(r => {
    if (!r.confirmedHero) return { ...r, flag: null }
    const dupe = rows.some(
      o => o.slot !== r.slot && o.team === r.team && o.confirmedHero === r.confirmedHero,
    )
    if (dupe) return { ...r, flag: 'duplicate' as const }
    // heroes_played comes from the summary + breakdown screens, read by a
    // different pipeline from the portrait matcher — a genuinely independent
    // cross-check. Skipped when empty, or a failed summary read would flag
    // every match.
    if (r.isUser && played.size > 0 && !played.has(r.confirmedHero.toLowerCase())) {
      return { ...r, flag: 'not_played' as const }
    }
    return { ...r, flag: null }
  })
}

export function buildAuditRows(
  heroes: ScoreboardHeroIdentification[],
  stats: ScoreboardPlayerStats[],
  heroesPlayed: string[],
): HeroAuditRow[] {
  const rows: HeroAuditRow[] = [...heroes]
    .sort((a, b) => a.slot - b.slot)
    .map(h => {
      const st = stats.find(s => s.slot === h.slot)
      return {
        slot: h.slot,
        team: h.team,
        role: st?.role ?? null,
        isUser: st?.isUser ?? false,
        readHero: h.heroName,
        confirmedHero: h.heroName,
        portraitDataUrl: h.portraitDataUrl,
        score: h.confidence,
        margin: h.margin ?? null,
        runnerUp: h.runnerUp ?? null,
        orbApplied: h.orbApplied ?? false,
        cropIndex: h.cropIndex ?? null,
        phase1Hero: h.phase1Hero ?? null,
        phase1Score: h.phase1Score ?? null,
        flag: null,
        verdict: 'pending' as const,
        bulk: false,
      }
    })
  return flagRows(rows, heroesPlayed)
}

// ── Lightbox (mirrors ConfirmationCard's, so enlarging feels identical) ──

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div onClick={onClose} role="dialog" aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 sm:p-8">
      <button onClick={onClose} aria-label="Close enlarged image"
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full
                   bg-ow-panel/80 hover:bg-ow-panel text-ow-fg border border-ow-line text-xl
                   leading-none transition-colors">{'\u2715'}</button>
      <div onClick={e => e.stopPropagation()} className="relative inline-block max-w-full max-h-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="enlarged" className="block max-w-full max-h-[88vh] object-contain rounded" />
      </div>
    </div>
  )
}

// ── Hero search ──────────────────────────────────────────────
// Searches the WHOLE roster, not the row's role. The role icon is usually
// right, but when it is wrong the correct hero would be missing from a
// filtered list and there would be no way to enter it.

function HeroSearch({
  allHeroes, onPick, onCancel,
}: {
  allHeroes: string[]
  onPick: (hero: string) => void
  onCancel: () => void
}) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return allHeroes
    const starts = allHeroes.filter(h => h.toLowerCase().startsWith(needle))
    const contains = allHeroes.filter(
      h => !h.toLowerCase().startsWith(needle) && h.toLowerCase().includes(needle),
    )
    return [...starts, ...contains]
  }, [q, allHeroes])

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { onCancel(); return }
    // Enter commits ONLY when the search has narrowed to exactly one hero, so
    // a fast Enter cannot silently pick the wrong one out of several matches.
    if (e.key === 'Enter' && hits.length === 1) onPick(hits[0])
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a hero name…"
          className="flex-1 bg-ow-dark border border-ow-orange/40 rounded px-3 py-3 text-ow-fg
                     text-base focus:outline-none focus:border-ow-orange"
        />
        <button onClick={onCancel}
          className="px-4 rounded border border-ow-line text-ow-muted font-display text-sm
                     tracking-wider hover:bg-white/5 transition-colors">
          CANCEL
        </button>
      </div>
      <div className="max-h-56 overflow-y-auto rounded border border-ow-line divide-y divide-ow-line/60">
        {hits.length === 0 ? (
          <p className="p-3 text-sm text-ow-faint">No hero matches that.</p>
        ) : hits.map(h => (
          <button key={h} onClick={() => onPick(h)}
            className="w-full text-left px-3 py-3 text-base text-ow-fg hover:bg-ow-orange/10
                       transition-colors">
            {h}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────

const FLAG_TEXT = {
  duplicate: (h: string) => `${h} appears twice on this team \u2014 a team cannot run the same hero twice.`,
  not_played: (h: string) => `This is your row, but ${h} is not among the heroes you played.`,
} as const

function RowCard({
  row, allHeroes, onConfirm, onChange, onEnlarge,
}: {
  row: HeroAuditRow
  allHeroes: string[]
  onConfirm: (slot: number) => void
  onChange: (slot: number, hero: string) => void
  onEnlarge: (src: string) => void
}) {
  const [searching, setSearching] = useState(false)
  const resolved = row.verdict !== 'pending'
  const corrected = row.verdict === 'corrected'

  const border =
    row.flag ? 'border-ow-defeat/50'
    : corrected ? 'border-ow-orange/50'
    : resolved ? 'border-ow-victory/40'
    : 'border-ow-line'
  const bg = resolved && !row.flag ? 'bg-ow-victory/5' : 'bg-ow-panel'

  return (
    <div className={`rounded-lg border p-3 space-y-3 ${border} ${bg} ${resolved ? 'opacity-80' : ''}`}>
      <div className="flex items-center gap-3">
        {row.portraitDataUrl ? (
          <button type="button" onClick={() => onEnlarge(row.portraitDataUrl!)}
            aria-label={`Enlarge slot ${row.slot} portrait`} title="Tap to enlarge"
            className="shrink-0 cursor-zoom-in">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={row.portraitDataUrl} alt={row.readHero ?? 'portrait'}
              className="w-16 h-16 rounded object-cover bg-ow-dark border border-ow-line" />
          </button>
        ) : (
          <div className="w-16 h-16 rounded bg-ow-dark shrink-0 border border-ow-line" />
        )}

        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-display tracking-wider text-ow-faint">
            {row.slot}. {row.team === 'ally' ? 'ALLY' : 'ENEMY'} {row.role ? row.role.toUpperCase() : '?'}
            {row.isUser && <span className="text-ow-orange"> {'\u00B7'} YOU</span>}
          </p>
          <p className={`text-lg font-bold leading-tight ${
            corrected ? 'text-ow-orange' : resolved ? 'text-ow-victory' : 'text-ow-fg'
          }`}>
            {row.confirmedHero ?? '\u2014 not identified \u2014'}
          </p>
          {corrected && (
            <p className="text-xs text-ow-faint">
              read as <span className="line-through">{row.readHero ?? '?'}</span>
            </p>
          )}
        </div>

        {resolved && !searching && (
          <span className="text-ow-victory text-xl shrink-0 pr-1">{'\u2713'}</span>
        )}
      </div>

      {row.flag && (
        <p className="text-xs text-ow-defeat leading-snug">
          {FLAG_TEXT[row.flag](row.confirmedHero ?? '?')}
        </p>
      )}

      {searching ? (
        <HeroSearch
          allHeroes={allHeroes}
          onPick={h => { onChange(row.slot, h); setSearching(false) }}
          onCancel={() => setSearching(false)}
        />
      ) : (
        <div className="flex gap-3">
          <button onClick={() => setSearching(true)}
            className="flex-1 bg-ow-dark hover:bg-white/5 text-ow-muted border border-ow-line
                       font-display py-3.5 rounded text-sm tracking-wider transition-colors">
            CHANGE
          </button>
          {!resolved && (
            <button onClick={() => onConfirm(row.slot)}
              className="flex-1 bg-ow-victory/20 hover:bg-ow-victory/30 text-ow-victory
                         border border-ow-victory/30 font-display font-bold py-3.5 rounded
                         text-sm tracking-wider transition-colors">
              CORRECT
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Panel ────────────────────────────────────────────────────

export function HeroAuditPanel({
  heroes, stats, heroesPlayed, knownHeroes, scoreboardImageUrl, onComplete,
}: {
  heroes: ScoreboardHeroIdentification[]
  stats: ScoreboardPlayerStats[]
  /** Heroes from the summary + breakdown screens, for the user-row check. */
  heroesPlayed: string[]
  knownHeroes: { name: string; role: 'tank' | 'dps' | 'support' }[]
  scoreboardImageUrl?: string
  onComplete: (result: HeroAuditResult) => void
}) {
  const [rows, setRows] = useState<HeroAuditRow[]>(() => buildAuditRows(heroes, stats, heroesPlayed))
  const [startedAt] = useState(() => Date.now())
  const [lightbox, setLightbox] = useState<string | null>(null)

  const allHeroes = useMemo(
    () => knownHeroes.map(h => h.name).sort((a, b) => a.localeCompare(b)),
    [knownHeroes],
  )

  const pending = rows.filter(r => r.verdict === 'pending')
  const flaggedPending = rows.filter(r => r.flag && r.verdict === 'pending')
  const correctedCount = rows.filter(r => r.verdict === 'corrected').length
  const allResolved = pending.length === 0

  function confirm(slot: number) {
    setRows(prev => prev.map(r =>
      r.slot === slot ? { ...r, verdict: 'confirmed' as const, bulk: false } : r,
    ))
  }

  // A change resolves the row immediately — picking a hero is already an
  // affirmative statement, so a second tap would be ceremony. CHANGE stays
  // available afterwards so a mis-pick can be revised.
  function change(slot: number, hero: string) {
    setRows(prev => flagRows(
      prev.map(r => {
        if (r.slot !== slot) return r
        const verdict = hero === r.readHero ? ('confirmed' as const) : ('corrected' as const)
        return { ...r, confirmedHero: hero, verdict, bulk: false }
      }),
      heroesPlayed,
    ))
  }

  function confirmRemaining() {
    setRows(prev => prev.map(r =>
      r.verdict === 'pending' ? { ...r, verdict: 'confirmed' as const, bulk: true } : r,
    ))
  }

  function submit() {
    onComplete({
      rows,
      correctedSlots: rows.filter(r => r.verdict === 'corrected').map(r => r.slot),
      bulkConfirmedSlots: rows.filter(r => r.bulk).map(r => r.slot),
      reviewSeconds: Math.round((Date.now() - startedAt) / 1000),
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-display tracking-wider text-ow-muted">CHECK THE HEROES</h3>
          <p className="text-xs text-ow-faint mt-0.5">In scoreboard order. Tap any image to enlarge.</p>
        </div>
        <span className="text-sm text-ow-muted tabular-nums shrink-0">
          {rows.length - pending.length} / {rows.length}
        </span>
      </div>

      <div className="h-1.5 rounded-full bg-ow-dark overflow-hidden">
        <div className="h-full bg-ow-orange transition-all"
          style={{ width: `${((rows.length - pending.length) / Math.max(rows.length, 1)) * 100}%` }} />
      </div>

      {scoreboardImageUrl && (
        <button type="button" onClick={() => setLightbox(scoreboardImageUrl)}
          aria-label="Enlarge scoreboard" title="Tap to enlarge"
          className="block w-full rounded border border-ow-line overflow-hidden cursor-zoom-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={scoreboardImageUrl} alt="scoreboard" className="w-full object-contain max-h-80" />
        </button>
      )}

      {flaggedPending.length > 0 && (
        <div className="bg-ow-defeat/10 border border-ow-defeat/30 rounded-lg p-3">
          <p className="text-sm text-ow-defeat font-display tracking-wider">
            CHECK SLOT{flaggedPending.length === 1 ? '' : 'S'} {flaggedPending.map(r => r.slot).join(', ')}
          </p>
          <p className="text-xs text-ow-defeat/80 mt-0.5">
            These failed a coherence check {'\u2014'} certainly wrong, not just uncertain.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {rows.map(r => (
          <RowCard key={r.slot} row={r} allHeroes={allHeroes}
            onConfirm={confirm} onChange={change} onEnlarge={setLightbox} />
        ))}
      </div>

      <div className="pt-3 border-t border-ow-line space-y-2">
        {pending.length > 0 && (
          <>
            <button onClick={confirmRemaining} disabled={flaggedPending.length > 0}
              className="w-full bg-ow-dark hover:bg-white/5 disabled:opacity-40
                         disabled:cursor-not-allowed text-ow-muted border border-ow-line
                         font-display py-3.5 rounded text-sm tracking-wider transition-colors">
              CONFIRM REMAINING {pending.length} AS READ
            </button>
            {flaggedPending.length > 0 && (
              <p className="text-[11px] text-ow-faint text-center">
                Resolve the flagged row{flaggedPending.length === 1 ? '' : 's'} first.
              </p>
            )}
          </>
        )}

        <button onClick={submit} disabled={!allResolved}
          className="w-full bg-ow-victory/20 hover:bg-ow-victory/30 disabled:opacity-40
                     disabled:cursor-not-allowed text-ow-victory border border-ow-victory/30
                     font-display font-bold py-4 rounded text-sm tracking-wider transition-colors">
          {!allResolved
            ? `${pending.length} ROW${pending.length === 1 ? '' : 'S'} LEFT TO CHECK`
            : correctedCount > 0
              ? `SAVE WITH ${correctedCount} CORRECTION${correctedCount === 1 ? '' : 'S'}`
              : 'ALL CORRECT \u2014 SAVE'}
        </button>
      </div>

      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}
