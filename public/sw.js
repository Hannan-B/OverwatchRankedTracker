// Overwatch Tracker — service worker
// Purpose: make the app installable ("Add to Home Screen") and let it open
// reliably as a standalone app. It deliberately does NOT cache the app's code
// or your uploads — every request goes to the network first. This keeps things
// simple and guarantees the phone always runs the latest version of the app
// (important: this app talks to Supabase, so we never want stale data).

const VERSION = 'ow-tracker-v1'

// Take control immediately on install/activate so updates apply on next open.
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Network-first for everything. If the network fails entirely (offline),
// just let the request fail normally — the upload page needs the network
// to reach Supabase anyway, so there's nothing useful to serve offline.
self.addEventListener('fetch', (event) => {
  // Only handle GET navigations/assets; let everything else pass straight through.
  if (event.request.method !== 'GET') return
  event.respondWith(fetch(event.request))
})
