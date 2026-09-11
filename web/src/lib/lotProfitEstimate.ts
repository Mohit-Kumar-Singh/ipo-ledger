import { parseGmpPercent } from './ipoGmp'
import { computeProfitSplit } from './profitSplit'

// Default account-holder cut used for this ESTIMATE only, when no specific
// account is in the picture yet (this runs before anyone's even applied) —
// same 25% fallback the rest of the app already uses whenever a real
// profit_share_percent isn't available (see DashboardPage's
// buildPendingPayouts/buildFunderAllottedCards, both `?? 25`).
export const DEFAULT_HOLDER_CUT_PERCENT = 25

export interface LotProfitEstimate {
  // What one lot actually costs to apply — lot_size * price_high.
  lotAmount: number
  // The GMP percentage parsed out of gmp_notes (e.g. 17 for "17%").
  gmpPercent: number
  // price_high grossed up by the GMP% — the hypothetical per-share listing
  // price this estimate assumes.
  estimatedSellPrice: number
  // lotAmount * gmpPercent/100 — before anyone's cut. Can be negative when
  // GMP is negative (trading below issue price).
  grossProfit: number
  // The demat holder's cut of a genuine profit — 0 on a loss (a loss is
  // never charged to the holder, same rule computeProfitSplit already
  // enforces everywhere else in this app).
  holderCut: number
  // Your half of what's left after the holder's cut, assuming this lot was
  // funded by someone else and gets allotted — the number this whole
  // estimate exists to show. On a loss this is half the loss (still split
  // with the funder), matching computeProfitSplit's loss-sharing rule.
  yourShare: number
}

// The one calculation behind the "if this lot gets allotted" estimate shown
// on the Dashboard's IPO progress cards, before any real application/cut/
// funder exists to plug into computeProfitSplit for real. Deliberately
// reuses computeProfitSplit itself (fed a synthetic holder/funder/profit-
// person so it takes the generic "funded, 50/50" branch) rather than
// re-deriving the split arithmetic here — this app's whole payout logic
// lives in one place for a reason (see profitSplit.ts's own history), and a
// second hand-rolled copy of "gross - cut, then /2" is exactly the kind of
// drift that already caused a real bug once (the partial-sell funder-split
// miss, v1.220.0).
//
// Returns null when there isn't enough on the IPO yet to estimate anything
// real — no price band (price_high not announced), or no GMP number in
// gmp_notes (free text with no parseable "%"). Showing a number built on a
// guessed lot amount or an invented GMP would be worse than showing nothing.
export function estimateLotProfit(
  priceHigh: number | null,
  lotSize: number,
  gmpNotes: string | null,
  holderCutPercent: number = DEFAULT_HOLDER_CUT_PERCENT,
): LotProfitEstimate | null {
  if (priceHigh == null || priceHigh <= 0 || lotSize <= 0) return null
  const gmpPercent = parseGmpPercent(gmpNotes)
  if (gmpPercent == null) return null

  const lotAmount = priceHigh * lotSize
  const estimatedSellPrice = priceHigh * (1 + gmpPercent / 100)

  const split = computeProfitSplit({
    sellPricePerShare: estimatedSellPrice,
    lotSize,
    lots: 1,
    bidAmount: lotAmount,
    cutPercent: holderCutPercent,
    dematHolderName: 'Demat holder',
    funderName: 'Funder',
    profitPersonName: 'You',
    splitWithFunder: true,
  })

  return {
    lotAmount,
    gmpPercent,
    estimatedSellPrice,
    grossProfit: split.grossProfit,
    holderCut: split.dematCutAmount,
    yourShare: split.profitPersonShare,
  }
}
