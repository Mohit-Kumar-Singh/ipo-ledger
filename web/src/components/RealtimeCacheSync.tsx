import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { queryKeys } from '../lib/queries'

// One realtime subscription for the whole app, mounted once near the root
// (App.tsx) — invalidates the shared v_allotment_board cache entry
// (queries.ts's useAllotmentBoardAll) on any `applications` change,
// regardless of which page made the write or which pages happen to be
// mounted. Before the shared query cache existed, freshness here was each
// page's own problem: ApplicationsPage and DashboardPage each ran their own
// `.channel().on('postgres_changes', ...)` and reloaded their own state,
// which meant a page with no such channel (Archives, Payouts, the Allotment
// board) only ever saw a change on its next full remount, and a page WITH
// one only refreshed itself — a change made from the Allotment board didn't
// reach an already-open Dashboard tab until it happened to reload some
// other way.
//
// `applications` is confirmed in the supabase_realtime publication
// (CLAUDE.md) — this listens for exactly the table CLAUDE.md documents as
// already pushing live updates, not a new subscription against a table that
// silently won't fire. ipos/demat_accounts/bank_accounts are NOT in that
// publication, so their shared caches rely on the app-wide staleTime
// (queryClient.ts) plus window-focus refetch instead of a push — correct,
// since there's no realtime channel to subscribe to for either even if a
// page wanted one.
//
// Deliberately NOT a replacement for ApplicationsPage's/DashboardPage's own
// channels — both do more on an applications change than this (reloading
// applications-specific embeds, attribution numbers, settlement figures)
// that isn't part of the shared cache and has to stay page-local. This only
// ever touches queryKeys.allotmentBoard.
export function RealtimeCacheSync() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const channel = supabase
      .channel('shared-cache-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applications' }, () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.allotmentBoard })
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])

  return null
}
