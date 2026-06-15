import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import './globals.css'
import AuthGate from '@/components/AuthGate'
import SignOutButton from '@/components/SignOutButton'

export const metadata: Metadata = {
  title: 'OW Tracker',
  description: 'Track and analyse your Overwatch competitive matches',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'OW Tracker',
  },
  icons: {
    icon: '/icon-192.png',
    apple: '/icon-192.png',
  },
}

export const viewport: Viewport = {
  themeColor: '#f99e1a',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
}

// No-FOUC theme bootstrap. Runs before first paint and sets data-theme from the
// OS preference (the 'system' default), so there's no flash of the wrong theme.
// The stored user_settings.theme_mode is reconciled shortly after via
// loadThemePref() (lib/theme.ts) — a no-op unless the user forced light/dark
// against their OS. Kept tiny and dependency-free on purpose.
const THEME_BOOTSTRAP = `
(function () {
  try {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the bootstrap script sets data-theme on <html>
    // before React hydrates, so the attribute legitimately differs from the
    // server-rendered markup. This silences the expected mismatch warning.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {/* Register the service worker so the app is installable on phones. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function () {
                  navigator.serviceWorker.register('/sw.js').catch(function () {});
                });
              }
            `,
          }}
        />

        {/* AuthGate: shows the login screen when logged out, the app when logged in.
            Everything below (nav + content) only renders once you're signed in. */}
        <AuthGate>
          {/* Desktop top nav only. The phone is upload-only by design, so there is
              NO mobile bottom nav — the upload flow is full-screen on a phone. */}
          <nav className="hidden md:flex items-center justify-between px-6 py-3
                          bg-ow-panel/80 backdrop-blur-sm border-b border-ow-line sticky top-0 z-50">
            <Link href="/" className="font-display text-xl text-ow-orange tracking-widest">
              OW TRACKER
            </Link>
            <div className="flex items-center gap-6">
              <Link href="/" className="text-sm text-ow-muted hover:text-ow-orange transition-colors font-display tracking-wider">
                HOME
              </Link>
              <Link href="/upload" className="text-sm text-ow-muted hover:text-ow-orange transition-colors font-display tracking-wider">
                UPLOAD
              </Link>
              <Link href="/process" className="text-sm text-ow-muted hover:text-ow-orange transition-colors font-display tracking-wider">
                PROCESS
              </Link>
              <Link href="/matches" className="text-sm text-ow-muted hover:text-ow-orange transition-colors font-display tracking-wider">
                MATCH HISTORY
              </Link>
              <Link href="/analytics" className="text-sm text-ow-muted hover:text-ow-orange transition-colors font-display tracking-wider">
                ANALYTICS
              </Link>
              <Link href="/issue-log" className="text-sm text-ow-muted hover:text-ow-orange transition-colors font-display tracking-wider">
                ISSUE LOG
              </Link>
              <Link href="/settings" className="text-sm text-ow-muted hover:text-ow-orange transition-colors font-display tracking-wider">
                SETTINGS
              </Link>
              <SignOutButton />
            </div>
          </nav>

          {/* Main content */}
          <main className="max-w-7xl mx-auto px-4 py-6">
            {children}
          </main>
        </AuthGate>
      </body>
    </html>
  )
}
