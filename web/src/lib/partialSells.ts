// Partial-sell math — the client-side companion to migration 0096's
// application_sells table. Two jobs:
//
//  1. summarise / value the tranches recorded against one application
//     (realized proceeds so far, shares still held), and split each
//     tranche's realized profit through the SAME computeProfitSplit rules
//     the full-sale path uses — just prorated onto that tranche's share
//     count instead of the whole allotment.
//
//  2. roll every still-held remainder up by demat holder, valued at the
//     live market price (and only the live price — no GMP/issue-price
//     fallback, by product decision: an unpriced holding shows its share
//     count but no rupee value rather than a guess).
import { computeProfitSplit, effectiveSplitWithFunder } from './profitSplit'
import type { AllotmentBoardRow, ApplicationSell } from '../types/database'

export function allottedShares(row: { lot_size: number; lots: number }): number {
  return row.lot_size * row.lots
}

export interface SellSummary {
  soldShares: number
  remainingShares: number
  realizedProceeds: number
  fullySold: boolean
}

export function summariseSells(
  row: { lot_size: number; lots: number },
  sells: readonly Pick<ApplicationSell, 'shares' | 'price'>[],
): SellSummary {
  const total = allottedShares(row)
  const soldShares = sells.reduce((s, t) => s + t.shares, 0)
  const realizedProceeds = sells.reduce((s, t) => s + t.shares * t.price, 0)
  return {
    soldShares,
    remainingShares: Math.max(0, total - soldShares),
    realizedProceeds,
    fullySold: total > 0 && soldShares >= total,
  }
}

export interface TrancheSplit {
  proceeds: number
  grossProfit: number
  holderCut: number
  funderShare: number
  profitPersonShare: number
}

// One tranche's realized profit, split the same way a full sale would be.
// bid_amount is prorated by (tranche shares / total allotted shares); the
// split itself then runs through computeProfitSplit with lotSize=1 so
// `lots` carries the raw share count.
export function trancheSplit(
  tranche: Pick<ApplicationSell, 'shares' | 'price'>,
  row: AllotmentBoardRow,
  profitPersonName: string,
): TrancheSplit {
  const totalShares = allottedShares(row)
  const proratedBid =
    row.bid_amount != null && totalShares > 0 ? (row.bid_amount * tranche.shares) / totalShares : 0
  const res = computeProfitSplit({
    sellPricePerShare: tranche.price,
    lotSize: 1,
    lots: tranche.shares,
    bidAmount: proratedBid,
    cutPercent: row.profit_share_percent ?? 25,
    dematHolderName: row.holder_name,
    funderName: row.bank_account_holder_name,
    profitPersonName,
    splitWithFunder: effectiveSplitWithFunder(row, row.split_profit_with_funder),
  })
  return {
    proceeds: res.totalSoldAmount,
    grossProfit: res.grossProfit,
    holderCut: res.isDematHolderSelf ? 0 : res.dematCutAmount,
    funderShare: res.funderShare,
    profitPersonShare: res.profitPersonShare,
  }
}

// Sum of a set of tranches' realized shares by application id — the shape
// buildHoldings wants for subtracting what's already sold.
export function soldSharesByApplication(
  sells: readonly Pick<ApplicationSell, 'application_id' | 'shares'>[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of sells) out[s.application_id] = (out[s.application_id] ?? 0) + s.shares
  return out
}

export interface HoldingSourceRow {
  application_id: string
  demat_id: string
  holder_name: string
  ipo_id: string
  ipo_name: string
  symbol: string | null
  lot_size: number
  lots: number
  bid_amount: number | null
  status: string
}

export interface HoldingRow {
  key: string
  dematId: string
  holderName: string
  ipoId: string
  ipoName: string
  symbol: string | null
  remainingShares: number
  costBasis: number
  livePricePerShare: number | null
  liveValue: number | null
}

export interface HolderHoldingTotal {
  dematId: string
  holderName: string
  remainingShares: number
  liveValue: number
  hasUnpricedHolding: boolean
  positions: HoldingRow[]
}

// Only ALLOTTED / PARTIALLY_SOLD rows can still hold shares. Rows are keyed
// by (demat, ipo) so two applications for the same holder on the same IPO
// (different funders) fold into one position.
export function buildHoldings(
  rows: readonly HoldingSourceRow[],
  soldByApp: Record<string, number>,
  livePriceBySymbol: Record<string, number | null>,
): { holdings: HoldingRow[]; byHolder: HolderHoldingTotal[] } {
  const byKey = new Map<string, HoldingRow>()
  for (const r of rows) {
    if (r.status !== 'ALLOTTED' && r.status !== 'PARTIALLY_SOLD') continue
    const total = r.lot_size * r.lots
    const remaining = Math.max(0, total - (soldByApp[r.application_id] ?? 0))
    if (remaining <= 0) continue
    const perShareBid = r.bid_amount != null && total > 0 ? r.bid_amount / total : 0
    const key = `${r.demat_id}::${r.ipo_id}`
    const existing = byKey.get(key)
    if (existing) {
      existing.remainingShares += remaining
      existing.costBasis += remaining * perShareBid
    } else {
      byKey.set(key, {
        key,
        dematId: r.demat_id,
        holderName: r.holder_name,
        ipoId: r.ipo_id,
        ipoName: r.ipo_name,
        symbol: r.symbol,
        remainingShares: remaining,
        costBasis: remaining * perShareBid,
        livePricePerShare: null,
        liveValue: null,
      })
    }
  }

  const holdings = Array.from(byKey.values())
  for (const h of holdings) {
    const live = h.symbol ? (livePriceBySymbol[h.symbol] ?? null) : null
    h.livePricePerShare = live
    h.liveValue = live != null ? Math.round(live * h.remainingShares) : null
    h.costBasis = Math.round(h.costBasis)
  }
  holdings.sort((a, b) => a.holderName.localeCompare(b.holderName) || a.ipoName.localeCompare(b.ipoName))

  const holderMap = new Map<string, HolderHoldingTotal>()
  for (const h of holdings) {
    let t = holderMap.get(h.dematId)
    if (!t) {
      t = {
        dematId: h.dematId,
        holderName: h.holderName,
        remainingShares: 0,
        liveValue: 0,
        hasUnpricedHolding: false,
        positions: [],
      }
      holderMap.set(h.dematId, t)
    }
    t.remainingShares += h.remainingShares
    t.positions.push(h)
    if (h.liveValue != null) t.liveValue += h.liveValue
    else t.hasUnpricedHolding = true
  }
  const byHolder = Array.from(holderMap.values()).sort(
    (a, b) => b.liveValue - a.liveValue || a.holderName.localeCompare(b.holderName),
  )
  return { holdings, byHolder }
}
