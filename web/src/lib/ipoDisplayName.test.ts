import { describe, expect, it } from 'vitest'
import { firstIpoWord } from './ipoDisplayName'

describe('firstIpoWord', () => {
  it('returns the first word of a multi-word company name', () => {
    expect(firstIpoWord('ESDS Software Solution')).toBe('ESDS')
    expect(firstIpoWord('Kanohar Electricals')).toBe('Kanohar')
  })
  it('leaves a single-word name unchanged', () => {
    expect(firstIpoWord('Rentomojo')).toBe('Rentomojo')
  })
  it('collapses extra whitespace instead of returning an empty first token', () => {
    expect(firstIpoWord('  Lumino   Industries')).toBe('Lumino')
  })
  it('returns empty string for null/undefined/empty input, never throws', () => {
    expect(firstIpoWord(null)).toBe('')
    expect(firstIpoWord(undefined)).toBe('')
    expect(firstIpoWord('')).toBe('')
  })
})
