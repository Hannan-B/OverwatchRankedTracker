'use client'

import { useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import type { RoleType, StartingSide } from '@/lib/types'
import { detectMapFromPhotos } from '@/lib/phone-map-detect'
import { detectScoreboardCrops, type ScoreboardCrops } from '@/lib/phone-scoreboard-detect'
import { needsStartingSide } from '@/data/reference'

// ============================================================
// MOBILE UPLOAD — one-thing-per-screen flow
//
// (v1.1.0) QUESTION SET REBUILT — question scale version 2.
// See PATCH-SPEC-v1.1.0.md §3. Summary of WHY, so nobody re-adds them:
//
//   RETIRED — tempo + coordination (both teams). Unanswerable by
//   construction: a control match can have a tight first point then two
//   collapses; an escort map a trivial first stage and a brutal last one.
//   Any single value for a multi-round game is a lie. The owner also
//   reported clicking through them without thought, which contaminates
//   the answers regardless of how healthy the distribution looks.
//
//   RETIRED — tilt. The answer depends on a fact not yet known: "fired up"
//   and "I should stop" are not alternatives at the end of a session, and
//   which one applies depends on whether this is the last game. Same defect
//   as tempo. Loss-carry-over is now DERIVED from played_at via time-lib's
//   session/streak helpers instead, which cannot be contaminated by mood.
//
//   REPLACED — match_feel (3) -> matchup_feel (5). Measures TEAM STRENGTH,
//   not result: "Behind" + victory is legitimate and interesting.
//   REPLACED — performance_feel (3) -> performance_rating (5).
//   REPLACED — fun_rating (1-5) -> fun_rating_6 (1-6, NO midpoint, so every
//   answer must lean; the old 3/4 pair were interchangeable).
//
//   ADDED — leaver/thrower as a multi-select per team (was two toggles).
//   ADDED — slot picks: which ally impressed, which enemy gave trouble.
//
// The OLD columns are frozen, not dropped. Season 3 keeps its data on the
// old scale; the two are NEVER pooled. seasons.question_scale_version says
// which set a season used.
//
// Preserves phone-side map detection + attack/defend. No default_role.
// ============================================================

const ADVANCE_DELAY = 250 // ms — lets the highlight show before moving on

// What went wrong on a team. MULTI-SELECT: a game can have both a leaver and
// a thrower. 'none' is explicit and mutually exclusive with the rest.
type TeamIssue = 'none' | 'left_gone' | 'left_returned' | 'thrower'

type Step =
  | 'format' | 'role' | 'matchup' | 'performance' | 'fun'
  | 'team' | 'enemy' | 'thoughts'
  | 'photos' | 'confirm_leaver' | 'checking' | 'confirm_side'
  | 'standout_ally' | 'standout_enemy'
  | 'uploading' | 'done'
  // (v1.2.0) Bulk session upload — a separate path beside the per-match wizard,
  // which is unchanged. A whole play session's match-history screenshots go up
  // in one batch, in any order; /process groups them into matches itself.
  | 'session_photos' | 'session_uploading' | 'session_done'

type FileStatus = 'idle' | 'uploading' | 'success' | 'error'
interface FilePreview { file: File; preview: string; status: FileStatus }

function OptionButton({
  label, selected, onClick, big = false,
}: { label: string; selected: boolean; onClick: () => void; big?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full ${big ? 'py-6 text-2xl' : 'py-4 text-base'} px-5 rounded-xl
        font-display tracking-[0.15em] uppercase transition-colors text-center
        ${selected
          ? 'bg-ow-orange text-ow-dark font-bold'
          : 'bg-ow-panel text-ow-muted border border-ow-line hover:border-ow-orange/40 hover:text-ow-fg'}`}
    >
      {label}
    </button>
  )
}

/** Full-screen view of a crop. Tap anywhere to dismiss. */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} aria-label="Close"
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-3 cursor-zoom-out">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="max-w-full max-h-full object-contain" />
    </button>
  )
}

function StepShell({
  title, hint, children, onBack, onNext, nextLabel = 'NEXT', nextDisabled = false, onSkip,
}: {
  title: string; hint?: string; children: React.ReactNode
  onBack?: () => void; onNext?: () => void; nextLabel?: string
  nextDisabled?: boolean; onSkip?: () => void
}) {
  return (
    <div className="min-h-[100dvh] flex flex-col px-5 pt-[max(env(safe-area-inset-top),20px)] pb-[max(env(safe-area-inset-bottom),20px)] bg-ow-dark relative overflow-hidden">
      <div aria-hidden className="absolute inset-0 opacity-50 pointer-events-none"
        style={{ background: 'radial-gradient(60% 40% at 50% 0%, rgba(249,158,26,0.08), transparent 70%), radial-gradient(50% 50% at 80% 100%, rgba(30,58,95,0.4), transparent 70%)' }} />

      <div className="relative flex items-center justify-between h-10 shrink-0">
        {onBack
          ? <button onClick={onBack} className="text-ow-faint hover:text-ow-orange text-sm font-display tracking-wider transition-colors">← BACK</button>
          : <span />}
        {onSkip && <button onClick={onSkip} className="text-ow-faint hover:text-ow-muted text-xs font-display tracking-wider transition-colors">SKIP</button>}
      </div>

      <div className="relative flex-1 flex flex-col justify-center max-w-md mx-auto w-full">
        <div className="h-1 w-12 bg-ow-orange mb-5 rounded-full" />
        <h1 className="font-display text-2xl tracking-[0.15em] text-ow-fg uppercase leading-tight">{title}</h1>
        {hint ? <p className="text-sm text-ow-faint mt-2 mb-6">{hint}</p> : <div className="mb-6" />}
        <div className="space-y-3">{children}</div>
      </div>

      {onNext && (
        <div className="relative shrink-0 max-w-md mx-auto w-full pt-4">
          <button
            onClick={onNext}
            disabled={nextDisabled}
            className="w-full rounded-xl bg-ow-orange hover:bg-ow-accent disabled:bg-slate-800
              disabled:text-slate-600 text-ow-dark font-display font-bold py-4
              tracking-[0.2em] uppercase text-sm transition-colors"
          >
            {nextLabel}
          </button>
        </div>
      )}
    </div>
  )
}

// A scale row: big label plus the behavioural test underneath. The test is the
// point — abstract intensity words (poor / fair / decent) are what made the old
// 3 and 4 interchangeable. Each option must be decidable in one second.
function ScaleOption({
  label, test, selected, onClick,
}: { label: string; test: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`w-full py-3.5 px-5 rounded-xl text-left transition-colors
        ${selected
          ? 'bg-ow-orange text-ow-dark'
          : 'bg-ow-panel border border-ow-line hover:border-ow-orange/40'}`}
    >
      <span className={`block font-display tracking-[0.15em] uppercase text-base
        ${selected ? 'font-bold text-ow-dark' : 'text-ow-fg'}`}>{label}</span>
      <span className={`block text-xs mt-0.5 ${selected ? 'text-ow-dark/75' : 'text-ow-faint'}`}>
        {test}
      </span>
    </button>
  )
}

const ISSUE_OPTIONS: { v: TeamIssue; label: string; test: string }[] = [
  { v: 'none',          label: 'NOTHING',        test: 'Normal game' },
  { v: 'left_gone',     label: 'LEFT — GONE',    test: "Someone left and didn't come back" },
  { v: 'left_returned', label: 'LEFT — RETURNED', test: 'Someone left and came back' },
  { v: 'thrower',       label: 'THROWING',       test: 'Someone was throwing' },
]

// Multi-select. 'NOTHING' is mutually exclusive with the rest (see toggleIssue).
// The left-gone / left-returned split matters structurally, not cosmetically:
// a permanent leaver's row DISAPPEARS from the scoreboard, so the board becomes
// asymmetric and the grid detection can no longer trust which slot is which
// player — those games write no scoreboard at all. A returned leaver's board is
// complete, so it is processed and filtered at read time instead.
function IssuePicker({
  value, onToggle,
}: { value: TeamIssue[]; onToggle: (i: TeamIssue) => void }) {
  return (
    <>
      {ISSUE_OPTIONS.map(o => (
        <ScaleOption key={o.v} label={o.label} test={o.test}
          selected={value.includes(o.v)} onClick={() => onToggle(o.v)} />
      ))}
    </>
  )
}

// Slot buttons. Numbers only for now — the scoreboard photo is not shown here
// yet because the phone does not classify which uploaded photo IS the
// scoreboard. A light detector (modelled on phone-map-detect) can be added
// later to display it above these buttons with tap-to-enlarge; this grid is the
// documented FALLBACK and must keep working even when detection misses, so the
// step is never blocked.
/** Single-select slot picker (v1.1.3, replaces the multi-select SlotGrid).
 *
 *  Buttons READ 1..N on both screens because that is how a human counts a team
 *  down the scoreboard. The value returned is the real slot number, so the
 *  enemy screen displays 1..5 and returns 6..10 — matching scoreboard_players
 *  and the DB's 1-12 CHECK. Do not "fix" the labels to match the stored value:
 *  the mismatch is the point. */
function SlotPicker({
  slots, selected, onPick,
}: { slots: number[]; selected: number | null; onPick: (s: number) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {slots.map((n, i) => (
        <button key={n} type="button" onClick={() => onPick(n)}
          className={`py-4 rounded-xl font-display text-lg tracking-wider transition-colors
            ${selected === n
              ? 'bg-ow-orange text-ow-dark font-bold'
              : 'bg-ow-panel text-ow-muted border border-ow-line hover:border-ow-orange/40'}`}
        >{i + 1}</button>
      ))}
    </div>
  )
}

/** The team block from the scoreboard photo, above the buttons. Tap to enlarge
 *  — at phone width a 1750px-wide crop renders about 390px across, which is
 *  enough to tell heroes apart but not to read a gamertag. */
function CropStrip({ src, alt, onEnlarge }: { src: string; alt: string; onEnlarge: (s: string) => void }) {
  return (
    <button type="button" onClick={() => onEnlarge(src)} title="Tap to enlarge"
      className="block w-full rounded-xl border border-ow-line overflow-hidden cursor-zoom-in">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="w-full object-contain" />
    </button>
  )
}

export default function UploadPage() {
  const [step, setStep] = useState<Step>('format')
  const inputRef = useRef<HTMLInputElement>(null)
  // Parked map/side between the side question and the upload — see proceedAfterSide.
  const pendingMapRef = useRef<string | null | undefined>(undefined)
  const pendingSideRef = useRef<StartingSide | null | undefined>(undefined)

  const [matchFormat, setMatchFormat] = useState<'5v5' | '6v6' | null>(null)
  const [role, setRole] = useState<RoleType | null>(null)
  const [rolesPlayed, setRolesPlayed] = useState<RoleType[]>([])

  // Scale version 2 fields. 1-5, 1-5, 1-6 respectively.
  const [matchupFeel, setMatchupFeel] = useState<number | null>(null)
  const [perfRating, setPerfRating] = useState<number | null>(null)
  const [funRating6, setFunRating6] = useState<number | null>(null)

  // Multi-select per team. Empty array = not answered; ['none'] = explicitly nothing.
  const [teamIssues, setTeamIssues] = useState<TeamIssue[]>([])
  const [enemyIssues, setEnemyIssues] = useState<TeamIssue[]>([])
  const [thoughts, setThoughts] = useState('')

  // Slot picks — captured on the PHONE, seconds after the match, because that
  // is when they are remembered. /process can run three days later, by which
  // point the answer would be invented rather than recalled.
  // Stored as SLOTS; resolved to hero names at save time, AFTER the hero audit
  // (a slot's hero is not trustworthy until HeroAuditPanel has been through it).
  // ONE pick per kind (v1.1.3). Was number[] with a multi-select grid, which
  // is incompatible with tap-to-advance and was never what the question meant:
  // "the standout", not "everyone who did well". Still written to metadata as
  // an ARRAY of at most one, because /process reads number[] and dedupes — so
  // the wire format is unchanged and any batch already sitting in pending/
  // stays readable.
  const [impressedAlly, setImpressedAlly] = useState<number | null>(null)
  const [struggledEnemy, setStruggledEnemy] = useState<number | null>(null)
  /** Ally + enemy crops of the scoreboard photo, for the standout screens.
   *  null = not found; the screens fall back to the bare number grid. */
  const [sbCrops, setSbCrops] = useState<ScoreboardCrops | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  const [files, setFiles] = useState<FilePreview[]>([])
  // (v1.2.0) Bulk session upload. No previews: a session can be 100–200
  // full-resolution screenshots, too many to decode as thumbnails on a phone.
  const [sessionFiles, setSessionFiles] = useState<File[]>([])
  const [sessionDone, setSessionDone] = useState(0)
  // Each photo keeps its original number, so a retry can never overwrite one
  // that already uploaded.
  const [sessionFailed, setSessionFailed] = useState<{ file: File; n: number }[]>([])
  const sessionIdRef = useRef<string | null>(null)

  const [detectedMap, setDetectedMap] = useState<string | null>(null)
  const [startingSide, setStartingSide] = useState<StartingSide | null>(null)

  // Leaver games skip scoreboard processing, so a tagged leaver gets an explicit
  // confirmation before the upload commits. This tracks that the user has seen it.
  const [leaverConfirmed, setLeaverConfirmed] = useState(false)

  // ---- derived from the issue multi-selects -------------------------------
  // The booleans are still written so nothing downstream breaks on day one;
  // the *_leaver_type columns carry the new three-state detail.
  const teamLeaverType: 'none' | 'left' | 'returned' =
    teamIssues.includes('left_gone') ? 'left'
      : teamIssues.includes('left_returned') ? 'returned' : 'none'
  const enemyLeaverType: 'none' | 'left' | 'returned' =
    enemyIssues.includes('left_gone') ? 'left'
      : enemyIssues.includes('left_returned') ? 'returned' : 'none'

  const teamLeaver = teamLeaverType !== 'none'
  const enemyLeaver = enemyLeaverType !== 'none'
  const teamThrower = teamIssues.includes('thrower')
  const enemyThrower = enemyIssues.includes('thrower')

  // A PERMANENT leaver means the scoreboard is geometrically broken — a row
  // disappears, the board becomes asymmetric (5 allies vs 6 enemies), and the
  // VS-gap grid detection can no longer trust which slot is which player. Those
  // games write NO scoreboard at all, so there are no slots to pick from.
  // A RETURNED leaver still has a full board, so slot picks are fine.
  const hasPermanentLeaver = teamLeaverType === 'left' || enemyLeaverType === 'left'

  // toggle one issue, keeping 'none' mutually exclusive with everything else
  // (v1.1.3) "NOTHING WENT WRONG" advances on its own; a real issue does not.
  //
  // Most matches have nothing wrong, so the common path becomes a single tap.
  // When something DID go wrong the deliberate NEXT press is the feature: it is
  // the moment to think twice, and it is also what keeps IssuePicker
  // multi-select — a match can have both a leaver and a thrower, and
  // auto-advancing on those would make that combination unrecordable.
  //
  // ⚠️ Advances only when SELECTING 'none', never when deselecting it.
  // `current` is the value this render was built from, so `current.includes`
  // reads the pre-tap state — which is exactly the question being asked. The
  // tapped value is passed in rather than read back after the setter, for the
  // same reason as sideOverride.
  //
  // 'none' writes an EMPTY array (see toggleIssue), not a 'none' member, so
  // nothing downstream of team_issues sees a new value.
  function autoAdvanceIssues(current: TeamIssue[], tapped: TeamIssue, next: Step) {
    if (tapped !== 'none') return
    if (current.includes('none')) return   // deselecting — stay put
    window.setTimeout(() => { setStep(next) }, ADVANCE_DELAY)
  }

  function toggleIssue(
    current: TeamIssue[], setter: (v: TeamIssue[]) => void, issue: TeamIssue,
  ) {
    if (issue === 'none') { setter(current.includes('none') ? [] : ['none']); return }
    const without = current.filter(i => i !== 'none')
    setter(without.includes(issue) ? without.filter(i => i !== issue) : [...without, issue])
  }

  // Slot ranges mirror scoreboard_players: 5v5 -> ally 1-5, enemy 6-10;
  // 6v6 -> ally 1-6, enemy 7-12.
  const teamSize = matchFormat === '6v6' ? 6 : 5
  const allySlots = Array.from({ length: teamSize }, (_, i) => i + 1)
  const enemySlots = Array.from({ length: teamSize }, (_, i) => i + 1 + teamSize)

  // auto-advance: set value, then move to next step after a brief beat
  function pickAndAdvance<T>(setter: (v: T) => void, value: T, next: Step) {
    setter(value)
    window.setTimeout(() => setStep(next), ADVANCE_DELAY)
  }

  // Map detection now runs when the user presses UPLOAD ALL (see beginUpload),
  // NOT automatically when photos change — this guarantees the attack/defend
  // question gets a chance to appear and can't be raced past.

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files
    if (!selected) return
    const newFiles: FilePreview[] = Array.from(selected).map(file => ({
      file, preview: URL.createObjectURL(file), status: 'idle' as FileStatus,
    }))
    setFiles(prev => [...prev, ...newFiles])
  }

  function removeFile(index: number) {
    setFiles(prev => {
      const updated = [...prev]
      URL.revokeObjectURL(updated[index].preview)
      updated.splice(index, 1)
      return updated
    })
  }

  async function convertToJpeg(file: File): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(img.src)
            if (blob) resolve(blob)
            else reject(new Error('Failed to convert image'))
          },
          'image/jpeg', 0.92,
        )
      }
      img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Failed to load image')) }
      img.src = URL.createObjectURL(file)
    })
  }

  // PHASE 1 — pressed UPLOAD ALL. If a leaver was tagged, confirm the
  // consequence first (the scoreboard is skipped for leaver games), because the
  // tag now controls processing, not just the Feel log. Otherwise go straight
  // to map detection.
  async function beginUpload() {
    const hasRole = matchFormat === '5v5' ? !!role : rolesPlayed.length > 0
    if (files.length === 0 || !hasRole) return

    if ((teamLeaver || enemyLeaver) && !leaverConfirmed) {
      setStep('confirm_leaver')
      return
    }
    await runMapDetection()
  }

  // PHASE 1b — map detection (with a visible "checking" step so it can't be
  // raced past). If the map is hybrid/escort, go ask attack/defend (blocking).
  // Otherwise — or if the map can't be read — go straight to committing.
  async function runMapDetection() {
    setStep('checking')
    let mapName: string | null = null
    try {
      const res = await detectMapFromPhotos(files.map(f => f.preview))
      mapName = res.mapName
    } catch {
      mapName = null
    }
    setDetectedMap(mapName)

    // (v1.1.3) Find the scoreboard photo and cut the two team blocks, while the
    // spinner is already up. Nine pixel reads plus two JPEG encodes — trivial
    // next to the Tesseract pass above, and doing it here means the standout
    // screens have their image the moment they render instead of popping it in
    // a beat later.
    //
    // Skipped for a permanent leaver: that game writes no scoreboard and the
    // standout step never runs. Failure is not an error — the screens fall back
    // to bare numbers, exactly as they behaved before this patch.
    if (!hasPermanentLeaver) {
      try {
        const crops = await detectScoreboardCrops(
          files.map(f => f.preview),
          matchFormat === '6v6' ? '6v6' : '5v5',
        )
        setSbCrops(crops)
        if (!crops) console.log('[standouts] no scoreboard photo found — showing numbers only')
      } catch (e) {
        console.warn('[standouts] crop detection failed, showing numbers only', e)
        setSbCrops(null)
      }
    }
    const needsSide = mapName ? needsStartingSide(mapName) : false

    if (needsSide) {
      // Ask the question and WAIT — the flow continues after the user answers.
      setStep('confirm_side')
    } else {
      // Map not hybrid/escort, or not detected → carry on. Pass the freshly
      // detected mapName directly: setDetectedMap above hasn't flushed yet this
      // tick, so reading the state var here would be stale.
      proceedAfterSide(mapName)
    }
  }

  // PHASE 1c — between the side question and the upload sits the slot-picks
  // step. The resolved map/side are parked in refs rather than re-read from
  // state, for the same stale-closure reason documented on commitUpload: the
  // values may have been set in the same tick we navigate away from.
  //
  // A PERMANENT-leaver game SKIPS the picks entirely — it writes no scoreboard,
  // so there are no slots to pick from.
  function proceedAfterSide(mapOverride?: string | null, sideOverride?: StartingSide | null) {
    pendingMapRef.current = mapOverride
    pendingSideRef.current = sideOverride
    if (hasPermanentLeaver) { void commitUpload(mapOverride, sideOverride); return }
    setStep('standout_ally')
  }

  // PHASE 1d — the enemy pick is made and the upload starts in the SAME tick,
  // so the pick is handed over explicitly rather than read back from state.
  // Identical reasoning to sideOverride: setStruggledEnemy has not flushed, and
  // commitUpload closes over the value from the render that created the
  // handler. The ally pick needs no override — it was set a full screen ago.
  function finishStandouts(enemyPick: number | null) {
    void commitUpload(pendingMapRef.current, pendingSideRef.current, enemyPick)
  }

  // PHASE 2 — actually upload photos + metadata, then show success.
  // `mapOverride` carries the just-detected map when commit runs in the same
  // tick as detection (the no-side path); otherwise the detectedMap state is
  // authoritative (the side path runs a tick later, after the user answers).
  //
  // `sideOverride` is the SAME PATTERN for the starting side, and it is not
  // optional politeness -- without it the value was lost on EVERY upload.
  // The confirm_side handler calls setStartingSide(side) and then commitUpload()
  // from a timeout, but the commitUpload it invokes is the function object from
  // the render in which the handler was created, closing over startingSide as
  // null. The delay does not help: the binding is captured when the handler
  // runs, not when the timeout fires. Result: starting_side was null in
  // metadata.json 100% of the time, and NULL on all 192 stored matches.
  //
  // Both overrides use an `!== undefined` sentinel rather than a truthiness or
  // ?? check, because null is a LEGITIMATE answer here ("Not sure") and must be
  // distinguishable from "no override passed".
  async function commitUpload(
    mapOverride?: string | null,
    sideOverride?: StartingSide | null,
    enemyPickOverride?: number | null,
  ) {
    setStep('uploading')
    const batchId = Date.now().toString()
    const updated = [...files]
    const effectiveMap = mapOverride !== undefined ? mapOverride : detectedMap
    const effectiveSide = sideOverride !== undefined ? sideOverride : startingSide

    const metadata = {
      match_format: matchFormat,
      role_played: role,
      roles_played: matchFormat === '6v6' ? rolesPlayed : (role ? [role] : []),
      // ---- question scale version 2 ----------------------------------------
      // These map to the NEW columns: matches.matchup_feel (1-5),
      // matches.performance_rating (1-5), matches.fun_rating_6 (1-6).
      // The OLD columns (match_feel, performance_feel, fun_rating, tilt_mood,
      // team_tempo, team_coordination + enemy twins) are FROZEN and are no
      // longer written. Do NOT map these onto them — the scales are different
      // and the two sets are never pooled.
      question_scale_version: 2,
      matchup_feel: matchupFeel,
      performance_rating: perfRating,
      fun_rating_6: funRating6,

      // ---- leavers + throwers ----------------------------------------------
      // Booleans STILL WRITTEN so nothing downstream breaks on day one; the
      // *_leaver_type fields carry the new three-state detail.
      team_leaver: teamLeaver,
      team_thrower: teamThrower,
      enemy_leaver: enemyLeaver,
      enemy_thrower: enemyThrower,
      team_leaver_type: teamLeaverType,
      enemy_leaver_type: enemyLeaverType,

      // Derived convenience flag for the process page. ONLY a PERMANENT leaver
      // skips the scoreboard: their row disappears, so the board is asymmetric
      // and the VS-gap grid can no longer be trusted to say which slot is which
      // player. A RETURNED leaver's board is complete — the numbers are skewed,
      // but the geometry is intact — so it IS processed, and excluded from
      // scoreboard-derived surfaces at read time instead.
      has_leaver: hasPermanentLeaver,
      personal_thoughts: thoughts || null,

      // ---- slot picks -------------------------------------------------------
      // Slots only. hero_name is resolved at save time, AFTER the hero audit —
      // the hero behind a slot is not trustworthy until HeroAuditPanel has been
      // through it, and a corrected misidentification must carry through.
      // Empty arrays = explicitly nothing stood out. Absent for permanent-leaver
      // games (no scoreboard, so the step is skipped).
      // Arrays of at most one. See the state declaration: /process resolves
      // number[] to hero names and dedupes, so a one-element array needs no
      // change there and old multi-pick batches still parse.
      impressed_ally_slots: impressedAlly == null ? [] : [impressedAlly],
      struggled_enemy_slots: (() => {
        // `!== undefined` sentinel, not `??`: null is a legitimate answer
        // ("NONE") and must stay distinguishable from "no override passed".
        const pick = enemyPickOverride !== undefined ? enemyPickOverride : struggledEnemy
        return pick == null ? [] : [pick]
      })(),
      starting_side: effectiveSide,
      detected_map: effectiveMap,
      // Step 10: phone map auto-detect produced nothing. The process page reads
      // this to raise a map dropdown (+ conditional attack/defend) at review,
      // and logs the miss. No side question was asked here when this is true.
      map_detect_missed: effectiveMap === null,
      uploaded_at: new Date().toISOString(),
      photo_count: files.length,
    }

    await supabase.storage
      .from('match-images')
      .upload(`pending/${batchId}/metadata.json`, JSON.stringify(metadata), {
        contentType: 'application/json',
      })

    for (let i = 0; i < updated.length; i++) {
      updated[i].status = 'uploading'
      setFiles([...updated])
      try {
        const jpegBlob = await convertToJpeg(updated[i].file)
        const path = `pending/${batchId}/photo_${i + 1}.jpg`
        const { error } = await supabase.storage
          .from('match-images')
          .upload(path, jpegBlob, { contentType: 'image/jpeg' })
        updated[i].status = error ? 'error' : 'success'
      } catch (err) {
        console.warn(`Failed to convert/upload photo ${i}:`, err)
        updated[i].status = 'error'
      }
      setFiles([...updated])
    }

    if (updated.every(f => f.status === 'success')) setStep('done')
  }

  function resetForm() {
    setStep('format')
    setMatchFormat(null); setRole(null); setRolesPlayed([])
    setMatchupFeel(null); setPerfRating(null); setFunRating6(null)
    setTeamIssues([]); setEnemyIssues([])
    setImpressedAlly(null); setStruggledEnemy(null)
    // (v1.1.3) Must be cleared too, or the next match's standout screens open
    // showing the PREVIOUS match's scoreboard. The crops are data URLs held in
    // state, not object URLs, so there is nothing to revoke — but a stale image
    // beside a fresh set of slot buttons is worse than no image at all.
    setSbCrops(null); setLightbox(null)
    pendingMapRef.current = undefined; pendingSideRef.current = undefined
    setThoughts('')
    files.forEach(f => URL.revokeObjectURL(f.preview))
    setFiles([])
    setDetectedMap(null); setStartingSide(null)
    setLeaverConfirmed(false)
  }

  // ======================== SESSION UPLOAD (v1.2.0) ========================
  // Storage: pending/session-<ts>/photo_NNN.jpg + metadata.json. metadata.json
  // is written FIRST with upload_complete:false (so an abandoned upload is
  // still found and auto-cleaned like any other), then rewritten with
  // upload_complete:true once every photo is up. /process warns on an
  // incomplete session rather than hiding it.
  async function writeSessionMetadata(sessionId: string, complete: boolean, uploaded: number, total: number) {
    const metadata = {
      kind: 'session',
      upload_complete: complete,
      uploaded_at: new Date().toISOString(),
      photo_count: total,
      uploaded_count: uploaded,
    }
    await supabase.storage
      .from('match-images')
      .upload(`pending/${sessionId}/metadata.json`, JSON.stringify(metadata), {
        contentType: 'application/json',
        upsert: true,
      })
  }

  async function uploadSession(toUpload: { file: File; n: number }[]) {
    const firstRun = sessionIdRef.current == null
    const sessionId = sessionIdRef.current ?? `session-${Date.now()}`
    sessionIdRef.current = sessionId
    const total = sessionFiles.length
    setStep('session_uploading')
    if (firstRun) await writeSessionMetadata(sessionId, false, 0, total)

    const failed: { file: File; n: number }[] = []
    let done = firstRun ? 0 : sessionDone
    for (const item of toUpload) {
      try {
        const jpegBlob = await convertToJpeg(item.file)
        const { error } = await supabase.storage
          .from('match-images')
          .upload(`pending/${sessionId}/photo_${String(item.n).padStart(3, '0')}.jpg`, jpegBlob, {
            contentType: 'image/jpeg',
            upsert: true,
          })
        if (error) failed.push(item)
        else done++
      } catch (err) {
        console.warn(`Session upload: photo ${item.n} failed`, err)
        failed.push(item)
      }
      setSessionDone(done)
    }
    setSessionFailed(failed)
    await writeSessionMetadata(sessionId, failed.length === 0, done, total)
    setStep('session_done')
  }

  function resetSession() {
    sessionIdRef.current = null
    setSessionFiles([])
    setSessionDone(0)
    setSessionFailed([])
    setStep('format')
  }

  if (step === 'session_photos') {
    return (
      <StepShell
        title="Upload a session"
        hint="Select every match-history screenshot from your session — Summary, Teams and each Personal page — in any order. The tracker sorts them into matches when you process them."
        onBack={resetSession}
        onNext={() => void uploadSession(sessionFiles.map((file, i) => ({ file, n: i + 1 })))}
        nextLabel={sessionFiles.length ? `UPLOAD ${sessionFiles.length} SCREENSHOTS` : 'UPLOAD'}
        nextDisabled={sessionFiles.length === 0}>
        <label className="block w-full rounded-xl border-2 border-dashed border-ow-line hover:border-ow-orange/40
          bg-ow-panel/50 px-4 py-10 text-center cursor-pointer transition-colors">
          <input type="file" accept="image/*" multiple className="hidden"
            onChange={e => {
              const picked = Array.from(e.target.files ?? []).filter(f => f.type.startsWith('image/'))
              setSessionFiles(prev => [...prev, ...picked])
              e.target.value = ''
            }} />
          <span className="font-display tracking-wider text-ow-fg">
            {sessionFiles.length ? `${sessionFiles.length} SCREENSHOTS SELECTED` : 'CHOOSE SCREENSHOTS'}
          </span>
          <span className="block text-xs text-ow-faint mt-2">
            {sessionFiles.length ? 'Tap to add more' : 'You can pick them all at once'}
          </span>
        </label>
        {sessionFiles.length > 0 && (
          <button type="button" onClick={() => setSessionFiles([])}
            className="w-full text-xs text-ow-faint hover:text-ow-defeat font-display tracking-wider py-2">
            CLEAR SELECTION
          </button>
        )}
      </StepShell>
    )
  }

  if (step === 'session_uploading') {
    const total = sessionFiles.length || 1
    return (
      <div className="min-h-[100dvh] flex items-center justify-center px-6 bg-ow-dark">
        <div className="w-full max-w-sm text-center">
          <div className="w-10 h-10 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-ow-fg font-display text-lg tracking-wider">UPLOADING SESSION</p>
          <p className="text-ow-muted text-sm mt-1">{sessionDone} / {sessionFiles.length} screenshots</p>
          <div className="h-2 rounded-full bg-ow-panel border border-ow-line mt-5 overflow-hidden">
            <div className="h-full bg-ow-orange transition-all" style={{ width: `${Math.round((100 * sessionDone) / total)}%` }} />
          </div>
          <p className="text-xs text-ow-faint mt-4">Keep this screen open until it finishes.</p>
        </div>
      </div>
    )
  }

  if (step === 'session_done') {
    const ok = sessionFailed.length === 0
    return (
      <div className="min-h-[100dvh] flex items-center justify-center px-6 bg-ow-dark">
        <div className="w-full max-w-sm">
          <div className={`${ok ? 'bg-ow-victory/10 border-ow-victory/30' : 'bg-ow-defeat/10 border-ow-defeat/30'} border rounded-xl p-8 text-center`}>
            <span className="text-4xl block mb-3">{ok ? '✓' : '!'}</span>
            <p className={`${ok ? 'text-ow-victory' : 'text-ow-defeat'} font-display text-xl font-bold tracking-wider`}>
              {ok ? 'SESSION UPLOADED' : `${sessionFailed.length} FAILED`}
            </p>
            <p className="text-ow-muted text-sm mt-2">
              {ok
                ? `${sessionDone} screenshots. Open the tracker on your laptop to process the session.`
                : `${sessionDone} of ${sessionFiles.length} uploaded. Retry the rest before processing.`}
            </p>
            {!ok && (
              <button onClick={() => void uploadSession(sessionFailed)}
                className="mt-6 w-full rounded-xl bg-ow-orange text-ow-dark font-display font-bold px-6 py-3 tracking-wider text-sm">
                RETRY {sessionFailed.length}
              </button>
            )}
            <button onClick={resetSession}
              className="mt-3 rounded-xl bg-ow-panel border border-ow-line text-ow-fg font-display
                px-6 py-3 tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
              DONE
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ======================== FORMAT (auto-advance) ========================
  if (step === 'format') {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center px-6 bg-ow-dark relative overflow-hidden">
        <div aria-hidden className="absolute inset-0 opacity-60 pointer-events-none"
          style={{ background: 'radial-gradient(60% 45% at 50% 0%, rgba(249,158,26,0.10), transparent 70%), radial-gradient(50% 50% at 80% 100%, rgba(30,58,95,0.45), transparent 70%)' }} />
        <div className="relative w-full max-w-sm">
          <div className="h-1 w-14 bg-ow-orange mb-5 mx-auto rounded-full" />
          <h1 className="font-display text-3xl tracking-[0.18em] text-center text-ow-fg uppercase">Overwatch</h1>
          <p className="font-display text-xs tracking-[0.4em] text-center text-ow-orange uppercase mt-1 mb-10">Ranked Tracker</p>
          <p className="text-center text-xs font-display tracking-[0.25em] text-ow-faint uppercase mb-5">Select Format</p>
          <div className="space-y-4">
            <OptionButton big label="5V5" selected={matchFormat === '5v5'}
              onClick={() => { setRolesPlayed([]); pickAndAdvance(setMatchFormat, '5v5', 'role') }} />
            <OptionButton big label="6V6" selected={matchFormat === '6v6'}
              onClick={() => { setRole(null); pickAndAdvance(setMatchFormat, '6v6', 'role') }} />
          </div>
          {/* (v1.2.0) Bulk session upload — a separate path; the per-match
              flow above is unchanged. */}
          <button type="button" onClick={() => setStep('session_photos')}
            className="w-full mt-8 text-xs font-display tracking-[0.2em] text-ow-faint hover:text-ow-orange uppercase transition-colors">
            Or upload a whole session →
          </button>
        </div>
      </div>
    )
  }

  // ======================== ROLE ========================
  if (step === 'role') {
    const fivev5 = matchFormat === '5v5'
    const toggleMulti = (r: RoleType) =>
      setRolesPlayed(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])
    return (
      <StepShell
        title={fivev5 ? 'Role Played' : 'Roles Played'}
        hint={fivev5 ? undefined : 'Select all roles you played (1–3)'}
        onBack={() => setStep('format')}
        onNext={fivev5 ? undefined : () => setStep('matchup')}
        nextDisabled={rolesPlayed.length === 0}
      >
        {(['tank', 'dps', 'support'] as RoleType[]).map(r => (
          <OptionButton key={r} label={r.toUpperCase()}
            selected={fivev5 ? role === r : rolesPlayed.includes(r)}
            onClick={() => fivev5 ? pickAndAdvance(setRole, r, 'matchup') : toggleMulti(r)} />
        ))}
      </StepShell>
    )
  }

  // ======================== Q1 MATCH-UP (auto-advance) ========================
  // "How did you feel your team matched up against the enemy?"
  // KEEPS ITS MIDPOINT deliberately, unlike fun: "evenly matched" IS the signal
  // here — it is the exact state the whole hypothesis (a tight loss is still
  // fun) is about, so removing it would delete the thing being measured.
  // Measures TEAM STRENGTH, not result: Behind + victory is legitimate.
  const MATCHUP_OPTIONS: { v: number; label: string; test: string }[] = [
    { v: 1, label: 'OUTCLASSED', test: 'Never had a chance' },
    { v: 2, label: 'BEHIND',     test: 'They had the edge throughout' },
    { v: 3, label: 'EVEN',       test: 'Genuinely contested' },
    { v: 4, label: 'AHEAD',      test: 'We had the edge throughout' },
    { v: 5, label: 'DOMINANT',   test: 'Never in doubt' },
  ]
  if (step === 'matchup') {
    return (
      <StepShell title="How did your team match up?" hint="Not the result — how the sides compared"
        onBack={() => setStep('role')} onSkip={() => setStep('performance')}>
        {MATCHUP_OPTIONS.map(o => (
          <ScaleOption key={o.v} label={o.label} test={o.test}
            selected={matchupFeel === o.v}
            onClick={() => pickAndAdvance(setMatchupFeel, o.v, 'performance')} />
        ))}
      </StepShell>
    )
  }

  // ======================== Q2 PERFORMANCE (auto-advance) ========================
  // ⚠️ WATCH: if "DID MY JOB" takes >40% of answers it is behaving like the old
  // fun 3/4 pair and should be cut to four points at the next season boundary.
  const PERF_OPTIONS: { v: number; label: string; test: string }[] = [
    { v: 1, label: 'OFF MY GAME', test: 'I was part of the problem' },
    { v: 2, label: 'BELOW PAR',   test: 'Not my usual standard' },
    { v: 3, label: 'DID MY JOB',  test: 'Normal game for me' },
    { v: 4, label: 'PLAYED WELL', test: 'Better than usual' },
    { v: 5, label: 'CARRIED',     test: 'I was the reason we were in it' },
  ]
  if (step === 'performance') {
    return (
      <StepShell title="How did you play?"
        onBack={() => setStep('matchup')} onSkip={() => setStep('fun')}>
        {PERF_OPTIONS.map(o => (
          <ScaleOption key={o.v} label={o.label} test={o.test}
            selected={perfRating === o.v}
            onClick={() => pickAndAdvance(setPerfRating, o.v, 'fun')} />
        ))}
      </StepShell>
    )
  }

  // ======================== Q3 FUN (auto-advance) ========================
  // SIX points, NO MIDPOINT — deliberately. The old 5-star scale collapsed:
  // 3 and 4 held 128 of 192 answers and were described as interchangeable,
  // 5 was used 3% of the time, and 1 was used MORE than 2. Six points means
  // the centre falls BETWEEN 3 and 4, so every answer must lean. The scale is
  // one binary question — did I enjoy this? — with two intensity steps either
  // side, and the 3/4 boundary is the whole decision.
  // Stars were dropped: they invite a lazy middle. Each point is anchored to a
  // BEHAVIOURAL TEST that can be decided in a second at 11pm.
  const FUN_OPTIONS: { v: number; label: string; test: string }[] = [
    { v: 1, label: 'MISERABLE', test: 'I wanted to stop playing' },
    { v: 2, label: 'BAD',       test: 'Unpleasant, but I saw it out' },
    { v: 3, label: 'POOR',      test: "No, I didn't enjoy that" },
    { v: 4, label: 'GOOD',      test: 'Yes, I enjoyed that' },
    { v: 5, label: 'GREAT',     test: "I'd happily play that again" },
    { v: 6, label: 'BRILLIANT', test: 'Memorable — the reason I play' },
  ]
  if (step === 'fun') {
    return (
      <StepShell title="Did you enjoy it?"
        onBack={() => setStep('performance')} onSkip={() => setStep('team')}>
        {FUN_OPTIONS.map(o => (
          <ScaleOption key={o.v} label={o.label} test={o.test}
            selected={funRating6 === o.v}
            onClick={() => pickAndAdvance(setFunRating6, o.v, 'team')} />
        ))}
      </StepShell>
    )
  }

  // ======================== TEAM ISSUES (multi → keep NEXT) ========================
  // Replaces the old tempo/coordination scales + leaver/thrower toggles.
  // MULTI-SELECT because a game can have both a leaver and a thrower.
  // Ally first, then enemy — matching the slot-pick order later.
  if (step === 'team') {
    return (
      <StepShell title="Anything go wrong on your team?"
        hint="Tap NOTHING to move on, or pick what happened"
        onBack={() => setStep('fun')}
        onNext={() => setStep('enemy')} onSkip={() => setStep('enemy')}>
        <IssuePicker value={teamIssues}
          onToggle={i => { toggleIssue(teamIssues, setTeamIssues, i); autoAdvanceIssues(teamIssues, i, 'enemy') }} />
      </StepShell>
    )
  }

  // ======================== ENEMY ISSUES (multi → keep NEXT) ========================
  if (step === 'enemy') {
    return (
      <StepShell title="And the enemy team?"
        hint="Tap NOTHING to move on, or pick what happened"
        onBack={() => setStep('team')}
        onNext={() => setStep('thoughts')} onSkip={() => setStep('thoughts')}>
        <IssuePicker value={enemyIssues}
          onToggle={i => { toggleIssue(enemyIssues, setEnemyIssues, i); autoAdvanceIssues(enemyIssues, i, 'thoughts') }} />
      </StepShell>
    )
  }

  // ======================== THOUGHTS (free text → keep NEXT) ========================
  if (step === 'thoughts') {
    return (
      <StepShell title="Anything to note?" hint="Optional — the one bit you'll want to remember"
        onBack={() => setStep('enemy')} onNext={() => setStep('photos')} nextLabel="NEXT → PHOTOS"
        onSkip={() => setStep('photos')}>
        <textarea value={thoughts} onChange={e => setThoughts(e.target.value)}
          placeholder="What happened? What could you improve?" rows={4}
          className="w-full rounded-xl bg-ow-panel border border-ow-line px-4 py-3 text-ow-fg
            placeholder-ow-faint focus:border-ow-orange/50 focus:outline-none transition-colors resize-none" />
      </StepShell>
    )
  }

  // ======================== UPLOADING ========================
  // ======================== SLOT PICKS (multi → keep NEXT) ========================
  // Captured HERE, on the phone, seconds after the match — not at /process,
  // which can run three days later by which point the answer would be invented
  // rather than recalled.
  //
  // Slots mirror scoreboard_players: 5v5 -> ally 1-5, enemy 6-10;
  // 6v6 -> ally 1-6, enemy 7-12. Only slots are stored; hero names are resolved
  // at save time AFTER the hero audit, so a corrected misidentification carries
  // through to the pick.
  //
  // Both picks are OPTIONAL — an empty selection means nothing stood out, which
  // is a real and common answer. NEXT is always enabled.
  //
  // This step is SKIPPED ENTIRELY for permanent-leaver games (see
  // proceedAfterSide): no scoreboard is written, so there are no slots.
  // ======================== STANDOUTS — ALLY (1 of 2) ========================
  // (v1.1.3) Was ONE screen with two multi-select grids, no image, and a manual
  // UPLOAD button. Now two screens, one pick each, the relevant team's crop on
  // top, and a tap advances.
  //
  // ⚠️ ONLY the team being asked about is shown. Putting both blocks on screen
  // was the previous behaviour and it invites picking from the wrong half.
  if (step === 'standout_ally') {
    const pick = (slot: number | null) => {
      setImpressedAlly(slot)
      // Advance on the TAPPED value, never by re-reading state. setImpressedAlly
      // has not flushed this tick, and the timeout does not change which
      // closure was captured — the mistake that made starting_side null on all
      // 192 stored matches. Nothing downstream needs the value here, but the
      // pattern is kept so the next edit cannot reintroduce it.
      window.setTimeout(() => { setStep('standout_enemy') }, ADVANCE_DELAY)
    }
    return (
      <StepShell title="Which ally stood out?" hint="Standouts — 1 of 2"
        onBack={() => setStep('photos')}>
        {sbCrops
          ? <CropStrip src={sbCrops.ally} alt="Your team" onEnlarge={setLightbox} />
          : <p className="text-xs text-ow-faint">
              Couldn{'\u2019'}t read the scoreboard photo {'\u2014'} slots are numbered
              top to bottom as they appear on the board.
            </p>}
        <div className="pt-3">
          <SlotPicker slots={allySlots} selected={impressedAlly} onPick={pick} />
        </div>
        <button type="button" onClick={() => pick(null)}
          className="w-full mt-2 py-3 rounded-xl font-display text-sm tracking-wider
            bg-ow-panel text-ow-muted border border-ow-line hover:border-ow-orange/40 transition-colors">
          NONE
        </button>
        {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      </StepShell>
    )
  }

  // ======================== STANDOUTS — ENEMY (2 of 2) ========================
  if (step === 'standout_enemy') {
    const pick = (slot: number | null) => {
      setStruggledEnemy(slot)
      // Pass the pick EXPLICITLY into commitUpload's caller chain. commitUpload
      // reads impressedAlly/struggledEnemy from state, and struggledEnemy has
      // not flushed yet — so the upload must not start until React has
      // re-rendered with it. ADVANCE_DELAY covers that, but the safe version is
      // to hand the value over rather than rely on timing: see finish().
      window.setTimeout(() => { finishStandouts(slot) }, ADVANCE_DELAY)
    }
    return (
      <StepShell title="Which enemy gave you trouble?" hint="Standouts — 2 of 2"
        onBack={() => setStep('standout_ally')}>
        {sbCrops
          ? <CropStrip src={sbCrops.enemy} alt="Enemy team" onEnlarge={setLightbox} />
          : <p className="text-xs text-ow-faint">
              Couldn{'\u2019'}t read the scoreboard photo {'\u2014'} slots are numbered
              top to bottom as they appear on the board.
            </p>}
        <div className="pt-3">
          <SlotPicker slots={enemySlots} selected={struggledEnemy} onPick={pick} />
        </div>
        <button type="button" onClick={() => pick(null)}
          className="w-full mt-2 py-3 rounded-xl font-display text-sm tracking-wider
            bg-ow-panel text-ow-muted border border-ow-line hover:border-ow-orange/40 transition-colors">
          NONE
        </button>
        {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      </StepShell>
    )
  }

  if (step === 'uploading') {
    const uploaded = files.filter(f => f.status === 'success').length
    return (
      <div className="min-h-[100dvh] flex items-center justify-center px-6 bg-ow-dark">
        <div className="w-full max-w-sm text-center">
          <div className="w-10 h-10 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-ow-fg font-display text-lg tracking-wider">UPLOADING</p>
          <p className="text-ow-muted text-sm mt-1">{uploaded} / {files.length} photos</p>
          <div className="grid grid-cols-4 gap-2 mt-6">
            {files.map((f, i) => (
              <div key={i} className="aspect-square rounded-lg overflow-hidden relative">
                <img src={f.preview} alt="" className="w-full h-full object-cover" />
                {f.status === 'success' && <div className="absolute inset-0 bg-ow-victory/30 flex items-center justify-center text-lg">✓</div>}
                {f.status === 'uploading' && <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /></div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ======================== DONE ========================
  if (step === 'done') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center px-6 bg-ow-dark">
        <div className="w-full max-w-sm">
          <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-xl p-8 text-center">
            <span className="text-4xl block mb-3">✓</span>
            <p className="text-ow-victory font-display text-xl font-bold tracking-wider">MATCH UPLOADED</p>
            <p className="text-ow-muted text-sm mt-2">Open the tracker on your laptop to process and review</p>
            <button onClick={resetForm}
              className="mt-6 rounded-xl bg-ow-panel border border-ow-line text-ow-fg font-display
                px-6 py-3 tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
              UPLOAD ANOTHER
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ======================== CONFIRM LEAVER (blocking — only when tagged) ========================
  // A leaver collapses the scoreboard, so we DON'T extract scoreboard stats for
  // these games — only the summary + hero breakdowns. This confirms the user
  // really meant the tag before committing to that. "Go back" returns to the
  // enemy step to clear it; confirming continues into map detection.
  if (step === 'confirm_leaver') {
    const sides = teamLeaver && enemyLeaver
      ? 'both teams'
      : teamLeaver ? 'your team' : 'the enemy team'
    const confirm = () => {
      setLeaverConfirmed(true)
      window.setTimeout(() => { runMapDetection() }, ADVANCE_DELAY)
    }
    return (
      <div className="min-h-[100dvh] flex flex-col justify-center px-5 bg-ow-dark relative overflow-hidden">
        <div aria-hidden className="absolute inset-0 opacity-50 pointer-events-none"
          style={{ background: 'radial-gradient(60% 45% at 50% 0%, rgba(248,81,73,0.10), transparent 70%)' }} />
        <div className="relative max-w-md mx-auto w-full">
          <div className="h-1 w-12 bg-ow-defeat mb-5 rounded-full" />
          <h1 className="font-display text-2xl tracking-[0.15em] text-ow-fg uppercase leading-tight">Leaver tagged</h1>
          <p className="text-sm text-ow-muted mt-3 mb-2">
            You marked a leaver on <span className="text-ow-defeat font-semibold">{sides}</span>.
          </p>
          <p className="text-sm text-ow-faint mb-6">
            A leaver changes the scoreboard, so the scoreboard stats won’t be read
            for this match. Your result, heroes and breakdown are still saved.
          </p>
          <div className="space-y-3">
            <OptionButton label="Yes, there was a leaver" selected={false} onClick={confirm} />
            <button type="button" onClick={() => setStep('enemy')}
              className="w-full py-4 px-5 rounded-xl font-display tracking-[0.15em] uppercase
                text-center bg-ow-panel text-ow-muted border border-ow-line
                hover:border-ow-orange/40 hover:text-ow-fg transition-colors">
              No, go back
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ======================== CHECKING (after UPLOAD ALL, before question) ========================
  if (step === 'checking') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center px-6 bg-ow-dark">
        <div className="w-full max-w-sm text-center">
          <div className="w-10 h-10 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-ow-fg font-display text-lg tracking-wider">CHECKING MAP…</p>
          <p className="text-ow-faint text-sm mt-1">One moment</p>
        </div>
      </div>
    )
  }

  // ======================== CONFIRM SIDE (blocking — hybrid/escort only) ========================
  // Reached only when the map needs a starting side. Answering (or UNSURE)
  // proceeds to the actual upload. There is intentionally NO back / upload-more
  // here — it must be answered before the upload commits.
  if (step === 'confirm_side') {
    const answer = (side: StartingSide | null) => {
      setStartingSide(side)
      // Pass `side` EXPLICITLY. commitUpload closes over the startingSide from
      // THIS render (still null); setStartingSide above has not flushed and the
      // timeout does not change which closure was captured. Mirrors the
      // mapOverride pattern -- see the commitUpload comment.
      window.setTimeout(() => { proceedAfterSide(undefined, side) }, ADVANCE_DELAY)
    }
    return (
      <div className="min-h-[100dvh] flex flex-col justify-center px-5 bg-ow-dark relative overflow-hidden">
        <div aria-hidden className="absolute inset-0 opacity-50 pointer-events-none"
          style={{ background: 'radial-gradient(60% 45% at 50% 0%, rgba(249,158,26,0.10), transparent 70%)' }} />
        <div className="relative max-w-md mx-auto w-full">
          <div className="h-1 w-12 bg-ow-orange mb-5 rounded-full" />
          <h1 className="font-display text-2xl tracking-[0.15em] text-ow-fg uppercase leading-tight">Starting Side</h1>
          <p className="text-sm text-ow-faint mt-2 mb-6">
            <span className="text-ow-orange">{detectedMap}</span> — did you attack or defend first?
          </p>
          <div className="space-y-3">
            <OptionButton label="ATTACK FIRST" selected={startingSide === 'attack'}
              onClick={() => answer('attack')} />
            <OptionButton label="DEFEND FIRST" selected={startingSide === 'defense'}
              onClick={() => answer('defense')} />
          </div>
          {/* Unsure is present but understated — attack/defend are the obvious choice */}
          <button type="button" onClick={() => answer(null)}
            className="mt-6 w-full text-center text-xs text-ow-faint hover:text-ow-muted font-display tracking-wider uppercase transition-colors">
            Not sure
          </button>
        </div>
      </div>
    )
  }

  // ======================== PHOTOS ========================
  return (
    <div className="min-h-[100dvh] flex flex-col px-5 pt-[max(env(safe-area-inset-top),20px)] pb-[max(env(safe-area-inset-bottom),20px)] bg-ow-dark relative overflow-hidden">
      <div aria-hidden className="absolute inset-0 opacity-50 pointer-events-none"
        style={{ background: 'radial-gradient(60% 40% at 50% 0%, rgba(249,158,26,0.08), transparent 70%)' }} />

      <div className="relative flex items-center h-10 shrink-0">
        <button onClick={() => setStep('thoughts')} className="text-ow-faint hover:text-ow-orange text-sm font-display tracking-wider transition-colors">← BACK</button>
      </div>

      <div className="relative flex-1 max-w-md mx-auto w-full overflow-y-auto">
        <div className="h-1 w-12 bg-ow-orange mb-5 rounded-full" />
        <h1 className="font-display text-2xl tracking-[0.15em] text-ow-fg uppercase">Upload Photos</h1>
        <p className="text-sm text-ow-faint mt-2 mb-6">Summary, Scoreboard &amp; Breakdown screenshots (up to 8)</p>

        <input ref={inputRef} type="file" accept="image/*" multiple onChange={handleFileSelect} className="hidden" />

        <button onClick={() => inputRef.current?.click()}
          className="w-full rounded-xl border-2 border-dashed border-ow-line p-8 text-center hover:border-ow-orange/40 transition-colors group">
          <span className="text-4xl block mb-2">📷</span>
          <span className="text-ow-muted group-hover:text-ow-fg font-display tracking-wider">TAP TO SELECT PHOTOS</span>
        </button>

        {files.length > 0 && (
          <div className="space-y-3 mt-4">
            <p className="text-sm text-ow-muted font-display tracking-wider">
              {files.length} PHOTO{files.length !== 1 ? 'S' : ''} SELECTED
            </p>
            <div className="grid grid-cols-3 gap-2">
              {files.map((f, i) => (
                <div key={i} className="relative aspect-[4/3] rounded-lg overflow-hidden bg-ow-panel">
                  <img src={f.preview} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
                  <button onClick={() => removeFile(i)}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs flex items-center justify-center hover:bg-ow-defeat transition-colors">✕</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {files.length > 0 && (
        <div className="relative shrink-0 max-w-md mx-auto w-full pt-4">
          <button onClick={beginUpload}
            className="w-full rounded-xl bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold py-4 tracking-[0.2em] uppercase text-sm transition-colors">
            UPLOAD ALL
          </button>
        </div>
      )}
    </div>
  )
}
