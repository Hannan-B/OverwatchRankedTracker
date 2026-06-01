/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable PWA capabilities
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    },
    {
      // The service worker must be served from the site root with a scope
      // that covers the whole app, and must never be cached by the browser,
      // or phones can get stuck on an old version after you deploy.
      source: '/sw.js',
      headers: [
        { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'Service-Worker-Allowed', value: '/' },
      ],
    },
    {
      // Make sure the manifest is served with the right type.
      source: '/manifest.json',
      headers: [
        { key: 'Content-Type', value: 'application/manifest+json' },
      ],
    },
  ],
}

module.exports = nextConfig
