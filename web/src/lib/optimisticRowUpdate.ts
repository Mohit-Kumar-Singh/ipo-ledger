// Optimistic update for one row of a cached list (e.g. the allotment board's
// v_allotment_board cache): the row changes on screen in the same tick as the
// tap, the real write runs in the background, and the list is refetched
// afterwards so the screen always ends up showing what the server confirmed.
//
//   - Instant: the patch is applied synchronously, before anything awaits.
//     In-flight refetches are cancelled WITHOUT reverting (the default revert
//     would restore pre-fetch data and wipe the patch) so a slow, stale
//     response can't land on top of it.
//   - Failure: `commit` throws → the row is put back exactly as it was, and
//     the error is returned for the caller to show.
//   - One at a time per row: a second call for a row whose update is still
//     running returns 'busy' without touching anything, so a double tap can't
//     fire a second write.
//   - Reconciled: success or failure, the list is refetched at the end — if
//     a write landed but its response was lost, the refetch still shows the
//     truth.
import type { QueryClient, QueryKey } from '@tanstack/react-query'

type KeyedRow = { application_id: string }

const inFlight = new Set<string>()

export function isRowUpdateInFlight(id: string): boolean {
  return inFlight.has(id)
}

export type OptimisticResult<R> =
  | { status: 'ok'; result: R }
  | { status: 'busy' }
  | { status: 'failed'; error: unknown }

export async function optimisticRowUpdate<T extends KeyedRow, R>({
  queryClient,
  queryKey,
  id,
  patch,
  commit,
}: {
  queryClient: QueryClient
  queryKey: QueryKey
  id: string
  patch: Partial<T>
  commit: () => Promise<R>
}): Promise<OptimisticResult<R>> {
  if (inFlight.has(id)) return { status: 'busy' }
  inFlight.add(id)

  void queryClient.cancelQueries({ queryKey }, { revert: false })
  const previous = queryClient.getQueryData<T[]>(queryKey)?.find((r) => r.application_id === id)
  queryClient.setQueryData<T[]>(queryKey, (rows) =>
    rows?.map((r) => (r.application_id === id ? { ...r, ...patch } : r)),
  )

  try {
    return { status: 'ok', result: await commit() }
  } catch (error) {
    if (previous) {
      queryClient.setQueryData<T[]>(queryKey, (rows) =>
        rows?.map((r) => (r.application_id === id ? previous : r)),
      )
    }
    return { status: 'failed', error }
  } finally {
    inFlight.delete(id)
    void queryClient.invalidateQueries({ queryKey })
  }
}
