'use client'

import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

// AuthGate wraps the whole app.
//   - While we check for an existing session: a quiet loading state.
//   - Logged OUT: the email + password login screen.
//   - Logged IN: your app (children) renders normally.
//
// IMPORTANT (Step 1 / Option A): this gate controls what you SEE. The
// database itself is still open at this stage — we lock that down in Step 2
// only after confirming login works. So nothing your app does can break here.

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setChecking(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => sub.subscription.unsubscribe()
  }, [])

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-ow-dark">
        <p className="font-display tracking-[0.3em] text-slate-500 text-sm uppercase animate-pulse">
          Loading
        </p>
      </div>
    )
  }

  if (!session) {
    return <LoginScreen />
  }

  return <>{children}</>
}

function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  async function signIn() {
    const e = email.trim()
    if (!e || !password) return
    setStatus('working')
    setErrorMsg('')

    const { error } = await supabase.auth.signInWithPassword({
      email: e,
      password,
    })

    if (error) {
      setStatus('error')
      // Keep the message friendly and non-specific (don't reveal whether the
      // email exists — good practice even for a single-user app).
      setErrorMsg('Incorrect email or password.')
    }
    // On success, onAuthStateChange in AuthGate swaps to the app automatically.
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ow-dark px-4 relative overflow-hidden">
      {/* Atmospheric background: layered radial glows + faint grid, no flat black */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.5]"
        style={{
          background:
            'radial-gradient(60% 50% at 50% 0%, rgba(249,158,26,0.10), transparent 70%),' +
            'radial-gradient(50% 50% at 80% 100%, rgba(30,58,95,0.45), transparent 70%)',
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px),' +
            'linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
        }}
      />

      <div className="relative w-full max-w-sm">
        <div className="h-1 w-16 bg-ow-orange mb-6 mx-auto rounded-full" />

        <h1 className="font-display text-3xl tracking-[0.2em] text-center text-slate-100 uppercase">
          Overwatch
        </h1>
        <p className="font-display text-sm tracking-[0.4em] text-center text-ow-orange uppercase mt-1 mb-8">
          Ranked Tracker
        </p>

        <div className="bg-ow-panel/80 backdrop-blur-sm border border-white/5 rounded-xl p-6 shadow-2xl">
          <label className="block text-xs font-display tracking-wider text-slate-400 uppercase mb-2">
            Email address
          </label>
          <input
            type="email"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            className="w-full bg-ow-dark/80 border border-white/10 rounded-lg px-4 py-3
                       text-slate-100 placeholder-slate-600 outline-none
                       focus:border-ow-orange/60 focus:ring-1 focus:ring-ow-orange/30
                       transition-colors"
          />

          <label className="block text-xs font-display tracking-wider text-slate-400 uppercase mb-2 mt-4">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            onKeyDown={(ev) => ev.key === 'Enter' && signIn()}
            placeholder="********"
            autoComplete="current-password"
            className="w-full bg-ow-dark/80 border border-white/10 rounded-lg px-4 py-3
                       text-slate-100 placeholder-slate-600 outline-none
                       focus:border-ow-orange/60 focus:ring-1 focus:ring-ow-orange/30
                       transition-colors"
          />

          {status === 'error' && (
            <p className="text-ow-defeat text-xs mt-3 leading-relaxed">{errorMsg}</p>
          )}

          <button
            onClick={signIn}
            disabled={status === 'working' || !email.trim() || !password}
            className="w-full mt-5 bg-ow-orange hover:bg-ow-accent disabled:opacity-40
                       disabled:cursor-not-allowed text-ow-dark font-display tracking-widest
                       uppercase text-sm py-3 rounded-lg transition-colors"
          >
            {status === 'working' ? 'Signing in...' : 'Sign In'}
          </button>
        </div>
      </div>
    </div>
  )
}
