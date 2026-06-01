import { createBrowserClient } from '@supabase/ssr'

// Browser-side Supabase client.
//
// This REPLACES the old bare createClient() setup. It uses @supabase/ssr
// (already in your package.json) so that the auth session is stored in
// cookies that BOTH the browser and the server can read. That cookie-based
// session is what will let the database recognise you as logged in once we
// lock down RLS in Step 2.
//
// Usage stays almost identical to before:
//   import { supabase } from '@/lib/supabase'
//   supabase.from('matches').select('*')
//
// so your existing pages keep working with no changes.

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)
