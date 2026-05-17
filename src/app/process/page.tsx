'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { processMatchPhotos, type ProcessedMatch, type ProcessingStatus } from '@/lib/image-processor'
import { getGameModeForMap, needsStartingSide } from '@/data/reference'
import type { RoleType, MatchFeel, PerformanceFeel, NotableEvent } from '@/lib/types'

interface PendingBatch {
  batchId: string
  metadata: {
    role_played: RoleType
    match_feel: MatchFeel | null
    performance_feel: PerformanceFeel | null
    notable_events: NotableEvent[]
    fun_rating: number | null
    personal_thoughts: string | null
    uploaded_at: string
    photo_count: number
  }
  photoUrls: string[]
  photoPaths: string[]
}

type PageState = 'scanning' | 'idle' | 'processing' | 'saving' | 'done' | 'error'

const STATUS_MESSAGES: Record<string, string> = {
  loading_opencv: 'Loading image recognition engine...',
  loading_heroes: 'Loading hero bank (51 heroes)...',
  processing_photo: 'Loading photos...',
  classifying_pages: 'Detecting page types...',
  running_ocr: 'Reading text from screenshots...',
  matching_heroes: 'Identifying heroes...',
  reading_breakdowns: 'Extracting hero stats...',
  complete: 'Processing complete!',
}

export default function ProcessPage() {
  const router = useRouter()
  const [batches, setBatches] = useState<PendingBatch[]>([])
  const [pageState, setPageState] = useState<PageState>('scanning')
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null)
  const [processedResult, setProcessedResult] = useState<ProcessedMatch | null>(null)
  const [currentBatch, setCurrentBatch] = useState<PendingBatch | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => { scanForBatches() }, [])

  async function scanForBatches() {
    setPageState('scanning')
    try {
      const { data: folders } = await supabase.storage
        .from('match-images')
        .list('pending', { limit: 20 })

      if (!folders || folders.length === 0) {
        setBatches([])
        setPageState('idle')
        return
      }

      const pendingBatches: PendingBatch[] = []

      for (const folder of folders) {
        if (!folder.name || folder.name === '.emptyFolderPlaceholder') continue

        const { data: files } = await supabase.storage
          .from('match-images')
          .list(`pending/${folder.name}`)
        if (!files) continue

        const metadataFile = files.find(f => f.name === 'metadata.json')
        if (!metadataFile) continue

        const { data: metadataBlob } = await supabase.storage
          .from('match-images')
          .download(`pending/${folder.name}/metadata.json`)
        if (!metadataBlob) continue

        const metadata = JSON.parse(await metadataBlob.text())
        const photoFiles = files.filter(f => f.name !== 'metadata.json')
        const photoUrls: string[] = []
        const photoPaths: string[] = []

        for (const photo of photoFiles) {
          const path = `pending/${folder.name}/${photo.name}`
          const { data: urlData } = await supabase.storage
            .from('match-images')
            .createSignedUrl(path, 3600)
          if (urlData?.signedUrl) {
            photoUrls.push(urlData.signedUrl)
            photoPaths.push(path)
          }
        }

        pendingBatches.push({ batchId: folder.name, metadata, photoUrls, photoPaths })
      }

      setBatches(pendingBatches)
      setPageState('idle')
    } catch (err) {
      console.error('Scan error:', err)
      setPageState('idle')
    }
  }

  async function processBatch(batch: PendingBatch) {
    setCurrentBatch(batch)
    setPageState('processing')
    setErrorMsg(null)

    try {
      const result = await processMatchPhotos(
        batch.photoUrls,
        (status) => setProcessingStatus(status),
        batch.metadata.role_played,
      )

      setProcessedResult(result)
      console.log('Processing result:', result)

      setPageState('saving')
      await saveMatch(batch, result)
      setPageState('done')

    } catch (err: any) {
      console.error('Processing error:', err)
      setErrorMsg(err.message || 'Processing failed')
      setPageState('error')
    }
  }

  async function saveMatch(batch: PendingBatch, processed: ProcessedMatch) {
    const meta = batch.metadata
    const gameMode = processed.mapName ? getGameModeForMap(processed.mapName) : null
    const finalRole = processed.correctedRole || meta.role_played

    const { data: seasonId } = await supabase
      .rpc('get_season_for_date', { match_date: new Date().toISOString() })

    const { data: match, error: matchError } = await supabase
      .from('matches')
      .insert({
        map: processed.mapName || 'Unknown',
        game_mode: gameMode || null,
        result: processed.result || 'defeat',
        score: processed.score,
        role_played: finalRole,
        game_length_seconds: processed.gameLengthSeconds,
        starting_side: null,
        season_id: seasonId || null,
        total_eliminations: processed.eliminations,
        total_assists: processed.assists,
        total_deaths: processed.deaths,
        match_feel: meta.match_feel,
        performance_feel: meta.performance_feel,
        notable_events: meta.notable_events.length > 0 ? meta.notable_events : null,
        fun_rating: meta.fun_rating,
        personal_thoughts: meta.personal_thoughts,
      })
      .select('id')
      .single()

    if (matchError) throw matchError

    if (match && processed.heroes.length > 0) {
      const heroInserts = processed.heroes.map((hero, i) => {
        const breakdown = processed.heroBreakdowns.find(b => b.heroName === hero.name)
        return {
          match_id: match.id,
          hero_name: hero.name,
          percent_played: breakdown?.percentPlayed ?? null,
          play_time_seconds: breakdown?.playTimeSeconds ?? null,
          display_order: i + 1,
        }
      })

      const { data: heroPerfs, error: heroError } = await supabase
        .from('hero_performances')
        .insert(heroInserts)
        .select('id, hero_name')

      if (heroError) throw heroError

      if (heroPerfs && processed.heroBreakdowns.length > 0) {
        const allStatInserts: {
          hero_performance_id: number
          stat_name: string
          stat_value: string
          avg_per_10_min: string | null
        }[] = []

        for (const perf of heroPerfs) {
          const breakdown = processed.heroBreakdowns.find(b => b.heroName === perf.hero_name)
          if (!breakdown) continue

          for (const stat of breakdown.stats) {
            allStatInserts.push({
              hero_performance_id: perf.id,
              stat_name: stat.statName,
              stat_value: stat.statValue,
              avg_per_10_min: stat.avgPer10Min,
            })
          }
        }

        if (allStatInserts.length > 0) {
          const { error: statsError } = await supabase
            .from('hero_stats')
            .insert(allStatInserts)

          if (statsError) {
            console.warn('Failed to save hero stats:', statsError)
          } else {
            console.log(`Saved ${allStatInserts.length} hero stats to database`)
          }
        }
      }
    }

    const allPaths = [
      `pending/${batch.batchId}/metadata.json`,
      ...batch.photoPaths,
    ]
    await supabase.storage.from('match-images').remove(allPaths)
  }

  function handleDone() {
    setCurrentBatch(null)
    setProcessedResult(null)
    setProcessingStatus(null)
    setPageState('scanning')
    scanForBatches()
  }

  // ======================== DONE ========================
  if (pageState === 'done' && processedResult) {
    const totalStats = processedResult.heroBreakdowns.reduce((sum, b) => sum + b.stats.length, 0)

    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-8 text-center">
          <span className="text-4xl block mb-3">✓</span>
          <p className="text-ow-victory font-display text-xl font-bold">MATCH SAVED</p>
          <p className="text-slate-400 text-sm mt-1">
            Processed in {(processedResult.processingTimeMs / 1000).toFixed(1)}s
            {totalStats > 0 && ` · ${totalStats} hero stats extracted`}
          </p>
        </div>

        {processedResult.correctedRole && currentBatch && (
          <div className="bg-ow-orange/10 border border-ow-orange/30 rounded-lg px-5 py-4">
            <p className="text-ow-orange font-display font-bold text-sm">ROLE AUTO-CORRECTED</p>
            <p className="text-slate-400 text-xs mt-1">
              You selected <span className="text-white font-display">{currentBatch.metadata.role_played.toUpperCase()}</span> but
              the matched hero is <span className="text-white font-display">{processedResult.correctedRole.toUpperCase()}</span>.
              The role has been updated automatically.
            </p>
          </div>
        )}

        {/* Summary extraction */}
        <div className="bg-ow-panel rounded-lg p-5 border border-white/5 space-y-3">
          <p className="text-xs text-slate-400 font-display tracking-wider">MATCH SUMMARY</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
            <div>
              <p className="text-xs text-slate-500">MAP</p>
              <p className="text-white font-display">{processedResult.mapName || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">RESULT</p>
              <p className={`font-display font-bold ${
                processedResult.result === 'victory' ? 'text-ow-victory' :
                processedResult.result === 'defeat' ? 'text-ow-defeat' : 'text-ow-draw'
              }`}>
                {processedResult.result?.toUpperCase() || '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">SCORE</p>
              <p className="text-white font-display">{processedResult.score || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500">E / A / D</p>
              <p className="text-white font-display">
                {processedResult.eliminations ?? '—'} / {processedResult.assists ?? '—'} / {processedResult.deaths ?? '—'}
              </p>
            </div>
          </div>
        </div>

        {/* Hero breakdowns */}
        {processedResult.heroBreakdowns.map((breakdown, i) => (
          <div key={i} className="bg-ow-panel rounded-lg p-5 border border-white/5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <p className="text-white font-display font-bold text-lg">{breakdown.heroName}</p>
                {breakdown.percentPlayed !== null && (
                  <span className="bg-ow-dark px-2 py-1 rounded text-xs text-slate-300 font-display">
                    {breakdown.percentPlayed}%
                  </span>
                )}
                {breakdown.playTimeSeconds !== null && (
                  <span className="bg-ow-dark px-2 py-1 rounded text-xs text-slate-400">
                    {Math.floor(breakdown.playTimeSeconds / 60)}:{String(breakdown.playTimeSeconds % 60).padStart(2, '0')}
                  </span>
                )}
              </div>
              {!breakdown.matchedToSummary && (
                <span className="text-xs text-ow-orange bg-ow-orange/10 px-2 py-1 rounded font-display">
                  NOT IN SUMMARY
                </span>
              )}
              <span className={`text-xs px-2 py-1 rounded font-display ${
                breakdown.foundStatCount === breakdown.expectedStatCount
                  ? 'text-ow-victory bg-ow-victory/10'
                  : 'text-ow-orange bg-ow-orange/10'
              }`}>
                {breakdown.foundStatCount}/{breakdown.expectedStatCount} STATS
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {breakdown.stats.map((stat, j) => (
                <div key={j} className="bg-ow-dark rounded-lg px-3 py-2.5 border border-white/5">
                  <p className="text-white text-lg font-display font-bold">{stat.statValue}</p>
                  <p className="text-xs text-slate-400 leading-tight">{stat.statName}</p>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Heroes without breakdowns */}
        {processedResult.heroes.length > 0 && processedResult.heroBreakdowns.length === 0 && (
          <div className="bg-ow-panel rounded-lg p-5 border border-white/5">
            <p className="text-xs text-slate-400 font-display tracking-wider mb-2">HEROES DETECTED</p>
            <div className="flex gap-2">
              {processedResult.heroes.map((h, i) => (
                <span key={i} className="bg-ow-dark px-3 py-1.5 rounded text-sm text-white font-display">
                  {h.name}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-center gap-3">
          <button onClick={handleDone}
            className="bg-ow-panel border border-white/10 text-white font-display
                       px-6 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
            PROCESS MORE
          </button>
          <button onClick={() => router.push('/matches')}
            className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                       px-6 py-2.5 rounded-lg tracking-wider text-sm transition-colors">
            VIEW MATCHES
          </button>
        </div>
      </div>
    )
  }

  // ======================== ERROR ========================
  if (pageState === 'error') {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="bg-ow-defeat/10 border border-ow-defeat/30 rounded-lg p-8 text-center">
          <span className="text-4xl block mb-3">✗</span>
          <p className="text-ow-defeat font-display text-xl font-bold">PROCESSING FAILED</p>
          <p className="text-slate-400 text-sm mt-2">{errorMsg}</p>
        </div>
        <div className="flex justify-center gap-3">
          <button onClick={() => currentBatch && processBatch(currentBatch)}
            className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                       px-6 py-2.5 rounded-lg tracking-wider text-sm transition-colors">
            RETRY
          </button>
          <button onClick={handleDone}
            className="bg-ow-panel border border-white/10 text-white font-display
                       px-6 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
            BACK
          </button>
        </div>
      </div>
    )
  }

  // ======================== PROCESSING / SAVING ========================
  if (pageState === 'processing' || pageState === 'saving') {
    const progress = pageState === 'saving' ? 97 : (processingStatus?.progress || 0)
    const stage = processingStatus?.stage || 'loading_opencv'

    let message = pageState === 'saving'
      ? 'Saving to database...'
      : STATUS_MESSAGES[stage] || 'Processing...'

    if (stage === 'matching_heroes' && currentBatch) {
      message = `Identifying heroes (${currentBatch.metadata.role_played} first)...`
    }

    return (
      <div className="max-w-3xl mx-auto">
        <div className="bg-ow-panel rounded-lg p-12 text-center border border-white/5">
          <div className="w-12 h-12 border-3 border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <p className="text-white font-display text-lg">{message}</p>
          <div className="mt-6 bg-ow-dark rounded-full h-2 overflow-hidden max-w-sm mx-auto">
            <div
              className="h-full bg-ow-orange transition-all duration-500 rounded-full"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-2 font-display">{Math.round(progress)}%</p>
        </div>
      </div>
    )
  }

  // ======================== SCANNING ========================
  if (pageState === 'scanning') {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="bg-ow-panel rounded-lg p-12 text-center border border-white/5">
          <div className="w-8 h-8 border-2 border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400 font-display">Checking for uploads...</p>
        </div>
      </div>
    )
  }

  // ======================== IDLE — BATCH LIST ========================
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl text-ow-orange">Process Matches</h1>
        <p className="text-sm text-slate-400 mt-1">
          Automatically extract data from uploaded match photos
        </p>
      </div>

      {batches.length === 0 ? (
        <div className="bg-ow-panel rounded-lg p-12 text-center border border-white/5">
          <span className="text-4xl block mb-3">📷</span>
          <p className="text-slate-400 font-display text-lg">NO PENDING UPLOADS</p>
          <p className="text-slate-500 text-sm mt-2">
            Upload match photos from your phone to see them here
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="bg-ow-orange/10 border border-ow-orange/30 rounded-lg px-5 py-4
                          flex items-center justify-between">
            <div>
              <p className="text-ow-orange font-display font-bold">
                {batches.length} MATCH{batches.length !== 1 ? 'ES' : ''} WAITING
              </p>
              <p className="text-slate-400 text-xs mt-0.5">
                Ready to process — click to extract data automatically
              </p>
            </div>
          </div>

          {batches.map(batch => (
            <div key={batch.batchId}
              className="bg-ow-panel rounded-lg p-5 border border-white/5 hover:border-ow-orange/20 transition-colors">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-white font-display">{batch.metadata.role_played.toUpperCase()}</span>
                    <span className="text-slate-500">•</span>
                    <span className="text-slate-400">
                      {batch.metadata.photo_count} photo{batch.metadata.photo_count !== 1 ? 's' : ''}
                    </span>
                    <span className="text-slate-500">•</span>
                    <span className="text-slate-500 text-xs">
                      {new Date(batch.metadata.uploaded_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex gap-2 mt-2">
                    {batch.photoUrls.slice(0, 4).map((url, i) => (
                      <img key={i} src={url} alt="" className="w-16 h-12 object-cover rounded" />
                    ))}
                  </div>
                </div>
                <button onClick={() => processBatch(batch)}
                  className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                             px-5 py-2.5 rounded-lg tracking-wider text-sm transition-colors whitespace-nowrap">
                  PROCESS
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button onClick={scanForBatches}
        className="text-sm text-slate-500 hover:text-slate-300 font-display tracking-wider transition-colors">
        ↻ REFRESH
      </button>
    </div>
  )
}
