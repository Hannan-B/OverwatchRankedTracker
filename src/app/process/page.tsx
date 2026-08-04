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
import { matchQuery } from '@/lib/alpha'
import { processMatchPhotos, type ProcessedMatch, type ProcessingStatus } from '@/lib/image-processor'
import { buildPlayerLabels } from '@/lib/scoreboard-extractor'
import { getGameModeForMap, needsStartingSide, MAPS, HEROES } from '@/data/reference'
import type { RoleType, MatchFeel, PerformanceFeel, StartingSide } from '@/lib/types'
import { logHeroAudit, logMatchSummary, logProcessingError } from '@/lib/beta-issue-log'
// Beta confirmation is SUNSET (v1.0.2). The confidence-gated question flow
// could measure how often a flag was right but never how many errors went
// unflagged — 60 of 71 wrong heroes were never questioned. It is replaced by
// a per-slot audit of every scoreboard row.
import { HeroAuditPanel, type HeroAuditResult } from '@/app/review/HeroAuditPanel'

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
    has_leaver?: boolean
    fun_rating: number | null
    personal_thoughts: string | null
    starting_side?: StartingSide | null
    detected_map?: string | null
    /** Step 10: phone map auto-detect produced nothing at upload (so no side
     *  question was asked). Drives the map dropdown + side follow-up at review. */
    map_detect_missed?: boolean
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

  // delete a pending (un-saved) upload: which batch is awaiting "are you sure?",
  // and whether a delete is currently in flight (to disable the buttons).
  const [batchPendingDelete, setBatchPendingDelete] = useState<PendingBatch | null>(null)
  const [deletingBatch, setDeletingBatch] = useState(false)

  // Escape closes the delete-confirm modal (unless a delete is mid-flight).
  useEffect(() => {
    if (!batchPendingDelete) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !deletingBatch) setBatchPendingDelete(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [batchPendingDelete, deletingBatch])

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

  // ── Alpha / test-data flagging ──
  // When the /process page runs on localhost we treat the matches we save as
  // TEST data (is_alpha = true) so they stay out of analytics. On the live
  // deployed site, saved matches are real (is_alpha = false). `alphaOverride`
  // lets you flip that decision by hand for the occasional exception.
  // null = "use the automatic localhost decision"; true/false = manual override.
  //
  // ⚠️ The manual override is LOCALHOST-ONLY. On the live site it is ignored, so
  // a real match can never be hand-flagged as test and silently vanish from
  // analytics. Live always follows the automatic decision (= real). The override
  // is only honoured when running on localhost (where its useful direction is
  // promoting a test match to real). See NEXT-STEPS #1 / alpha.ts write-side.
  const [alphaOverride, setAlphaOverride] = useState<boolean | null>(null)
  const [isLocalhost, setIsLocalhost] = useState(false)
  useEffect(() => {
    const h = window.location.hostname
    setIsLocalhost(h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0')
  }, [])
  // The value actually written to the DB: on localhost a manual override wins if
  // set, otherwise the automatic localhost decision. OFF localhost (live) the
  // override is ignored entirely — live matches are always real (is_alpha=false).
  const isAlpha = isLocalhost ? (alphaOverride ?? isLocalhost) : false

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

        // Auto-cleanup of abandoned uploads: a batch only remains in pending/ if
        // it was never processed+saved (saving deletes its files). So anything
        // here older than the retention window is an upload the user never acted
        // on — safe to delete. Keyed on the batch's own uploaded_at timestamp.
        // 21-day window: comfortably longer than any phone→laptop gap.
        const PENDING_RETENTION_DAYS = 21
        const uploadedAtMs = Date.parse(metadata?.uploaded_at ?? '')
        if (!Number.isNaN(uploadedAtMs)) {
          const ageDays = (Date.now() - uploadedAtMs) / (1000 * 60 * 60 * 24)
          if (ageDays > PENDING_RETENTION_DAYS) {
            const stalePaths = [
              `pending/${folder.name}/metadata.json`,
              ...files
                .filter(f => f.name !== 'metadata.json')
                .map(f => `pending/${folder.name}/${f.name}`),
            ]
            const { error: cleanupErr } = await supabase.storage
              .from('match-images')
              .remove(stalePaths)
            if (cleanupErr) {
              console.warn(`Auto-cleanup failed for batch ${folder.name}:`, cleanupErr)
            } else {
              console.log(`Auto-cleaned abandoned upload ${folder.name} (${Math.floor(ageDays)} days old)`)
            }
            continue // don't build preview URLs or list a batch we just removed
          }
        }

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

  // ── Delete a pending (un-saved) upload ──
  // Removes the batch's files from Storage (metadata.json + every photo) WITHOUT
  // writing anything to the database — a pure discard. Reuses the same storage
  // path shape + `.remove()` that saveMatch uses for post-save cleanup.
  async function deletePendingBatch(batch: PendingBatch) {
    setDeletingBatch(true)
    try {
      const allPaths = [
        `pending/${batch.batchId}/metadata.json`,
        ...batch.photoPaths,
      ]
      const { error } = await supabase.storage.from('match-images').remove(allPaths)
      if (error) {
        console.error('Failed to delete pending batch:', error)
        // Leave it in the list so the user can retry; surface nothing destructive.
        setDeletingBatch(false)
        setBatchPendingDelete(null)
        return
      }
      // Drop it from the on-screen list and any selection it was part of.
      setBatches(prev => prev.filter(b => b.batchId !== batch.batchId))
      setSelectedBatchIds(prev => {
        const next = new Set(prev)
        next.delete(batch.batchId)
        return next
      })
    } catch (err) {
      console.error('Failed to delete pending batch:', err)
    } finally {
      setDeletingBatch(false)
      setBatchPendingDelete(null)
    }
  }

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
  // buildQuestions() removed with beta confirmation (v1.0.2). The hero audit
  // needs no pre-built candidate list — it derives its rows from the
  // scoreboard result at render time.

  async function runProcessingLoop(which: PendingBatch[]) {
    const collected: ReviewItem[] = []
    const failed: ProcessFailure[] = []
    let seq = matchSeqCounter

    // Step 3: fetch the most recent matches' played_at ONCE for the date
    // neighbour-check (a parsed date >7 days from its nearest neighbour is
    // surfaced for confirmation). Routed through matchQuery so the alpha rule is
    // respected (localhost sees test data; live sees only real). Best-effort —
    // if it fails we just skip the neighbour trigger (missing/implausible still fire).
    let recentMatchDates: Date[] = []
    try {
      const { data: recentRows } = await matchQuery('played_at')
        .order('played_at', { ascending: false })
        .limit(10)
      // Cast via `unknown`: the Supabase client types this result as
      // GenericStringError[] | null, which doesn't overlap our row shape
      // directly (strict build catches it), so go through unknown first.
      const rows = (recentRows as unknown as { played_at: string | null }[] | null) ?? []
      recentMatchDates = rows
        .map(r => (r.played_at ? new Date(r.played_at) : null))
        .filter((d): d is Date => d !== null && !isNaN(d.getTime()))
    } catch {
      recentMatchDates = []
    }

    for (let i = 0; i < which.length; i++) {
      const batch = which[i]
      setProcDone(i)
      const roles = batch.metadata.roles_played?.length
        ? batch.metadata.roles_played.join(', ')
        : batch.metadata.role_played || 'all roles'
      setProcCurrentLabel(`${batch.metadata.match_format?.toUpperCase() || ''} · ${roles}`.trim())
      setProcessingStatus(null)

      try {
        const rawResult = await processMatchPhotos(
          batch.photoUrls,
          (status) => setProcessingStatus(status),
          batch.metadata.role_played || undefined,
          gamertag || undefined,
        )

        // Leaver games: a leaver collapses the scoreboard layout, so its stats
        // can't be read reliably. Discard whatever was extracted from the
        // scoreboard — the summary + hero breakdowns are still kept. Dropping it
        // here means everything downstream (the confirmation cards, the username
        // check, and the scoreboard insert in saveMatch) all correctly see "no
        // scoreboard" without any further special-casing.
        const isLeaverGame = !!(batch.metadata.has_leaver || batch.metadata.team_leaver || batch.metadata.enemy_leaver)
        // Omit the scoreboard key (rather than set it undefined) so this is valid
        // under exactOptionalPropertyTypes as well as the default config.
        const result = isLeaverGame ? { ...rawResult, scoreboard: null } : rawResult

        seq += 1
        const userResolved = !(result.scoreboard?.ocrAnalysis && !result.scoreboard.ocrAnalysis.resolved)

        collected.push({
          batch,
          result,
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
  // ── Hero audit complete ──────────────────────────────────
  // Replaces onBetaComplete (v1.0.2). Two jobs, in this order:
  //   1. WRITE the confirmed heroes into the in-memory result, so saveMatch
  //      stores what the user said rather than what the matcher guessed.
  //      Until this existed, hero_id was the one confirmation field logged but
  //      never written back — 11 corrections were made during the beta, all 11
  //      matched ground truth, and all 11 were discarded on save.
  //   2. LOG every slot, confirmed and corrected alike. The confirmed ones are
  //      the negative examples; without them no error rate is computable.
  async function onAuditComplete(audit: HeroAuditResult) {
    const item = reviewItems[reviewIndex]
    if (!item) return
    const { batch, result } = item
    const format = (result.matchFormat || batch.metadata.match_format || '5v5') as '5v5' | '6v6'

    setReviewStep('saving')
    setReviewError(null)

    // ---- 1. write-back ----
    // heroName lives on FOUR arrays inside ScoreboardResult. saveMatch reads
    // hero_name/role from `stats` and is_user from `players`, but the others
    // feed downstream checks, so all four move together — a partial update
    // would leave the result internally inconsistent.
    if (result.scoreboard) {
      const sb = result.scoreboard
      for (const row of audit.rows) {
        if (!row.confirmedHero || row.confirmedHero === row.readHero) continue
        const hero = HEROES.find(h => h.name === row.confirmedHero)
        if (!hero) {
          console.warn(`[audit] skipped unknown hero "${row.confirmedHero}" at slot ${row.slot}`)
          continue
        }
        // Role is RE-DERIVED, never carried: a wrong hero drags a wrong role
        // with it, so correcting one without the other relocates the error.
        for (const st of sb.stats) if (st.slot === row.slot) { st.heroName = hero.name; st.role = hero.role }
        for (const h of sb.heroes) if (h.slot === row.slot) { h.heroName = hero.name }
        for (const r of sb.roles) if (r.slot === row.slot) { r.heroName = hero.name; r.role = hero.role; r.source = 'hero_lookup' }
        for (const pl of sb.players) if (pl.slot === row.slot) { pl.heroName = hero.name }
        // The match-level role follows the user's row; finalRole in saveMatch
        // reads correctedRole first, so a stale value would contradict the
        // scoreboard we just corrected.
        if (row.isUser) result.correctedRole = hero.role
        console.log(`[audit] slot ${row.slot}: ${row.readHero} -> ${hero.name} (${hero.role})`)
      }
    }

    // ---- 2. logging ----
    // Best-effort: a logging failure must never block the save.
    try {
      await logHeroAudit({
        matchId: batch.batchId,
        format,
        reviewSeconds: audit.reviewSeconds,
        rows: audit.rows.map(r => ({
          slot: r.slot,
          team: r.team,
          role: r.role,
          isUser: r.isUser,
          readHero: r.readHero,
          confirmedHero: r.confirmedHero,
          corrected: r.verdict === 'corrected',
          bulk: r.bulk,
          score: r.score,
          margin: r.margin,
          runnerUp: r.runnerUp,
          orbApplied: r.orbApplied,
        })),
      })
      // autoPassFields is 0 in the audit era, deliberately. "Auto-pass" meant a
      // field the user was never shown; now every slot is shown, so nothing
      // auto-passes. Leaving it as (rows - corrected) would DOUBLE-COUNT against
      // the confirmed_correct rows already written per slot, and the issue-log
      // page's error rate would read as roughly half its true value.
      // questionsAsked is every slot presented, which is the denominator.
      await logMatchSummary({
        matchId: batch.batchId,
        format,
        questionsAsked: audit.rows.length,
        autoPassFields: 0,
      })
    } catch (err) {
      console.warn('[audit] logging failed (continuing to save):', err)
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
      // Step 3a: log the hard date failure as a background event so it's tracked
      // rather than silently swallowed. 'unparseable' if some text was read but
      // didn't parse; 'missing' if nothing was read at all. Best-effort (fire-
      // and-forget): a logging failure must never block the save.
      // logDateOcrFailure removed with beta confirmation (v1.0.2): the issue
      // log now records hero identification only.
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
        is_alpha: isAlpha,
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
        <div className="bg-ow-panel rounded-lg p-12 text-center border border-ow-line">
          <div className="w-8 h-8 border-2 border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-ow-muted font-display tracking-wider">CHECKING FOR UPLOADS…</p>
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
          <h1 className="font-display text-3xl tracking-[0.12em] text-ow-fg uppercase">Processing</h1>
          <p className="text-sm text-ow-muted mt-1">
            Working through {procTotal} match{procTotal !== 1 ? 'es' : ''} — no input needed until review.
          </p>
        </div>

        <div className="bg-ow-panel rounded-lg p-10 text-center border border-ow-line">
          <p className="text-ow-orange font-display font-bold text-sm tracking-wider mb-4">
            MATCH {Math.min(procDone + 1, procTotal)} / {procTotal}
            {procCurrentLabel && <span className="text-ow-muted font-normal"> · {procCurrentLabel}</span>}
          </p>
          <div className="w-12 h-12 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <p className="text-ow-fg font-display text-lg">{message}</p>

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
          <p className="text-xs text-ow-faint mt-2 font-display tracking-wider">
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

    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-[0.12em] text-ow-fg uppercase">Review</h1>
            <p className="text-sm text-ow-muted mt-1">
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
        <div className="bg-ow-panel rounded-lg border border-ow-line px-5 py-4 flex items-center gap-3 flex-wrap">
          {item.result.matchFormat && (
            <span className="text-[10px] font-display font-bold px-2 py-0.5 rounded bg-ow-orange/10 text-ow-orange tracking-wider">
              {item.result.matchFormat.toUpperCase()}
            </span>
          )}
          <span className="text-ow-fg font-display">{item.result.mapName || 'Unknown map'}</span>
          {item.result.result && (
            <span className={`font-display font-bold text-sm ${
              item.result.result === 'victory' ? 'text-ow-victory'
              : item.result.result === 'defeat' ? 'text-ow-defeat' : 'text-ow-draw'
            }`}>{item.result.result.toUpperCase()}</span>
          )}
          {item.result.score && <span className="text-ow-muted text-sm font-display">{item.result.score}</span>}
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
              <p className="text-ow-muted text-xs mb-5">
                OCR wasn&apos;t confident enough to auto-identify your player
                ({(analysis.bestCandidate.similarity * 100).toFixed(0)}% similarity,
                {' '}{(analysis.bestCandidate.margin * 100).toFixed(0)}% margin).
              </p>
              <div className="flex items-center gap-4 bg-ow-dark rounded-lg p-4 mb-5 border border-ow-line">
                {bestCandidate.heroPortraitUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={bestCandidate.heroPortraitUrl} alt="" className="w-14 h-14 rounded border border-ow-line" />
                )}
                <div className="flex-1 min-w-0">
                  {bestCandidate.gamertagCropUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={bestCandidate.gamertagCropUrl} alt="" className="h-8 rounded mb-1" style={{ imageRendering: 'auto' }} />
                  )}
                  <p className="text-xs text-ow-faint">
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
                  className="bg-ow-panel border border-ow-line text-ow-fg font-display px-5 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
                  NO, SHOW ALL
                </button>
                <button onClick={handleSkipConfirm}
                  className="text-ow-faint hover:text-ow-muted font-display px-4 py-2.5 text-sm tracking-wider transition-colors">
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
            <p className="text-ow-muted text-xs mb-5">Select your player from the ally team.</p>
            <div className="space-y-2">
              {analysis.candidates.map(candidate => (
                <button key={candidate.slot} onClick={() => handleSelectUser(candidate.slot)}
                  className="w-full flex items-center gap-4 bg-ow-dark hover:bg-ow-dark/80 rounded-lg p-3 transition-colors text-left border border-ow-line hover:border-ow-orange/30">
                  {candidate.heroPortraitUrl && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={candidate.heroPortraitUrl} alt="" className="w-12 h-12 rounded border border-ow-line flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    {candidate.gamertagCropUrl && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={candidate.gamertagCropUrl} alt="" className="h-7 rounded mb-1" style={{ imageRendering: 'auto' }} />
                    )}
                    <p className="text-xs text-ow-faint">Slot {candidate.slot} · {candidate.heroName || 'Unknown hero'}</p>
                  </div>
                  <span className="text-xs font-mono text-ow-faint">{(candidate.ocrSimilarity * 100).toFixed(0)}%</span>
                </button>
              ))}
            </div>
            <button onClick={handleSkipConfirm}
              className="mt-4 text-ow-faint hover:text-ow-muted font-display text-sm tracking-wider transition-colors">
              SKIP — SAVE WITHOUT USER ID
            </button>
          </div>
        )}

        {/* sub-step: hero audit (replaces 6f beta quick check) */}
        {reviewStep === 'beta' && (
          <div className="space-y-4">
            <div>
              <h2 className="font-display text-xl text-ow-orange tracking-wider">Check the heroes</h2>
              <p className="text-sm text-ow-muted mt-1">
                Confirm every row against the scoreboard before saving.
              </p>
            </div>
            {sb ? (
              <HeroAuditPanel
                heroes={sb.heroes}
                stats={sb.stats}
                heroesPlayed={item.result.heroes.map(h => h.name)}
                knownHeroes={HEROES.map(h => ({ name: h.name, role: h.role }))}
                scoreboardImageUrl={liveImages.scoreboard}
                onComplete={onAuditComplete}
              />
            ) : (
              // Leaver games legitimately have no scoreboard, so there is
              // nothing to audit — save straight through.
              <>
                <div className="bg-ow-panel border border-ow-line rounded-lg p-4 text-sm text-ow-muted">
                  No scoreboard for this match (leaver game) — nothing to check.
                </div>
                <button
                  onClick={() => onAuditComplete({ rows: [], correctedSlots: [], bulkConfirmedSlots: [], reviewSeconds: 0 })}
                  className="w-full bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold
                             py-3 rounded-lg tracking-wider transition-colors text-sm">
                  SAVE MATCH
                </button>
              </>
            )}
          </div>
        )}

        {/* sub-step: saving */}
        {reviewStep === 'saving' && (
          <div className="bg-ow-panel rounded-lg p-10 text-center border border-ow-line">
            <div className="w-10 h-10 border-[3px] border-ow-orange border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-ow-fg font-display tracking-wider">SAVING…</p>
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
            <p className="text-xs text-ow-muted">
              These batches couldn&apos;t be processed and their screenshots are still
              in storage. They&apos;ve been noted in the issue log. Try them again from here.
            </p>
            <div className="space-y-2">
              {failures.map(f => (
                <div key={f.batchId} className="bg-ow-dark rounded-lg px-4 py-3 border border-ow-line">
                  <p className="text-xs text-ow-muted font-display">
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
            className="bg-ow-panel border border-ow-line text-ow-fg font-display px-6 py-2.5 rounded-lg tracking-wider text-sm hover:border-ow-orange/30 transition-colors">
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
        <h1 className="font-display text-3xl tracking-[0.12em] text-ow-fg uppercase">Process Matches</h1>
        <p className="text-sm text-ow-muted mt-1">
          Automatically extract data from uploaded match photos
        </p>
      </div>

      {batches.length === 0 ? (
        <div className="bg-ow-panel rounded-lg p-12 text-center border border-ow-line">
          <span className="text-4xl block mb-3">📷</span>
          <p className="text-ow-muted font-display text-lg tracking-wider">NO PENDING UPLOADS</p>
          <p className="text-ow-faint text-sm mt-2">
            Upload match photos from your phone to see them here
          </p>
          <button onClick={scanForBatches}
            className="mt-5 text-sm text-ow-faint hover:text-ow-muted font-display tracking-wider transition-colors">
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
              <p className="text-ow-muted text-xs mt-0.5">
                Process all unattended, then review them together — or pick a few.
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              {selectedBatchIds.size > 0 && (
                <button onClick={processSelected}
                  className="bg-ow-panel border border-ow-line text-ow-fg font-display px-4 py-2 rounded-lg tracking-wider text-xs hover:border-ow-orange/30 transition-colors whitespace-nowrap">
                  PROCESS {selectedBatchIds.size} SELECTED
                </button>
              )}
              <button onClick={processAllBatches}
                className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold px-4 py-2 rounded-lg tracking-wider text-xs transition-colors whitespace-nowrap">
                PROCESS ALL
              </button>
            </div>
          </div>

          {/* Alpha / test-data status + manual override.
              Shows what is_alpha will be for matches saved right now, and why. */}
          <div className={`rounded-lg border px-5 py-3 flex items-center justify-between gap-3 flex-wrap ${
            isAlpha ? 'border-amber-500/40 bg-amber-500/5' : 'border-emerald-500/30 bg-emerald-500/5'
          }`}>
            <div className="min-w-0">
              <p className={`font-display font-bold tracking-wider text-sm ${
                isAlpha ? 'text-amber-400' : 'text-emerald-400'
              }`}>
                {isAlpha ? '⚠ SAVING AS TEST DATA' : '● SAVING AS REAL DATA'}
              </p>
              <p className="text-ow-muted text-xs mt-0.5">
                {alphaOverride !== null
                  ? 'Manual override active.'
                  : isLocalhost
                    ? 'Running on localhost — matches won’t count in analytics.'
                    : 'Running on the live site — matches count in analytics.'}
              </p>
            </div>
            {/* Manual override is LOCALHOST-ONLY. On the live site these buttons
                don't render at all — live always saves as real (is_alpha=false),
                so a real match can't be hand-flagged as test and disappear. */}
            {isLocalhost && (
              <div className="flex gap-2 flex-wrap shrink-0">
                <button
                  onClick={() => setAlphaOverride(isAlpha ? false : true)}
                  className="bg-ow-panel border border-ow-line text-ow-fg font-display px-3 py-1.5 rounded-lg tracking-wider text-xs hover:border-ow-orange/40 transition-colors whitespace-nowrap">
                  {isAlpha ? 'MARK AS REAL' : 'MARK AS TEST'}
                </button>
                {alphaOverride !== null && (
                  <button
                    onClick={() => setAlphaOverride(null)}
                    className="text-xs text-ow-faint hover:text-ow-muted font-display tracking-wider transition-colors whitespace-nowrap">
                    RESET TO AUTO
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 px-1">
            <button
              onClick={selectedBatchIds.size === batches.length ? deselectAllBatches : selectAllBatches}
              className="text-xs text-ow-faint hover:text-ow-muted font-display tracking-wider transition-colors">
              {selectedBatchIds.size === batches.length ? '✓ DESELECT ALL' : '☐ SELECT ALL'}
            </button>
            {selectedBatchIds.size > 0 && selectedBatchIds.size < batches.length && (
              <span className="text-xs text-ow-faint font-display">{selectedBatchIds.size} selected</span>
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
                  isSelected ? 'border-ow-orange/40 bg-ow-orange/5' : 'border-ow-line hover:border-ow-orange/20'
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
                            {format && <span className="text-ow-faint">•</span>}
                            <span className="text-ow-fg font-display">{roles}</span>
                          </>
                        )}
                        {!format && !roles && <span className="text-ow-faint font-display">NO METADATA</span>}
                        <span className="text-ow-faint">•</span>
                        <span className="text-ow-muted">
                          {batch.metadata.photo_count} photo{batch.metadata.photo_count !== 1 ? 's' : ''}
                        </span>
                        <span className="text-ow-faint">•</span>
                        <span className="text-ow-faint text-xs">{new Date(batch.metadata.uploaded_at).toLocaleString()}</span>
                      </div>
                      <div className="flex gap-2 mt-2">
                        {batch.photoUrls.slice(0, 4).map((url, i) => (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img key={i} src={url} alt="" className="w-16 h-12 object-cover rounded" />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); startProcessing([batch]) }}
                      className="bg-ow-orange hover:bg-ow-accent text-ow-dark font-display font-bold px-5 py-2.5 rounded-lg tracking-wider text-sm transition-colors whitespace-nowrap">
                      PROCESS
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setBatchPendingDelete(batch) }}
                      aria-label="Delete this upload"
                      title="Delete this upload"
                      className="w-9 h-9 flex items-center justify-center rounded-lg border border-ow-line text-ow-faint hover:text-ow-defeat hover:border-ow-defeat/40 transition-colors">
                      {/* trash icon */}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )
          })}

          <button onClick={scanForBatches}
            className="text-sm text-ow-faint hover:text-ow-muted font-display tracking-wider transition-colors">
            ↻ REFRESH
          </button>
        </div>
      )}

      {/* Delete-confirmation modal (dimmed backdrop, centered card). Discards a
          pending upload from Storage — does NOT touch the database. */}
      {batchPendingDelete && (
        <div
          onClick={() => { if (!deletingBatch) setBatchPendingDelete(null) }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-ow-panel border border-ow-line rounded-xl p-6 max-w-sm w-full space-y-4 shadow-xl"
          >
            <div className="space-y-1">
              <h2 className="text-ow-fg font-display font-bold tracking-wider">Delete this upload?</h2>
              <p className="text-sm text-ow-muted">
                This permanently removes the {batchPendingDelete.metadata.photo_count} photo
                {batchPendingDelete.metadata.photo_count !== 1 ? 's' : ''} in this upload from
                storage. It hasn’t been saved to your match history, and this can’t be undone.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setBatchPendingDelete(null)}
                disabled={deletingBatch}
                className="bg-ow-dark border border-ow-line text-ow-muted font-display tracking-wider text-xs px-4 py-2 rounded-lg hover:border-ow-orange/30 transition-colors disabled:opacity-50">
                CANCEL
              </button>
              <button
                onClick={() => deletePendingBatch(batchPendingDelete)}
                disabled={deletingBatch}
                className="bg-ow-defeat/90 hover:bg-ow-defeat text-white font-display font-bold tracking-wider text-xs px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
                {deletingBatch ? 'DELETING…' : 'DELETE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
