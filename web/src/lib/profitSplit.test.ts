// Regression suite for the one function every profit figure in this app
// ultimately runs through. Each "historical bug" test below encodes a real
// incident from git history/the production audit — the point isn't just
// coverage, it's making sure none of these five can silently come back.
import { describe, expect, it } from 'vitest'
import { computeProfitSplit, namesMatch, effectiveSplitWithFunder, payoutCutContact } from './profitSplit'
import type { AllotmentBoardRow } from '../types/database'

describe('namesMatch', () => {
  it('matches case-insensitively, trimming whitespace', () => {
    expect(namesMatch('Mohit Kumar', '  mohit kumar  ')).toBe(true)
  })
  it('is false for two different names', () => {
    expect(namesMatch('Mohit', 'Jigyansh')).toBe(false)
  })
  // The exact guard that makes profitPersonName='' safe for a non-admin
  // viewer (Dashboard/Payouts pass '' rather than their own name so a
  // funder never spuriously self-matches — see buildPendingPayouts' own
  // comment on this). If this guard ever regressed to treat '' as a real
  // match against another '', a non-admin's own row could silently zero
  // out.
  it('never matches on two empty/null names', () => {
    expect(namesMatch('', '')).toBe(false)
    expect(namesMatch(null, null)).toBe(false)
    expect(namesMatch(undefined, 'Mohit')).toBe(false)
  })
})

// One lot, ₹1,000/share sell price, 100-share lot, ₹80,000 bid, 25% holder
// cut, real distinct funder, standard 50/50 split — the baseline every
// other scenario below is a variation of.
const BASE = {
  sellPricePerShare: 1000,
  lotSize: 100,
  lots: 1,
  bidAmount: 80_000,
  cutPercent: 25,
  dematHolderName: 'Holder A',
  funderName: 'Funder B',
  profitPersonName: 'Admin',
  splitWithFunder: true,
} as const

describe('computeProfitSplit — core 3-way split', () => {
  it('splits gross profit as holder cut, then 50/50 of the remainder', () => {
    const r = computeProfitSplit(BASE)
    // total = 1000*100*1 = 100,000; profit = 100,000 - 80,000 = 20,000
    expect(r.totalSoldAmount).toBe(100_000)
    expect(r.grossProfit).toBe(20_000)
    // holder cut = 20,000 * 25% = 5,000
    expect(r.dematCutAmount).toBe(5_000)
    // remainder = 15,000; funder and admin each get half
    expect(r.remainingAfterCut).toBe(15_000)
    expect(r.funderShare).toBe(7_500)
    expect(r.profitPersonShare).toBe(7_500)
    expect(r.isDematHolderSelf).toBe(false)
    expect(r.isFunderSelf).toBe(false)
    expect(r.hasFunder).toBe(true)
  })

  it('Scenario B — multiple lots scale every figure linearly', () => {
    const r = computeProfitSplit({ ...BASE, lots: 3, bidAmount: 240_000 })
    expect(r.totalSoldAmount).toBe(300_000)
    expect(r.grossProfit).toBe(60_000)
    expect(r.dematCutAmount).toBe(15_000)
    expect(r.funderShare).toBe(22_500)
    expect(r.profitPersonShare).toBe(22_500)
  })

  it("Scenario I — decimal sell price produces a fractional-rupee result (rounding is the caller's job, not this function's)", () => {
    const r = computeProfitSplit({ ...BASE, sellPricePerShare: 1000.5 })
    expect(r.totalSoldAmount).toBeCloseTo(100_050, 5)
    expect(r.grossProfit).toBeCloseTo(20_050, 5)
  })

  it('Scenario J — zero profit (sold at cost) pays nobody anything extra', () => {
    const r = computeProfitSplit({ ...BASE, sellPricePerShare: 800 })
    expect(r.grossProfit).toBe(0)
    expect(r.dematCutAmount).toBe(0)
    expect(r.funderShare).toBe(0)
    expect(r.profitPersonShare).toBe(0)
  })

  it('a loss (sold below cost) produces a negative share, not a clamped zero', () => {
    const r = computeProfitSplit({ ...BASE, sellPricePerShare: 700 })
    expect(r.grossProfit).toBe(-10_000)
    expect(r.profitPersonShare).toBeLessThan(0)
  })
})

describe('computeProfitSplit — a loss is never the account holder\'s to share', () => {
  // BASE: real distinct funder ('Funder B'), 25% holder cut, splitWithFunder
  // true. Sold at 700/share vs 800 bid -> grossProfit = -10,000.
  it('holder gets zero (not a negative cut) and the whole loss splits 50/50 with a real funder — regardless of splitWithFunder', () => {
    const r = computeProfitSplit({ ...BASE, sellPricePerShare: 700, splitWithFunder: false })
    expect(r.grossProfit).toBe(-10_000)
    expect(r.dematCutAmount).toBe(0)
    expect(r.funderShare).toBe(-5_000)
    expect(r.profitPersonShare).toBe(-5_000)
    // Reconciles exactly: nothing paid to the holder, funder + admin sum to
    // the whole loss.
    expect(r.funderShare + r.profitPersonShare).toBe(r.grossProfit)
  })

  it("confirms the old bug this replaces: amountFromHolder (totalSoldAmount - dematCutAmount) no longer exceeds what the sale actually returned", () => {
    const r = computeProfitSplit({ ...BASE, sellPricePerShare: 700 })
    const amountFromHolder = r.totalSoldAmount - r.dematCutAmount
    expect(amountFromHolder).toBe(r.totalSoldAmount)
    expect(amountFromHolder).toBeLessThanOrEqual(r.totalSoldAmount)
  })

  it('no real funder (self-funded, funderName null) — admin alone absorbs the whole loss', () => {
    const r = computeProfitSplit({ ...BASE, sellPricePerShare: 700, funderName: null })
    expect(r.dematCutAmount).toBe(0)
    expect(r.funderShare).toBe(0)
    expect(r.profitPersonShare).toBe(-10_000)
  })

  it('funder IS the profit person (no separate third party) — admin alone absorbs the whole loss', () => {
    const r = computeProfitSplit({ ...BASE, sellPricePerShare: 700, funderName: 'Admin' })
    expect(r.dematCutAmount).toBe(0)
    expect(r.funderShare).toBe(0)
    expect(r.profitPersonShare).toBe(-10_000)
  })

  it('the demat holder genuinely funded their own application (isDematHolderSelf) — they still bear their own loss, same as risking any own capital', () => {
    const r = computeProfitSplit({ ...BASE, sellPricePerShare: 700, dematHolderName: 'Admin', profitPersonName: 'Admin' })
    expect(r.isDematHolderSelf).toBe(true)
    // Unlike the third-party-holder case above, this does NOT special-case
    // to dematCutAmount=0 — it's their own capital, so the existing
    // fold-the-cut-back-into-their-own-share path applies untouched.
    expect(r.dematCutAmount).toBe(-2_500)
    expect(r.funderShare).toBe(-3_750)
    expect(r.profitPersonShare).toBe(-6_250)
    expect(r.funderShare + r.profitPersonShare).toBe(r.grossProfit)
  })
})

describe('computeProfitSplit — self-funded / self-held', () => {
  it('demat holder IS the profit person: their cut folds into their own share instead of being an external payout', () => {
    const r = computeProfitSplit({ ...BASE, dematHolderName: 'Admin', profitPersonName: 'Admin' })
    expect(r.isDematHolderSelf).toBe(true)
    // dematCutAmount is still computed (5,000) but is NOT a separate payout —
    // it's added back into profitPersonShare instead.
    expect(r.dematCutAmount).toBe(5_000)
    expect(r.profitPersonShare).toBe(r.remainingAfterCut - r.funderShare + r.dematCutAmount)
  })

  it('funder IS the profit person: no split happens, the whole remainder is the admin\'s own share', () => {
    const r = computeProfitSplit({ ...BASE, funderName: 'Admin' })
    expect(r.isFunderSelf).toBe(true)
    expect(r.funderShare).toBe(0)
    expect(r.profitPersonShare).toBe(r.remainingAfterCut)
  })

  it('Scenario D — no funder at all (self-funded application, funderName null) behaves the same as isFunderSelf', () => {
    const r = computeProfitSplit({ ...BASE, funderName: null })
    expect(r.hasFunder).toBe(false)
    expect(r.isFunderSelf).toBe(true)
    expect(r.funderShare).toBe(0)
  })

  it('Scenario K — an empty-string funder name is treated as "no funder", not a real (mis-)match', () => {
    const r = computeProfitSplit({ ...BASE, funderName: '' })
    expect(r.hasFunder).toBe(false)
  })
})

describe('computeProfitSplit — historical bug regressions', () => {
  // v1.172.1: demat_accounts has no funder-visibility RLS policy, so a
  // funder viewing an account they don't personally own got
  // profit_share_percent back as null from the join. Every call site fixed
  // this with a `?? 25` fallback at the CALL SITE (not inside this
  // function) — this test pins down that computeProfitSplit itself does
  // exactly what a caller asks when cutPercent is a real 0, so that
  // behavior is never confused with the null-coercion bug that inflated a
  // real funder's payout by ₹526 (₹17,086 shown vs. the correct ₹16,560).
  it('cutPercent=0 is a real "no cut" instruction, distinct from the null-coercion bug', () => {
    const r = computeProfitSplit({ ...BASE, cutPercent: 0 })
    expect(r.dematCutAmount).toBe(0)
    expect(r.funderShare).toBe(10_000) // full 20,000 remainder split 50/50
  })

  // v1.189.0→v1.189.1: the pre-sale projection briefly read
  // applications.split_profit_with_funder (which defaults false at the DB
  // level and is only ever really set at SALE time) as if it were a
  // decision already made, handing the admin 100% of the remainder on
  // every still-allotted application. splitWithFunder=false is a real,
  // deliberate instruction from the CALLER — this function doing exactly
  // that is correct; the bug was upstream, feeding it a false that didn't
  // mean anything yet. Pinned here so nobody "fixes" this function itself
  // in response to that report.
  it('splitWithFunder=false gives the admin the WHOLE remainder, not half', () => {
    const r = computeProfitSplit({ ...BASE, splitWithFunder: false })
    expect(r.funderShare).toBe(0)
    expect(r.profitPersonShare).toBe(15_000) // the full remainder, not 7,500
  })
})

// --- effectiveSplitWithFunder / payoutCutContact (moved here from
// AllotmentBoardPage.tsx — pure business rules, no reason to live on a page
// component; see profitSplit.ts's own comment on the move) ---

function boardRow(overrides: Partial<AllotmentBoardRow> = {}): AllotmentBoardRow {
  return {
    application_id: 'app-1',
    ipo_id: 'ipo-1',
    demat_id: 'demat-1',
    company_name: 'Test Co',
    listing_date: null,
    holder_name: 'Holder A',
    pan_masked: 'XXXXX0000X',
    phone_e164: '+910000000001',
    profit_share_percent: 25,
    bank_name: null,
    last4: null,
    lots: 1,
    bid_amount: 80_000,
    status: 'SOLD',
    sell_price: 1000,
    lot_size: 100,
    split_profit_with_funder: true,
    demat_cut_paid: false,
    funder_share_paid: false,
    upi_id: null,
    bank_account_holder_name: 'Funder B',
    bank_account_phone: '+910000000002',
    mandate_status: 'APPROVED',
    ipo_is_archived: false,
    is_funder_override: false,
    close_date: '2026-01-01',
    demat_linked_user_id: null,
    status_changed_at: '2026-01-01T00:00:00Z',
    gmp_notes: null,
    platform: null,
    account_manager_id: null,
    account_manager_name: null,
    account_manager_phone: null,
    account_manager_case_type: null,
    bank_account_linked_user_id: null,
    ...overrides,
  }
}

describe('effectiveSplitWithFunder', () => {
  it('a normal (non-shared) row keeps whatever the caller asked for', () => {
    expect(effectiveSplitWithFunder(boardRow(), true)).toBe(true)
    expect(effectiveSplitWithFunder(boardRow(), false)).toBe(false)
  })
  it('a CASE_1 shared account also keeps the caller\'s request — a separate funder still gets a share', () => {
    expect(effectiveSplitWithFunder(boardRow({ account_manager_case_type: 'CASE_1' }), true)).toBe(true)
  })
  it('a CASE_2 shared account (manager IS the funder) always forces the split off', () => {
    expect(effectiveSplitWithFunder(boardRow({ account_manager_case_type: 'CASE_2' }), true)).toBe(false)
  })
})

describe('payoutCutContact', () => {
  it('routes to the literal PAN holder for a normal account', () => {
    expect(payoutCutContact(boardRow())).toEqual({ name: 'Holder A', phone: '+910000000001' })
  })
  it('routes to the shared-account manager, not the literal holder, when one is assigned', () => {
    const row = boardRow({
      account_manager_id: 'mgr-1',
      account_manager_name: 'Person X',
      account_manager_phone: '+910000000009',
    })
    expect(payoutCutContact(row)).toEqual({ name: 'Person X', phone: '+910000000009' })
  })
})
