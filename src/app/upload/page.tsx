'use client'

import { useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

interface FilePreview {
  file: File
  preview: string
  status: UploadStatus
}

export default function UploadPage() {
  const [files, setFiles] = useState<FilePreview[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadComplete, setUploadComplete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files
    if (!selected) return

    const newFiles: FilePreview[] = Array.from(selected).map(file => ({
      file,
      preview: URL.createObjectURL(file),
      status: 'idle' as UploadStatus,
    }))

    setFiles(prev => [...prev, ...newFiles])
    setUploadComplete(false)
  }

  function removeFile(index: number) {
    setFiles(prev => {
      const updated = [...prev]
      URL.revokeObjectURL(updated[index].preview)
      updated.splice(index, 1)
      return updated
    })
  }

  async function uploadAll() {
    if (files.length === 0) return

    setUploading(true)
    const batchId = Date.now().toString()

    const updated = [...files]

    for (let i = 0; i < updated.length; i++) {
      updated[i].status = 'uploading'
      setFiles([...updated])

      const file = updated[i].file
      const ext = file.name.split('.').pop() || 'heic'
      const path = `pending/${batchId}/image_${i + 1}.${ext}`

      const { error } = await supabase.storage
        .from('match-images')
        .upload(path, file, {
          contentType: file.type || 'image/heic',
        })

      updated[i].status = error ? 'error' : 'success'
      setFiles([...updated])
    }

    setUploading(false)
    const allSuccess = updated.every(f => f.status === 'success')
    if (allSuccess) setUploadComplete(true)
  }

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <div>
        <h1 className="text-3xl text-ow-orange">Upload Match</h1>
        <p className="text-sm text-slate-400 mt-1">
          Select your match result photos to upload
        </p>
      </div>

      {/* Upload complete state */}
      {uploadComplete ? (
        <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-6 text-center">
          <p className="text-ow-victory font-display text-xl font-bold">
            PHOTOS UPLOADED
          </p>
          <p className="text-slate-400 text-sm mt-2">
            Open the tracker on your laptop to process these photos
          </p>
          <button
            onClick={() => {
              setFiles([])
              setUploadComplete(false)
            }}
            className="mt-4 bg-ow-panel border border-white/10 text-white font-display
                       px-5 py-2 rounded-lg tracking-wider text-sm hover:border-ow-orange/30
                       transition-colors"
          >
            UPLOAD ANOTHER MATCH
          </button>
        </div>
      ) : (
        <>
          {/* File selector */}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          <button
            onClick={() => inputRef.current?.click()}
            className="w-full border-2 border-dashed border-white/10 rounded-lg p-8
                       text-center hover:border-ow-orange/40 transition-colors group"
          >
            <span className="text-4xl block mb-2">📷</span>
            <span className="text-slate-400 group-hover:text-slate-300 font-display tracking-wider">
              TAP TO SELECT PHOTOS
            </span>
            <span className="block text-xs text-slate-600 mt-1">
              Summary, Personal breakdown pages
            </span>
          </button>

          {/* Preview grid */}
          {files.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm text-slate-400 font-display">
                {files.length} PHOTO{files.length !== 1 ? 'S' : ''} SELECTED
              </p>

              <div className="grid grid-cols-3 gap-2">
                {files.map((f, i) => (
                  <div key={i} className="relative aspect-[4/3] rounded-lg overflow-hidden bg-ow-panel">
                    <img
                      src={f.preview}
                      alt={`Match photo ${i + 1}`}
                      className="w-full h-full object-cover"
                    />

                    {/* Status overlay */}
                    {f.status === 'uploading' && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <div className="w-6 h-6 border-2 border-ow-orange border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                    {f.status === 'success' && (
                      <div className="absolute inset-0 bg-ow-victory/20 flex items-center justify-center">
                        <span className="text-2xl">✓</span>
                      </div>
                    )}
                    {f.status === 'error' && (
                      <div className="absolute inset-0 bg-ow-defeat/20 flex items-center justify-center">
                        <span className="text-2xl">✗</span>
                      </div>
                    )}

                    {/* Remove button (only before upload) */}
                    {f.status === 'idle' && (
                      <button
                        onClick={() => removeFile(i)}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70
                                   text-white text-xs flex items-center justify-center
                                   hover:bg-ow-defeat transition-colors"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Upload button */}
              <button
                onClick={uploadAll}
                disabled={uploading || files.every(f => f.status === 'success')}
                className="w-full bg-ow-orange hover:bg-ow-accent disabled:bg-slate-700
                           disabled:text-slate-500 text-ow-dark font-display font-bold
                           py-3 rounded-lg tracking-wider transition-colors text-sm"
              >
                {uploading ? 'UPLOADING...' : 'UPLOAD ALL'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
