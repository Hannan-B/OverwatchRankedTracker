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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
                          bg-ow-panel/80 backdrop-blur-sm border-b border-white/5 sticky top-0 z-50">
            <Link href="/" className="font-display text-xl text-ow-orange tracking-widest">
              OW TRACKER
            </Link>
            <div className="flex items-center gap-6">
              <Link href="/" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
                HOME
              </Link>
              <Link href="/upload" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
                UPLOAD
              </Link>
              <Link href="/process" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
                PROCESS
              </Link>
              <Link href="/matches" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
                MATCH HISTORY
              </Link>
              <Link href="/heroes" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
                HERO ANALYTICS
              </Link>
              <Link href="/issue-log" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
                ISSUE LOG
              </Link>
              <Link href="/settings" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
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
