import { describe, expect, it } from 'vitest'
import {
  allottedShares,
  buildHoldings,
  partialPayoutMessage,
  partialPositionSplit,
  soldSharesByApplication,
  summariseSells,
  trancheSplit,
  type HoldingSourceRow,
} from './partialSells'
import type { AllotmentBoardRow } from '../types/database'

function boardRow(over: Partial<AllotmentBoardRow> = {}): AllotmentBoardRow {
  return {
    application_id: 'app-1',
    ipo_id: 'ipo-1',
    demat_id: 'demat-1',
    company_name: 'Lunio',
    listing_date: '2026-09-03',
    holder_name: 'Harsh Verma',
    pan_masked: 'XXXXX1234X',
    phone_e164: '+919000000001',
    profit_share_percent: 25,
    bank_name: null,
    last4: null,
    lots: 3,
    bid_amount: 30000,
    status: 'ALLOTTED',
    sell_price: null,
    lot_size: 111,
    split_profit_with_funder: false,
    demat_cut_paid: false,
    funder_share_paid: false,
    upi_id: null,
    bank_account_holder_name: 'Avinash sir',
    bank_account_phone: null,
    mandate_status: 'APPROVED',
    ipo_is_archived: false,
    is_funder_override: false,
    close_date: '2026-08-29',
    demat_linked_user_id: null,
    bank_account_linked_user_id: null,
    status_changed_at: '2026-09-01T00:00:00Z',
    gmp_notes: null,
    platform: null,
    account_manager_id: null,
    account_manager_name: null,
    account_manager_phone: null,
    account_manager_case_type: null,
    ...over,
  }
}

describe('summariseSells', () => {
  it('reports sold / remaining / realized for a partial sale', () => {
    const s = summariseSells({ lot_size: 111, lots: 3 }, [{ shares: 111, price: 111.53 }])
    expect(s.soldShares).toBe(111)
    expect(s.remainingShares).toBe(222)
    expect(s.realizedProceeds).toBeCloseTo(12379.83, 2)
    expect(s.fullySold).toBe(false)
  })

  it('flags fullySold once every allotted share is gone across tranches', () => {
    const s = summariseSells({ lot_size: 100, lots: 1 }, [
      { shares: 40, price: 90 },
      { shares: 60, price: 95 },
    ])
    expect(s.remainingShares).toBe(0)
    expect(s.fullySold).toBe(true)
  })

  it('never goes negative if over-recorded', () => {
    expect(summariseSells({ lot_size: 10, lots: 1 }, [{ shares: 25, price: 5 }]).remainingShares).toBe(0)
  })
})

describe('allottedShares', () => {
  it('is lot_size * lots', () => {
    expect(allottedShares({ lot_size: 111, lots: 3 })).toBe(333)
  })
})

describe('trancheSplit', () => {
  it('prorates bid cost onto the tranche and splits the realized profit 3 ways', () => {
    // 333 allotted, bid 30000 -> per-share cost ~90.09. Sell 111 @ 150.
    const t = trancheSplit({ shares: 111, price: 150 }, boardRow(), 'Me')
    expect(t.proceeds).toBe(16650)
    // prorated bid for 111/333 of 30000 = 10000
    expect(t.grossProfit).toBeCloseTo(6650, 6)
    // holder is not the profit person and not self-funded -> gets 25% cut
    expect(t.holderCut).toBeCloseTo(1662.5, 4)
    // The partial-sell path has no "split with funder" checkbox, so a real
    // distinct funder always takes half the remainder — the fixture's idle
    // split_profit_with_funder=false is deliberately ignored here.
    expect(t.funderShare).toBeCloseTo(2493.75, 4) // (6650 - 1662.5) / 2
    expect(t.profitPersonShare).toBeCloseTo(2493.75, 4)
  })

  it('a CASE_2 shared account still keeps the whole remainder (no third party to split with)', () => {
    const t = trancheSplit({ shares: 111, price: 150 }, boardRow({ account_manager_case_type: 'CASE_2' }), 'Me')
    expect(t.funderShare).toBe(0)
    expect(t.profitPersonShare).toBeCloseTo(6650 - 1662.5, 4)
  })

  it('a loss on a tranche is never charged to the holder', () => {
    const t = trancheSplit({ shares: 111, price: 50 }, boardRow(), 'Me')
    expect(t.grossProfit).toBeLessThan(0)
    expect(t.holderCut).toBe(0)
  })
})

describe('partialPositionSplit — the ESDS / Tejas regression', () => {
  // 1 lot × 34 = 34 shares, ₹14,586 invested (₹429/share). Tejas holds,
  // Avinash funds, 25% cut. 24 sold @ ₹853; 10 held; live price ₹1,542.10.
  const esds = boardRow({
    company_name: 'ESDS Software Solution',
    holder_name: 'Tejas',
    bank_account_holder_name: 'Avinash sir',
    bank_account_phone: '+919000000002',
    lots: 1,
    lot_size: 34,
    bid_amount: 14586,
    status: 'PARTIALLY_SOLD',
    profit_share_percent: 25,
  })
  const sells = [{ shares: 24, price: 853 }]

  it('splits BOTH legs with the funder, and the totals come to ₹7,990 each / ₹5,327 holder cut', () => {
    const s = partialPositionSplit(esds, sells, 1542.1, 'Me')

    // Realized (24 sold): proceeds 20,472 − cost 10,296 = gross 10,176
    expect(s.realized.proceeds).toBe(20472)
    expect(s.realized.costBasis).toBeCloseTo(10296, 6)
    expect(s.realized.grossProfit).toBeCloseTo(10176, 6)
    expect(s.realized.holderCut).toBeCloseTo(2544, 6) // 25%
    expect(s.realized.funderShare).toBeCloseTo(3816, 6) // (10176 − 2544) / 2
    expect(s.realized.yourShare).toBeCloseTo(3816, 6)

    // Held (10 @ 1,542.10): value 15,421 − cost 4,290 = gross 11,131
    expect(s.held).not.toBeNull()
    expect(s.held!.proceeds).toBeCloseTo(15421, 6)
    expect(s.held!.costBasis).toBeCloseTo(4290, 6)
    expect(s.held!.grossProfit).toBeCloseTo(11131, 6)
    expect(s.held!.holderCut).toBeCloseTo(2782.75, 6)
    expect(s.held!.funderShare).toBeCloseTo(4174.125, 4)
    expect(s.held!.yourShare).toBeCloseTo(4174.125, 4)

    // Totals — the numbers the WhatsApp message quotes.
    expect(s.holderCutTotal).toBeCloseTo(5326.75, 4)
    expect(s.funderShareTotal).toBeCloseTo(7990.125, 4)
    expect(s.yourShareTotal).toBeCloseTo(7990.125, 4)
    expect(Math.round(s.yourShareTotal)).toBe(7990)
  })

  it('with no live price, only the realized leg is returned (held is null)', () => {
    const s = partialPositionSplit(esds, sells, null, 'Me')
    expect(s.held).toBeNull()
    expect(s.yourShareTotal).toBeCloseTo(3816, 6) // realized only
    expect(s.heldShares).toBe(10)
  })

  it('a CASE_2 shared account keeps the whole remainder on both legs', () => {
    const s = partialPositionSplit(boardRow({ ...esds, account_manager_case_type: 'CASE_2' }), sells, 1542.1, 'Me')
    expect(s.realized.funderShare).toBe(0)
    expect(s.held!.funderShare).toBe(0)
    expect(s.realized.yourShare).toBeCloseTo(7632, 6) // 10176 − 2544, kept whole
  })

  it('the holder WhatsApp message shows the booked cut and the estimated rest', () => {
    const s = partialPositionSplit(esds, sells, 1542.1, 'Me')
    const msg = partialPayoutMessage(esds, s, 'cut')
    expect(msg).toContain('24 of 34 shares sold')
    expect(msg).toContain('Your 25% cut: ₹2,544')
    expect(msg).toContain('send back ₹10,296 + ₹7,632 = ₹17,928')
    expect(msg).toContain('~₹2,783') // held-leg cut estimate
    expect(msg).toContain('~₹5,327 total')
  })

  it('the funder WhatsApp message shows their booked half and expected half', () => {
    const s = partialPositionSplit(esds, sells, 1542.1, 'Me')
    const msg = partialPayoutMessage(esds, s, 'share')
    expect(msg).toContain('your half = ₹3,816')
    expect(msg).toContain('₹10,296 principal + ₹3,816 = ₹14,112 to you now')
    expect(msg).toContain('~₹4,174')
    expect(msg).toContain('₹3,816 booked')
    expect(msg).toContain('~₹7,990 total')
  })
})

describe('buildHoldings', () => {
  const src: HoldingSourceRow[] = [
    {
      application_id: 'app-1',
      demat_id: 'demat-1',
      holder_name: 'Harsh Verma',
      ipo_id: 'ipo-1',
      ipo_name: 'Lunio',
      symbol: 'LUNIO',
      lot_size: 111,
      lots: 3,
      bid_amount: 30000,
      status: 'PARTIALLY_SOLD',
    },
    {
      application_id: 'app-2',
      demat_id: 'demat-2',
      holder_name: 'Priya Sharma',
      ipo_id: 'ipo-1',
      ipo_name: 'Lunio',
      symbol: 'LUNIO',
      lot_size: 111,
      lots: 1,
      bid_amount: 10000,
      status: 'ALLOTTED',
    },
    {
      application_id: 'app-3',
      demat_id: 'demat-3',
      holder_name: 'Sold Out',
      ipo_id: 'ipo-1',
      ipo_name: 'Lunio',
      symbol: 'LUNIO',
      lot_size: 111,
      lots: 1,
      bid_amount: 10000,
      status: 'SOLD',
    },
  ]

  it('subtracts sold shares and values the remainder at the live price only', () => {
    const sold = soldSharesByApplication([{ application_id: 'app-1', shares: 111 }])
    const { holdings, byHolder } = buildHoldings(src, sold, { LUNIO: 120 })

    // app-3 SOLD excluded; app-1 has 222 left, app-2 has 111 left
    expect(holdings.map((h) => h.holderName)).toEqual(['Harsh Verma', 'Priya Sharma'])
    const harsh = holdings.find((h) => h.holderName === 'Harsh Verma')!
    expect(harsh.remainingShares).toBe(222)
    expect(harsh.liveValue).toBe(Math.round(222 * 120))
    expect(byHolder[0].holderName).toBe('Harsh Verma') // sorted by live value desc
  })

  it('leaves liveValue null when no live price for the symbol', () => {
    const { holdings, byHolder } = buildHoldings(src, {}, {})
    for (const h of holdings) expect(h.liveValue).toBeNull()
    expect(byHolder.every((t) => t.hasUnpricedHolding)).toBe(true)
    expect(byHolder.every((t) => t.liveValue === 0)).toBe(true)
  })
})
