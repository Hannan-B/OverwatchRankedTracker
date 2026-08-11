'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { formatBritishDate } from '@/lib/date-format'
import AlphaToggle from '@/components/AlphaToggle'
import ExcludedGames from '@/components/ExcludedGames'
import ThemeControl from '@/components/ThemeControl'
import { CURRENT_QUESTION_SCALE, QUESTION_SCALE_LABELS } from '@/data/reference'

// ============================================================
// SETTINGS + SEASON MANAGEMENT (Phase 2)
//
// - Gamertag (display/scoreboard ID) — kept
// - Default role — REMOVED (user plays all roles)
// - Change password (Supabase auth.updateUser) — NEW
// - Excluded games — three switches (v1.1.0), replacing the single leaver
//   toggle: permanent leavers, returned leavers, throwers
// - Season Management — NEW:
//     create / edit seasons (name + start + end date)
//     delete ONLY if no matches fall in that season
//     date ranges may not overlap (validated before save)
//
// `seasons` table confirmed: id(bigint), name(text), start_date(date),
// end_date(date), created_at.
//
// (v1.1.0) `question_scale_version` (smallint, NOT NULL, default 1) added.
// Which post-match question set a season was played under. NEW seasons are
// stamped with CURRENT_QUESTION_SCALE from reference.ts automatically -- this
// used to be a manual SQL step, and a manual step performed once every few
// months is one you eventually forget. EDITING a season deliberately does NOT
// restamp it: the questions a season was played under are a historical fact,
// not a setting. Changing one is a deliberate SQL act.
// ============================================================

interface Season {
  id: number
  name: string
  start_date: string // YYYY-MM-DD
  end_date: string
  question_scale_version: number
}

// inclusive overlap test for two date ranges
function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string) {
  return aStart <= bEnd && bStart <= aEnd
}

export default function SettingsPage() {
  // ---- profile ----
  const [gamertag, setGamertag] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)

  // ---- password ----
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwStatus, setPwStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle')
  const [pwMsg, setPwMsg] = useState('')

  // ---- seasons ----
  const [seasons, setSeasons] = useState<Season[]>([])
  const [seasonCounts, setSeasonCounts] = useState<Record<number, number>>({})
  const [editing, setEditing] = useState<Season | null>(null)
  const [form, setForm] = useState({ name: '', start_date: '', end_date: '' })
  const [seasonErr, setSeasonErr] = useState('')
  const [seasonBusy, setSeasonBusy] = useState(false)

  // ---------- load ----------
  const loadProfile = useCallback(async () => {
    const { data } = await supabase.from('user_settings').select('*').limit(1).single()
    if (data) setGamertag(data.gamertag || '')
  }, [])

  const loadSeasons = useCallback(async () => {
    const { data } = await supabase
      .from('seasons')
      .select('id, name, start_date, end_date, question_scale_version')
      .order('start_date', { ascending: false })
    const list = (data as Season[]) || []
    setSeasons(list)

    // count matches per season (to guard deletes)
    const { data: matchRows } = await supabase.from('matches').select('season_id')
    const counts: Record<number, number> = {}
    ;(matchRows as { season_id: number | null }[] | null)?.forEach(m => {
      if (m.season_id != null) counts[m.season_id] = (counts[m.season_id] || 0) + 1
    })
    setSeasonCounts(counts)
  }, [])

  useEffect(() => { loadProfile(); loadSeasons() }, [loadProfile, loadSeasons])

  // ---------- profile save ----------
  async function saveProfile() {
    setSavingProfile(true); setProfileSaved(false)
    const { data: existing } = await supabase.from('user_settings').select('id').limit(1).single()
    if (existing) {
      await supabase.from('user_settings').update({ gamertag: gamertag || null }).eq('id', existing.id)
    } else {
      await supabase.from('user_settings').insert({ gamertag: gamertag || null })
    }
    setSavingProfile(false); setProfileSaved(true)
    setTimeout(() => setProfileSaved(false), 2000)
  }

  // ---------- change password ----------
  async function changePassword() {
    setPwMsg('')
    if (newPassword.length < 8) { setPwStatus('error'); setPwMsg('Password must be at least 8 characters.'); return }
    if (newPassword !== confirmPassword) { setPwStatus('error'); setPwMsg('Passwords do not match.'); return }
    setPwStatus('saving')
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) { setPwStatus('error'); setPwMsg(error.message) }
    else {
      setPwStatus('done'); setPwMsg('Password updated.')
      setNewPassword(''); setConfirmPassword('')
      setTimeout(() => { setPwStatus('idle'); setPwMsg('') }, 2500)
    }
  }

  // ---------- season form ----------
  function startNew() {
    setEditing(null)
    setForm({ name: '', start_date: '', end_date: '' })
    setSeasonErr('')
  }
  function startEdit(s: Season) {
    setEditing(s)
    setForm({ name: s.name, start_date: s.start_date, end_date: s.end_date })
    setSeasonErr('')
  }

  async function saveSeason() {
    setSeasonErr('')
    const { name, start_date, end_date } = form
    if (!name.trim() || !start_date || !end_date) { setSeasonErr('Name, start date and end date are all required.'); return }
    if (start_date > end_date) { setSeasonErr('Start date must be on or before the end date.'); return }

    // overlap check against all OTHER seasons
    const clash = seasons.find(s =>
      s.id !== editing?.id && rangesOverlap(start_date, end_date, s.start_date, s.end_date))
    if (clash) { setSeasonErr(`Dates overlap with "${clash.name}" (${formatBritishDate(clash.start_date)} – ${formatBritishDate(clash.end_date)}).`); return }

    setSeasonBusy(true)
    if (editing) {
      await supabase.from('seasons').update({ name: name.trim(), start_date, end_date }).eq('id', editing.id)
    } else {
      await supabase.from('seasons').insert({
        name: name.trim(), start_date, end_date,
        question_scale_version: CURRENT_QUESTION_SCALE,
      })
    }
    setSeasonBusy(false)
    startNew()
    loadSeasons()
  }

  async function deleteSeason(s: Season) {
    const count = seasonCounts[s.id] || 0
    if (count > 0) {
      setSeasonErr(`Can't delete "${s.name}" — ${count} match${count !== 1 ? 'es' : ''} fall in this season.`)
      return
    }
    if (!confirm(`Delete season "${s.name}"? This cannot be undone.`)) return
    setSeasonBusy(true)
    await supabase.from('seasons').delete().eq('id', s.id)
    setSeasonBusy(false)
    if (editing?.id === s.id) startNew()
    loadSeasons()
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="font-display text-3xl tracking-[0.12em] text-ow-fg uppercase">Settings</h1>
        <p className="text-sm text-ow-faint mt-1">Profile, security &amp; seasons</p>
      </div>

      {/* ---------- PROFILE ---------- */}
      <section className="bg-ow-panel rounded-xl p-6 border border-ow-line space-y-4">
        <h2 className="font-display text-lg tracking-wider text-ow-fg uppercase">Profile</h2>
        <div>
          <label className="block text-xs font-display tracking-[0.15em] text-ow-muted uppercase mb-2">Gamertag</label>
          <input type="text" value={gamertag} onChange={e => setGamertag(e.target.value)}
            placeholder="Your in-game name"
            className="w-full bg-ow-dark border border-ow-line rounded-lg px-4 py-2.5 text-ow-fg placeholder-ow-faint focus:border-ow-orange/50 focus:outline-none transition-colors" />
          <p className="text-xs text-ow-faint mt-1">Used for scoreboard identification during processing.</p>
        </div>
        <button onClick={saveProfile} disabled={savingProfile}
          className="w-full bg-ow-orange hover:bg-ow-accent disabled:bg-slate-700 text-ow-dark font-display font-bold py-2.5 rounded-lg tracking-wider transition-colors text-sm">
          {savingProfile ? 'SAVING…' : profileSaved ? '✓ SAVED' : 'SAVE PROFILE'}
        </button>
      </section>

      {/* ---------- APPEARANCE ---------- */}
      <section className="bg-ow-panel rounded-xl p-6 border border-ow-line space-y-4">
        <h2 className="font-display text-lg tracking-wider text-ow-fg uppercase">Appearance</h2>
        <ThemeControl />
      </section>

      {/* ---------- SECURITY ---------- */}
      <section className="bg-ow-panel rounded-xl p-6 border border-ow-line space-y-4">
        <h2 className="font-display text-lg tracking-wider text-ow-fg uppercase">Change Password</h2>
        <div className="space-y-3">
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
            placeholder="New password" autoComplete="new-password"
            className="w-full bg-ow-dark border border-ow-line rounded-lg px-4 py-2.5 text-ow-fg placeholder-ow-faint focus:border-ow-orange/50 focus:outline-none transition-colors" />
          <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password" autoComplete="new-password"
            onKeyDown={e => e.key === 'Enter' && changePassword()}
            className="w-full bg-ow-dark border border-ow-line rounded-lg px-4 py-2.5 text-ow-fg placeholder-ow-faint focus:border-ow-orange/50 focus:outline-none transition-colors" />
        </div>
        {pwMsg && <p className={`text-xs ${pwStatus === 'error' ? 'text-ow-defeat' : 'text-ow-victory'}`}>{pwMsg}</p>}
        <button onClick={changePassword} disabled={pwStatus === 'saving' || !newPassword || !confirmPassword}
          className="w-full bg-ow-panel border border-ow-line hover:border-ow-orange/40 disabled:opacity-40 text-ow-fg font-display font-bold py-2.5 rounded-lg tracking-wider transition-colors text-sm">
          {pwStatus === 'saving' ? 'UPDATING…' : 'UPDATE PASSWORD'}
        </button>
      </section>

      {/* ---------- SEASON MANAGEMENT ---------- */}
      <section className="bg-ow-panel rounded-xl p-6 border border-ow-line space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg tracking-wider text-ow-fg uppercase">Seasons</h2>
          <span className="text-xs text-ow-faint">{seasons.length} total</span>
        </div>
        <p className="text-xs text-ow-faint -mt-2">
          Matches auto-assign to a season by their real played date. Ranges can't overlap.
          New seasons are saved with question set <span className="text-ow-muted">Q{CURRENT_QUESTION_SCALE}</span>.
        </p>

        {/* existing seasons */}
        <div className="space-y-2">
          {seasons.length === 0 && (
            <p className="text-sm text-ow-faint">No seasons yet — add your first one below.</p>
          )}
          {seasons.map(s => {
            const count = seasonCounts[s.id] || 0
            const isCurrent = s.start_date <= today && today <= s.end_date
            const scale = s.question_scale_version ?? 1
            // The safeguard: if the season you are ACTIVELY PLAYING was stamped
            // with a different question set than the app now writes, the Feel
            // page will look empty -- it reads the columns for the season's
            // scale while uploads fill the columns for the current one. Nothing
            // is lost, but it looks broken. Surface it here rather than let it
            // be discovered weeks later.
            const scaleMismatch = isCurrent && scale !== CURRENT_QUESTION_SCALE
            return (
              <div key={s.id} className="bg-ow-dark/60 rounded-lg p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-display text-ow-fg tracking-wider truncate">{s.name}</p>
                    {isCurrent && <span className="text-[10px] bg-ow-orange text-ow-dark font-bold px-1.5 py-0.5 rounded font-display tracking-wider">CURRENT</span>}
                    <span
                      title={QUESTION_SCALE_LABELS[scale] ?? `Unknown question scale (${scale})`}
                      className={`text-[10px] font-display tracking-wider px-1.5 py-0.5 rounded border ${
                        scaleMismatch
                          ? 'border-ow-defeat/60 text-ow-defeat'
                          : 'border-ow-line text-ow-faint'
                      }`}>
                      Q{scale}
                    </span>
                  </div>
                  <p className="text-xs text-ow-faint mt-0.5">
                    {formatBritishDate(s.start_date)} – {formatBritishDate(s.end_date)} · {count} match{count !== 1 ? 'es' : ''}
                  </p>
                  {scaleMismatch && (
                    <p className="text-[11px] text-ow-defeat mt-1">
                      This season uses question set Q{scale}, but new matches are saved as
                      Q{CURRENT_QUESTION_SCALE}. Feel analytics will look empty until this is corrected.
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => startEdit(s)}
                    className="text-xs font-display tracking-wider text-ow-muted hover:text-ow-orange transition-colors">EDIT</button>
                  <button onClick={() => deleteSeason(s)}
                    disabled={count > 0}
                    title={count > 0 ? 'Has matches — cannot delete' : 'Delete season'}
                    className="text-xs font-display tracking-wider text-ow-faint hover:text-ow-defeat disabled:opacity-30 disabled:hover:text-ow-faint transition-colors">DELETE</button>
                </div>
              </div>
            )
          })}
        </div>

        {/* create / edit form */}
        <div className="border-t border-ow-line pt-4 space-y-3">
          <p className="text-xs font-display tracking-[0.15em] text-ow-muted uppercase">
            {editing ? `Edit: ${editing.name}` : 'Add a season'}
          </p>
          <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="Season name (e.g. Season 3)"
            className="w-full bg-ow-dark border border-ow-line rounded-lg px-4 py-2.5 text-ow-fg placeholder-ow-faint focus:border-ow-orange/50 focus:outline-none transition-colors" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-ow-faint font-display tracking-wider uppercase mb-1">Start date</label>
              <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })}
                className="w-full bg-ow-dark border border-ow-line rounded-lg px-3 py-2.5 text-ow-fg focus:border-ow-orange/50 focus:outline-none transition-colors [color-scheme:dark]" />
            </div>
            <div>
              <label className="block text-[11px] text-ow-faint font-display tracking-wider uppercase mb-1">End date</label>
              <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })}
                className="w-full bg-ow-dark border border-ow-line rounded-lg px-3 py-2.5 text-ow-fg focus:border-ow-orange/50 focus:outline-none transition-colors [color-scheme:dark]" />
            </div>
          </div>
          {seasonErr && <p className="text-xs text-ow-defeat">{seasonErr}</p>}
          <div className="flex gap-2">
            <button onClick={saveSeason} disabled={seasonBusy}
              className="flex-1 bg-ow-orange hover:bg-ow-accent disabled:bg-slate-700 text-ow-dark font-display font-bold py-2.5 rounded-lg tracking-wider transition-colors text-sm">
              {seasonBusy ? 'SAVING…' : editing ? 'SAVE CHANGES' : 'ADD SEASON'}
            </button>
            {editing && (
              <button onClick={startNew}
                className="px-5 bg-ow-dark border border-ow-line text-ow-muted hover:text-ow-fg font-display font-bold py-2.5 rounded-lg tracking-wider transition-colors text-sm">
                CANCEL
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ---------- EXCLUDED GAMES (leavers x2 + throwers) ---------- */}
      <ExcludedGames />

      {/* ---------- DEV: ALPHA DATA VISIBILITY (localhost only) ---------- */}
      <AlphaToggle />
    </div>
  )
}
