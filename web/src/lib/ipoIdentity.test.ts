import { describe, expect, it } from 'vitest'
import { extractIpojiSlug, findExistingIpoMatch, normalizeIpoName } from './ipoIdentity'

describe('normalizeIpoName', () => {
  it('lowercases, trims, and collapses internal whitespace', () => {
    expect(normalizeIpoName('  Coal   India  ')).toBe('coal india')
  })

  it('treats differently-cased names as equal', () => {
    expect(normalizeIpoName('COAL INDIA')).toBe(normalizeIpoName('coal india'))
  })
})

describe('extractIpojiSlug', () => {
  it('pulls the slug out of a full ipoji detail URL', () => {
    expect(extractIpojiSlug('https://www.ipoji.com/ipo/nse-ipo')).toBe('nse-ipo')
  })

  it('is case-insensitive and normalizes to lowercase', () => {
    expect(extractIpojiSlug('https://www.ipoji.com/ipo/NSE-IPO')).toBe('nse-ipo')
  })

  it('ignores a trailing slash or query string', () => {
    expect(extractIpojiSlug('https://www.ipoji.com/ipo/nse-ipo/')).toBe('nse-ipo')
    expect(extractIpojiSlug('https://www.ipoji.com/ipo/nse-ipo?utm=x')).toBe('nse-ipo')
  })

  it('returns null for a non-ipo URL or missing input', () => {
    expect(extractIpojiSlug('https://www.ipoji.com/ipo/current-ipo'.replace('/ipo/', '/'))).toBeNull()
    expect(extractIpojiSlug(null)).toBeNull()
    expect(extractIpojiSlug(undefined)).toBeNull()
  })
})

describe('findExistingIpoMatch', () => {
  // The actual regression this whole module exists to fix: ipoji renamed
  // "National Stock Exchange of India" to "NSE" mid-bidding. Company-name
  // matching alone can never catch this (the strings share no normalizable
  // substring) — only the slug, which ipoji kept stable across the rename
  // via a redirect, can.
  it('matches by slug even when the company name has completely changed', () => {
    const existing = [{ id: 'nse-1', company_name: 'National Stock Exchange of India', ipoji_slug: 'nse-ipo' }]
    const match = findExistingIpoMatch({ ipojiSlug: 'nse-ipo', companyName: 'NSE' }, existing)
    expect(match?.id).toBe('nse-1')
  })

  it('falls back to a case/whitespace-insensitive name match when the candidate has no slug', () => {
    const existing = [{ id: 'c1', company_name: 'Coal India', ipoji_slug: null }]
    const match = findExistingIpoMatch({ ipojiSlug: null, companyName: '  coal   INDIA  ' }, existing)
    expect(match?.id).toBe('c1')
  })

  it('falls back to name match when the candidate has a slug but no existing row carries it yet (legacy rows)', () => {
    const existing = [{ id: 'c1', company_name: 'Coal India', ipoji_slug: null }]
    const match = findExistingIpoMatch({ ipojiSlug: 'coal-india-ipo', companyName: 'Coal India' }, existing)
    expect(match?.id).toBe('c1')
  })

  it('prefers a slug match over a coincidental name match when both are present', () => {
    const existing = [
      { id: 'stale-name-match', company_name: 'Nse', ipoji_slug: 'some-other-ipo' },
      { id: 'real-slug-match', company_name: 'National Stock Exchange of India', ipoji_slug: 'nse-ipo' },
    ]
    const match = findExistingIpoMatch({ ipojiSlug: 'nse-ipo', companyName: 'NSE' }, existing)
    expect(match?.id).toBe('real-slug-match')
  })

  it('returns null when nothing matches by slug or name', () => {
    const existing = [{ id: 'c1', company_name: 'Coal India', ipoji_slug: 'coal-india-ipo' }]
    const match = findExistingIpoMatch({ ipojiSlug: 'nse-ipo', companyName: 'NSE' }, existing)
    expect(match).toBeNull()
  })

  it('does not merge two genuinely different IPOs that happen to share nothing but similar-looking names', () => {
    const existing = [{ id: 'c1', company_name: 'Glass Wall Systems (India)', ipoji_slug: 'glass-wall-systems-ipo' }]
    const match = findExistingIpoMatch({ ipojiSlug: 'glass-wall-holdings-ipo', companyName: 'Glass Wall Holdings' }, existing)
    expect(match).toBeNull()
  })
})
