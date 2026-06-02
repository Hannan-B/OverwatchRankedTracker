'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { processMatchPhotos, type ProcessedMatch, type ProcessingStatus, type ScoreboardResult } from '@/lib/image-processor'
import { buildPlayerLabels } from '@/lib/scoreboard-extractor'
import { getGameModeForMap, needsStartingSide } from '@/data/reference'
import type { RoleType, MatchFeel, PerformanceFeel, StartingSide } from '@/lib/types'
import { buildConfirmationQuestions, type ConfirmInputs, type ConfirmationCandidate } from '@/lib/beta-confirmation'
import { logConfirmationOutcome, logMatchSummary } from '@/lib/beta-issue-log'
import { ConfirmationPanel, type ConfirmationResult } from '@/app/review/ConfirmationCard'

interface PendingBatch {
  batchId: string
  metadata: {
    role_played: RoleType | null
    match_format?: '5v5' | '6v6'
    roles_played?: RoleType[]
    match_feel: MatchFeel | null
    performance_feel: PerformanceFeel | null
    tilt_mood: string | null
    team_tempo: string | null
    team_coordination: string | null
    team_leaver: boolean
    team_thrower: boolean
    enemy_tempo: string | null
    enemy_coordination: string | null
    enemy_leaver: boolean
    enemy_thrower: boolean
    fun_rating: number | null
    personal_thoughts: string | null
    starting_side?: StartingSide | null
    detected_map?: string | null
    uploaded_at: string
    photo_count: number
  }
  photoUrls: string[]
  photoPaths: string[]
}

type PageState = 'scanning' | 'idle' | 'processing' | 'confirming' | 'beta_confirm' | 'saving' | 'done' | 'error'

const STATUS_MESSAGES: Record<string, string> = {
  loading_opencv: 'Loading image recognition engine...',
  loading_heroes: 'Loading hero bank (51 heroes)...',
  processing_photo: 'Loading photos...',
  classifying_pages: 'Detecting page types...',
  running_ocr: 'Reading text from screenshots...',
  matching_heroes: 'Identifying heroes...',
  reading_breakdowns: 'Extracting hero stats...',
  reading_scoreboard: 'Reading scoreboard data...',
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
  const [gamertag, setGamertag] = useState<string>('')
  const [confirmStep, setConfirmStep] = useState<'confirm' | 'select'>('confirm')

  // 6f beta confirmation
  const [betaQuestions, setBetaQuestions] = useState<ConfirmationCandidate[]>([])
  const [betaPending, setBetaPending] = useState<{ batch: PendingBatch; result: ProcessedMatch } | null>(null)
  const [matchSeq, setMatchSeq] = useState(0)

  // Multi-process queue
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(new Set())
  const [queueRemaining, setQueueRemaining] = useState<PendingBatch[]>([])
  const [queueTotal, setQueueTotal] = useState(0)
  const [queueProcessed, setQueueProcessed] = useState(0)

  // Fetch gamertag from user_settings on mount
  useEffect(() => {
    async function loadGamertag() {
      const { data } = await supabase
        .from('user_settings')
        .select('gamertag')
        .limit(1)
        .single()
      if (data?.gamertag) {
        setGamertag(data.gamertag)
      }
    }
    loadGamertag()
  }, [])

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

  // ── Selection & multi-process ──

  function toggleBatchSelection(batchId: string) {
    setSelectedBatchIds(prev => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  function selectAllBatches() {
    setSelectedBatchIds(new Set(batches.map(b => b.batchId)))
  }

  function deselectAllBatches() {
    setSelectedBatchIds(new Set())
  }

  function processSelected() {
    const selected = batches.filter(b => selectedBatchIds.has(b.batchId))
    if (selected.length === 0) return

    const [first, ...rest] = selected
    setQueueRemaining(rest)
    setQueueTotal(selected.length)
    setQueueProcessed(0)
    setSelectedBatchIds(new Set())
    processBatch(first)
  }

  function processAllBatches() {
    if (batches.length === 0) return
    const [first, ...rest] = batches
    setQueueRemaining(rest)
    setQueueTotal(batches.length)
    setQueueProcessed(0)
    setSelectedBatchIds(new Set())
    processBatch(first)
  }

  function processNextInQueue() {
    if (queueRemaining.length === 0) {
      // Queue finished — reset
      setQueueTotal(0)
      setQueueProcessed(0)
      handleDone()
      return
    }
    const [next, ...rest] = queueRemaining
    setQueueRemaining(rest)
    setQueueProcessed(prev => prev + 1)
    processBatch(next)
  }

  async function processBatch(batch: PendingBatch) {
    setCurrentBatch(batch)
    setPageState('processing')
    setErrorMsg(null)

    try {
      const result = await processMatchPhotos(
        batch.photoUrls,
        (status) => setProcessingStatus(status),
        batch.metadata.role_played || undefined,
        gamertag || undefined,
      )

      setProcessedResult(result)
      console.log('Processing result:', result)

      // Check if scoreboard needs user confirmation
      if (result.scoreboard?.ocrAnalysis && !result.scoreboard.ocrAnalysis.resolved) {
        setConfirmStep('confirm')
        setPageState('confirming')
        return
      }

      // No username confirmation needed — go to beta confirmation before saving
      startBetaConfirm(batch, result)

    } catch (err: any) {
      console.error('Processing error:', err)
      setErrorMsg(err.message || 'Processing failed')
      setPageState('error')
    }
  }

  // ── 6f Beta confirmation ──────────────────────────────────
  // Build the (ranked, capped) confirmation questions from the finished result
  // and switch to the beta_confirm screen. Every match shows this step.
  function startBetaConfirm(batch: PendingBatch, result: ProcessedMatch) {
    const sb = result.scoreboard
    const seq = matchSeq + 1
    setMatchSeq(seq)

    // Derive low-confidence hero slots from the per-slot confidence the
    // identifier already produced (no extra signal needed).
    const lowConfHeroSlots = (sb?.heroes ?? [])
      .filter(h => h.heroName && h.confidence < 0.6)
      .map(h => h.slot)

    // Map breakdowns to the BreakdownOcrResult shape the builder expects.
    const breakdowns = result.heroBreakdowns.map(b => ({
      heroName: b.heroName,
      percentPlayed: b.percentPlayed,
      playTimeSeconds: b.playTimeSeconds,
      stats: b.stats,
      expectedStatCount: b.expectedStatCount,
      foundStatCount: b.foundStatCount,
      raw: '',
    }))

    const inputs: ConfirmInputs = {
      matchId: batch.batchId,
      format: (result.matchFormat || batch.metadata.match_format || '5v5') as '5v5' | '6v6',
      scoreboardCells: sb?.cellConfidence,
      scoreboardStats: sb?.stats,
      userAnalysis: sb?.ocrAnalysis,
      breakdowns,
      summary: {
        mapName: result.mapName,
        result: result.result,
        score: result.score,
        gameLengthText: result.gameLengthSeconds
          ? `${Math.floor(result.gameLengthSeconds / 60)}:${String(result.gameLengthSeconds % 60).padStart(2, '0')}`
          : null,
        gameLengthSeconds: result.gameLengthSeconds,
        matchTimestamp: result.matchTimestamp,
        matchDateText: null,
        eliminations: result.eliminations,
        assists: result.assists,
        deaths: result.deaths,
        heroNames: result.heroes.map(h => h.name),
        raw: result.ocrRaw,
      },
      lowConfHeroSlots,
      // knownMaps / knownModes omitted for now (reference export names unverified);
      // the unrecognized-content producer no-ops safely without them.
      scoreboardImageUrl: sb?.imageUrl,
      summaryImageUrl: result.summaryImageUrl,
      breakdownImageUrlByHero: Object.fromEntries(
        result.heroBreakdowns.map(b => [b.heroName, b.imageUrl])
      ),
      grid: sb?.detection?.grid ?? undefined,
      // Scoreboard images are always 3840×2160 (the extractor rejects anything
      // else), so grid coords map to fractions against these fixed dimensions.
      imageNaturalWidth: 3840,
      imageNaturalHeight: 2160,
      matchSequence: seq,
    }

    const questions = buildConfirmationQuestions(inputs)
    setBetaQuestions(questions)
    setBetaPending({ batch, result })
    setPageState('beta_confirm')
  }

  async function onBetaComplete(results: ConfirmationResult[]) {
    if (!betaPending) return
    const { batch, result } = betaPending
    const format = (result.matchFormat || batch.metadata.match_format || '5v5') as '5v5' | '6v6'
    let autoPassFields = result.scoreboard?.cellConfidence?.length ?? 0

    try {
      for (const r of results) {
        await logConfirmationOutcome({
          matchId: batch.batchId,
          format,
          field: r.candidate.field,
          fieldDetail: r.candidate.fieldDetail,
          signal: r.candidate.signal,
          readValue: r.candidate.extractedValue,
          confidence: r.candidate.confidence,
          outcome: r.outcome,
          correctedValue: r.correctedValue,
        })
      }
      await logMatchSummary({
        matchId: batch.batchId,
        format,
        questionsAsked: results.length,
        autoPassFields: Math.max(0, autoPassFields - results.length),
      })
    } catch (err) {
      console.warn('[beta] logging failed (continuing to save):', err)
    }

    // Proceed to save the match exactly as before.
    setPageState('saving')
    try {
      await saveMatch(batch, result)
      setPageState('done')
    } catch (err: any) {
      setErrorMsg(err.message || 'Save failed')
      setPageState('error')
    }
  }

  // Handle user confirming the OCR suggestion
  const handleConfirmUser = useCallback((slot: number) => {
    if (!processedResult?.scoreboard || !currentBatch) return

    const sb = processedResult.scoreboard
    const updatedPlayers = buildPlayerLabels(
      sb.heroes, sb.roles, gamertag, slot, 'ocr_confirmed',
    )

    const updatedResult: ProcessedMatch = {
      ...processedResult,
      scoreboard: {
        ...sb,
        players: updatedPlayers,
        ocrAnalysis: { ...sb.ocrAnalysis, resolved: true, userSlot: slot },
      },
    }

    setProcessedResult(updatedResult)
    startBetaConfirm(currentBatch, updatedResult)
  }, [processedResult, currentBatch, gamertag])

  // Handle user selecting from all 5 options
  const handleSelectUser = useCallback((slot: number) => {
    if (!processedResult?.scoreboard || !currentBatch) return

    const sb = processedResult.scoreboard
    const updatedPlayers = buildPlayerLabels(
      sb.heroes, sb.roles, gamertag, slot, 'manual_select',
    )

    const updatedResult: ProcessedMatch = {
      ...processedResult,
      scoreboard: {
        ...sb,
        players: updatedPlayers,
        ocrAnalysis: { ...sb.ocrAnalysis, resolved: true, userSlot: slot },
      },
    }

    setProcessedResult(updatedResult)
    startBetaConfirm(currentBatch, updatedResult)
  }, [processedResult, currentBatch, gamertag])

  // Decline → show all 5 options
  const handleDeclineConfirm = useCallback(() => {
    setConfirmStep('select')
  }, [])

  // Skip user identification entirely — save without marking any player as user
  const handleSkipConfirm = useCallback(() => {
    if (!processedResult || !currentBatch) return
    startBetaConfirm(currentBatch, processedResult)
  }, [processedResult, currentBatch])

  async function saveMatch(batch: PendingBatch, processed: ProcessedMatch) {
    const meta = batch.metadata
    const gameMode = processed.mapName ? getGameModeForMap(processed.mapName) : null
    const finalRole = processed.correctedRole || meta.role_played || 'dps'

    // match_format: prefer auto-detected from scoreboard, fall back to upload metadata, default '5v5'
    const matchFormat = processed.matchFormat || meta.match_format || '5v5'

    // roles_played: prefer upload metadata (user-declared), fall back to single role
    const rolesPlayed = meta.roles_played && meta.roles_played.length > 0
      ? meta.roles_played
      : [finalRole]

    // starting_side: the phone asks attack/defend only on hybrid/escort maps
    // and sends the answer in metadata. We only TRUST it if the laptop's own
    // (authoritative) map detection agrees the map needs a starting side —
    // this prevents a phone OCR mis-read from writing a bogus value. If the
    // map is symmetric (control/push/flashpoint) or unknown, store null.
    const startingSide: StartingSide | null =
      processed.mapName && needsStartingSide(processed.mapName)
        ? (meta.starting_side ?? null)
        : null

    // Real match time, OCR'd from the summary screenshot. If the date couldn't
    // be read (null), fall back to NOW so processing never breaks — but log it,
    // since a fallback means session/season for this match are approximate.
    const playedAtDate: Date = processed.matchTimestamp ?? new Date()
    if (!processed.matchTimestamp) {
      console.warn('[process] No match timestamp from OCR — falling back to process time for played_at/season')
    }
    const playedAtISO = playedAtDate.toISOString()

    const { data: seasonId } = await supabase
      .rpc('get_season_for_date', { match_date: playedAtISO })

    const { data: match, error: matchError } = await supabase
      .from('matches')
      .insert({
        map: processed.mapName || 'Unknown',
        game_mode: gameMode || null,
        result: processed.result || 'defeat',
        score: processed.score,
        role_played: finalRole,
        match_format: matchFormat,
        roles_played: rolesPlayed,
        ally_team_comp: processed.allyComp,
        enemy_team_comp: processed.enemyComp,
        game_length_seconds: processed.gameLengthSeconds,
        starting_side: startingSide,
        season_id: seasonId || null,
        played_at: playedAtISO,
        total_eliminations: processed.eliminations,
        total_assists: processed.assists,
        total_deaths: processed.deaths,
        match_feel: meta.match_feel,
        performance_feel: meta.performance_feel,
        tilt_mood: meta.tilt_mood ?? null,
        team_tempo: meta.team_tempo ?? null,
        team_coordination: meta.team_coordination ?? null,
        team_leaver: meta.team_leaver ?? false,
        team_thrower: meta.team_thrower ?? false,
        enemy_tempo: meta.enemy_tempo ?? null,
        enemy_coordination: meta.enemy_coordination ?? null,
        enemy_leaver: meta.enemy_leaver ?? false,
        enemy_thrower: meta.enemy_thrower ?? false,
        fun_rating: meta.fun_rating,
        personal_thoughts: meta.personal_thoughts,
      })
      .select('id')
      .single()

    if (matchError) throw matchError

    // Save hero performances + stats (existing logic)
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

    // Save scoreboard players (10 or 12 rows depending on format)
    if (match && processed.scoreboard) {
      const sb = processed.scoreboard
      const scoreboardInserts = sb.stats.map(s => {
        const player = sb.players.find(p => p.slot === s.slot)
        return {
          match_id: match.id,
          slot: s.slot,
          team: s.team,
          hero_name: s.heroName,
          role: s.role,
          is_user: player?.isUser ?? false,
          user_match_method: player?.userMatchMethod ?? null,
          eliminations: s.eliminations,
          assists: s.assists,
          deaths: s.deaths,
          damage: s.damage,
          healing: s.healing,
          mitigation: s.mitigation,
        }
      })

      const { error: sbError } = await supabase
        .from('scoreboard_players')
        .insert(scoreboardInserts)

      if (sbError) {
        console.warn('Failed to save scoreboard players:', sbError)
      } else {
        console.log(`Saved ${scoreboardInserts.length} scoreboard players to database`)
      }
    }

    // Clean up pending files
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
    setQueueRemaining([])
    setQueueTotal(0)
    setQueueProcessed(0)
    scanForBatches()
  }

  // ======================== CONFIRMING (Scoreboard User ID) ========================
  if (pageState === 'confirming' && processedResult?.scoreboard) {
    const sb = processedResult.scoreboard
    const analysis = sb.ocrAnalysis
    const bestCandidate = analysis.candidates.find(
      c => c.slot === analysis.bestCandidate.slot
    )

    if (confirmStep === 'confirm' && bestCandidate) {
      return (
        <div className="max-w-3xl mx-auto space-y-4">
          <div className="bg-ow-orange/10 border border-ow-orange/30 rounded-lg p-8">
            <p className="text-ow-orange font-display font-bold text-lg mb-1">
              IS THIS YOU?
            </p>
            <p className="text-slate-400 text-xs mb-5">
              OCR wasn&apos;t confident enough to auto-identify your player
              ({(analysis.bestCandidate.similarity * 100).toFixed(0)}% similarity,
              {(analysis.bestCandidate.margin * 100).toFixed(0)}% margin).
            </p>

            <div className="flex items-center gap-4 bg-ow-dark rounded-lg p-4 mb-5 border border-white/5">
              {bestCandidate.heroPortraitUrl && (
                <img
                  src={bestCandidate.heroPortraitUrl}
                  alt=""
                  className="w-14 h-14 rounded border border-white/10"
                />
              )}
              <div className="flex-1 min-w-0">
                {bestCandidate.gamertagCropUrl && (
                  <img
                    src={bestCandidate.gamertagCropUrl}
                    alt=""
                    className="h-8 rounded mb-1"
                    style={{ imageRendering: 'auto' }}
                  />
                )}
                <p className="text-xs text-slate-500">
                  Slot {bestCandidate.slot} · {bestCandidate.heroName || 'Unknown hero'}
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => handleConfirmUser(bestCandidate.slot)}
                className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                           px-5 py-2.5 rounded-lg tracking-wider text-sm transition-colors"
              >
                YES, THAT&apos;S ME
              </button>
              <button
                onClick={handleDeclineConfirm}
                className="bg-ow-panel border border-white/10 text-white font-display
                           px-5 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors"
              >
                NO, SHOW ALL
              </button>
              <button
                onClick={handleSkipConfirm}
                className="text-slate-500 hover:text-slate-300 font-display
                           px-4 py-2.5 text-sm tracking-wider transition-colors"
              >
                SKIP
              </button>
            </div>
          </div>
        </div>
      )
    }

    // confirmStep === 'select' — show all 5 ally candidates
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="bg-ow-orange/10 border border-ow-orange/30 rounded-lg p-8">
          <p className="text-ow-orange font-display font-bold text-lg mb-1">
            WHICH ONE IS YOU?
          </p>
          <p className="text-slate-400 text-xs mb-5">
            Select your player from the ally team.
          </p>

          <div className="space-y-2">
            {analysis.candidates.map(candidate => (
              <button
                key={candidate.slot}
                onClick={() => handleSelectUser(candidate.slot)}
                className="w-full flex items-center gap-4 bg-ow-dark hover:bg-ow-dark/80 rounded-lg p-3
                           transition-colors text-left border border-white/5 hover:border-ow-orange/30"
              >
                {candidate.heroPortraitUrl && (
                  <img
                    src={candidate.heroPortraitUrl}
                    alt=""
                    className="w-12 h-12 rounded border border-white/10 flex-shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  {candidate.gamertagCropUrl && (
                    <img
                      src={candidate.gamertagCropUrl}
                      alt=""
                      className="h-7 rounded mb-1"
                      style={{ imageRendering: 'auto' }}
                    />
                  )}
                  <p className="text-xs text-slate-500">
                    Slot {candidate.slot} · {candidate.heroName || 'Unknown hero'}
                  </p>
                </div>
                <span className="text-xs font-mono text-slate-600">
                  {(candidate.ocrSimilarity * 100).toFixed(0)}%
                </span>
              </button>
            ))}
          </div>

          <button
            onClick={handleSkipConfirm}
            className="mt-4 text-slate-500 hover:text-slate-300 font-display
                       text-sm tracking-wider transition-colors"
          >
            SKIP — SAVE WITHOUT USER ID
          </button>
        </div>
      </div>
    )
  }

  // ======================== 6f BETA CONFIRM ========================
  if (pageState === 'beta_confirm') {
    return (
      <div className="max-w-lg mx-auto space-y-4">
        <div>
          <h1 className="text-2xl text-ow-orange">Quick check</h1>
          <p className="text-sm text-slate-400 mt-1">
            Confirm what was read before saving.
          </p>
        </div>
        <ConfirmationPanel candidates={betaQuestions} onComplete={onBetaComplete} />
        {betaQuestions.length === 0 && (
          <button
            onClick={() => onBetaComplete([])}
            className="w-full bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                       py-3 rounded-lg tracking-wider transition-colors text-sm"
          >
            SAVE MATCH
          </button>
        )}
      </div>
    )
  }

  // ======================== DONE ========================
  if (pageState === 'done' && processedResult) {
    const totalStats = processedResult.heroBreakdowns.reduce((sum, b) => sum + b.stats.length, 0)
    const sb = processedResult.scoreboard
    const hasQueue = queueTotal > 1
    const queueDoneCount = queueProcessed + 1
    const queueHasMore = queueRemaining.length > 0

    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-8 text-center">
          <span className="text-4xl block mb-3">✓</span>
          <p className="text-ow-victory font-display text-xl font-bold">MATCH SAVED</p>
          {hasQueue && (
            <p className="text-ow-orange font-display text-sm font-bold mt-1">
              {queueDoneCount} / {queueTotal}
            </p>
          )}
          <p className="text-slate-400 text-sm mt-1">
            Processed in {(processedResult.processingTimeMs / 1000).toFixed(1)}s
            {processedResult.matchFormat && ` · ${processedResult.matchFormat}`}
            {totalStats > 0 && ` · ${totalStats} hero stats extracted`}
            {sb && ` · scoreboard saved`}
          </p>
        </div>

        {processedResult.correctedRole && currentBatch && (
          <div className="bg-ow-orange/10 border border-ow-orange/30 rounded-lg px-5 py-4">
            <p className="text-ow-orange font-display font-bold text-sm">ROLE AUTO-CORRECTED</p>
            <p className="text-slate-400 text-xs mt-1">
              You selected <span className="text-white font-display">{(currentBatch.metadata.role_played || 'unknown').toUpperCase()}</span> but
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

        {/* Scoreboard data */}
        {sb && (() => {
          const totalSlots = sb.stats.length
          return (
          <div className="bg-ow-panel rounded-lg p-5 border border-white/5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <p className="text-xs text-slate-400 font-display tracking-wider">SCOREBOARD</p>
                {processedResult.matchFormat && (
                  <span className="text-[10px] font-display font-bold px-1.5 py-0.5 rounded bg-ow-orange/10 text-ow-orange">
                    {processedResult.matchFormat.toUpperCase()}
                  </span>
                )}
              </div>
              <span className="text-xs text-slate-500 font-display">
                {sb.heroes.filter(h => h.heroName).length}/{totalSlots} heroes
                {' · '}
                {sb.stats.filter(s => s.eliminations !== null).length}/{totalSlots} stats
              </span>
            </div>

            {/* Team compositions */}
            {(processedResult.allyComp || processedResult.enemyComp) && (
              <div className="flex gap-4 text-xs font-display">
                {processedResult.allyComp && (
                  <span className="text-blue-400">
                    Ally <span className="text-white font-bold">{processedResult.allyComp}</span>
                  </span>
                )}
                {processedResult.enemyComp && (
                  <span className="text-red-400">
                    Enemy <span className="text-white font-bold">{processedResult.enemyComp}</span>
                  </span>
                )}
              </div>
            )}

            {/* Ally team */}
            <div>
              <p className="text-[10px] text-blue-400 font-display tracking-wider uppercase mb-2">Ally Team</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                      <th className="text-left py-1.5 px-2 font-medium">Player</th>
                      <th className="text-left py-1.5 px-2 font-medium">Hero</th>
                      <th className="text-left py-1.5 px-2 font-medium">Role</th>
                      <th className="text-right py-1.5 px-2 font-medium">E</th>
                      <th className="text-right py-1.5 px-2 font-medium">A</th>
                      <th className="text-right py-1.5 px-2 font-medium">D</th>
                      <th className="text-right py-1.5 px-2 font-medium">DMG</th>
                      <th className="text-right py-1.5 px-2 font-medium">H</th>
                      <th className="text-right py-1.5 px-2 font-medium">MIT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sb.stats.filter(s => s.team === 'ally').map(s => {
                      const player = sb.players.find(p => p.slot === s.slot)
                      return (
                        <tr
                          key={s.slot}
                          className={`border-b border-white/5 ${player?.isUser ? 'bg-ow-orange/5' : ''}`}
                        >
                          <td className={`py-1.5 px-2 font-display ${player?.isUser ? 'text-ow-orange font-bold' : 'text-slate-300'}`}>
                            {player?.displayName || `Ally ${s.slot}`}
                          </td>
                          <td className="py-1.5 px-2 text-slate-300">{s.heroName || '—'}</td>
                          <td className={`py-1.5 px-2 uppercase font-display text-[10px] font-bold ${
                            s.role === 'tank' ? 'text-blue-300' :
                            s.role === 'dps' ? 'text-red-300' :
                            s.role === 'support' ? 'text-green-300' : 'text-slate-600'
                          }`}>
                            {s.role || '—'}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.eliminations ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.assists ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.deaths ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.damage?.toLocaleString() ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.healing?.toLocaleString() ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.mitigation?.toLocaleString() ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Enemy team */}
            <div>
              <p className="text-[10px] text-red-400 font-display tracking-wider uppercase mb-2">Enemy Team</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 text-[10px] uppercase tracking-wider border-b border-white/5">
                      <th className="text-left py-1.5 px-2 font-medium">Player</th>
                      <th className="text-left py-1.5 px-2 font-medium">Hero</th>
                      <th className="text-left py-1.5 px-2 font-medium">Role</th>
                      <th className="text-right py-1.5 px-2 font-medium">E</th>
                      <th className="text-right py-1.5 px-2 font-medium">A</th>
                      <th className="text-right py-1.5 px-2 font-medium">D</th>
                      <th className="text-right py-1.5 px-2 font-medium">DMG</th>
                      <th className="text-right py-1.5 px-2 font-medium">H</th>
                      <th className="text-right py-1.5 px-2 font-medium">MIT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sb.stats.filter(s => s.team === 'enemy').map(s => {
                      const player = sb.players.find(p => p.slot === s.slot)
                      return (
                        <tr key={s.slot} className="border-b border-white/5">
                          <td className="py-1.5 px-2 text-slate-300 font-display">
                            {player?.displayName || `Enemy ${s.slot - (sb.detection.grid?.rowsPerTeam ?? 5)}`}
                          </td>
                          <td className="py-1.5 px-2 text-slate-300">{s.heroName || '—'}</td>
                          <td className={`py-1.5 px-2 uppercase font-display text-[10px] font-bold ${
                            s.role === 'tank' ? 'text-blue-300' :
                            s.role === 'dps' ? 'text-red-300' :
                            s.role === 'support' ? 'text-green-300' : 'text-slate-600'
                          }`}>
                            {s.role || '—'}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.eliminations ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.assists ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.deaths ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.damage?.toLocaleString() ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.healing?.toLocaleString() ?? '—'}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-slate-300">{s.mitigation?.toLocaleString() ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          ) })()}

        <div className="flex justify-center gap-3">
          {queueHasMore ? (
            <>
              <button onClick={processNextInQueue}
                className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                           px-6 py-2.5 rounded-lg tracking-wider text-sm transition-colors">
                NEXT MATCH ({queueRemaining.length} remaining)
              </button>
              <button onClick={handleDone}
                className="bg-ow-panel border border-white/10 text-white font-display
                           px-6 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
                STOP
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
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
          {queueRemaining.length > 0 && (
            <button onClick={processNextInQueue}
              className="bg-ow-panel border border-white/10 text-white font-display
                         px-6 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
              SKIP
            </button>
          )}
          <button onClick={handleDone}
            className="bg-ow-panel border border-white/10 text-white font-display
                       px-6 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
            {queueRemaining.length > 0 ? 'STOP' : 'BACK'}
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
      message = `Identifying heroes (${currentBatch.metadata.role_played || 'all roles'} first)...`
    }

    return (
      <div className="max-w-3xl mx-auto">
        <div className="bg-ow-panel rounded-lg p-12 text-center border border-white/5">
          {queueTotal > 1 && (
            <p className="text-ow-orange font-display font-bold text-sm mb-4">
              MATCH {queueProcessed + 1} / {queueTotal}
            </p>
          )}
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
          {/* Header with actions */}
          <div className="bg-ow-orange/10 border border-ow-orange/30 rounded-lg px-5 py-4
                          flex items-center justify-between">
            <div>
              <p className="text-ow-orange font-display font-bold">
                {batches.length} MATCH{batches.length !== 1 ? 'ES' : ''} WAITING
              </p>
              <p className="text-slate-400 text-xs mt-0.5">
                Select matches to process, or process all at once
              </p>
            </div>
            <div className="flex gap-2">
              {selectedBatchIds.size > 0 && (
                <button onClick={processSelected}
                  className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                             px-4 py-2 rounded-lg tracking-wider text-xs transition-colors whitespace-nowrap">
                  PROCESS {selectedBatchIds.size} SELECTED
                </button>
              )}
              <button onClick={processAllBatches}
                className="bg-ow-panel border border-white/10 text-white font-display
                           px-4 py-2 rounded-lg tracking-wider text-xs hover:border-ow-orange/30 transition-colors whitespace-nowrap">
                PROCESS ALL
              </button>
            </div>
          </div>

          {/* Select all / deselect */}
          <div className="flex items-center gap-3 px-1">
            <button
              onClick={selectedBatchIds.size === batches.length ? deselectAllBatches : selectAllBatches}
              className="text-xs text-slate-500 hover:text-slate-300 font-display tracking-wider transition-colors"
            >
              {selectedBatchIds.size === batches.length ? '✓ DESELECT ALL' : '☐ SELECT ALL'}
            </button>
            {selectedBatchIds.size > 0 && selectedBatchIds.size < batches.length && (
              <span className="text-xs text-slate-600 font-display">
                {selectedBatchIds.size} selected
              </span>
            )}
          </div>

          {/* Batch cards */}
          {batches.map(batch => {
            const isSelected = selectedBatchIds.has(batch.batchId)
            const format = batch.metadata.match_format?.toUpperCase()
            const roles = batch.metadata.roles_played?.length
              ? batch.metadata.roles_played.map(r => r.toUpperCase()).join(', ')
              : batch.metadata.role_played?.toUpperCase() || null

            return (
              <div key={batch.batchId}
                onClick={() => toggleBatchSelection(batch.batchId)}
                className={`bg-ow-panel rounded-lg p-5 border transition-colors cursor-pointer ${
                  isSelected
                    ? 'border-ow-orange/40 bg-ow-orange/5'
                    : 'border-white/5 hover:border-ow-orange/20'
                }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    {/* Checkbox */}
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      isSelected
                        ? 'border-ow-orange bg-ow-orange text-ow-dark'
                        : 'border-slate-600'
                    }`}>
                      {isSelected && <span className="text-xs font-bold">✓</span>}
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-sm">
                        {format && (
                          <span className="text-ow-orange font-display font-bold text-xs">{format}</span>
                        )}
                        {roles && (
                          <>
                            {format && <span className="text-slate-500">•</span>}
                            <span className="text-white font-display">{roles}</span>
                          </>
                        )}
                        {!format && !roles && (
                          <span className="text-slate-500 font-display">NO METADATA</span>
                        )}
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
                  </div>

                  <button onClick={(e) => {
                      e.stopPropagation()
                      setQueueRemaining([])
                      setQueueTotal(0)
                      setQueueProcessed(0)
                      processBatch(batch)
                    }}
                    className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                               px-5 py-2.5 rounded-lg tracking-wider text-sm transition-colors whitespace-nowrap">
                    PROCESS
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <button onClick={scanForBatches}
        className="text-sm text-slate-500 hover:text-slate-300 font-display tracking-wider transition-colors">
        ↻ REFRESH
      </button>
    </div>
  )
}
