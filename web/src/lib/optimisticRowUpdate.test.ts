import { describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { optimisticRowUpdate, isRowUpdateInFlight } from './optimisticRowUpdate'

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
})
