import { describe, expect, it } from 'vitest'
import { extractAppNumberTokens, matchPastedAppNumbers } from './allotmentPaste'

const rows = [
  { application_id: 'a', ipoji_app_number: '1100234567' },
  { application_id: 'b', ipoji_app_number: 'ZRD123456789' },
  { application_id: 'c', ipoji_app_number: null },
]

describe('extractAppNumberTokens', () => {
  it('skips words and short numbers, keeps number-like tokens once', () => {
    expect(extractAppNumberTokens('Ravi allotted 1100234567, lots 1\n1100234567')).toEqual(['1100234567'])
  })
})

describe('matchPastedAppNumbers', () => {
  it('matches case-insensitively across any separators', () => {
    const r = matchPastedAppNumbers('zrd123456789\t1100234567', rows)
    expect(r.matchedIds.sort()).toEqual(['a', 'b'])
    expect(r.unmatched).toEqual([])
  })

  it('reports numbers that match no pending application', () => {
    const r = matchPastedAppNumbers('1100234567 9999999999', rows)
    expect(r.matchedIds).toEqual(['a'])
    expect(r.unmatched).toEqual(['9999999999'])
  })

  it('returns nothing for empty text', () => {
    expect(matchPastedAppNumbers('', rows)).toEqual({ matchedIds: [], unmatched: [] })
  })
})
