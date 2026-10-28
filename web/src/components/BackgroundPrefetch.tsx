// App-like startup: the screen you open (normally the Dashboard) loads
// first, on its own; once it has finished and the browser is idle, the
// other everyday screens' data and code are loaded quietly in the
// background, so tapping Applications / Allotment / Accounts / IPOs shows
// the list straight away instead of a spinner.
//
//   - Same fetchers and cache keys the pages themselves use, so a page
//     opened later reads this exact cache entry — no second request, and
//     RLS scopes it exactly as the page's own read would.
//   - prefetchQuery skips anything already fresh (e.g. what the Dashboard
//     loaded itself), and never throws or shows a message: a background
//     load that fails just means that page loads normally when opened.
//   - Once per signed-in user per app load; skipped on data-saver.
import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import {
  queryKeys,
  fetchIpos,
  fetchDematAccounts,
  fetchBankAccounts,
  fetchAllotmentBoardAll,
  fetchParentCompanies,
} from '../lib/queries'
import { applicationsListKey, fetchApplicationsList } from '../lib/applicationsList'

const routeChunks = [
  () => import('../pages/admin/ApplicationsPage'),
  () => import('../pages/admin/AllotmentBoardPage'),
  () => import('../pages/admin/AccountsPage'),
  () => import('../pages/admin/PayoutsPage'),
  () => import('../pages/admin/IposPage'),
  () => import('../pages/admin/NotificationsPage'),
]

function prefetchEverydayScreens(queryClient: QueryClient): Promise<unknown> {
  return Promise.allSettled([
    queryClient.prefetchQuery({ queryKey: applicationsListKey, queryFn: fetchApplicationsList }),
    queryClient.prefetchQuery({ queryKey: queryKeys.allotmentBoard, queryFn: fetchAllotmentBoardAll, staleTime: 15_000 }),
    queryClient.prefetchQuery({ queryKey: queryKeys.ipos, queryFn: fetchIpos }),
    queryClient.prefetchQuery({ queryKey: queryKeys.dematAccounts, queryFn: fetchDematAccounts }),
    queryClient.prefetchQuery({ queryKey: queryKeys.bankAccounts, queryFn: fetchBankAccounts }),
    queryClient.prefetchQuery({ queryKey: queryKeys.parentCompanies, queryFn: fetchParentCompanies }),
    ...routeChunks.map((load) => load()),
  ])
}

function saveDataOn(): boolean {
  return !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
}

function whenIdle(fn: () => void): () => void {
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(fn, { timeout: 3000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = setTimeout(fn, 1500)
  return () => clearTimeout(id)
}

export function BackgroundPrefetch() {
  const { profile } = useAuth()
  const queryClient = useQueryClient()
  const doneFor = useRef<string | null>(null)

  useEffect(() => {
    const userId = profile?.id
    if (!userId || doneFor.current === userId || saveDataOn()) return

    let cancelIdle: (() => void) | null = null
    // Wait for the opening screen's own loads to finish first — nothing
    // here may compete with what's on screen.
    const tryStart = () => {
      if (cancelIdle || queryClient.isFetching() > 0) return
      cancelIdle = whenIdle(() => {
        doneFor.current = userId
        unsubscribe()
        void prefetchEverydayScreens(queryClient)
      })
    }
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      // Something started loading again before idle came: start over.
      if (cancelIdle && queryClient.isFetching() > 0 && doneFor.current !== userId) {
        cancelIdle()
        cancelIdle = null
      }
      tryStart()
    })
    // The opening screen's queries mount in the same commit as this; give
    // them a beat to register before deciding nothing is loading.
    const kickoff = setTimeout(tryStart, 300)
    return () => {
      clearTimeout(kickoff)
      cancelIdle?.()
      unsubscribe()
    }
  }, [profile?.id, queryClient])

  return null
}
