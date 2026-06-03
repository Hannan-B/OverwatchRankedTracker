'use client'

// ============================================================
// PROCESS MATCHES — two-phase rework
// ------------------------------------------------------------
// Phase 1 (PROCESSING, unattended): loops every selected/all pending batch,
//   runs processMatchPhotos() with NO stops, builds each match's 6f
//   confirmation questions, and holds the result in memory as a ReviewItem.
//   A batch that throws is SKIPPED (files left in pending for retry), logged
//   to the issue log as a processing_error, and collected into failures[].
//
// Phase 2 (REVIEW, grouped by match): steps through the held ReviewItems one
//   match at a time — username confirmation (if unresolved) then the 6f Quick
//   check — and SAVES each match the instant its review clears. Saving removes
//   that match's pending files (inside saveMatch, after all inserts succeed),
//   exactly as before. Nothing is deleted before save.
//
// Safety notes:
//   - Signed image URLs are re-minted at review time (per match), so a long
//     session never shows expired/broken source crops in the confirmation
//     cards. Scan-time URLs are only used for the batch-list thumbnails.
//   - File cleanup remains the final step of saveMatch — never earlier.
// ============================================================

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { processMatchPhotos, type ProcessedMatch, type ProcessingStatus } from '@/lib/image-processor'
import { buildPlayerLabels } from '@/lib/scoreboard-extractor'
import { getGameModeForMap, needsStartingSide, MAPS } from '@/data/reference'
import type { RoleType, MatchFeel, PerformanceFeel, StartingSide } from '@/lib/types'
import { buildConfirmationQuestions, type ConfirmInputs, type ConfirmationCandidate } from '@/lib/beta-confirmation'
import { logConfirmationOutcome, logMatchSummary, logProcessingError } from '@/lib/beta-issue-log'
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

// A processed-but-not-yet-saved match held in memory through Phase 2.
interface ReviewItem {
  batch: PendingBatch
  result: ProcessedMatch
  questions: ConfirmationCandidate[]
  matchSeq: number
  // username confirmation state for THIS match
  userResolved: boolean
  saved: boolean
}

interface ProcessFailure {
  batchId: string
  message: string
  uploadedAt: string
}

type PageState =
  | 'scanning'
  | 'idle'
  | 'processing'    // Phase 1 — unattended loop
  | 'review'        // Phase 2 — grouped-by-match review
  | 'done'

// Per-match review sub-step within Phase 2.
type ReviewStep = 'user_confirm' | 'user_select' | 'beta' | 'saving' | 'saved'

const MAP_NAMES = MAPS.map(m => m.name)
const MODE_NAMES = ['escort', 'control', 'hybrid', 'push', 'flashpoint']

const STATUS_MESSAGES: Record<string, string> = {
  loading_opencv: 'Loading image recognition engine…',
  loading_heroes: 'Loading hero bank (51 heroes)…',
  processing_photo: 'Loading photos…',
  classifying_pages: 'Detecting page types…',
  running_ocr: 'Reading text from screenshots…',
  matching_heroes: 'Identifying heroes…',
  reading_breakdowns: 'Extracting hero stats…',
  reading_scoreboard: 'Reading scoreboard data…',
  complete: 'Processing complete!',
}

export default function ProcessPage() {
  const router = useRouter()
  const [batches, setBatches] = useState<PendingBatch[]>([])
  const [pageState, setPageState] = useState<PageState>('scanning')
  const [gamertag, setGamertag] = useState<string>('')

  // selection
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(new Set())

  // Phase 1 — processing
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null)
  const [procTotal, setProcTotal] = useState(0)
  const [procDone, setProcDone] = useState(0)
  const [procCurrentLabel, setProcCurrentLabel] = useState<string>('')
  const [failures, setFailures] = useState<ProcessFailure[]>([])

  // Phase 2 — review queue (held in memory until each is saved)
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [reviewIndex, setReviewIndex] = useState(0)
  const [reviewStep, setReviewStep] = useState<ReviewStep>('beta')
  const [reviewError, setReviewError] = useState<string | null>(null)
  // freshly re-minted signed URLs for the match currently under review
  const [liveImages, setLiveImages] = useState<{
    scoreboard?: string
    summary?: string
    byHero: Record<string, string>
  }>({ byHero: {} })

  const [savedCount, setSavedCount] = useState(0)
  const [matchSeqCounter, setMatchSeqCounter] = useState(0)

  // ── Mount: gamertag + initial scan ──
  useEffect(() => {
    async function loadGamertag() {
      const { data } = await supabase
        .from('user_settings')
        .select('gamertag')
        .limit(1)
        .single()
      if (data?.gamertag) setGamertag(data.gamertag)
    }
    loadGamertag()
  }, [])

  useEffect(() => { scanForBatches() }, [])

  async function scanForBatches() {
    setPageState('scanning')
    try {
      const { data: folders } = await supabase.storage
        .from('match-images')
        .list('pending', { limit: 50 })

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

      // Stable order: oldest upload first, so an overnight run processes in
      // the order matches were played/uploaded.
      pendingBatches.sort((a, b) =>
        (a.metadata.uploaded_at || '').localeCompare(b.metadata.uploaded_at || ''))

      setBatches(pendingBatches)
      setPageState('idle')
    } catch (err) {
      console.error('Scan error:', err)
      setPageState('idle')
    }
  }

  // ── Selection ──
  function toggleBatchSelection(batchId: string) {
    setSelectedBatchIds(prev => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }
  function selectAllBatches() { setSelectedBatchIds(new Set(batches.map(b => b.batchId))) }
  function deselectAllBatches() { setSelectedBatchIds(new Set()) }

  // ════════════════════════════════════════════════════════════
  // PHASE 1 — unattended processing
  // ════════════════════════════════════════════════════════════

  function startProcessing(which: PendingBatch[]) {
    if (which.length === 0) return
    setFailures([])
    setReviewItems([])
    setReviewIndex(0)
    setSavedCount(0)
    setProcTotal(which.length)
    setProcDone(0)
    setSelectedBatchIds(new Set())
    setPageState('processing')
    // Run the loop. It owns its own seq counter so memory state stays correct.
    void runProcessingLoop(which)
  }

  function processSelected() {
    const selected = batches.filter(b => selectedBatchIds.has(b.batchId))
    startProcessing(selected)
  }
  function processAllBatches() { startProcessing(batches) }

  // Build the 6f confirmation questions for a finished result (pure-ish; no save).
  function buildQuestions(batch: PendingBatch, result: ProcessedMatch, seq: number): ConfirmationCandidate[] {
    const sb = result.scoreboard

    const lowConfHeroSlots = (sb?.heroes ?? [])
      .filter(h => h.heroName && h.confidence < 0.6)
      .map(h => h.slot)

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
      knownMaps: MAP_NAMES,
      knownModes: MODE_NAMES,
      scoreboardImageUrl: sb?.imageUrl,
      summaryImageUrl: result.summaryImageUrl,
      breakdownImageUrlByHero: Object.fromEntries(
        result.heroBreakdowns.map(b => [b.heroName, b.imageUrl])
      ),
      grid: sb?.detection?.grid ?? undefined,
      imageNaturalWidth: 3840,
      imageNaturalHeight: 2160,
      matchSequence: seq,
    }

    return buildConfirmationQuestions(inputs)
  }

  async function runProcessingLoop(which: PendingBatch[]) {
    const collected: ReviewItem[] = []
    const failed: ProcessFailure[] = []
    let seq = matchSeqCounter

    for (let i = 0; i < which.length; i++) {
      const batch = which[i]
      setProcDone(i)
      const roles = batch.metadata.roles_played?.length
        ? batch.metadata.roles_played.join(', ')
        : batch.metadata.role_played || 'all roles'
      setProcCurrentLabel(`${batch.metadata.match_format?.toUpperCase() || ''} · ${roles}`.trim())
      setProcessingStatus(null)

      try {
        const result = await processMatchPhotos(
          batch.photoUrls,
          (status) => setProcessingStatus(status),
          batch.metadata.role_played || undefined,
          gamertag || undefined,
        )

        seq += 1
        const questions = buildQuestions(batch, result, seq)
        const userResolved = !(result.scoreboard?.ocrAnalysis && !result.scoreboard.ocrAnalysis.resolved)

        collected.push({
          batch,
          result,
          questions,
          matchSeq: seq,
          userResolved,
          saved: false,
        })
      } catch (err: any) {
        const message = err?.message || 'Processing failed'
        console.error(`[process] batch ${batch.batchId} failed:`, err)
        failed.push({ batchId: batch.batchId, message, uploadedAt: batch.metadata.uploaded_at })
        // Log to issue log (best-effort; never blocks the run). Files are NOT
        // removed — they stay in pending/ for a later retry.
        try {
          await logProcessingError({
            matchId: batch.batchId,
            message,
            format: batch.metadata.match_format ?? null,
          })
        } catch (logErr) {
          console.warn('[process] failed to log processing_error (continuing):', logErr)
        }
      }
    }

    setProcDone(which.length)
    setMatchSeqCounter(seq)
    setFailures(failed)
    setReviewItems(collected)

    if (collected.length === 0) {
      // Nothing processed successfully — go straight to the done screen, which
      // will surface the failures.
      setPageState('done')
      return
    }

    // Enter Phase 2 at the first match.
    setReviewIndex(0)
    void enterReviewForIndex(0, collected)
  }

  // ════════════════════════════════════════════════════════════
  // PHASE 2 — review, grouped by match
  // ════════════════════════════════════════════════════════════

  // Re-mint fresh signed URLs for a match's source screenshots so the
  // confirmation crops never show an expired link, then pick the first sub-step.
  async function enterReviewForIndex(index: number, items: ReviewItem[]) {
    const item = items[index]
    if (!item) { finishReview(); return }

    setReviewError(null)
    setPageState('review')

    // Re-sign the batch's photo paths and remap to the result's image roles by
    // matching the path suffix the original signed URLs used. We can't know
    // which path was scoreboard vs summary without the result's own URLs, so we
    // refresh ALL batch paths and substitute by filename where the result URL
    // contained that filename. Simpler + robust: refresh each path, then for
    // each result image URL find the path whose filename it ends with.
    const fresh: Record<string, string> = {}
    for (const path of item.batch.photoPaths) {
      const { data } = await supabase.storage
        .from('match-images')
        .createSignedUrl(path, 3600)
      if (data?.signedUrl) fresh[path] = data.signedUrl
    }
    const reSign = (oldUrl: string | undefined): string | undefined => {
      if (!oldUrl) return undefined
      // The signed URL path segment contains the storage path; match by the
      // batch path whose filename appears in the old URL.
      const hit = item.batch.photoPaths.find(p => {
        const file = p.split('/').pop() || p
        return oldUrl.includes(encodeURIComponent(file)) || oldUrl.includes(file)
      })
      return hit ? fresh[hit] ?? oldUrl : oldUrl
    }

    const sb = item.result.scoreboard
    const byHero: Record<string, string> = {}
    for (const b of item.result.heroBreakdowns) {
      const u = reSign(b.imageUrl)
      if (u) byHero[b.heroName] = u
    }
    setLiveImages({
      scoreboard: reSign(sb?.imageUrl),
      summary: reSign(item.result.summaryImageUrl),
      byHero,
    })

    // First sub-step: username confirmation if unresolved, else straight to 6f.
    if (!item.userResolved) setReviewStep('user_confirm')
    else setReviewStep('beta')
  }

  const current = reviewItems[reviewIndex]

  // Username confirmation handlers (operate on the current review item) ──
  function applyUserSlot(slot: number, method: 'ocr_confirmed' | 'manual_select') {
    setReviewItems(prev => {
      const next = [...prev]
      const item = next[reviewIndex]
      if (!item?.result.scoreboard) return prev
      const sb = item.result.scoreboard
      const updatedPlayers = buildPlayerLabels(sb.heroes, sb.roles, gamertag, slot, method)
      next[reviewIndex] = {
        ...item,
        userResolved: true,
        result: {
          ...item.result,
          scoreboard: {
            ...sb,
            players: updatedPlayers,
            ocrAnalysis: { ...sb.ocrAnalysis, resolved: true, userSlot: slot },
          },
        },
      }
      return next
    })
    setReviewStep('beta')
  }

  const handleConfirmUser = useCallback((slot: number) => applyUserSlot(slot, 'ocr_confirmed'), [reviewIndex, gamertag])
  const handleSelectUser  = useCallback((slot: number) => applyUserSlot(slot, 'manual_select'), [reviewIndex, gamertag])
  const handleDeclineConfirm = useCallback(() => setReviewStep('user_select'), [])
  const handleSkipConfirm = useCallback(() => setReviewStep('beta'), [])

  // 6f completion → log outcomes, then SAVE this match immediately.
  async function onBetaComplete(results: ConfirmationResult[]) {
    const item = reviewItems[reviewIndex]
    if (!item) return
    const { batch, result } = item
    const format = (result.matchFormat || batch.metadata.match_format || '5v5') as '5v5' | '6v6'
    const autoPassFields = result.scoreboard?.cellConfidence?.length ?? 0

    setReviewStep('saving')
    setReviewError(null)

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

    try {
      await saveMatch(batch, result)
      setReviewItems(prev => {
        const next = [...prev]
        if (next[reviewIndex]) next[reviewIndex] = { ...next[reviewIndex], saved: true }
        return next
      })
      setSavedCount(c => c + 1)
      setReviewStep('saved')
    } catch (err: any) {
      setReviewError(err?.message || 'Save failed')
      setReviewStep('beta')
    }
  }

  function advanceReview() {
    const nextIndex = reviewIndex + 1
    if (nextIndex >= reviewItems.length) { finishReview(); return }
    setReviewIndex(nextIndex)
    void enterReviewForIndex(nextIndex, reviewItems)
  }

  function finishReview() {
    setPageState('done')
  }

  // ── Save (unchanged logic; cleanup remains the LAST step) ──
  async function saveMatch(batch: PendingBatch, processed: ProcessedMatch) {
    const meta = batch.metadata
    const gameMode = processed.mapName ? getGameModeForMap(processed.mapName) : null
    const finalRole = processed.correctedRole || meta.role_played || 'dps'
    const matchFormat = processed.matchFormat || meta.match_format || '5v5'
    const rolesPlayed = meta.roles_played && meta.roles_played.length > 0
      ? meta.roles_played
      : [finalRole]

    const startingSide: StartingSide | null =
      processed.mapName && needsStartingSide(processed.mapName)
        ? (meta.starting_side ?? null)
        : null

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
          if (statsError) console.warn('Failed to save hero stats:', statsError)
          else console.log(`Saved ${allStatInserts.length} hero stats to database`)
        }
      }
    }

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
      if (sbError) console.warn('Failed to save scoreboard players:', sbError)
      else console.log(`Saved ${scoreboardInserts.length} scoreboard players to database`)
    }

    // Clean up pending files — LAST, only after every insert above succeeded.
    const allPaths = [
      `pending/${batch.batchId}/metadata.json`,
      ...batch.photoPaths,
    ]
    await supabase.storage.from('match-images').remove(allPaths)
  }

  function resetToIdle() {
    setReviewItems([])
    setReviewIndex(0)
    setFailures([])
    setProcTotal(0)
    setProcDone(0)
    setSavedCount(0)
    setProcessingStatus(null)
    scanForBatches()
  }

  // ════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════

  // ---------- SCANNING ----------
  if (pageState === 'scanning') {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="bg-ow-panel rounded-lg p-12 text-center border border-white/10">
          <div className="w-8 h-8 border-2 border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400 font-display tracking-wider">CHECKING FOR UPLOADS…</p>
        </div>
      </div>
    )
  }

  // ---------- PHASE 1: PROCESSING ----------
  if (pageState === 'processing') {
    const stage = processingStatus?.stage || 'loading_opencv'
    const stageProgress = processingStatus?.progress || 0
    const message = STATUS_MESSAGES[stage] || 'Processing…'
    // Overall progress across the whole run (each match contributes 1/total).
    const overall = procTotal > 0
      ? Math.min(100, ((procDone + stageProgress / 100) / procTotal) * 100)
      : 0

    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-3xl tracking-[0.12em] text-slate-100 uppercase">Processing</h1>
          <p className="text-sm text-slate-400 mt-1">
            Working through {procTotal} match{procTotal !== 1 ? 'es' : ''} — no input needed until review.
          </p>
        </div>

        <div className="bg-ow-panel rounded-lg p-10 text-center border border-white/10">
          <p className="text-ow-orange font-display font-bold text-sm tracking-wider mb-4">
            MATCH {Math.min(procDone + 1, procTotal)} / {procTotal}
            {procCurrentLabel && <span className="text-slate-400 font-normal"> · {procCurrentLabel}</span>}
          </p>
          <div className="w-12 h-12 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <p className="text-white font-display text-lg">{message}</p>

          {/* per-match stage bar */}
          <div className="mt-6 bg-ow-dark rounded-full h-1.5 overflow-hidden max-w-sm mx-auto">
            <div className="h-full bg-ow-orange/60 transition-all duration-500 rounded-full"
              style={{ width: `${stageProgress}%` }} />
          </div>

          {/* overall run bar */}
          <div className="mt-3 bg-ow-dark rounded-full h-2 overflow-hidden max-w-sm mx-auto">
            <div className="h-full bg-ow-orange transition-all duration-500 rounded-full"
              style={{ width: `${overall}%` }} />
          </div>
          <p className="text-xs text-slate-500 mt-2 font-display tracking-wider">
            {Math.round(overall)}% overall
          </p>

          {failures.length > 0 && (
            <p className="text-xs text-ow-defeat/80 mt-4 font-display">
              {failures.length} skipped so far — you can retry these later.
            </p>
          )}
        </div>
      </div>
    )
  }

  // ---------- PHASE 2: REVIEW ----------
  if (pageState === 'review' && current) {
    const item = current
    const sb = item.result.scoreboard
    const analysis = sb?.ocrAnalysis
    const positionInQueue = `Match ${reviewIndex + 1} of ${reviewItems.length}`

    // inject the freshly-signed image URLs into the questions for THIS match so
    // the confirmation cards never reference an expired link.
    const liveQuestions: ConfirmationCandidate[] = item.questions.map(q => {
      if (!q.region) return q
      // pick the right re-signed URL by field type
      let url = q.region.imageUrl
      if (q.field === 'summary') url = liveImages.summary ?? url
      else if (q.field === 'breakdown_stat' || q.field === 'hero_id') {
        // breakdown questions name the hero in fieldDetail; fall back to summary
        const heroHit = Object.keys(liveImages.byHero).find(h => q.fieldDetail.includes(h))
        url = (heroHit && liveImages.byHero[heroHit]) ?? liveImages.scoreboard ?? url
      } else {
        url = liveImages.scoreboard ?? url
      }
      return { ...q, region: { ...q.region, imageUrl: url } }
    })

    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-[0.12em] text-slate-100 uppercase">Review</h1>
            <p className="text-sm text-slate-400 mt-1">
              {positionInQueue} · {savedCount} saved{failures.length > 0 ? ` · ${failures.length} skipped` : ''}
            </p>
          </div>
        </div>

        {/* queue progress bar */}
        <div className="bg-ow-dark rounded-full h-2 overflow-hidden">
          <div className="h-full bg-ow-orange transition-all duration-300 rounded-full"
            style={{ width: `${(reviewIndex / reviewItems.length) * 100}%` }} />
        </div>

        {/* match identity header */}
        <div className="bg-ow-panel rounded-lg border border-white/10 px-5 py-4 flex items-center gap-3 flex-wrap">
          {item.result.matchFormat && (
            <span className="text-[10px] font-display font-bold px-2 py-0.5 rounded bg-ow-orange/10 text-ow-orange tracking-wider">
              {item.result.matchFormat.toUpperCase()}
            </span>
          )}
          <span className="text-white font-display">{item.result.mapName || 'Unknown map'}</span>
          {item.result.result && (
            <span className={`font-display font-bold text-sm ${
              item.result.result === 'victory' ? 'text-ow-victory'
              : item.result.result === 'defeat' ? 'text-ow-defeat' : 'text-ow-draw'
            }`}>{item.result.result.toUpperCase()}</span>
          )}
          {item.result.score && <span className="text-slate-400 text-sm font-display">{item.result.score}</span>}
        </div>

        {reviewError && (
          <div className="bg-ow-defeat/10 border border-ow-defeat/30 rounded-lg px-4 py-3 text-sm text-ow-defeat">
            {reviewError}
          </div>
        )}

        {/* sub-step: username confirm */}
        {reviewStep === 'user_confirm' && analysis && (() => {
          const bestCandidate = analysis.candidates.find(c => c.slot === analysis.bestCandidate.slot)
          if (!bestCandidate) { setReviewStep('beta'); return null }
          return (
            <div className="bg-ow-panel rounded-lg border border-ow-orange/30 p-6">
              <p className="text-ow-orange font-display font-bold text-lg mb-1">IS THIS YOU?</p>
              <p className="text-slate-400 text-xs mb-5">
                OCR wasn&apos;t confident enough to auto-identify your player
                ({(analysis.bestCandidate.similarity * 100).toFixed(0)}% similarity,
                {' '}{(analysis.bestCandidate.margin * 100).toFixed(0)}% margin).
              </p>
              <div className="flex items-center gap-4 bg-ow-dark rounded-lg p-4 mb-5 border border-white/10">
                {bestCandidate.heroPortraitUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={bestCandidate.heroPortraitUrl} alt="" className="w-14 h-14 rounded border border-white/10" />
                )}
                <div className="flex-1 min-w-0">
                  {bestCandidate.gamertagCropUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={bestCandidate.gamertagCropUrl} alt="" className="h-8 rounded mb-1" style={{ imageRendering: 'auto' }} />
                  )}
                  <p className="text-xs text-slate-500">
                    Slot {bestCandidate.slot} · {bestCandidate.heroName || 'Unknown hero'}
                  </p>
                </div>
              </div>
              <div className="flex gap-3 flex-wrap">
                <button onClick={() => handleConfirmUser(bestCandidate.slot)}
                  className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold px-5 py-2.5 rounded-lg tracking-wider text-sm transition-colors">
                  YES, THAT&apos;S ME
                </button>
                <button onClick={handleDeclineConfirm}
                  className="bg-ow-panel border border-white/10 text-white font-display px-5 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
                  NO, SHOW ALL
                </button>
                <button onClick={handleSkipConfirm}
                  className="text-slate-500 hover:text-slate-300 font-display px-4 py-2.5 text-sm tracking-wider transition-colors">
                  SKIP
                </button>
              </div>
            </div>
          )
        })()}

        {/* sub-step: username select-all */}
        {reviewStep === 'user_select' && analysis && (
          <div className="bg-ow-panel rounded-lg border border-ow-orange/30 p-6">
            <p className="text-ow-orange font-display font-bold text-lg mb-1">WHICH ONE IS YOU?</p>
            <p className="text-slate-400 text-xs mb-5">Select your player from the ally team.</p>
            <div className="space-y-2">
              {analysis.candidates.map(candidate => (
                <button key={candidate.slot} onClick={() => handleSelectUser(candidate.slot)}
                  className="w-full flex items-center gap-4 bg-ow-dark hover:bg-ow-dark/80 rounded-lg p-3 transition-colors text-left border border-white/10 hover:border-ow-orange/30">
                  {candidate.heroPortraitUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={candidate.heroPortraitUrl} alt="" className="w-12 h-12 rounded border border-white/10 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    {candidate.gamertagCropUrl && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={candidate.gamertagCropUrl} alt="" className="h-7 rounded mb-1" style={{ imageRendering: 'auto' }} />
                    )}
                    <p className="text-xs text-slate-500">Slot {candidate.slot} · {candidate.heroName || 'Unknown hero'}</p>
                  </div>
                  <span className="text-xs font-mono text-slate-600">{(candidate.ocrSimilarity * 100).toFixed(0)}%</span>
                </button>
              ))}
            </div>
            <button onClick={handleSkipConfirm}
              className="mt-4 text-slate-500 hover:text-slate-300 font-display text-sm tracking-wider transition-colors">
              SKIP — SAVE WITHOUT USER ID
            </button>
          </div>
        )}

        {/* sub-step: 6f beta quick check */}
        {reviewStep === 'beta' && (
          <div className="space-y-4">
            <div>
              <h2 className="font-display text-xl text-ow-orange tracking-wider">Quick check</h2>
              <p className="text-sm text-slate-400 mt-1">Confirm what was read before saving this match.</p>
            </div>
            <ConfirmationPanel candidates={liveQuestions} onComplete={onBetaComplete} />
            {liveQuestions.length === 0 && (
              <button onClick={() => onBetaComplete([])}
                className="w-full bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold py-3 rounded-lg tracking-wider transition-colors text-sm">
                SAVE MATCH
              </button>
            )}
          </div>
        )}

        {/* sub-step: saving */}
        {reviewStep === 'saving' && (
          <div className="bg-ow-panel rounded-lg p-10 text-center border border-white/10">
            <div className="w-10 h-10 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-white font-display tracking-wider">SAVING…</p>
          </div>
        )}

        {/* sub-step: saved → advance */}
        {reviewStep === 'saved' && (
          <div className="space-y-4">
            <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-6 text-center">
              <span className="text-3xl block mb-2">✓</span>
              <p className="text-ow-victory font-display tracking-wider font-bold">MATCH SAVED</p>
            </div>
            <button onClick={advanceReview}
              className="w-full bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold py-3 rounded-lg tracking-wider transition-colors text-sm">
              {reviewIndex + 1 >= reviewItems.length ? 'FINISH' : `NEXT MATCH (${reviewItems.length - reviewIndex - 1} left)`}
            </button>
          </div>
        )}
      </div>
    )
  }

  // ---------- DONE ----------
  if (pageState === 'done') {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="bg-ow-victory/10 border border-ow-victory/30 rounded-lg p-8 text-center">
          <span className="text-4xl block mb-3">✓</span>
          <p className="text-ow-victory font-display text-xl font-bold tracking-wider">
            {savedCount} MATCH{savedCount !== 1 ? 'ES' : ''} SAVED
          </p>
        </div>

        {failures.length > 0 && (
          <div className="bg-ow-panel rounded-lg border border-ow-defeat/30 p-5 space-y-3">
            <p className="text-ow-defeat font-display font-bold text-sm tracking-wider">
              {failures.length} SKIPPED — KEPT FOR RETRY
            </p>
            <p className="text-xs text-slate-400">
              These batches couldn&apos;t be processed and their screenshots are still
              in storage. They&apos;ve been noted in the issue log. Try them again from here.
            </p>
            <div className="space-y-2">
              {failures.map(f => (
                <div key={f.batchId} className="bg-ow-dark rounded-lg px-4 py-3 border border-white/10">
                  <p className="text-xs text-slate-300 font-display">
                    {new Date(f.uploadedAt).toLocaleString()}
                  </p>
                  <p className="text-xs text-ow-defeat/80 mt-1">{f.message}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-center gap-3 flex-wrap">
          <button onClick={resetToIdle}
            className="bg-ow-panel border border-white/10 text-white font-display px-6 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
            PROCESS MORE
          </button>
          <button onClick={() => router.push('/matches')}
            className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold px-6 py-2.5 rounded-lg tracking-wider text-sm transition-colors">
            VIEW MATCHES
          </button>
        </div>
      </div>
    )
  }

  // ---------- IDLE: BATCH LIST ----------
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="font-display text-3xl tracking-[0.12em] text-slate-100 uppercase">Process Matches</h1>
        <p className="text-sm text-slate-400 mt-1">
          Automatically extract data from uploaded match photos
        </p>
      </div>

      {batches.length === 0 ? (
        <div className="bg-ow-panel rounded-lg p-12 text-center border border-white/10">
          <span className="text-4xl block mb-3">📷</span>
          <p className="text-slate-300 font-display text-lg tracking-wider">NO PENDING UPLOADS</p>
          <p className="text-slate-500 text-sm mt-2">
            Upload match photos from your phone to see them here
          </p>
          <button onClick={scanForBatches}
            className="mt-5 text-sm text-slate-500 hover:text-slate-300 font-display tracking-wider transition-colors">
            ↻ REFRESH
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Header with actions */}
          <div className="bg-ow-panel rounded-lg border border-ow-orange/30 px-5 py-4 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-ow-orange font-display font-bold tracking-wider">
                {batches.length} MATCH{batches.length !== 1 ? 'ES' : ''} WAITING
              </p>
              <p className="text-slate-400 text-xs mt-0.5">
                Process all unattended, then review them together — or pick a few.
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              {selectedBatchIds.size > 0 && (
                <button onClick={processSelected}
                  className="bg-ow-panel border border-white/10 text-white font-display px-4 py-2 rounded-lg tracking-wider text-xs hover:border-ow-orange/30 transition-colors whitespace-nowrap">
                  PROCESS {selectedBatchIds.size} SELECTED
                </button>
              )}
              <button onClick={processAllBatches}
                className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold px-4 py-2 rounded-lg tracking-wider text-xs transition-colors whitespace-nowrap">
                PROCESS ALL
              </button>
            </div>
          </div>

          {/* Select all / deselect */}
          <div className="flex items-center gap-3 px-1">
            <button
              onClick={selectedBatchIds.size === batches.length ? deselectAllBatches : selectAllBatches}
              className="text-xs text-slate-500 hover:text-slate-300 font-display tracking-wider transition-colors">
              {selectedBatchIds.size === batches.length ? '✓ DESELECT ALL' : '☐ SELECT ALL'}
            </button>
            {selectedBatchIds.size > 0 && selectedBatchIds.size < batches.length && (
              <span className="text-xs text-slate-600 font-display">{selectedBatchIds.size} selected</span>
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
                  isSelected ? 'border-ow-orange/40 bg-ow-orange/5' : 'border-white/10 hover:border-ow-orange/20'
                }`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      isSelected ? 'border-ow-orange bg-ow-orange text-ow-dark' : 'border-slate-600'
                    }`}>
                      {isSelected && <span className="text-xs font-bold">✓</span>}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm flex-wrap">
                        {format && <span className="text-ow-orange font-display font-bold text-xs">{format}</span>}
                        {roles && (
                          <>
                            {format && <span className="text-slate-500">•</span>}
                            <span className="text-white font-display">{roles}</span>
                          </>
                        )}
                        {!format && !roles && <span className="text-slate-500 font-display">NO METADATA</span>}
                        <span className="text-slate-500">•</span>
                        <span className="text-slate-400">
                          {batch.metadata.photo_count} photo{batch.metadata.photo_count !== 1 ? 's' : ''}
                        </span>
                        <span className="text-slate-500">•</span>
                        <span className="text-slate-500 text-xs">{new Date(batch.metadata.uploaded_at).toLocaleString()}</span>
                      </div>
                      <div className="flex gap-2 mt-2">
                        {batch.photoUrls.slice(0, 4).map((url, i) => (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img key={i} src={url} alt="" className="w-16 h-12 object-cover rounded" />
                        ))}
                      </div>
                    </div>
                  </div>

                  <button onClick={(e) => { e.stopPropagation(); startProcessing([batch]) }}
                    className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold px-5 py-2.5 rounded-lg tracking-wider text-sm transition-colors whitespace-nowrap">
                    PROCESS
                  </button>
                </div>
              </div>
            )
          })}

          <button onClick={scanForBatches}
            className="text-sm text-slate-500 hover:text-slate-300 font-display tracking-wider transition-colors">
            ↻ REFRESH
          </button>
        </div>
      )}
    </div>
  )
}
