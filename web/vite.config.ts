import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json' with { type: 'json' }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
