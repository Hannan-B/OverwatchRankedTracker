import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Server-side Supabase client for the Next.js App Router.
//
// This is used in server components and route handlers (like the auth
// callback) where we need to read/write the auth session cookie on the
// server. It is separate from the browser client in supabase.ts on purpose:
// the server reads cookies via next/headers, the browser reads them directly.
//
// You generally won't call this from your pages. It exists so the magic-link
// callback route can complete the login on the server and set the session
// cookie correctly.

export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component where setting cookies isn't
            // allowed. Safe to ignore here — the callback route handles it.
          }
        },
      },
    }
  )
}
