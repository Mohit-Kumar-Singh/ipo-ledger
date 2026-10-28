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
//     the error is returned for the caller to show. Only that row is put
//     back, so another row's optimistic change made meanwhile survives.
//   - One at a time per row: a second call for a row whose update is still
//     running returns 'busy' without touching anything, so a double tap can't
//     fire a second write.
//   - Reconciled: success or failure, the list (and any `alsoInvalidate`
//     keys built from the same rows) is refetched at the end — if a write
//     landed but its response was lost, the refetch still shows the truth.
//
// Rows are matched on `application_id` by default; pass `idField` for other
// tables, and `lens` when the cached value wraps the list (e.g. the
// Applications page caches `{ rows, ...lookups }`).
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { showToast } from './toast'
import { friendlyError } from './friendlyError'

type AnyRow = Record<string, unknown>

export type RowsLens<D, T> = {
  get: (data: D) => T[]
  set: (data: D, rows: T[]) => D
}

const inFlight = new Set<string>()

export function isRowUpdateInFlight(id: string): boolean {
  return inFlight.has(id)
}

export type OptimisticResult<R> =
  | { status: 'ok'; result: R }
  | { status: 'busy' }
  | { status: 'failed'; error: unknown }

export async function optimisticRowUpdate<T extends object, R, D = T[]>({
  queryClient,
  queryKey,
  id,
  patch,
  commit,
  idField = 'application_id',
  lens,
  alsoInvalidate = [],
}: {
  queryClient: QueryClient
  queryKey: QueryKey
  id: string
  patch: Partial<T>
  commit: () => Promise<R>
  idField?: string
  lens?: RowsLens<D, T>
  alsoInvalidate?: QueryKey[]
}): Promise<OptimisticResult<R>> {
  if (inFlight.has(id)) return { status: 'busy' }
  inFlight.add(id)

  const matches = (r: T) => (r as AnyRow)[idField] === id
  const read = (data: D | undefined): T[] | undefined =>
    data === undefined ? undefined : lens ? lens.get(data) : (data as unknown as T[])
  const mapRow = (fn: (r: T) => T) => (data: D | undefined): D | undefined => {
    const rows = read(data)
    if (data === undefined || !rows) return data
    const next = rows.map((r) => (matches(r) ? fn(r) : r))
    return lens ? lens.set(data, next) : (next as unknown as D)
  }

  // Revert-cancel (the default), applied BEFORE the patch: it synchronously
  // puts the cache back to its last settled/hand-set value with no error.
  // `{ revert: false }` was used here and looked the same, but TanStack then
  // records the cancelled refetch as a failed load — the board's load-error
  // toast fired on every quick second tap (v1.260.0–v1.261.0).
  void queryClient.cancelQueries({ queryKey })
  const previous = read(queryClient.getQueryData<D>(queryKey))?.find(matches)
  queryClient.setQueryData<D>(queryKey, mapRow((r) => ({ ...r, ...patch })))

  try {
    return { status: 'ok', result: await commit() }
  } catch (error) {
    if (previous) queryClient.setQueryData<D>(queryKey, mapRow(() => previous))
    return { status: 'failed', error }
  } finally {
    inFlight.delete(id)
    void queryClient.invalidateQueries({ queryKey })
    for (const key of alsoInvalidate) void queryClient.invalidateQueries({ queryKey: key })
  }
}

// A conditional write (`.eq('status', expected)…select('id')`) that matched
// nothing: RLS refused it, or the row already changed elsewhere. Supabase
// reports both as an empty result, not an error — so callers throw this to
// make the optimistic change roll back with a human message.
export class RowUnchanged extends Error {
  readonly tone: 'warning' | 'critical'
  constructor(message: string, tone: 'warning' | 'critical' = 'warning') {
    super(message)
    this.tone = tone
  }
}

// The one way an optimistic action reports a rollback: a RowUnchanged keeps
// its own human message; anything else goes through friendlyError with the
// action-specific fallback. 'busy' (a repeat tap) and 'ok' say nothing — the
// changed row on screen is the confirmation.
export function reportOptimisticFailure(result: OptimisticResult<unknown>, fallback: string): void {
  if (result.status !== 'failed') return
  const { error } = result
  if (error instanceof RowUnchanged) showToast(error.message, error.tone)
  else showToast(friendlyError(error, fallback), 'critical')
}
