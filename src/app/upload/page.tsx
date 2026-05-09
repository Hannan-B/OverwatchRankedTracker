'use client'

import { useState, useRef, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import type { RoleType, MatchFeel, PerformanceFeel, NotableEvent } from '@/lib/types'

type UploadStep = 'questions' | 'photos' | 'uploading' | 'done'
type FileStatus = 'idle' | 'uploading' | 'success' | 'error'

interface FilePreview {
  file: File
  preview: string
  status: FileStatus
}

function ChipSelect<T extends string>({
  options, value, onChange, labels, colors,
}: {
  options: T[]; value: T | null; onChange: (v: T | null) => void
  labels: Record<T, string>; colors?: Record<T, string>
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(opt => (
        <button key={opt} type="button"
          onClick={() => onChange(value === opt ? null : opt)}
          className={`px-4 py-2 rounded-lg text-sm font-display tracking-wider transition-all
            ${value === opt
              ? `${colors?.[opt] || 'bg-ow-orange text-ow-dark'} font-bold`
              : 'bg-ow-dark text-slate-400 border border-white/10 hover:text-white hover:border-white/20'
            }`}
        >{labels[opt]}</button>
      ))}
    </div>
  )
}

function MultiChipSelect<T extends string>({
  options, value, onChange, labels,
}: {
  options: T[]; value: T[]; onChange: (v: T[]) => void; labels: Record<T, string>
}) {
  const toggle = (opt: T) => {
    onChange(value.includes(opt) ? value.filter(v => v !== opt) : [...value, opt])
  }
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(opt => (
        <button key={opt} type="button" onClick={() => toggle(opt)}
          className={`px-4 py-2 rounded-lg text-sm font-display tracking-wider transition-all
            ${value.includes(opt)
              ? 'bg-ow-orange text-ow-dark font-bold'
              : 'bg-ow-dark text-slate-400 border border-white/10 hover:text-white hover:border-white/20'
            }`}
        >{labels[opt]}</button>
      ))}
    </div>
  )
}

function StarRating({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map(star => (
        <button key={star} type="button"
          onClick={() => onChange(value === star ? null : star)}
          className={`text-2xl transition-colors ${
            value && star <= value ? 'text-ow-orange' : 'text-slate-600 hover:text-slate-400'
          }`}
        >★</button>
      ))}
    </div>
  )
}

export default function UploadPage() {
  const [step, setStep] = useState<UploadStep>('questions')
  const inputRef = useRef<HTMLInputElement>(null)

  const [role, setRole] = useState<RoleType | null>(null)
  const [matchFeel, setMatchFeel] = useState<MatchFeel | null>(null)
  const [perfFeel, setPerfFeel] = useState<PerformanceFeel | null>(null)
  const [notableEvents, setNotableEvents] = useState<NotableEvent[]>([])
  const [funRating, setFunRating] = useState<number | null>(null)
  const [thoughts, setThoughts] = useState('')
  const [files, setFiles] = useState<FilePreview[]>([])

  useEffect(() => {
    async function loadDefaults() {
      const { data } = await supabase
        .from('user_settings')
        .select('default_role')
        .limit(1)
        .single()
      if (data?.default_role && !role) setRole(data.default_role)
    }
    loadDefaults()
  }, [])

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

  // Convert any image to JPEG blob (handles HEIC on iPhone)
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
          'image/jpeg',
          0.92 // High quality
        )
      }
      img.onerror = () => {
        URL.revokeObjectURL(img.src)
        reject(new Error('Failed to load image for conversion'))
      }
      img.src = URL.createObjectURL(file)
    })
  }

  async function uploadAll() {
    if (files.length === 0 || !role) return
    setStep('uploading')
    const batchId = Date.now().toString()
    const updated = [...files]

    const metadata = {
      role_played: role,
      match_feel: matchFeel,
      performance_feel: perfFeel,
      notable_events: notableEvents,
      fun_rating: funRating,
      personal_thoughts: thoughts || null,
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
        // Convert to JPEG (handles HEIC from iPhone)
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
    setStep('questions')
    setRole(null)
    setMatchFeel(null)
    setPerfFeel(null)
    setNotableEvents([])
    setFunRating(null)
    setThoughts('')
    files.forEach(f => URL.revokeObjectURL(f.preview))
    setFiles([])
  }

  // ======================== DONE ========================
  if (step === 'done') {
    return (
      <div className="max-w-lg mx-auto">
        <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-8 text-center">
          <span className="text-4xl block mb-3">✓</span>
          <p className="text-ow-victory font-display text-xl font-bold">MATCH UPLOADED</p>
          <p className="text-slate-400 text-sm mt-2">
            Open the tracker on your laptop to process and review
          </p>
          <button onClick={resetForm}
            className="mt-6 bg-ow-panel border border-white/10 text-white font-display
                       px-6 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30
                       transition-colors">
            UPLOAD ANOTHER MATCH
          </button>
        </div>
      </div>
    )
  }

  // ======================== UPLOADING ========================
  if (step === 'uploading') {
    const uploaded = files.filter(f => f.status === 'success').length
    return (
      <div className="max-w-lg mx-auto">
        <div className="bg-ow-panel rounded-lg p-8 text-center border border-white/5">
          <div className="w-10 h-10 border-3 border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-white font-display text-lg">UPLOADING</p>
          <p className="text-slate-400 text-sm mt-1">{uploaded} / {files.length} photos</p>
          <div className="grid grid-cols-4 gap-2 mt-6">
            {files.map((f, i) => (
              <div key={i} className="aspect-square rounded overflow-hidden relative">
                <img src={f.preview} alt="" className="w-full h-full object-cover" />
                {f.status === 'success' && (
                  <div className="absolute inset-0 bg-ow-victory/30 flex items-center justify-center text-lg">✓</div>
                )}
                {f.status === 'uploading' && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ======================== PHOTOS STEP ========================
  if (step === 'photos') {
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <div>
          <h1 className="text-3xl text-ow-orange">Upload Photos</h1>
          <p className="text-sm text-slate-400 mt-1">Select your Summary and Breakdown screenshots</p>
          <button onClick={() => setStep('questions')}
            className="text-xs text-slate-500 hover:text-ow-orange transition-colors mt-1">
            ← Back to questions
          </button>
        </div>

        <div className="bg-ow-panel rounded-lg p-3 border border-white/5 flex flex-wrap gap-2 text-xs">
          <span className="bg-ow-dark px-2 py-1 rounded text-slate-300 font-display">{role?.toUpperCase()}</span>
          {matchFeel && <span className="bg-ow-dark px-2 py-1 rounded text-slate-300 font-display">
            {matchFeel === 'stomped_them' ? 'STOMPED' : matchFeel === 'close_game' ? 'CLOSE' : 'GOT STOMPED'}
          </span>}
          {perfFeel && <span className="bg-ow-dark px-2 py-1 rounded text-slate-300 font-display">
            {perfFeel === 'did_my_job' ? 'DID MY JOB' : perfFeel.toUpperCase()}
          </span>}
          {funRating && <span className="bg-ow-dark px-2 py-1 rounded text-slate-300">{'★'.repeat(funRating)}</span>}
        </div>

        <input ref={inputRef} type="file" accept="image/*" multiple onChange={handleFileSelect} className="hidden" />

        <button onClick={() => inputRef.current?.click()}
          className="w-full border-2 border-dashed border-white/10 rounded-lg p-8
                     text-center hover:border-ow-orange/40 transition-colors group">
          <span className="text-4xl block mb-2">📷</span>
          <span className="text-slate-400 group-hover:text-slate-300 font-display tracking-wider">
            TAP TO SELECT PHOTOS
          </span>
          <span className="block text-xs text-slate-600 mt-1">Summary page + Personal/Breakdown page(s)</span>
        </button>

        {files.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-slate-400 font-display">
              {files.length} PHOTO{files.length !== 1 ? 'S' : ''} SELECTED
            </p>
            <div className="grid grid-cols-3 gap-2">
              {files.map((f, i) => (
                <div key={i} className="relative aspect-[4/3] rounded-lg overflow-hidden bg-ow-panel">
                  <img src={f.preview} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
                  <button onClick={() => removeFile(i)}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70
                               text-white text-xs flex items-center justify-center hover:bg-ow-defeat transition-colors">
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button onClick={uploadAll}
              className="w-full bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                         py-3 rounded-lg tracking-wider transition-colors text-sm">
              UPLOAD ALL
            </button>
          </div>
        )}
      </div>
    )
  }

  // ======================== QUESTIONS STEP ========================
  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-3xl text-ow-orange">Log Match</h1>
        <p className="text-sm text-slate-400 mt-1">Quick questions, then upload your photos</p>
      </div>

      <div>
        <label className="block text-sm font-display tracking-wider text-slate-300 mb-2">
          ROLE PLAYED <span className="text-ow-defeat">*</span>
        </label>
        <ChipSelect options={['tank', 'dps', 'support'] as RoleType[]} value={role} onChange={setRole}
          labels={{ tank: 'TANK', dps: 'DPS', support: 'SUPPORT' }} />
      </div>

      <div>
        <label className="block text-sm font-display tracking-wider text-slate-300 mb-2">HOW WAS THE MATCH?</label>
        <ChipSelect options={['stomped_them', 'close_game', 'got_stomped'] as MatchFeel[]} value={matchFeel} onChange={setMatchFeel}
          labels={{ stomped_them: 'STOMPED THEM', close_game: 'CLOSE GAME', got_stomped: 'GOT STOMPED' }} />
      </div>

      <div>
        <label className="block text-sm font-display tracking-wider text-slate-300 mb-2">YOUR PERFORMANCE</label>
        <ChipSelect options={['carried', 'did_my_job', 'struggled'] as PerformanceFeel[]} value={perfFeel} onChange={setPerfFeel}
          labels={{ carried: 'CARRIED', did_my_job: 'DID MY JOB', struggled: 'STRUGGLED' }} />
      </div>

      <div>
        <label className="block text-sm font-display tracking-wider text-slate-300 mb-2">ANYTHING NOTABLE?</label>
        <MultiChipSelect options={['leaver', 'smurf', 'thrower', 'great_teamwork'] as NotableEvent[]} value={notableEvents} onChange={setNotableEvents}
          labels={{ leaver: 'LEAVER', smurf: 'SMURF', thrower: 'THROWER', great_teamwork: 'GREAT TEAMWORK' }} />
      </div>

      <div>
        <label className="block text-sm font-display tracking-wider text-slate-300 mb-2">FUN RATING</label>
        <StarRating value={funRating} onChange={setFunRating} />
      </div>

      <div>
        <label className="block text-sm font-display tracking-wider text-slate-300 mb-2">PERSONAL THOUGHTS</label>
        <textarea value={thoughts} onChange={e => setThoughts(e.target.value)}
          placeholder="What happened? What could you improve?" rows={3}
          className="w-full bg-ow-dark border border-white/10 rounded-lg px-4 py-2.5
                     text-white placeholder-slate-600 focus:border-ow-orange/50
                     focus:outline-none transition-colors resize-none" />
      </div>

      <button onClick={() => setStep('photos')} disabled={!role}
        className="w-full bg-ow-orange hover:bg-ow-accent disabled:bg-slate-700
                   disabled:text-slate-500 text-ow-dark font-display font-bold
                   py-3 rounded-lg tracking-wider transition-colors text-sm">
        NEXT → SELECT PHOTOS
      </button>
    </div>
  )
}
