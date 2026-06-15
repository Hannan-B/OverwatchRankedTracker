'use client'

import { useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import type { RoleType, MatchFeel, PerformanceFeel, StartingSide } from '@/lib/types'
import { detectMapFromPhotos } from '@/lib/phone-map-detect'
import { needsStartingSide } from '@/data/reference'

// ============================================================
// MOBILE UPLOAD — one-thing-per-screen flow (Phase 2 rebuild v2)
//
// v2 changes:
//   - Rounded buttons (reverted from angular cut)
//   - Full words on team/enemy scales (stacked full-width rows)
//   - Auto-advance on single-select questions (~250ms delay so the
//     selection highlight is visible). EXCEPTIONS that keep NEXT:
//     6v6 roles (multi), team feel, enemy feel, thoughts, photos.
//   - Back button on every step.
//
// Preserves phone-side map detection + attack/defend. No default_role.
// ============================================================

const ADVANCE_DELAY = 250 // ms — lets the highlight show before moving on

type Tempo = 'aggressive' | 'balanced' | 'passive'
type Coordination = 'coordinated' | 'average' | 'chaotic'
type TiltMood = 'tilted' | 'annoyed' | 'fine' | 'good' | 'hyped'

type Step =
  | 'format' | 'role' | 'vibe' | 'performance' | 'fun'
  | 'tilt' | 'team' | 'enemy' | 'thoughts'
  | 'photos' | 'confirm_leaver' | 'checking' | 'confirm_side' | 'uploading' | 'done'

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

function ScaleRow<T extends string>({
  label, options, value, onChange, labels,
}: { label: string; options: T[]; value: T | null; onChange: (v: T | null) => void; labels: Record<T, string> }) {
  return (
    <div>
      <p className="text-xs font-display tracking-[0.2em] text-ow-faint uppercase mb-2">{label}</p>
      <div className="space-y-2">
        {options.map(opt => (
          <button key={opt} type="button"
            onClick={() => onChange(value === opt ? null : opt)}
            className={`w-full py-3 rounded-xl text-sm font-display tracking-[0.12em] uppercase transition-colors
              ${value === opt ? 'bg-ow-orange text-ow-dark font-bold'
                : 'bg-ow-panel text-ow-muted border border-ow-line hover:text-ow-fg'}`}
          >{labels[opt]}</button>
        ))}
      </div>
    </div>
  )
}

function TogglePill({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle}
      className={`flex-1 px-4 py-3 rounded-xl text-xs font-display tracking-wider uppercase transition-colors
        ${on ? 'bg-ow-defeat text-white font-bold' : 'bg-ow-panel text-ow-muted border border-ow-line hover:text-ow-fg'}`}
    >{label}</button>
  )
}

export default function UploadPage() {
  const [step, setStep] = useState<Step>('format')
  const inputRef = useRef<HTMLInputElement>(null)

  const [matchFormat, setMatchFormat] = useState<'5v5' | '6v6' | null>(null)
  const [role, setRole] = useState<RoleType | null>(null)
  const [rolesPlayed, setRolesPlayed] = useState<RoleType[]>([])

  const [matchFeel, setMatchFeel] = useState<MatchFeel | null>(null)
  const [perfFeel, setPerfFeel] = useState<PerformanceFeel | null>(null)
  const [funRating, setFunRating] = useState<number | null>(null)
  const [tiltMood, setTiltMood] = useState<TiltMood | null>(null)
  const [teamTempo, setTeamTempo] = useState<Tempo | null>(null)
  const [teamCoord, setTeamCoord] = useState<Coordination | null>(null)
  const [teamLeaver, setTeamLeaver] = useState(false)
  const [teamThrower, setTeamThrower] = useState(false)
  const [enemyTempo, setEnemyTempo] = useState<Tempo | null>(null)
  const [enemyCoord, setEnemyCoord] = useState<Coordination | null>(null)
  const [enemyLeaver, setEnemyLeaver] = useState(false)
  const [enemyThrower, setEnemyThrower] = useState(false)
  const [thoughts, setThoughts] = useState('')

  const [files, setFiles] = useState<FilePreview[]>([])

  const [detectedMap, setDetectedMap] = useState<string | null>(null)
  const [startingSide, setStartingSide] = useState<StartingSide | null>(null)

  // Leaver games skip scoreboard processing, so a tagged leaver gets an explicit
  // confirmation before the upload commits. This tracks that the user has seen it.
  const [leaverConfirmed, setLeaverConfirmed] = useState(false)

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
    const needsSide = mapName ? needsStartingSide(mapName) : false

    if (needsSide) {
      // Ask the question and WAIT — commitUpload runs after the user answers.
      // (detectedMap state has settled by the time the user answers, so the
      // side-branch commit reads it from state; pass it explicitly anyway.)
      setStep('confirm_side')
    } else {
      // Map not hybrid/escort, or not detected → upload straight away. Pass the
      // freshly-detected mapName directly: setDetectedMap above hasn't flushed
      // yet this tick, so reading the state var here would be stale.
      await commitUpload(mapName)
    }
  }

  // PHASE 2 — actually upload photos + metadata, then show success.
  // startingSide is whatever's in state (set by the question, or null).
  // `mapOverride` carries the just-detected map when commit runs in the same
  // tick as detection (the no-side path); otherwise the detectedMap state is
  // authoritative (the side path runs a tick later, after the user answers).
  async function commitUpload(mapOverride?: string | null) {
    setStep('uploading')
    const batchId = Date.now().toString()
    const updated = [...files]
    const effectiveMap = mapOverride !== undefined ? mapOverride : detectedMap

    const metadata = {
      match_format: matchFormat,
      role_played: role,
      roles_played: matchFormat === '6v6' ? rolesPlayed : (role ? [role] : []),
      match_feel: matchFeel,
      performance_feel: perfFeel,
      fun_rating: funRating,
      tilt_mood: tiltMood,
      team_tempo: teamTempo,
      team_coordination: teamCoord,
      team_leaver: teamLeaver,
      team_thrower: teamThrower,
      enemy_tempo: enemyTempo,
      enemy_coordination: enemyCoord,
      enemy_leaver: enemyLeaver,
      enemy_thrower: enemyThrower,
      // Derived convenience flag for the process page: when true, the scoreboard
      // step is skipped (a leaver collapses the scoreboard layout, so its stats
      // can't be read). team_leaver / enemy_leaver still carry which side(s).
      has_leaver: teamLeaver || enemyLeaver,
      personal_thoughts: thoughts || null,
      starting_side: startingSide,
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
    setMatchFeel(null); setPerfFeel(null); setFunRating(null); setTiltMood(null)
    setTeamTempo(null); setTeamCoord(null); setTeamLeaver(false); setTeamThrower(false)
    setEnemyTempo(null); setEnemyCoord(null); setEnemyLeaver(false); setEnemyThrower(false)
    setThoughts('')
    files.forEach(f => URL.revokeObjectURL(f.preview))
    setFiles([])
    setDetectedMap(null); setStartingSide(null)
    setLeaverConfirmed(false)
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
        onNext={fivev5 ? undefined : () => setStep('vibe')}
        nextDisabled={rolesPlayed.length === 0}
      >
        {(['tank', 'dps', 'support'] as RoleType[]).map(r => (
          <OptionButton key={r} label={r.toUpperCase()}
            selected={fivev5 ? role === r : rolesPlayed.includes(r)}
            onClick={() => fivev5 ? pickAndAdvance(setRole, r, 'vibe') : toggleMulti(r)} />
        ))}
      </StepShell>
    )
  }

  // ======================== MATCH VIBE (auto-advance) ========================
  if (step === 'vibe') {
    return (
      <StepShell title="How was the match?" onBack={() => setStep('role')} onSkip={() => setStep('performance')}>
        {(['stomped_them', 'close_game', 'got_stomped'] as MatchFeel[]).map(v => (
          <OptionButton key={v}
            label={v === 'stomped_them' ? 'STOMPED THEM' : v === 'close_game' ? 'CLOSE GAME' : 'GOT STOMPED'}
            selected={matchFeel === v}
            onClick={() => pickAndAdvance(setMatchFeel, v, 'performance')} />
        ))}
      </StepShell>
    )
  }

  // ======================== PERFORMANCE (auto-advance) ========================
  if (step === 'performance') {
    return (
      <StepShell title="Your performance" onBack={() => setStep('vibe')} onSkip={() => setStep('fun')}>
        {(['carried', 'did_my_job', 'struggled'] as PerformanceFeel[]).map(v => (
          <OptionButton key={v}
            label={v === 'did_my_job' ? 'DID MY JOB' : v.toUpperCase()}
            selected={perfFeel === v}
            onClick={() => pickAndAdvance(setPerfFeel, v, 'fun')} />
        ))}
      </StepShell>
    )
  }

  // ======================== FUN (stars — brief pause then auto-advance) ========================
  if (step === 'fun') {
    const pickStar = (s: number) => {
      setFunRating(s)
      window.setTimeout(() => setStep('tilt'), ADVANCE_DELAY)
    }
    return (
      <StepShell title="Fun rating" onBack={() => setStep('performance')} onSkip={() => setStep('tilt')}>
        <div className="flex justify-center gap-2 py-2">
          {[1, 2, 3, 4, 5].map(s => (
            <button key={s} type="button"
              onClick={() => pickStar(s)}
              className={`text-4xl transition-colors ${funRating && s <= funRating ? 'text-ow-orange' : 'text-slate-700 hover:text-slate-500'}`}
            >★</button>
          ))}
        </div>
      </StepShell>
    )
  }

  // ======================== TILT / MOOD (auto-advance) ========================
  if (step === 'tilt') {
    const moods: TiltMood[] = ['tilted', 'annoyed', 'fine', 'good', 'hyped']
    return (
      <StepShell title="How do you feel?" hint="Worst → best"
        onBack={() => setStep('fun')} onSkip={() => setStep('team')}>
        {moods.map(m => (
          <OptionButton key={m} label={m.toUpperCase()}
            selected={tiltMood === m}
            onClick={() => pickAndAdvance(setTiltMood, m, 'team')} />
        ))}
      </StepShell>
    )
  }

  // ======================== TEAM (multi-input → keep NEXT) ========================
  if (step === 'team') {
    return (
      <StepShell title="Your team" onBack={() => setStep('tilt')}
        onNext={() => setStep('enemy')} onSkip={() => setStep('enemy')}>
        <ScaleRow label="Tempo" options={['aggressive', 'balanced', 'passive'] as Tempo[]}
          value={teamTempo} onChange={setTeamTempo}
          labels={{ aggressive: 'AGGRESSIVE', balanced: 'BALANCED', passive: 'PASSIVE' }} />
        <ScaleRow label="Coordination" options={['coordinated', 'average', 'chaotic'] as Coordination[]}
          value={teamCoord} onChange={setTeamCoord}
          labels={{ coordinated: 'COORDINATED', average: 'AVERAGE', chaotic: 'CHAOTIC' }} />
        <div className="flex gap-2 pt-1">
          <TogglePill label="LEAVER" on={teamLeaver} onToggle={() => setTeamLeaver(v => !v)} />
          <TogglePill label="THROWER" on={teamThrower} onToggle={() => setTeamThrower(v => !v)} />
        </div>
      </StepShell>
    )
  }

  // ======================== ENEMY (multi-input → keep NEXT) ========================
  if (step === 'enemy') {
    return (
      <StepShell title="Enemy team" onBack={() => setStep('team')}
        onNext={() => setStep('thoughts')} onSkip={() => setStep('thoughts')}>
        <ScaleRow label="Tempo" options={['aggressive', 'balanced', 'passive'] as Tempo[]}
          value={enemyTempo} onChange={setEnemyTempo}
          labels={{ aggressive: 'AGGRESSIVE', balanced: 'BALANCED', passive: 'PASSIVE' }} />
        <ScaleRow label="Coordination" options={['coordinated', 'average', 'chaotic'] as Coordination[]}
          value={enemyCoord} onChange={setEnemyCoord}
          labels={{ coordinated: 'COORDINATED', average: 'AVERAGE', chaotic: 'CHAOTIC' }} />
        <div className="flex gap-2 pt-1">
          <TogglePill label="LEAVER" on={enemyLeaver} onToggle={() => setEnemyLeaver(v => !v)} />
          <TogglePill label="THROWER" on={enemyThrower} onToggle={() => setEnemyThrower(v => !v)} />
        </div>
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
            A leaver changes the scoreboard, so the scoreboard stats won't be read
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
      window.setTimeout(() => { commitUpload() }, ADVANCE_DELAY)
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
