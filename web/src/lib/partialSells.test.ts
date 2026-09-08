import { describe, expect, it } from 'vitest'
import {
  allottedShares,
  buildHoldings,
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
  it('prorates bid cost onto the tranche and splits the realized profit', () => {
    // 333 allotted, bid 30000 -> per-share cost ~90.09. Sell 111 @ 150.
    const t = trancheSplit({ shares: 111, price: 150 }, boardRow(), 'Me')
    expect(t.proceeds).toBe(16650)
    // prorated bid for 111/333 of 30000 = 10000
    expect(t.grossProfit).toBeCloseTo(6650, 6)
    // holder is not the profit person and not self-funded -> gets 25% cut
    expect(t.holderCut).toBeCloseTo(1662.5, 4)
    // splitWithFunder false on this row -> funder gets nothing
    expect(t.funderShare).toBe(0)
    expect(t.profitPersonShare).toBeCloseTo(6650 - 1662.5, 4)
  })

  it('a loss on a tranche is never charged to the holder', () => {
    const t = trancheSplit({ shares: 111, price: 50 }, boardRow(), 'Me')
    expect(t.grossProfit).toBeLessThan(0)
    expect(t.holderCut).toBe(0)
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
