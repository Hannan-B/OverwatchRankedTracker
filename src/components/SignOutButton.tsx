'use client'

import { supabase } from '@/lib/supabase'

// Small sign-out control for the desktop nav. After signing out, AuthGate
// detects the change and shows the login screen again.
export default function SignOutButton() {
  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <button
      onClick={signOut}
      className="text-sm text-slate-500 hover:text-ow-defeat transition-colors
                 font-display tracking-wider uppercase"
      title="Sign out"
    >
      Sign Out
    </button>
  )
}
