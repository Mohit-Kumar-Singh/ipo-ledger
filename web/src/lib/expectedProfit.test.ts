import { describe, expect, it } from 'vitest'
import {
  effectiveFunder,
  buildFunderAllottedCards,
  expectedProfitBreakdown,
  buildBookedProfitLines,
  buildUnrealizedProfitLines,
  type ProfitProjectionRow,
  type FunderAllottedCard,
} from './expectedProfit'

const sameIdentity = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

function row(overrides: Partial<ProfitProjectionRow> = {}): ProfitProjectionRow {
  return {
    id: 'app-1',
    ipo_id: 'ipo-1',
    lots: 1,
    applied_at: '2026-01-01T00:00:00Z',
    status_changed_at: '2026-01-05T00:00:00Z',
    status: 'ALLOTTED',
    mandate_status: 'APPROVED',
    ipoji_status_text: null,
    bid_amount: 14_807, // matches the real Dhoot Transmission row the audit traced
    sell_price: null,
    split_profit_with_funder: false, // the DB's own idle default pre-sale — deliberately left false in every fixture below to prove the projection functions don't trust it
    ipos: {
      company_name: 'Dhoot Transmission',
      open_date: '2026-08-10',
      close_date: '2026-08-12',
      listing_date: '2026-08-17',
      price_high: 871,
      lot_size: 17,
      gmp_notes: 'GMP: ₹261-263 (30%)',
      is_archived: false,
      symbol: 'DHOOTTRANS',
    },
    demat_accounts: {
      holder_name: 'Aviral Patel',
      profit_share_percent: 25,
      phone_e164: '+910000000001',
      account_manager_id: null,
    },
    bank_accounts: { account_holder_name: 'Avinash sir', phone_e164: '+910000000002', upi_id: null },
    funder_override: null,
    ...overrides,
  }
}

describe('effectiveFunder', () => {
  it('prefers a manual funder_override over the literal bank_accounts row', () => {
    const r = row({ funder_override: { account_holder_name: 'Override Person', phone_e164: null, upi_id: null } })
    expect(effectiveFunder(r)?.account_holder_name).toBe('Override Person')
  })
  it('falls back to the demat holder\'s own identity when there\'s no bank/UPI account on file at all (self-funded)', () => {
    const r = row({ bank_accounts: null, funder_override: null })
    expect(effectiveFunder(r)?.account_holder_name).toBe('Aviral Patel')
  })
})

describe('buildFunderAllottedCards — grouping and weighted cut%', () => {
  it('groups multiple applications under the same funder+IPO into one card, weighting cut% by lots', () => {
    const rows = [
      row({ id: 'a', lots: 1, demat_accounts: { ...row().demat_accounts!, profit_share_percent: 20 } }),
      row({ id: 'b', lots: 3, demat_accounts: { ...row().demat_accounts!, profit_share_percent: 40 }, bank_accounts: { account_holder_name: 'Avinash sir', phone_e164: null, upi_id: null } }),
    ]
    const cards = buildFunderAllottedCards(rows, sameIdentity)
    expect(cards).toHaveLength(1)
    // (20*1 + 40*3) / 4 = 35
    expect(cards[0].cutPercent).toBe(35)
    expect(cards[0].totalLots).toBe(4)
  })

  it('ignores APPLIED/NOT_ALLOTTED rows — only ALLOTTED or SOLD count toward a card', () => {
    const cards = buildFunderAllottedCards([row({ status: 'APPLIED' })], sameIdentity)
    expect(cards).toHaveLength(0)
  })

  it('a CASE_2 shared account forces splitWithFunder off on the card; a normal row leaves it on', () => {
    const normal = buildFunderAllottedCards([row()], sameIdentity, new Set())
    expect(normal[0].splitWithFunder).toBe(true)

    const case2Row = row({ demat_accounts: { ...row().demat_accounts!, account_manager_id: 'mgr-1' } })
    const withCase2 = buildFunderAllottedCards([case2Row], sameIdentity, new Set(['mgr-1']))
    expect(withCase2[0].splitWithFunder).toBe(false)
  })

  it('regression: an idle split_profit_with_funder=false on the row does NOT turn splitWithFunder off — only CASE_2 does', () => {
    // Every fixture row() already sets split_profit_with_funder: false (the
    // DB's own pre-sale default) precisely to prove this function ignores it.
    const cards = buildFunderAllottedCards([row()], sameIdentity)
    expect(cards[0].splitWithFunder).toBe(true)
  })
})

describe('expectedProfitBreakdown', () => {
  const card: FunderAllottedCard = {
    key: 'k',
    funderName: 'Avinash sir',
    phone: null,
    ipoId: 'ipo-1',
    ipoName: 'Dhoot Transmission',
    listingDate: '2026-08-17',
    priceHigh: 871,
    lotSize: 17,
    gmpPercent: 30,
    symbol: 'DHOOTTRANS',
    holderNames: [{ name: 'Aviral Patel', isOverride: false }],
    totalLots: 1,
    cutPercent: 25,
    _cutWeightedSum: 25,
    splitWithFunder: true,
  }

  it('GMP-based estimate: lotAmount, profit, and the 3-way split all derive from the same numbers', () => {
    const b = expectedProfitBreakdown(card, null)
    expect(b.priceSource).toBe('gmp')
    expect(b.lotAmount).toBe(871 * 17) // 14,807
    expect(b.soldPrice).toBe(Math.round(14_807 * 1.3)) // 19,249
    expect(b.profitPerLot).toBe(b.soldPrice - b.lotAmount)
    // holder cut + net profit must always reconstruct the full per-lot profit
    expect(b.holderCutTotal + b.netProfitPerLot).toBe(b.profitPerLot)
  })

  it('a live price overrides the GMP estimate once the IPO is actually listed', () => {
    const b = expectedProfitBreakdown(card, 1132)
    expect(b.priceSource).toBe('live')
    expect(b.soldPrice).toBe(1132 * 17)
  })

  it('regression (v1.189.0): amountToReturn uses the FUNDER\'s own share, not the admin\'s — the two only coincide when split is actually on', () => {
    const split = expectedProfitBreakdown({ ...card, splitWithFunder: true })
    // when split is on, funder's share and admin's share are the same half
    expect(split.funderShareTotal).toBe(split.netYourProfit)
    expect(split.amountToReturn).toBe(split.investedTotal + split.funderShareTotal)

    const noSplit = expectedProfitBreakdown({ ...card, splitWithFunder: false })
    // when split is OFF, the funder gets nothing extra — only their
    // principal back. Before the fix, amountToReturn wrongly reused the
    // full remainder (the admin's own share) here instead of 0.
    expect(noSplit.funderShareTotal).toBe(0)
    expect(noSplit.amountToReturn).toBe(noSplit.investedTotal)
    expect(noSplit.netYourProfit).toBeGreaterThan(0) // the admin keeps the whole remainder
    expect(noSplit.amountToReturn).toBeLessThan(split.amountToReturn)
  })

  it('a projected LOSS is never the account holder\'s to share — holder cut is 0, the whole loss splits 50/50 with the funder', () => {
    // lotAmount = 871*17 = 14,807; a live price of 700/share sells for
    // 700*17 = 11,900 -> a projected loss of -2,907.
    const b = expectedProfitBreakdown(card, 700)
    expect(b.profitPerLot).toBeLessThan(0)
    expect(b.holderCutTotal).toBe(0)
    // netProfitPerLot * totalLots isn't exposed directly, but netYourProfit +
    // funderShareTotal must reconstruct the whole loss exactly (holder took
    // none of it) — same reconciliation invariant as the profit case above.
    expect(b.netYourProfit + b.funderShareTotal).toBe(b.profitPerLot * card.totalLots)
    expect(b.netYourProfit).toBeLessThan(0)
    expect(b.funderShareTotal).toBeLessThan(0)
  })

  it('a projected LOSS with no real funder (splitWithFunder off) falls entirely to the admin', () => {
    const b = expectedProfitBreakdown({ ...card, splitWithFunder: false }, 700)
    expect(b.holderCutTotal).toBe(0)
    expect(b.funderShareTotal).toBe(0)
    expect(b.netYourProfit).toBe(b.profitPerLot * card.totalLots)
  })

  it('multiple lots scale the total figures but not the per-lot ones', () => {
    const b = expectedProfitBreakdown({ ...card, totalLots: 3 })
    const one = expectedProfitBreakdown({ ...card, totalLots: 1 })
    expect(b.netYourProfit).toBe(one.netYourProfit * 3)
    expect(b.investedTotal).toBe(one.investedTotal * 3)
    expect(b.profitPerLot).toBe(one.profitPerLot) // per-lot figures don't scale
  })
})

describe('buildBookedProfitLines (REALIZED — respects the real, sale-time decision)', () => {
  it('only counts SOLD rows with both sell_price and bid_amount present', () => {
    expect(buildBookedProfitLines([row({ status: 'ALLOTTED' })], 'Admin')).toHaveLength(0)
    expect(buildBookedProfitLines([row({ status: 'SOLD', sell_price: null })], 'Admin')).toHaveLength(0)
  })

  it('a SOLD row genuinely respects split_profit_with_funder=false — this IS a real sale-time decision by now', () => {
    const [line] = buildBookedProfitLines([row({ status: 'SOLD', sell_price: 1132, split_profit_with_funder: false })], 'Admin')
    // totalSoldAmount = 1132*17 = 19,244; profit = 19,244 - 14,807 = 4,437;
    // cut 25% = 1,109.25; remainder kept entirely by the admin since split
    // is genuinely off here (no third party to give the other half to).
    const grossProfit = 1132 * 17 - 14_807
    expect(line.profit).toBeCloseTo(grossProfit * 0.75, 5)
  })

  it('a CASE_2 shared account forces the split off even if the row somehow has split_profit_with_funder=true', () => {
    const r = row({
      status: 'SOLD',
      sell_price: 1132,
      split_profit_with_funder: true,
      demat_accounts: { ...row().demat_accounts!, account_manager_id: 'mgr-1', profit_share_percent: 70 },
    })
    const [withoutCase2] = buildBookedProfitLines([r], 'Admin', new Set())
    const [withCase2] = buildBookedProfitLines([r], 'Admin', new Set(['mgr-1']))
    // With split honored (true, no case2), profit person only gets half the
    // remainder; forced off (case2), they get the whole remainder — strictly more.
    expect(withCase2.profit).toBeGreaterThan(withoutCase2.profit)
  })

  // Real user report: a sold, fully-paid-out IPO's realized profit
  // disappeared from Payouts the instant it archived (auto-archive fires
  // precisely once every row is SOLD-and-paid — i.e. this is the single
  // most common state a real, already-realized profit ends up in, not an
  // edge case). Root cause was here: this function used to hard-exclude
  // ipos.is_archived rows itself, so no caller could ever see archived
  // profit no matter what it fetched or filtered upstream. Archived-or-not
  // is now a caller decision (see the comment on the function itself);
  // this pins that a SOLD row under an archived IPO still counts.
  it("regression: a SOLD row under an archived IPO still counts — archiving isn't 'this profit never happened'", () => {
    const r = row({ status: 'SOLD', sell_price: 1132, ipos: { ...row().ipos!, is_archived: true } })
    expect(buildBookedProfitLines([r], 'Admin')).toHaveLength(1)
  })
})

describe('buildUnrealizedProfitLines (PROJECTED — ignores the idle pre-sale column)', () => {
  it('only counts ALLOTTED rows with bid_amount and price_high present', () => {
    expect(buildUnrealizedProfitLines([row({ status: 'SOLD' })], 'Admin', {})).toHaveLength(0)
    expect(buildUnrealizedProfitLines([row({ ipos: { ...row().ipos!, price_high: null } })], 'Admin', {})).toHaveLength(0)
  })

  it('regression (v1.189.1): standard 50/50 split applies regardless of the row\'s idle split_profit_with_funder=false', () => {
    // Every fixture row() sets split_profit_with_funder: false. If this
    // function ever regresses to reading that column again, funderShare
    // below would silently become 0.
    const [line] = buildUnrealizedProfitLines([row()], 'Admin', {})
    expect(line.funderShare).toBeGreaterThan(0)
    expect(line.holderCut).toBeGreaterThan(0)
    // holder cut + funder share + admin's own share must reconstruct the
    // full gross profit exactly (nothing lost, nothing double-counted).
    // Same unrounded formula computeProfitSplit itself uses internally
    // (GMP-adjusted price × lot size × lots, minus bid amount) — NOT
    // expectedProfitBreakdown's separately-rounded soldPrice, which this
    // function doesn't go through.
    const sellPricePerShare = 871 * (1 + 30 / 100)
    const grossProfit = sellPricePerShare * 17 * 1 - 14_807
    expect(line.holderCut + line.funderShare + line.profit).toBeCloseTo(grossProfit, 5)
  })

  it('a CASE_2 shared account is the one real case that DOES force the split off', () => {
    const r = row({ demat_accounts: { ...row().demat_accounts!, account_manager_id: 'mgr-1', profit_share_percent: 70 } })
    const [line] = buildUnrealizedProfitLines([r], 'Admin', {}, new Set(['mgr-1']))
    expect(line.funderShare).toBe(0)
  })

  it('a live price is used over the GMP estimate once the symbol resolves one', () => {
    const [gmpLine] = buildUnrealizedProfitLines([row()], 'Admin', {})
    const [liveLine] = buildUnrealizedProfitLines([row()], 'Admin', { DHOOTTRANS: 1132 })
    expect(gmpLine.priceSource).toBe('gmp')
    expect(liveLine.priceSource).toBe('live')
    expect(liveLine.profit).not.toBe(gmpLine.profit)
  })
})
