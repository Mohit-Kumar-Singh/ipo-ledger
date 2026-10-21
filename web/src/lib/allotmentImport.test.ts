import { describe, expect, it } from 'vitest'
import { allotmentIssues, isAllotmentPaste, planAllotment, type AllotmentRow, type AppRef } from './allotmentImport'

const row = (pan: string, result: AllotmentRow['result']): AllotmentRow => ({
  kind: 'allotment',
  ipo: 'HD Fire',
  applicant: 'x',
  panNumber: pan,
  status: result,
  result,
})
const app = (over: Partial<AppRef>): AppRef => ({
  id: 'a1',
  ipo_id: 'ipo1',
  demat_id: 'd1',
  status: 'APPLIED',
  category: 'RETAIL',
  mandate_status: 'APPROVED',
  ...over,
})
const resolveTo = (dematId: string | null, ipoId: string | null = 'ipo1') => () => ({ ipoId, dematId, holderName: 'H' })

describe('planAllotment', () => {
  it('updates an APPLIED application to the ipoji result', () => {
    const [i] = planAllotment([row('P', 'ALLOTTED')], resolveTo('d1'), [app({})])
    expect(i.action).toBe('update')
    expect(i.newStatus).toBe('ALLOTTED')
    expect(i.applicationId).toBe('a1')
  })

  it('maps NOT_ALLOTTED too', () => {
    const [i] = planAllotment([row('P', 'NOT_ALLOTTED')], resolveTo('d1'), [app({})])
    expect(i.newStatus).toBe('NOT_ALLOTTED')
  })

  it('leaves already-correct and already-moved-on applications alone', () => {
    const [same] = planAllotment([row('P', 'ALLOTTED')], resolveTo('d1'), [app({ status: 'ALLOTTED' })])
    expect(same.action).toBe('already')
    const [sold] = planAllotment([row('P', 'ALLOTTED')], resolveTo('d1'), [app({ status: 'SOLD' })])
    expect(sold.action).toBe('final')
    const [flip] = planAllotment([row('P', 'NOT_ALLOTTED')], resolveTo('d1'), [app({ status: 'ALLOTTED' })])
    expect(flip.action).toBe('final')
  })

  it('does not guess when an account has two live applications (retail + shareholder)', () => {
    const items = planAllotment([row('P', 'ALLOTTED')], resolveTo('d1'), [
      app({ id: 'a1' }),
      app({ id: 'a2', category: 'SHAREHOLDER' }),
    ])
    expect(items[0].action).toBe('ambiguous')
    expect(allotmentIssues(items)).toHaveLength(1)
  })

  it('ignores cancelled mandates and flags a result with no live application', () => {
    const [i] = planAllotment([row('P', 'ALLOTTED')], resolveTo('d1'), [app({ mandate_status: 'CANCELLED' })])
    expect(i.action).toBe('no-application')
  })

  it('flags unmatched IPO / account, ignores no-record, flags unfinished rows', () => {
    const items = planAllotment(
      [row('A', 'ALLOTTED'), row('B', 'ALLOTTED'), row('C', 'NO_RECORD'), row('D', 'PENDING')],
      (r) =>
        r.panNumber === 'A'
          ? { ipoId: null, dematId: 'd1', holderName: null }
          : r.panNumber === 'B'
            ? { ipoId: 'ipo1', dematId: null, holderName: null }
            : { ipoId: 'ipo1', dematId: 'd1', holderName: 'H' },
      [app({})],
    )
    expect(items.map((i) => i.action)).toEqual(['unmatched-ipo', 'unmatched-account', 'ignore', 'ignore'])
    expect(allotmentIssues(items).map((i) => i.row.panNumber)).toEqual(['A', 'B', 'D'])
  })

  it('recognises an allotment paste', () => {
    expect(isAllotmentPaste([row('P', 'ALLOTTED')])).toBe(true)
    expect(isAllotmentPaste([{ ipo: 'x' }])).toBe(false)
    expect(isAllotmentPaste([])).toBe(false)
  })
})
