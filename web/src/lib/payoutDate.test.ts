import { describe, expect, it } from 'vitest'
import { payoutClassificationDate, latestSoldOn, isAllotmentStatus, type PayoutClassifiableRow } from './payoutDate'
import { istDateOf } from './ipoStatus'

function row(over: Partial<PayoutClassifiableRow> = {}): PayoutClassifiableRow {
  return {
    status: 'ALLOTTED',
    applied_at: '2026-08-28T09:00:00Z',
    status_changed_at: '2026-09-02T06:00:00Z',
    application_sells: null,
    ipos: { allotment_date: '2026-09-02' },
    ...over,
  }
}

describe('istDateOf', () => {
  it('returns a bare yyyy-mm-dd unchanged (a Postgres date has no time to shift)', () => {
    expect(istDateOf('2026-09-04')).toBe('2026-09-04')
  })
  it('shifts a UTC timestamp into IST before reading its date', () => {
    // 19:00Z on 31 Aug is 00:30 IST on 1 Sep — belongs to September.
    expect(istDateOf('2026-08-31T19:00:00Z')).toBe('2026-09-01')
    // 18:00Z on 31 Aug is 23:30 IST on 31 Aug — still August.
    expect(istDateOf('2026-08-31T18:00:00Z')).toBe('2026-08-31')
  })
  it('handles the year boundary', () => {
    expect(istDateOf('2025-12-31T19:00:00Z')).toBe('2026-01-01')
  })
})

describe('latestSoldOn', () => {
  it('is null when there are no tranches', () => {
    expect(latestSoldOn({ application_sells: null })).toBeNull()
    expect(latestSoldOn({ application_sells: [] })).toBeNull()
  })
  it('returns the max sold_on across tranches', () => {
    expect(
      latestSoldOn({ application_sells: [{ sold_on: '2026-09-04' }, { sold_on: '2026-09-06' }, { sold_on: '2026-09-02' }] }),
    ).toBe('2026-09-06')
  })
  it('ignores tranches with no sold_on', () => {
    expect(latestSoldOn({ application_sells: [{ sold_on: null }, { sold_on: '2026-09-03' }] })).toBe('2026-09-03')
  })
})

describe('isAllotmentStatus', () => {
  it('is true only for ALLOTTED / PARTIALLY_SOLD / SOLD', () => {
    expect(['ALLOTTED', 'PARTIALLY_SOLD', 'SOLD'].every((s) => isAllotmentStatus(s as never))).toBe(true)
    expect(['APPLIED', 'NOT_ALLOTTED'].some((s) => isAllotmentStatus(s as never))).toBe(false)
  })
})

describe('payoutClassificationDate', () => {
  it('ALLOTTED → the IPO allotment_date, not applied_at (window straddles the month boundary)', () => {
    expect(payoutClassificationDate(row())).toBe('2026-09-02')
  })

  it('ALLOTTED with no allotment_date → falls back to status_changed_at, then applied_at', () => {
    expect(payoutClassificationDate(row({ ipos: { allotment_date: null } }))).toBe('2026-09-02') // status_changed_at
    expect(
      payoutClassificationDate(row({ ipos: null, status_changed_at: undefined })),
    ).toBe('2026-08-28') // applied_at
  })

  it('PARTIALLY_SOLD → the allotment_date for the row itself (its remainder is an open position)', () => {
    expect(payoutClassificationDate(row({ status: 'PARTIALLY_SOLD' }))).toBe('2026-09-02')
  })

  it('SOLD → the latest tranche sold_on', () => {
    const r = row({
      status: 'SOLD',
      status_changed_at: '2026-09-10T10:00:00Z',
      application_sells: [{ sold_on: '2026-09-03' }, { sold_on: '2026-09-05' }],
    })
    expect(payoutClassificationDate(r)).toBe('2026-09-05')
  })

  it('SOLD with no tranches → status_changed_at, normalised to its IST date', () => {
    const r = row({ status: 'SOLD', status_changed_at: '2026-08-31T19:30:00Z', application_sells: null, ipos: null })
    expect(payoutClassificationDate(r)).toBe('2026-09-01')
  })

  it('APPLIED / NOT_ALLOTTED → applied_at (their only real date)', () => {
    expect(payoutClassificationDate(row({ status: 'APPLIED' }))).toBe('2026-08-28')
    expect(payoutClassificationDate(row({ status: 'NOT_ALLOTTED' }))).toBe('2026-08-28')
  })

  it('regression: ESDS & Lumino (applied Aug, allotted Sep) classify to September', () => {
    const esdsTejas = row({
      status: 'PARTIALLY_SOLD',
      applied_at: '2026-08-28T04:00:00Z',
      status_changed_at: '2026-09-09T09:00:00Z',
      application_sells: [{ sold_on: '2026-09-04' }],
      ipos: { allotment_date: '2026-09-02' },
    })
    const luminoHarsh = row({
      status: 'SOLD',
      applied_at: '2026-08-28T04:00:00Z',
      status_changed_at: '2026-09-10T05:00:00Z',
      application_sells: [{ sold_on: '2026-09-03' }],
      ipos: { allotment_date: '2026-09-01' },
    })
    expect(payoutClassificationDate(esdsTejas).slice(0, 7)).toBe('2026-09')
    expect(payoutClassificationDate(luminoHarsh).slice(0, 7)).toBe('2026-09')
  })
})
