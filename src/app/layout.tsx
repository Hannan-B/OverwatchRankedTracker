import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'OW Tracker',
  description: 'Track and analyse your Overwatch competitive matches',
  manifest: '/manifest.json',
}

export const viewport: Viewport = {
  themeColor: '#f99e1a',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

function NavLink({ href, label, icon }: { href: string; label: string; icon: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center gap-1 px-3 py-2 text-xs text-slate-400 
                 hover:text-ow-orange transition-colors"
    >
      <span className="text-lg">{icon}</span>
      <span className="font-display tracking-wider">{label}</span>
    </Link>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="pb-20 md:pb-0">
        {/* Desktop top nav */}
        <nav className="hidden md:flex items-center justify-between px-6 py-3 
                        bg-ow-panel/80 backdrop-blur-sm border-b border-white/5 sticky top-0 z-50">
          <Link href="/" className="font-display text-xl text-ow-orange tracking-widest">
            OW TRACKER
          </Link>
          <div className="flex items-center gap-6">
            <Link href="/" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
              DASHBOARD
            </Link>
            <Link href="/upload" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
              UPLOAD
            </Link>
            <Link href="/process" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
              PROCESS
            </Link>
            <Link href="/matches" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
              MATCHES
            </Link>
            <Link href="/heroes" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
              HEROES
            </Link>
            <Link href="/issue-log" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
              ISSUE LOG
            </Link>
            <Link href="/settings" className="text-sm text-slate-300 hover:text-ow-orange transition-colors font-display tracking-wider">
              SETTINGS
            </Link>
          </div>
        </nav>

        {/* Main content */}
        <main className="max-w-7xl mx-auto px-4 py-6">
          {children}
        </main>

        {/* Mobile bottom nav */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50
                        bg-ow-panel/95 backdrop-blur-sm border-t border-white/5
                        flex items-center justify-around py-1 safe-area-bottom">
          <NavLink href="/" label="HOME" icon="📊" />
          <NavLink href="/upload" label="UPLOAD" icon="📷" />
          <NavLink href="/matches" label="MATCHES" icon="⚔️" />
          <NavLink href="/heroes" label="HEROES" icon="🎯" />
          <NavLink href="/issue-log" label="ISSUES" icon="🩺" />
          <NavLink href="/settings" label="SETTINGS" icon="⚙️" />
        </nav>
      </body>
    </html>
  )
}
