import { describe, expect, it } from 'vitest'
import { normalizeIndianPhoneDigits } from './phone'

describe('normalizeIndianPhoneDigits', () => {
  it('keeps a plain 10-digit number', () => {
    expect(normalizeIndianPhoneDigits('9876543210')).toBe('9876543210')
  })

  it('strips a pasted +91 with spaces (the WhatsApp copy format)', () => {
    expect(normalizeIndianPhoneDigits('+91 98765 43210')).toBe('9876543210')
  })

  it('strips +91 with no space', () => {
    expect(normalizeIndianPhoneDigits('+919876543210')).toBe('9876543210')
  })

  it('strips a 0091 country code', () => {
    expect(normalizeIndianPhoneDigits('0091 98765 43210')).toBe('9876543210')
  })

  it('strips a single 0 trunk prefix', () => {
    expect(normalizeIndianPhoneDigits('098765-43210')).toBe('9876543210')
  })

  it('drops punctuation and dashes', () => {
    expect(normalizeIndianPhoneDigits('(98765) 43210')).toBe('9876543210')
  })

  it('caps overly long input at 10 digits', () => {
    expect(normalizeIndianPhoneDigits('987654321099')).toBe('9876543210')
  })

  it('leaves a partial number alone for mid-typing', () => {
    expect(normalizeIndianPhoneDigits('98765')).toBe('98765')
  })

  it('does not strip a leading 9 from a bare 10-digit number starting 91', () => {
    expect(normalizeIndianPhoneDigits('9123456780')).toBe('9123456780')
  })
})
