import { QueryClient } from '@tanstack/react-query'

// One shared in-memory cache for the whole app session — the actual fix for
// "same table fetched fresh on every page visit." Deliberately NOT persisted
// to localStorage/IndexedDB: this app's cached tables (ipos, demat_accounts,
// bank_accounts, the allotment-board view) carry PAN-adjacent identifiers,
// UPI IDs and broker login fields, and CLAUDE.md's security model treats RLS
// as the only real boundary — a persisted client-side cache would keep that
// data on disk past the tab closing, for no real gain (a fresh fetch on next
// app open is one round trip, not a slow one; see queries.ts's per-key
// staleTime for why a warm in-memory cache during a session already removes
// the actual duplicate-request problem this exists to fix).
//
// staleTime default (not 0, TanStack's own default): 0 means every single
// component mount is treated as stale and refetches immediately, which is
// exactly the "loading screen even though we just fetched this" behavior
// being fixed here. A non-zero default means returning to a page within the
// window renders the cached data with no network call and no spinner at
// all — individual queries in queries.ts override this where a table has its
// own realtime push (applications-backed views) or genuinely needs to be
// fresher/staler than the app-wide default.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // Cache entries survive being unmounted (e.g. navigating off a route)
      // for 5 minutes before being garbage-collected — long enough that
      // clicking Dashboard -> Applications -> Dashboard again reuses the
      // same cache entry instead of refetching, short enough not to hold
      // stale financial data in memory indefinitely on a long-lived tab.
      gcTime: 5 * 60_000,
      // A failed Supabase read is almost always RLS/auth/network, not a
      // transient blip worth hammering — one retry, not TanStack's default
      // 3, so a real failure surfaces as an error state quickly instead of
      // the request-lifecycle guarantee this task explicitly asks for
      // ("failed requests don't cause endless retry/loading loops").
      retry: 1,
      // Refetch when the tab regains focus (catches changes made in another
      // tab/device while this one was in the background). refetchOnMount
      // stays at its TanStack default (true) deliberately, not disabled —
      // "true" does NOT mean "always show a spinner on mount": within
      // staleTime it's a pure cache hit (instant render, zero network), and
      // past staleTime it's stale-while-revalidate (cached data renders
      // immediately, a background refetch silently updates it once it
      // lands) — exactly the fetch-once/cache/refresh-silently behavior
      // this exists to implement. Disabling it would mean a stale cache
      // entry never refreshes again until the window refocuses, which
      // trades "no request-count regression" for "may show outdated data
      // indefinitely" — the wrong trade for a financial ledger.
      refetchOnWindowFocus: true,
    },
  },
})
