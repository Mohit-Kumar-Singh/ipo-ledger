import { describe, expect, it } from 'vitest'
import { sameIdentity } from './applicationAttribution'

describe('sameIdentity', () => {
  it('matches exact names case-insensitively, trimming whitespace', () => {
    expect(sameIdentity('Mohit Kumar', '  mohit kumar  ')).toBe(true)
  })

  it('matches a shortened name against the fuller registered name it\'s a prefix subsequence of', () => {
    expect(sameIdentity('Mohit', 'Mohit Kumar Singh')).toBe(true)
    expect(sameIdentity('Mohit Kumar Singh', 'Mohit')).toBe(true) // order-independent
  })

  it('does not match two different people who merely share a first name', () => {
    // Real data this app has on file: two distinct funders both named
    // "Harsh" (Harsh Gandhi, Harsh Verma) — first-token-only matching was
    // tried and rejected specifically because it silently merged them.
    expect(sameIdentity('Harsh Gandhi', 'Harsh Verma')).toBe(false)
  })

  it('does not match when a middle/last token actually disagrees, even with a shared prefix token', () => {
    expect(sameIdentity('Mohit Verma', 'Mohit Kumar Singh')).toBe(false)
  })

  // Widened for lib/profitSplit.ts's computeProfitSplit, whose funderName
  // input is string | null (no funder on file at all) — must degrade to
  // "not the same person" rather than throwing.
  it('is false, not a throw, for null/undefined/empty input', () => {
    expect(sameIdentity(null, 'Mohit')).toBe(false)
    expect(sameIdentity(undefined, 'Mohit')).toBe(false)
    expect(sameIdentity('', '')).toBe(false)
    expect(sameIdentity('Mohit', null)).toBe(false)
  })
})
