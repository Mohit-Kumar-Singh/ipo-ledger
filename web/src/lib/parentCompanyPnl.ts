import type { ParentCompanyHolding } from '../types/database'

export interface HoldingPnl {
  investedAmount: number
  // null only while HELD with no live price yet resolved — never guesses a
  // value from the buy price, same "no live price → no number" rule
  // HoldingsPage already applies to open IPO positions.
  currentValue: number | null
  pnl: number | null
  isRealized: boolean
}

// SOLD uses the recorded sell_price (locked in, ignores any live price
// passed in); HELD uses the live price when one's available. Mirrors the
// applications open→SOLD pattern (sell_price only ever set at the point of
// sale, unrealized value computed live until then).
export function computeHoldingPnl(holding: ParentCompanyHolding, livePrice: number | null): HoldingPnl {
  const investedAmount = holding.quantity * holding.buy_price
  if (holding.status === 'SOLD') {
    const currentValue = holding.quantity * (holding.sell_price ?? 0)
    return { investedAmount, currentValue, pnl: currentValue - investedAmount, isRealized: true }
  }
  if (livePrice == null) return { investedAmount, currentValue: null, pnl: null, isRealized: false }
  const currentValue = holding.quantity * livePrice
  return { investedAmount, currentValue, pnl: currentValue - investedAmount, isRealized: false }
}

export interface PnlAttribution {
  profitBearer: 'funder' | 'holder'
  lossBearer: 'funder' | 'holder' | 'loss_bearer'
}

// Who's actually on the hook for a lot's profit/loss — distinct from who's
// merely named on the row. A lot someone else funded is simple: that
// funder takes both the gain and the loss. A self-funded lot (funder_id
// null) is deliberately asymmetric: a named loss_bearer only ever steps in
// on a LOSS, never a gain — the holder always keeps a profit on their own
// self-funded purchase regardless of any loss-bearer arrangement.
export function pnlAttribution(
  holding: Pick<ParentCompanyHolding, 'funder_id' | 'loss_bearer_id'>,
): PnlAttribution {
  if (holding.funder_id) return { profitBearer: 'funder', lossBearer: 'funder' }
  if (holding.loss_bearer_id) return { profitBearer: 'holder', lossBearer: 'loss_bearer' }
  return { profitBearer: 'holder', lossBearer: 'holder' }
}

export interface CompanyHoldingsSummary {
  investedTotal: number
  fundedByMeTotal: number
  // Only what the admin is actually on the hook for: full pnl on lots they
  // funded, plus the loss (never a gain) on self-funded lots where they're
  // the named loss_bearer. Excludes every self-funded lot's own gain, which
  // always stays with the holder — see holderGains.
  myPnl: number
  hasUnpriced: boolean
  // Visibility only, per the admin's own request — a self-funded holder's
  // gain isn't money owed to the admin, just something they want to see.
  // Omits zero/negative results: a self-funded loss with no loss-bearer
  // arrangement is the holder's own concern, not tracked here.
  holderGains: { dematId: string; pnl: number }[]
}

export function summarizeCompanyHoldings(
  holdings: ParentCompanyHolding[],
  livePrice: number | null,
  isMeAccount: (bankAccountId: string | null) => boolean,
): CompanyHoldingsSummary {
  let investedTotal = 0
  let fundedByMeTotal = 0
  let myPnl = 0
  let hasUnpriced = false
  const holderGains: { dematId: string; pnl: number }[] = []

  for (const h of holdings) {
    const { investedAmount, pnl } = computeHoldingPnl(h, livePrice)
    investedTotal += investedAmount
    const attribution = pnlAttribution(h)
    if (pnl == null) hasUnpriced = true

    if (attribution.profitBearer === 'funder') {
      if (isMeAccount(h.funder_id)) {
        fundedByMeTotal += investedAmount
        if (pnl != null) myPnl += pnl
      }
      continue
    }

    // Self-funded by the holder.
    if (attribution.lossBearer === 'loss_bearer' && isMeAccount(h.loss_bearer_id) && pnl != null && pnl < 0) {
      myPnl += pnl
    }
    if (pnl != null && pnl > 0) holderGains.push({ dematId: h.demat_id, pnl })
  }

  return { investedTotal, fundedByMeTotal, myPnl, hasUnpriced, holderGains }
}
