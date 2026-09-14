import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canArchiveIpo } from './ipoStatus'

// canArchiveIpo reads "now" via nowIst() (real wall-clock time) — fake
// timers give deterministic dates to test against instead of the test's
// own pass/fail depending on what day it happens to run.
function setNowIst(dateIso: string, hour = 12) {
  const [y, m, d] = dateIso.split('-').map(Number)
  // nowIst() shifts UTC by +5:30 then reads UTC fields back off — so the
  // "real" UTC instant to set is IST minus 5:30.
  vi.setSystemTime(new Date(Date.UTC(y, m - 1, d, hour, 0, 0) - 5.5 * 60 * 60 * 1000))
}

describe('canArchiveIpo', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is false with no allotment_date at all (TBA)', () => {
    setNowIst('2026-09-20')
    expect(canArchiveIpo({ allotment_date: null })).toBe(false)
  })

  it('is false on the allotment date itself', () => {
    setNowIst('2026-09-17')
    expect(canArchiveIpo({ allotment_date: '2026-09-17' })).toBe(false)
  })

  it('is false the day before allotment', () => {
    setNowIst('2026-09-16')
    expect(canArchiveIpo({ allotment_date: '2026-09-17' })).toBe(false)
  })

  it('is true the day after allotment', () => {
    setNowIst('2026-09-18')
    expect(canArchiveIpo({ allotment_date: '2026-09-17' })).toBe(true)
  })

  it('is true well after allotment', () => {
    setNowIst('2026-10-01')
    expect(canArchiveIpo({ allotment_date: '2026-09-17' })).toBe(true)
  })

  it('handles a month/year rollover correctly (string comparison, not naive digit comparison)', () => {
    setNowIst('2027-01-01')
    expect(canArchiveIpo({ allotment_date: '2026-12-31' })).toBe(true)
  })
})
