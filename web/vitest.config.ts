import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose — the app config pulls in the
// Tailwind/PWA/React plugins the calculation-only test suite has no use for
// (profitSplit.ts/settlement.ts/expectedProfit.ts are plain TS, no DOM), so
// this stays a minimal, fast config rather than inheriting build-time
// plugins that would just slow test startup down for no benefit.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
