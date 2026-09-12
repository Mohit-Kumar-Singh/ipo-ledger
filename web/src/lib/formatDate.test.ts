import { describe, expect, it } from 'vitest'
import { formatShortDate } from './formatDate'

describe('formatShortDate', () => {
  it('formats with an ordinal day and short month', () => {
    expect(formatShortDate('2026-09-16')).toBe('16th Sep')
    expect(formatShortDate('2026-09-01')).toBe('1st Sep')
    expect(formatShortDate('2026-09-02')).toBe('2nd Sep')
    expect(formatShortDate('2026-09-03')).toBe('3rd Sep')
    expect(formatShortDate('2026-09-11')).toBe('11th Sep') // the 11th/12th/13th exception, not "11st"
  })

  it('returns "TBA" for a null/undefined date', () => {
    expect(formatShortDate(null)).toBe('TBA')
    expect(formatShortDate(undefined)).toBe('TBA')
  })

  it('appends the weekday when asked — long form', () => {
    // 16 Sep 2026 is a Wednesday.
    expect(formatShortDate('2026-09-16', { weekday: 'long' })).toBe('16th Sep · Wednesday')
  })

  it('appends the weekday when asked — short form, for tight layouts', () => {
    expect(formatShortDate('2026-09-16', { weekday: 'short' })).toBe('16th Sep · Wed')
  })

  it('a null date with weekday requested still just says TBA, not "TBA · undefined"', () => {
    expect(formatShortDate(null, { weekday: 'long' })).toBe('TBA')
  })

  it('reads the date as UTC, not the runner\'s local timezone, so it never shifts a day', () => {
    // A date-only string has no time component — parsing it as UTC and
    // reading the weekday back out via UTC keeps day-of-week correct
    // regardless of what timezone this test happens to run in.
    expect(formatShortDate('2026-01-01', { weekday: 'long' })).toBe('1st Jan · Thursday')
  })
})
