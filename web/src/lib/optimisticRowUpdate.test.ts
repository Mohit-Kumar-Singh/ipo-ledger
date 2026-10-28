import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { optimisticRowUpdate, isRowUpdateInFlight, reportOptimisticFailure, RowUnchanged } from './optimisticRowUpdate'
import * as toast from './toast'

type Row = { application_id: string; status: string; sell_price: number | null }
const KEY = ['v_allotment_board']

function setup(rows: Row[] = [
  { application_id: 'a', status: 'ALLOTTED', sell_price: null },
  { application_id: 'b', status: 'ALLOTTED', sell_price: null },
]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData<Row[]>(KEY, rows)
  const read = () => queryClient.getQueryData<Row[]>(KEY)!
  return { queryClient, read }
}

// A commit we resolve or reject by hand — stands in for a slow network.
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('optimisticRowUpdate', () => {
  it('changes the row immediately, before the write finishes (slow network)', async () => {
    const { queryClient, read } = setup()
    const write = deferred<string>()
    const pending = optimisticRowUpdate<Row, string>({
      queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit: () => write.promise,
    })
    // Same tick as the call — nothing awaited yet.
    expect(read().find((r) => r.application_id === 'a')!.status).toBe('SOLD')
    expect(read().find((r) => r.application_id === 'b')!.status).toBe('ALLOTTED')
    expect(isRowUpdateInFlight('a')).toBe(true)

    write.resolve('done')
    await expect(pending).resolves.toEqual({ status: 'ok', result: 'done' })
    expect(read().find((r) => r.application_id === 'a')!.status).toBe('SOLD')
    expect(isRowUpdateInFlight('a')).toBe(false)
  })

  it('puts the row back exactly as it was when the write fails', async () => {
    const { queryClient, read } = setup([{ application_id: 'a', status: 'SOLD', sell_price: 250 }])
    const failure = new Error('network down')
    const result = await optimisticRowUpdate<Row, never>({
      queryClient, queryKey: KEY, id: 'a', patch: { status: 'ALLOTTED', sell_price: null },
      commit: () => Promise.reject(failure),
    })
    expect(result).toEqual({ status: 'failed', error: failure })
    expect(read()).toEqual([{ application_id: 'a', status: 'SOLD', sell_price: 250 }])
    expect(isRowUpdateInFlight('a')).toBe(false)
  })

  it('ignores repeat taps while the first write is still running — one write only', async () => {
    const { queryClient } = setup()
    const write = deferred<string>()
    const commit = vi.fn(() => write.promise)
    const first = optimisticRowUpdate<Row, string>({ queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit })
    const second = await optimisticRowUpdate<Row, string>({ queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit })
    const third = await optimisticRowUpdate<Row, string>({ queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit })
    expect(second).toEqual({ status: 'busy' })
    expect(third).toEqual({ status: 'busy' })
    write.resolve('done')
    await first
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('lets different rows update at the same time', async () => {
    const { queryClient, read } = setup()
    const [wa, wb] = [deferred<string>(), deferred<string>()]
    const pa = optimisticRowUpdate<Row, string>({ queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit: () => wa.promise })
    const pb = optimisticRowUpdate<Row, string>({ queryClient, queryKey: KEY, id: 'b', patch: { status: 'SOLD' }, commit: () => wb.promise })
    expect(read().map((r) => r.status)).toEqual(['SOLD', 'SOLD'])
    wb.reject(new Error('b failed'))
    wa.resolve('ok')
    await Promise.all([pa, pb])
    expect(read().map((r) => r.status)).toEqual(['SOLD', 'ALLOTTED'])
  })

  it('accepts a new tap once the previous write has finished', async () => {
    const { queryClient, read } = setup()
    await optimisticRowUpdate<Row, string>({ queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit: async () => 'ok' })
    const again = await optimisticRowUpdate<Row, string>({
      queryClient, queryKey: KEY, id: 'a', patch: { status: 'ALLOTTED' }, commit: async () => 'ok',
    })
    expect(again.status).toBe('ok')
    expect(read().find((r) => r.application_id === 'a')!.status).toBe('ALLOTTED')
  })

  it('refetches afterwards so the screen matches what the server confirmed', async () => {
    const { queryClient } = setup()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await optimisticRowUpdate<Row, string>({ queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit: async () => 'ok' })
    await optimisticRowUpdate<Row, never>({
      queryClient, queryKey: KEY, id: 'b', patch: { status: 'SOLD' }, commit: () => Promise.reject(new Error('x')),
    })
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY })
  })

  it('a slow, stale refetch that was already running cannot overwrite the change', async () => {
    const { queryClient, read } = setup()
    const stale = deferred<Row[]>()
    // A board refetch already on the wire, carrying the OLD state.
    const refetch = queryClient.fetchQuery({ queryKey: KEY, queryFn: () => stale.promise, staleTime: 0 }).catch(() => {})
    const write = deferred<string>()
    const pending = optimisticRowUpdate<Row, string>({
      queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit: () => write.promise,
    })
    stale.resolve([
      { application_id: 'a', status: 'ALLOTTED', sell_price: null },
      { application_id: 'b', status: 'ALLOTTED', sell_price: null },
    ])
    await refetch
    expect(read().find((r) => r.application_id === 'a')!.status).toBe('SOLD')
    write.resolve('ok')
    await pending
  })

  it('works on other tables (idField) and on wrapped caches (lens), touching only the target row', async () => {
    const queryClient = new QueryClient()
    type Wrapped = { rows: { id: string; status: string }[]; lookups: Map<string, string> }
    const lookups = new Map([['x', 'y']])
    queryClient.setQueryData<Wrapped>(['apps'], { rows: [{ id: '1', status: 'APPLIED' }, { id: '2', status: 'APPLIED' }], lookups })
    const result = await optimisticRowUpdate<{ id: string; status: string }, never, Wrapped>({
      queryClient, queryKey: ['apps'], id: '1', idField: 'id',
      lens: { get: (d) => d.rows, set: (d, rows) => ({ ...d, rows }) },
      patch: { status: 'ALLOTTED' },
      commit: () => Promise.reject(new RowUnchanged('changed meanwhile')),
    })
    expect(result.status).toBe('failed')
    const after = queryClient.getQueryData<Wrapped>(['apps'])!
    expect(after.rows).toEqual([{ id: '1', status: 'APPLIED' }, { id: '2', status: 'APPLIED' }])
    expect(after.lookups).toBe(lookups)
  })

  it('a failed row rolls back without undoing another row changed meanwhile', async () => {
    const { queryClient, read } = setup()
    const wa = deferred<string>()
    const pa = optimisticRowUpdate<Row, string>({ queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit: () => wa.promise })
    await optimisticRowUpdate<Row, string>({ queryClient, queryKey: KEY, id: 'b', patch: { status: 'NOT_ALLOTTED' }, commit: async () => 'ok' })
    wa.reject(new Error('a failed'))
    await pa
    expect(read().map((r) => r.status)).toEqual(['ALLOTTED', 'NOT_ALLOTTED'])
  })

  it('refetches the extra caches built from the same rows', async () => {
    const { queryClient } = setup()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await optimisticRowUpdate<Row, string>({
      queryClient, queryKey: KEY, id: 'a', patch: { status: 'SOLD' }, commit: async () => 'ok',
      alsoInvalidate: [['dashboard'], ['applications-list']],
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dashboard'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['applications-list'] })
  })
})

describe('reportOptimisticFailure', () => {
  it('shows nothing on success or a repeat tap — the changed row is the feedback', () => {
    const spy = vi.spyOn(toast, 'showToast').mockImplementation(() => {})
    reportOptimisticFailure({ status: 'ok', result: undefined }, 'x')
    reportOptimisticFailure({ status: 'busy' }, 'x')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('keeps a RowUnchanged message and tone, and translates anything else', () => {
    const spy = vi.spyOn(toast, 'showToast').mockImplementation(() => {})
    reportOptimisticFailure({ status: 'failed', error: new RowUnchanged('Already paid.', 'warning') }, 'fallback')
    expect(spy).toHaveBeenLastCalledWith('Already paid.', 'warning')
    reportOptimisticFailure({ status: 'failed', error: { message: 'violates foreign key constraint "x_fkey"', code: '23503' } }, "Couldn't save.")
    const [msg, tone] = spy.mock.calls.at(-1)!
    expect(tone).toBe('critical')
    expect(msg).not.toMatch(/constraint|fkey|23503/)
    spy.mockRestore()
  })
})
