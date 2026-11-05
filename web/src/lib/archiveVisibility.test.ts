import { describe, expect, it } from 'vitest'
import { selectArchivedIpos, isResolvedForArchive, describeOpenWork } from './archiveVisibility'

describe('selectArchivedIpos', () => {
  it('returns every archived IPO regardless of anything else about it', () => {
    const ipos = [
      { id: '1', is_archived: true },
      { id: '2', is_archived: false },
      { id: '3', is_archived: true },
    ]
    expect(selectArchivedIpos(ipos)).toEqual([ipos[0], ipos[2]])
  })

  // The actual regression this module exists to prevent: an archived IPO
  // nobody ever applied to must still show up here — it has nowhere else
  // to be found or unarchived from.
  it('includes an archived IPO with no applications tracked against it at all', () => {
    const neverApplied = { id: 'zero-apps', is_archived: true, company_name: 'Glass Wall Systems (India)' }
    expect(selectArchivedIpos([neverApplied])).toEqual([neverApplied])
  })

  it('returns an empty array when nothing is archived', () => {
    expect(selectArchivedIpos([{ id: '1', is_archived: false }])).toEqual([])
  })
})

describe('isResolvedForArchive / describeOpenWork', () => {
  const row = (status: string, demat_cut_paid = false, funder_share_paid = false, sell_price: number | null = status === 'SOLD' ? 100 : null) => ({
    status,
    sell_price,
    demat_cut_paid,
    funder_share_paid,
  })

  it('treats NOT_ALLOTTED and fully paid SOLD as resolved, everything else as open', () => {
    expect(isResolvedForArchive(row('NOT_ALLOTTED'))).toBe(true)
    expect(isResolvedForArchive(row('SOLD', true, true))).toBe(true)
    expect(isResolvedForArchive(row('SOLD', true, false))).toBe(false)
    expect(isResolvedForArchive(row('APPLIED'))).toBe(false)
    expect(isResolvedForArchive(row('ALLOTTED'))).toBe(false)
    expect(isResolvedForArchive(row('PARTIALLY_SOLD'))).toBe(false)
  })

  it('keeps a SOLD application open until its sale price is entered, even if marked paid', () => {
    expect(isResolvedForArchive(row('SOLD', true, true, null))).toBe(false)
    expect(describeOpenWork([row('SOLD', true, true, null)])).toBe('1 sold with no sale price entered')
  })

  it('describes open work in plain words, and nothing when all resolved', () => {
    expect(describeOpenWork([row('NOT_ALLOTTED'), row('SOLD', true, true)])).toBe('')
    expect(
      describeOpenWork([row('APPLIED'), row('APPLIED'), row('ALLOTTED'), row('PARTIALLY_SOLD'), row('SOLD', false, true)]),
    ).toBe('2 still waiting for an allotment result, 2 with shares not fully sold, 1 with payouts not settled')
  })
})
