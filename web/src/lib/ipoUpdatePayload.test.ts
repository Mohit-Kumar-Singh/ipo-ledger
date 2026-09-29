import { describe, expect, it } from 'vitest'
import { withoutEmptyEnrichment } from './ipoUpdatePayload'

describe('withoutEmptyEnrichment', () => {
  it('drops blank enrichment fields so a failed detail scrape cannot wipe known data', () => {
    const payload = {
      company_name: 'NSE',
      lot_size: 8,
      gmp_notes: null,
      allotment_date: null,
      listing_date: null,
      issue_size: null,
      retail_issue_size: null,
      retail_subscription_rate: null,
      registrar: 'OTHER',
    }
    expect(withoutEmptyEnrichment(payload)).toEqual({ company_name: 'NSE', lot_size: 8, gmp_notes: null })
  })

  it('keeps fields ipoji actually reported, including a changed date', () => {
    const payload = {
      company_name: 'NSE',
      allotment_date: '2026-09-22',
      listing_date: '2026-09-24',
      registrar: 'MUFG_INTIME',
      retail_subscription_rate: '12.4x',
    }
    expect(withoutEmptyEnrichment(payload)).toEqual(payload)
  })

  it('still passes live GMP through, even when empty', () => {
    expect(withoutEmptyEnrichment({ company_name: 'X', gmp_notes: null })).toHaveProperty('gmp_notes', null)
  })
})
