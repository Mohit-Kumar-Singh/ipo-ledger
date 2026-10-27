import { describe, expect, it } from 'vitest'
import { fetchAllRows, PAGE_SIZE } from './fetchAllRows'

// Stands in for a PostgREST table: serves .range(from, to) slices of `total`
// rows, never more than PAGE_SIZE per response, like the real max_rows cap.
function fakeTable(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }))
  const calls: Array<[number, number]> = []
  const page = async (from: number, to: number) => {
    calls.push([from, to])
    return { data: rows.slice(from, Math.min(to + 1, from + PAGE_SIZE)), error: null }
  }
  return { page, calls }
}

describe('fetchAllRows', () => {
  it('returns every row when the table is past the 1000-row cap', async () => {
    const { page, calls } = fakeTable(1010)
    const { data, error } = await fetchAllRows(page)
    expect(error).toBeNull()
    expect(data).toHaveLength(1010)
    expect(new Set(data!.map((r) => r.id)).size).toBe(1010)
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
    ])
  })

  it('makes one request when everything fits in a page', async () => {
    const { page, calls } = fakeTable(25)
    const { data } = await fetchAllRows(page)
    expect(data).toHaveLength(25)
    expect(calls).toHaveLength(1)
  })

  it('asks once more after an exactly-full page, then stops on the empty one', async () => {
    const { page, calls } = fakeTable(2000)
    const { data } = await fetchAllRows(page)
    expect(data).toHaveLength(2000)
    expect(calls).toHaveLength(3)
  })

  it('handles an empty table and null data', async () => {
    const { data } = await fetchAllRows(async () => ({ data: null, error: null }))
    expect(data).toEqual([])
  })

  it('returns the error and no partial data when a later page fails', async () => {
    const failure = { message: 'boom' }
    let n = 0
    const { data, error } = await fetchAllRows(async () =>
      n++ === 0
        ? { data: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i })), error: null }
        : { data: null, error: failure },
    )
    expect(data).toBeNull()
    expect(error).toBe(failure)
  })
})
