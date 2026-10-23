import { describe, expect, it } from 'vitest'
import { mapLimit } from './mapLimit'

describe('mapLimit', () => {
  it('never runs more than the limit at once and keeps the result order', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5 - (n % 3)))
      inFlight--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
    expect(peak).toBe(3)
  })

  it('handles empty input and a limit larger than the list', async () => {
    expect(await mapLimit([], 5, async (x: number) => x)).toEqual([])
    expect(await mapLimit([1, 2], 10, async (x) => x + 1)).toEqual([2, 3])
  })

  it('passes the index and does not swallow a rejection', async () => {
    expect(await mapLimit(['a', 'b'], 1, async (x, i) => x + i)).toEqual(['a0', 'b1'])
    await expect(mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('boom'); return x })).rejects.toThrow('boom')
  })
})
