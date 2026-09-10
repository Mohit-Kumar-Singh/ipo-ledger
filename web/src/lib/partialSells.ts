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
import { computeProfitSplit, effectiveSplitWithFunder, namesMatch } from './profitSplit'
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

// Same numbers as summariseSells, but read straight off a
// ProfitProjectionRow-shaped object (embedded application_sells + ipos) so
// the profit-line builders in expectedProfit.ts can split a PARTIALLY_SOLD
// row into its realized (sold) and unrealized (still-held) halves.
export function rowSellSplit(r: {
  lots: number
  ipos: { lot_size: number } | null
  application_sells?: readonly Pick<ApplicationSell, 'shares' | 'price'>[] | null
}): { totalShares: number; soldShares: number; remainingShares: number; realizedProceeds: number } {
  const totalShares = (r.ipos?.lot_size ?? 0) * r.lots
  const sells = r.application_sells ?? []
  const soldShares = sells.reduce((s, t) => s + t.shares, 0)
  const realizedProceeds = sells.reduce((s, t) => s + t.shares * t.price, 0)
  return {
    totalShares,
    soldShares,
    remainingShares: Math.max(0, totalShares - soldShares),
    realizedProceeds,
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
//
// splitWithFunder is forced ON (unless CASE_2, which effectiveSplitWithFunder
// still overrides) rather than read off row.split_profit_with_funder: the
// "Record a sell" flow has no checkbox to set that column, so it is only
// ever its idle DB default here. A real third-party funder shares every
// leg of a partial exit — the sold tranches AND the still-held remainder —
// same rule buildUnrealizedProfitLines uses for the remainder. See the
// matching comment in expectedProfit.ts's buildBookedProfitLines.
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
    splitWithFunder: effectiveSplitWithFunder(row, true),
  })
  return {
    proceeds: res.totalSoldAmount,
    grossProfit: res.grossProfit,
    holderCut: res.isDematHolderSelf ? 0 : res.dematCutAmount,
    funderShare: res.funderShare,
    profitPersonShare: res.profitPersonShare,
  }
}

// ── The whole partial position, both legs, one shape ─────────────────────
// Realized = every recorded tranche (real, owed now). Held = whatever is
// left, valued at the live market price (an ESTIMATE — no GMP/issue-price
// fallback, same product rule as buildHoldings). Both legs run the SAME
// 3-way split (holder cut %, then the remainder 50/50 with a real funder
// unless CASE_2) so the sold tranches and the still-held shares never
// disagree — matches buildBookedProfitLines (tranche path) +
// buildUnrealizedProfitLines exactly, so this card and the Payouts page
// show the same numbers.
export interface PartialPositionLeg {
  shares: number
  proceeds: number // realized: Σ shares×price; held: shares × livePrice
  costBasis: number // bid_amount prorated onto these shares
  grossProfit: number
  holderCut: number
  funderShare: number
  yourShare: number
}
export interface PartialPositionSplit {
  totalShares: number
  soldShares: number
  heldShares: number
  perShareBid: number
  livePricePerShare: number | null
  realized: PartialPositionLeg
  // null when nothing is still held, or no live price is available for it.
  held: PartialPositionLeg | null
  holderCutTotal: number
  funderShareTotal: number
  yourShareTotal: number
  holderName: string
  funderName: string | null
  hasRealFunder: boolean
}

const emptyLeg = (shares = 0): PartialPositionLeg => ({
  shares,
  proceeds: 0,
  costBasis: 0,
  grossProfit: 0,
  holderCut: 0,
  funderShare: 0,
  yourShare: 0,
})

export function partialPositionSplit(
  row: AllotmentBoardRow,
  sells: readonly Pick<ApplicationSell, 'shares' | 'price'>[],
  livePricePerShare: number | null,
  profitPersonName: string,
): PartialPositionSplit {
  const totalShares = allottedShares(row)
  const soldShares = sells.reduce((s, t) => s + t.shares, 0)
  const heldShares = Math.max(0, totalShares - soldShares)
  const perShareBid = row.bid_amount != null && totalShares > 0 ? row.bid_amount / totalShares : 0
  const hasRealFunder =
    !!row.bank_account_holder_name && !namesMatch(row.bank_account_holder_name, row.holder_name)

  // Realized leg — summed per tranche, so a tranche that individually sold
  // at a loss is handled by computeProfitSplit's own loss rule rather than
  // being averaged away.
  const realized = emptyLeg(soldShares)
  for (const t of sells) {
    const ts = trancheSplit(t, row, profitPersonName)
    realized.proceeds += ts.proceeds
    realized.costBasis += perShareBid * t.shares
    realized.grossProfit += ts.grossProfit
    realized.holderCut += ts.holderCut
    realized.funderShare += ts.funderShare
    realized.yourShare += ts.profitPersonShare
  }

  let held: PartialPositionLeg | null = null
  if (heldShares > 0 && livePricePerShare != null && row.bid_amount != null) {
    const res = computeProfitSplit({
      sellPricePerShare: livePricePerShare,
      lotSize: 1,
      lots: heldShares,
      bidAmount: perShareBid * heldShares,
      cutPercent: row.profit_share_percent ?? 25,
      dematHolderName: row.holder_name,
      funderName: row.bank_account_holder_name,
      profitPersonName,
      splitWithFunder: effectiveSplitWithFunder(row, true),
    })
    held = {
      shares: heldShares,
      proceeds: res.totalSoldAmount,
      costBasis: perShareBid * heldShares,
      grossProfit: res.grossProfit,
      holderCut: res.isDematHolderSelf ? 0 : res.dematCutAmount,
      funderShare: res.funderShare,
      yourShare: res.profitPersonShare,
    }
  }

  return {
    totalShares,
    soldShares,
    heldShares,
    perShareBid,
    livePricePerShare,
    realized,
    held,
    holderCutTotal: realized.holderCut + (held?.holderCut ?? 0),
    funderShareTotal: realized.funderShare + (held?.funderShare ?? 0),
    yourShareTotal: realized.yourShare + (held?.yourShare ?? 0),
    holderName: row.holder_name,
    funderName: row.bank_account_holder_name,
    hasRealFunder,
  }
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const inrApprox = (n: number) => `~₹${Math.round(n).toLocaleString('en-IN')}`

// The WhatsApp text for a PARTIALLY_SOLD position. 'cut' goes to the demat
// holder (what they keep, what they send back on the sold shares); 'share'
// goes to the funder (their share of the sold shares now, plus the estimate
// on what's still held). The held leg is always labelled an estimate — it
// moves with the market and only settles on sale.
export function partialPayoutMessage(
  row: AllotmentBoardRow,
  split: PartialPositionSplit,
  kind: 'cut' | 'share',
): string {
  const { realized: R, held: H, soldShares, heldShares, totalShares } = split
  const cutPct = row.profit_share_percent ?? 25
  const head =
    `*${row.company_name}* — ${soldShares.toLocaleString('en-IN')} of ${totalShares.toLocaleString('en-IN')} shares sold` +
    (heldShares > 0 ? `, ${heldShares.toLocaleString('en-IN')} still held.` : '.')

  if (kind === 'cut') {
    // Holder keeps their cut; sends back principal + both other parties' shares.
    const sendBack = R.costBasis + R.grossProfit - R.holderCut
    const lines = [
      head,
      '',
      `*Sold (${soldShares.toLocaleString('en-IN')} sh):*`,
      `• Sold for ${inr(R.proceeds)}  ·  funded ${inr(R.costBasis)}  ·  profit ${inr(R.grossProfit)}`,
      `• Your ${cutPct}% cut: ${inr(R.holderCut)}  (keep this)`,
      `→ send back ${inr(R.costBasis)} + ${inr(R.grossProfit - R.holderCut)} = ${inr(sendBack)}`,
    ]
    if (H) {
      lines.push(
        '',
        `*Still held (${heldShares.toLocaleString('en-IN')} sh, at ${inrApprox(split.livePricePerShare ?? 0)}/sh — estimate, settles on sale):*`,
        `• Value ${inrApprox(H.proceeds)}  ·  funded ${inr(H.costBasis)}  ·  profit ${inrApprox(H.grossProfit)}`,
        `• Your ${cutPct}% cut: ${inrApprox(H.holderCut)}`,
        '',
        `Your cut: ${inr(R.holderCut)} booked, ${inrApprox(H.holderCut)} more once the rest sells (${inrApprox(split.holderCutTotal)} total).`,
      )
    }
    return lines.join('\n')
  }

  // kind === 'share' — to the funder.
  const nowToFunder = R.costBasis + R.funderShare
  const lines = [
    head,
    '',
    `*Sold (${soldShares.toLocaleString('en-IN')} sh):*`,
    `• After ${split.holderName}'s ${cutPct}% (${inr(R.grossProfit)} − ${inr(R.holderCut)} = ${inr(R.grossProfit - R.holderCut)}), your half = ${inr(R.funderShare)}`,
    `→ ${inr(R.costBasis)} principal + ${inr(R.funderShare)} = ${inr(nowToFunder)} to you now`,
  ]
  if (H) {
    lines.push(
      '',
      `*Still held (${heldShares.toLocaleString('en-IN')} sh, at ${inrApprox(split.livePricePerShare ?? 0)}/sh — estimate):*`,
      `• After ${split.holderName}'s ${cutPct}% (${inrApprox(H.grossProfit)} − ${inrApprox(H.holderCut)} = ${inrApprox(H.grossProfit - H.holderCut)}), your half ${inrApprox(H.funderShare)}`,
      `→ settles when sold`,
      '',
      `Your share: ${inr(R.funderShare)} booked, ${inrApprox(H.funderShare)} expected (${inrApprox(split.funderShareTotal)} total).`,
    )
  }
  return lines.join('\n')
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
