'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { formatBritishDate } from '@/lib/date-format'

// ============================================================
// SETTINGS + SEASON MANAGEMENT (Phase 2)
//
// - Gamertag (display/scoreboard ID) — kept
// - Default role — REMOVED (user plays all roles)
// - Change password (Supabase auth.updateUser) — NEW
// - Season Management — NEW:
//     create / edit seasons (name + start + end date)
//     delete ONLY if no matches fall in that season
//     date ranges may not overlap (validated before save)
//
// `seasons` table confirmed: id(bigint), name(text), start_date(date),
// end_date(date), created_at. No migration needed.
// ============================================================

interface Season {
  id: number
  name: string
  start_date: string // YYYY-MM-DD
  end_date: string
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
      .select('id, name, start_date, end_date')
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
      await supabase.from('seasons').insert({ name: name.trim(), start_date, end_date })
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
        <h1 className="font-display text-3xl tracking-[0.12em] text-slate-100 uppercase">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">Profile, security &amp; seasons</p>
      </div>

      {/* ---------- PROFILE ---------- */}
      <section className="bg-ow-panel rounded-xl p-6 border border-white/5 space-y-4">
        <h2 className="font-display text-lg tracking-wider text-white uppercase">Profile</h2>
        <div>
          <label className="block text-xs font-display tracking-[0.15em] text-slate-400 uppercase mb-2">Gamertag</label>
          <input type="text" value={gamertag} onChange={e => setGamertag(e.target.value)}
            placeholder="Your in-game name"
            className="w-full bg-ow-dark border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-600 focus:border-ow-orange/50 focus:outline-none transition-colors" />
          <p className="text-xs text-slate-600 mt-1">Used for scoreboard identification during processing.</p>
        </div>
        <button onClick={saveProfile} disabled={savingProfile}
          className="w-full bg-ow-orange hover:bg-ow-accent disabled:bg-slate-700 text-ow-dark font-display font-bold py-2.5 rounded-lg tracking-wider transition-colors text-sm">
          {savingProfile ? 'SAVING…' : profileSaved ? '✓ SAVED' : 'SAVE PROFILE'}
        </button>
      </section>

      {/* ---------- SECURITY ---------- */}
      <section className="bg-ow-panel rounded-xl p-6 border border-white/5 space-y-4">
        <h2 className="font-display text-lg tracking-wider text-white uppercase">Change Password</h2>
        <div className="space-y-3">
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
            placeholder="New password" autoComplete="new-password"
            className="w-full bg-ow-dark border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-600 focus:border-ow-orange/50 focus:outline-none transition-colors" />
          <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password" autoComplete="new-password"
            onKeyDown={e => e.key === 'Enter' && changePassword()}
            className="w-full bg-ow-dark border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-600 focus:border-ow-orange/50 focus:outline-none transition-colors" />
        </div>
        {pwMsg && <p className={`text-xs ${pwStatus === 'error' ? 'text-ow-defeat' : 'text-ow-victory'}`}>{pwMsg}</p>}
        <button onClick={changePassword} disabled={pwStatus === 'saving' || !newPassword || !confirmPassword}
          className="w-full bg-ow-panel border border-white/15 hover:border-ow-orange/40 disabled:opacity-40 text-white font-display font-bold py-2.5 rounded-lg tracking-wider transition-colors text-sm">
          {pwStatus === 'saving' ? 'UPDATING…' : 'UPDATE PASSWORD'}
        </button>
      </section>

      {/* ---------- SEASON MANAGEMENT ---------- */}
      <section className="bg-ow-panel rounded-xl p-6 border border-white/5 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg tracking-wider text-white uppercase">Seasons</h2>
          <span className="text-xs text-slate-500">{seasons.length} total</span>
        </div>
        <p className="text-xs text-slate-500 -mt-2">
          Matches auto-assign to a season by their real played date. Ranges can't overlap.
        </p>

        {/* existing seasons */}
        <div className="space-y-2">
          {seasons.length === 0 && (
            <p className="text-sm text-slate-600">No seasons yet — add your first one below.</p>
          )}
          {seasons.map(s => {
            const count = seasonCounts[s.id] || 0
            const isCurrent = s.start_date <= today && today <= s.end_date
            return (
              <div key={s.id} className="bg-ow-dark/60 rounded-lg p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-display text-white tracking-wider truncate">{s.name}</p>
                    {isCurrent && <span className="text-[10px] bg-ow-orange text-ow-dark font-bold px-1.5 py-0.5 rounded font-display tracking-wider">CURRENT</span>}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {formatBritishDate(s.start_date)} – {formatBritishDate(s.end_date)} · {count} match{count !== 1 ? 'es' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => startEdit(s)}
                    className="text-xs font-display tracking-wider text-slate-400 hover:text-ow-orange transition-colors">EDIT</button>
                  <button onClick={() => deleteSeason(s)}
                    disabled={count > 0}
                    title={count > 0 ? 'Has matches — cannot delete' : 'Delete season'}
                    className="text-xs font-display tracking-wider text-slate-500 hover:text-ow-defeat disabled:opacity-30 disabled:hover:text-slate-500 transition-colors">DELETE</button>
                </div>
              </div>
            )
          })}
        </div>

        {/* create / edit form */}
        <div className="border-t border-white/5 pt-4 space-y-3">
          <p className="text-xs font-display tracking-[0.15em] text-slate-400 uppercase">
            {editing ? `Edit: ${editing.name}` : 'Add a season'}
          </p>
          <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="Season name (e.g. Season 3)"
            className="w-full bg-ow-dark border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-slate-600 focus:border-ow-orange/50 focus:outline-none transition-colors" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-slate-500 font-display tracking-wider uppercase mb-1">Start date</label>
              <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })}
                className="w-full bg-ow-dark border border-white/10 rounded-lg px-3 py-2.5 text-white focus:border-ow-orange/50 focus:outline-none transition-colors [color-scheme:dark]" />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 font-display tracking-wider uppercase mb-1">End date</label>
              <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })}
                className="w-full bg-ow-dark border border-white/10 rounded-lg px-3 py-2.5 text-white focus:border-ow-orange/50 focus:outline-none transition-colors [color-scheme:dark]" />
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
                className="px-5 bg-ow-dark border border-white/10 text-slate-300 hover:text-white font-display font-bold py-2.5 rounded-lg tracking-wider transition-colors text-sm">
                CANCEL
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
