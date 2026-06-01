import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'

// Magic-link callback.
//
// When you click the login link in your email, Supabase sends you to:
//   <your-app>/auth/callback?code=XXXX
// This route exchanges that one-time code for a real logged-in session,
// stores it in a cookie, and then sends you on into the app.

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // Where to land after login. Defaults to the home page.
  const next = searchParams.get('next') ?? '/'

  if (code) {
    const supabase = await createSupabaseServerClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  // If something went wrong, send back to home with an error flag the
  // login screen can read and show a friendly message.
  return NextResponse.redirect(`${origin}/?auth_error=1`)
}
