import { describe, expect, it } from 'vitest'
import { buildPayoutAnalytics, resolveDateRange } from './payoutAnalytics'
import type { ProfitProjectionRow } from './expectedProfit'
import type { SettlementPayment } from '../types/database'

// "Today" for every range in this file — 10 Sep 2026 IST.
const TODAY = '2026-09-10'
const THIS_MONTH = resolveDateRange('this_month', TODAY) // 2026-09-01 .. 2026-09-10
const LAST_MONTH = resolveDateRange('last_month', TODAY) // 2026-08-01 .. 2026-08-31

const NO_PRICES: Record<string, number | null> = {}
const NO_CASE2 = new Set<string>()

let seq = 0
function pr(over: Partial<ProfitProjectionRow> = {}): ProfitProjectionRow {
  seq += 1
  return {
    id: `app-${seq}`,
    demat_id: `demat-${seq}`,
    ipo_id: 'ipo-esds',
    lots: 1,
    applied_at: '2026-08-28T04:00:00Z',
    status_changed_at: '2026-09-02T06:00:00Z',
    status: 'ALLOTTED',
    mandate_status: 'APPROVED',
    ipoji_status_text: null,
    bid_amount: 14_586,
    sell_price: null,
    split_profit_with_funder: false,
    application_sells: null,
    ipos: {
      company_name: 'ESDS Software Solution',
      open_date: '2026-08-28',
      close_date: '2026-09-01',
      allotment_date: '2026-09-02',
      listing_date: '2026-09-04',
      price_high: 486,
      lot_size: 30,
      gmp_notes: 'GMP: (10%)',
      is_archived: false,
      symbol: 'ESDS',
    },
    demat_accounts: {
      holder_name: 'Tejas',
      profit_share_percent: 25,
      phone_e164: null,
      account_manager_id: null,
    },
    bank_accounts: { account_holder_name: 'Avinash sir', phone_e164: null, upi_id: null },
    funder_override: null,
    ...over,
  }
}

const lumino = (over: Partial<ProfitProjectionRow> = {}) =>
  pr({
    ipo_id: 'ipo-lumino',
    bid_amount: 14_924,
    ipos: {
      company_name: 'Lumino Industries',
      open_date: '2026-08-27',
      close_date: '2026-08-31',
      allotment_date: '2026-09-01',
      listing_date: '2026-09-03',
      price_high: 100,
      lot_size: 150,
      gmp_notes: 'GMP: (5%)',
      is_archived: false,
      symbol: 'LUMINO',
    },
    demat_accounts: { holder_name: 'Harsh Verma(lame)', profit_share_percent: 25, phone_e164: null, account_manager_id: null },
    ...over,
  })

function build(rows: ProfitProjectionRow[], range = THIS_MONTH, payments: SettlementPayment[] = []) {
  return buildPayoutAnalytics(rows, [], payments, range, 'Admin', NO_CASE2, NO_PRICES)
}

// ─────────────────────────────────────────────────────────────────────────
describe('resolveDateRange — boundaries', () => {
  it('this_month starts on the 1st (IST), ends today', () => {
    expect(THIS_MONTH.start).toBe('2026-09-01')
    expect(THIS_MONTH.end).toBe('2026-09-10')
  })
  it('last_month is the whole previous calendar month', () => {
    expect(LAST_MONTH.start).toBe('2026-08-01')
    expect(LAST_MONTH.end).toBe('2026-08-31') // 31 days, not 30
  })
  it('last_month across the year boundary → December of the previous year', () => {
    const r = resolveDateRange('last_month', '2026-01-14')
    expect(r.start).toBe('2025-12-01')
    expect(r.end).toBe('2025-12-31')
  })
  it('this_month in January stays in January', () => {
    const r = resolveDateRange('this_month', '2026-01-14')
    expect(r.start).toBe('2026-01-01')
    expect(r.end).toBe('2026-01-14')
  })
  it('last_month for a 30-day month reports 30, not 31', () => {
    expect(resolveDateRange('last_month', '2026-05-10').end).toBe('2026-04-30')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('month classification — one row, one month (ESDS / Lumino regression)', () => {
  // Applied 28 Aug, allotted 2 Sep, one tranche sold 4 Sep, remainder held.
  const esdsTejas = pr({
    status: 'PARTIALLY_SOLD',
    status_changed_at: '2026-09-09T09:00:00Z',
    application_sells: [{ shares: 15, price: 620, sold_on: '2026-09-04' }],
  })
  // Applied 28 Aug, allotted 1 Sep, fully sold (one tranche) 3 Sep.
  const luminoHarsh = lumino({
    status: 'SOLD',
    sell_price: 99.51,
    status_changed_at: '2026-09-10T05:00:00Z',
    application_sells: [{ shares: 150, price: 99.51, sold_on: '2026-09-03' }],
  })

  it('LAST month (August): ESDS and Lumino contribute nothing at all', () => {
    const a = build([esdsTejas, luminoHarsh], LAST_MONTH)
    expect(a.summary.totalProfit).toBe(0)
    expect(a.summary.realizedProfit).toBe(0)
    expect(a.summary.unrealizedProfit).toBe(0)
    expect(a.summary.totalInvested).toBe(0)
    expect(a.summary.totalSharesAllotted).toBe(0)
    expect(a.statusBreakdown.sold).toBe(0)
    expect(a.statusBreakdown.partiallySold).toBe(0)
    expect(a.ipoAccountBreakdown).toHaveLength(0)
    expect(a.ipoBreakdown).toHaveLength(0)
  })

  it('THIS month (September): both appear, with realized profit booked', () => {
    const a = build([esdsTejas, luminoHarsh], THIS_MONTH)
    expect(a.statusBreakdown.sold).toBe(1)
    expect(a.statusBreakdown.partiallySold).toBe(1)
    expect(a.realizedLines.length).toBe(2) // one per row (each has a single tranche)
    expect(a.summary.realizedProfit).not.toBe(0)
    // ESDS still holds 15 of 30 shares → an unrealized line too.
    expect(a.unrealizedLines.some((l) => l.ipoName.startsWith('ESDS'))).toBe(true)
    const names = a.ipoAccountBreakdown.map((r) => r.ipoName).sort()
    expect(names).toEqual(['ESDS Software Solution', 'Lumino Industries'])
  })

  it('neither IPO is ever in BOTH months', () => {
    const sep = build([esdsTejas, luminoHarsh], THIS_MONTH).ipoAccountBreakdown.map((r) => r.ipoId)
    const aug = build([esdsTejas, luminoHarsh], LAST_MONTH).ipoAccountBreakdown.map((r) => r.ipoId)
    expect(sep.filter((id) => aug.includes(id))).toHaveLength(0)
  })

  it('a pile of still-APPLIED rows on those IPOs never shows in either month', () => {
    const appliedOnly = [pr({ status: 'APPLIED' }), pr({ status: 'APPLIED' }), lumino({ status: 'APPLIED' })]
    expect(build(appliedOnly, THIS_MONTH).ipoAccountBreakdown).toHaveLength(0)
    expect(build(appliedOnly, LAST_MONTH).ipoAccountBreakdown).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('month-end / IST-midnight boundary', () => {
  it('a sale at 00:30 IST on 1 Sep (19:00Z 31 Aug) is September, not August', () => {
    const r = pr({ status: 'SOLD', sell_price: 600, application_sells: null, status_changed_at: '2026-08-31T19:00:00Z' })
    expect(build([r], THIS_MONTH).statusBreakdown.sold).toBe(1)
    expect(build([r], LAST_MONTH).statusBreakdown.sold).toBe(0)
  })
  it('a sale at 23:30 IST on 31 Aug (18:00Z) is August', () => {
    const r = pr({ status: 'SOLD', sell_price: 600, application_sells: null, status_changed_at: '2026-08-31T18:00:00Z' })
    expect(build([r], LAST_MONTH).statusBreakdown.sold).toBe(1)
    expect(build([r], THIS_MONTH).statusBreakdown.sold).toBe(0)
  })
  it('a settlement payment is bucketed by its own IST date', () => {
    const paidSep: SettlementPayment = {
      id: 'p1', application_id: 'x', kind: 'admin_to_funder', amount: 5000,
      note: null, created_by: null, created_at: '2026-08-31T20:00:00Z', idempotency_key: null,
    }
    expect(build([], THIS_MONTH, [paidSep]).summary.totalPayout).toBe(5000)
    expect(build([], LAST_MONTH, [paidSep]).summary.totalPayout).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('year boundary', () => {
  it('a December sale shows under "last month" when viewed in January', () => {
    const dec = resolveDateRange('last_month', '2026-01-09')
    const r = pr({
      status: 'SOLD', sell_price: 600, status_changed_at: '2025-12-20T06:00:00Z',
      application_sells: [{ shares: 30, price: 600, sold_on: '2025-12-20' }],
      ipos: { ...pr().ipos!, allotment_date: '2025-12-15', listing_date: '2025-12-18' },
    })
    const a = buildPayoutAnalytics([r], [], [], dec, 'Admin', NO_CASE2, NO_PRICES)
    expect(a.statusBreakdown.sold).toBe(1)
    expect(a.summary.realizedProfit).not.toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('allotment / payment independence', () => {
  it('allotment with no payment: an unrealized line, nothing paid', () => {
    const a = build([pr({ status: 'ALLOTTED' })])
    expect(a.unrealizedLines).toHaveLength(1)
    expect(a.summary.totalPayout).toBe(0)
    expect(a.statusBreakdown.allotted).toBe(1)
  })
  it('payment with no matching allotment row still counts toward payout paid', () => {
    const pay: SettlementPayment = {
      id: 'p9', application_id: 'orphan', kind: 'admin_to_funder', amount: 2500,
      note: null, created_by: null, created_at: '2026-09-05T06:00:00Z', idempotency_key: null,
    }
    expect(build([], THIS_MONTH, [pay]).summary.totalPayout).toBe(2500)
  })
  it('two payments on one application both count', () => {
    const mk = (id: string, amount: number): SettlementPayment => ({
      id, application_id: 'a1', kind: 'admin_to_funder', amount,
      note: null, created_by: null, created_at: '2026-09-05T06:00:00Z', idempotency_key: null,
    })
    expect(build([], THIS_MONTH, [mk('p1', 1000), mk('p2', 1500)]).summary.totalPayout).toBe(2500)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('account-holder mapping', () => {
  it('multiple holders on one IPO → one card, both accounts, allotted = 2', () => {
    const a = build([
      pr({ status: 'ALLOTTED', demat_accounts: { holder_name: 'Tejas', profit_share_percent: 25, phone_e164: null, account_manager_id: null } }),
      pr({ status: 'ALLOTTED', demat_accounts: { holder_name: 'Apra', profit_share_percent: 25, phone_e164: null, account_manager_id: null } }),
    ])
    expect(a.ipoAccountBreakdown).toHaveLength(1)
    expect(a.ipoAccountBreakdown[0].allotted).toBe(2)
    expect(a.ipoAccountBreakdown[0].accounts).toHaveLength(2)
  })
  it('the same (holder, funder) pair twice → deduped to one account, allotted still counts both rows', () => {
    const a = build([pr({ status: 'ALLOTTED' }), pr({ status: 'ALLOTTED' })])
    expect(a.ipoAccountBreakdown[0].allotted).toBe(2)
    expect(a.ipoAccountBreakdown[0].accounts).toHaveLength(1)
  })
  it('a missing demat embed does not throw — holder shows as Unknown', () => {
    const a = build([pr({ status: 'ALLOTTED', demat_accounts: null })])
    expect(a.ipoAccountBreakdown[0].accounts[0].holderName).toBe('Unknown')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('partial profit booking', () => {
  const partial = pr({
    status: 'PARTIALLY_SOLD',
    lots: 1,
    bid_amount: 10_000,
    ipos: { ...pr().ipos!, price_high: 100, lot_size: 100, gmp_notes: 'GMP: (20%)', symbol: 'PART', allotment_date: '2026-09-02' },
    status_changed_at: '2026-09-05T06:00:00Z',
    application_sells: [{ shares: 40, price: 150, sold_on: '2026-09-04' }],
  })

  it('the realized tranche and the held remainder are both counted, and reconcile to the whole bid', () => {
    const a = build([partial])
    expect(a.realizedLines).toHaveLength(1)
    expect(a.unrealizedLines).toHaveLength(1)
    const invested = (a.realizedLines[0].investedAmount ?? 0) + a.unrealizedLines[0].investedAmount
    expect(invested).toBe(10_000)
    expect(a.summary.totalInvested).toBe(10_000)
  })

  it('realized profit does not vanish while the position is still partly held', () => {
    expect(build([partial]).summary.realizedProfit).toBeGreaterThan(0)
  })

  it('multiple partial sells in different months each land in their own month', () => {
    const twoTranche = pr({
      status: 'PARTIALLY_SOLD',
      bid_amount: 10_000,
      ipos: { ...pr().ipos!, price_high: 100, lot_size: 100, allotment_date: '2026-08-20', listing_date: '2026-08-25' },
      status_changed_at: '2026-09-04T06:00:00Z',
      application_sells: [
        { shares: 30, price: 120, sold_on: '2026-08-28' },
        { shares: 20, price: 130, sold_on: '2026-09-04' },
      ],
    })
    const aug = build([twoTranche], LAST_MONTH)
    const sep = build([twoTranche], THIS_MONTH)
    expect(aug.realizedLines).toHaveLength(1)
    expect(aug.realizedLines[0].realizedAt).toBe('2026-08-28')
    expect(sep.realizedLines).toHaveLength(1)
    expect(sep.realizedLines[0].realizedAt).toBe('2026-09-04')
    // the still-held remainder is projected in August (its allotment month), once
    expect(aug.unrealizedLines).toHaveLength(1)
    expect(sep.unrealizedLines).toHaveLength(0)
  })

  it('partial then full sell: one realized line, dated by the last tranche', () => {
    const fully = pr({
      status: 'SOLD',
      sell_price: 135,
      bid_amount: 10_000,
      ipos: { ...pr().ipos!, price_high: 100, lot_size: 100, allotment_date: '2026-09-01' },
      status_changed_at: '2026-09-30T06:00:00Z',
      application_sells: [
        { shares: 60, price: 130, sold_on: '2026-09-05' },
        { shares: 40, price: 142.5, sold_on: '2026-09-08' },
      ],
    })
    const a = build([fully])
    expect(a.realizedLines).toHaveLength(1)
    expect(a.realizedLines[0].realizedAt).toBe('2026-09-08')
    expect(a.unrealizedLines).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('defensive / null handling', () => {
  it('a null ipos embed is skipped, not thrown on', () => {
    expect(() => build([pr({ status: 'ALLOTTED', ipos: null })])).not.toThrow()
    expect(build([pr({ status: 'ALLOTTED', ipos: null })]).unrealizedLines).toHaveLength(0)
  })
  it('a null bid_amount produces no profit line', () => {
    const a = build([pr({ status: 'ALLOTTED', bid_amount: null })])
    expect(a.unrealizedLines).toHaveLength(0)
    expect(a.summary.totalInvested).toBe(0)
  })
  it('a CANCELLED mandate is excluded from every count', () => {
    const a = build([pr({ status: 'ALLOTTED', mandate_status: 'CANCELLED' })])
    expect(a.statusBreakdown.allotted).toBe(0)
    expect(a.ipoAccountBreakdown).toHaveLength(0)
  })
  it('ROI is 0 (not NaN/Infinity) when nothing is invested in range', () => {
    expect(build([], LAST_MONTH).summary.roi).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('ROI is self-consistent with the range profit', () => {
  it('roi === totalProfit / totalInvested * 100 over the same lines', () => {
    const a = build([
      pr({ status: 'ALLOTTED' }),
      lumino({ status: 'SOLD', sell_price: 130, status_changed_at: '2026-09-06T06:00:00Z', application_sells: [{ shares: 150, price: 130, sold_on: '2026-09-06' }] }),
    ])
    expect(a.summary.roi).toBeCloseTo((a.summary.totalProfit / a.summary.totalInvested) * 100, 6)
  })
})
