import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json' with { type: 'json' }

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Service worker updates itself and takes over on the next load — no
      // "new version available" prompt to build/maintain. Right for a
      // single-owner tool where being one load behind is harmless.
      registerType: 'autoUpdate',
      // Non-hashed static files the SW should also cache (the manifest icons
      // are handled via the manifest; these are the extras referenced in HTML).
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'IPO Ledger',
        short_name: 'IPO Ledger',
        description: 'Track IPO applications, allotments, and payouts across shared demat/bank accounts.',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the built app shell (JS/CSS/HTML/fonts/icons) so the app
        // opens instantly and works offline down to the login/loading screen.
        // Supabase API calls are deliberately NOT cached here — they stay
        // network-only, so data is always fresh and never served stale from a
        // cache (and auth-scoped responses never get persisted). The app shell
        // loads offline; the data it shows still needs a connection.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        // The vendor + icon chunks are a bit above the 2MB default ceiling.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      // Keep the SW out of `npm run dev` — avoids stale-cache confusion while
      // developing; it only activates in the production build/preview.
      devOptions: { enabled: false },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        // Split the big, rarely-changing vendors into their own long-lived
        // chunks. App code changes every deploy (version bump); pinning
        // React / supabase-js / router into stable-hash chunks means a
        // returning user only re-downloads the small app chunk after a
        // deploy, not the whole ~490KB vendor payload every time.
        manualChunks(id) {
          if (id.includes('/node_modules/@supabase/')) return 'vendor-supabase'
          if (id.match(/\/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//))
            return 'vendor-react'
          return undefined
        },
      },
    },
  },
})
