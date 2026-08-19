// Expected-profit-from-allotment math, shared between NotificationsPage's
// "Allotment updates" funder cards and the Dashboard's "Expected profit"
// tile — extracted so the two never silently drift apart on how a projected
// payout is computed. Everything here operates on the SAME row shape
// (ProfitProjectionRow) NotificationsPage's admin query already fetches.
import { parseGmpPercent } from './ipoGmp'
import { computeProfitSplit } from './profitSplit'

export type ProfitProjectionRow = {
  ipo_id: string
  lots: number
  applied_at: string
  status: 'APPLIED' | 'ALLOTTED' | 'NOT_ALLOTTED' | 'SOLD'
  mandate_status: 'PENDING' | 'APPROVED' | 'CANCELLED'
  ipoji_status_text: string | null
  // Optional — only the Dashboard's profit query selects these (needed to
  // compute REALIZED profit for already-SOLD rows via computeProfitSplit,
  // same actual-sell-price math "Payouts pending" uses); NotificationsPage's
  // funder cards don't need them and leave this undefined.
  bid_amount?: number | null
  sell_price?: number | null
  split_profit_with_funder?: boolean | null
  ipos: {
    company_name: string
    open_date: string
    close_date: string
    listing_date: string | null
    price_high: number | null
    lot_size: number
    gmp_notes: string | null
    is_archived?: boolean
    // Optional — only the Dashboard's profit query selects it (to key a live
    // price lookup once listed); NotificationsPage's funder cards still work
    // fine without it, just always falling back to the GMP-based estimate.
    symbol?: string | null
  } | null
  // Credential/platform fields are optional — only NotificationsPage's
  // sell-reminder query selects them (to hand login details back to the
  // holder); other consumers of this shape leave them undefined. RLS still
  // returns them only to admin/the account's own owner, so a funder-only
  // viewer gets a null embed here regardless.
  demat_accounts:
    | {
        holder_name: string
        profit_share_percent: number
        phone_e164: string | null
        // Shared account (migration 0079) — used to tell a genuine funder
        // apart from a CASE_2 manager (who IS the funder, no separate 50/50
        // split applies). See buildFunderAllottedCards' case2ManagerIds.
        account_manager_id?: string | null
        platform?: string | null
        dp_client_id?: string | null
        application_name?: string | null
        login_email?: string | null
        login_password?: string | null
        app_password?: string | null
        t_pin?: string | null
        logged_in_notes?: string | null
      }
    | null
  bank_accounts: { account_holder_name: string | null; phone_e164: string | null; upi_id: string | null } | null
  // Manual funder-credit override (migration 0063) — wins over bank_accounts
  // wherever "who funded this" is computed, via effectiveFunder() below.
  funder_override: { account_holder_name: string | null; phone_e164: string | null; upi_id: string | null } | null
}

// Falls back to the demat holder's own identity when there's no bank/UPI
// account on file at all — a genuinely self-funded application still needs
// to generate a funder card (e.g. the Expected profit projection), same
// fallback lib/applicationAttribution.ts's pie chart already uses.
export function effectiveFunder(r: ProfitProjectionRow) {
  return (
    r.funder_override ??
    r.bank_accounts ??
    (r.demat_accounts
      ? { account_holder_name: r.demat_accounts.holder_name, phone_e164: r.demat_accounts.phone_e164, upi_id: null }
      : null)
  )
}

// One card per (funder, IPO) covering only their ALLOTTED (or already SOLD —
// still allotted, just further along) applications.
export interface FunderAllottedCard {
  key: string
  funderName: string
  phone: string | null
  ipoId: string
  ipoName: string
  listingDate: string | null
  priceHigh: number | null
  lotSize: number
  gmpPercent: number | null
  // The IPO's own NSE ticker, once known/listed — lets expectedProfitBreakdown
  // use a live market price instead of the static GMP-based estimate.
  symbol: string | null
  // Each holder tagged with whether ANY of their applications in this card
  // were funded via a manual override (funder_override_id) — surfaced as
  // the same 🏷️ tag ApplicationsPage/the allotment board already show.
  holderNames: { name: string; isOverride: boolean }[]
  totalLots: number
  // Weighted-average cut% across every demat account this funder's money
  // ended up in for this IPO — see buildFunderAllottedCards.
  cutPercent: number
  _cutWeightedSum: number
  // False when this "funder" identity is actually a CASE_2 shared-account
  // manager (migration 0079) — they already ARE the funder, so
  // expectedProfitBreakdown shouldn't additionally halve the remainder with
  // a third party that doesn't exist for this card. True (the historical
  // default) for every normal funder and CASE_1 manager.
  splitWithFunder: boolean
}

export function buildFunderAllottedCards(
  rows: ProfitProjectionRow[],
  sameIdentity: (a: string, b: string) => boolean,
  case2ManagerIds: Set<string> = new Set(),
): FunderAllottedCard[] {
  const cardsByIpo = new Map<string, FunderAllottedCard[]>()
  for (const r of rows) {
    const funder = effectiveFunder(r)
    const name = funder?.account_holder_name
    if (!name || !r.ipos) continue
    if (r.status !== 'ALLOTTED' && r.status !== 'SOLD') continue
    if (!cardsByIpo.has(r.ipo_id)) cardsByIpo.set(r.ipo_id, [])
    const cardsForIpo = cardsByIpo.get(r.ipo_id)!
    let card = cardsForIpo.find((c) => sameIdentity(c.funderName, name))
    if (!card) {
      card = {
        key: `allotted::${r.ipo_id}::${cardsForIpo.length}`,
        funderName: name,
        phone: funder?.phone_e164 ?? null,
        ipoId: r.ipo_id,
        ipoName: r.ipos.company_name,
        listingDate: r.ipos.listing_date,
        priceHigh: r.ipos.price_high,
        lotSize: r.ipos.lot_size,
        gmpPercent: parseGmpPercent(r.ipos.gmp_notes),
        symbol: r.ipos.symbol ?? null,
        holderNames: [],
        totalLots: 0,
        cutPercent: 25,
        _cutWeightedSum: 0,
        splitWithFunder: true,
      }
      cardsForIpo.push(card)
    } else if (name.length > card.funderName.length) {
      card.funderName = name
    }
    if (!card.phone && funder?.phone_e164) card.phone = funder.phone_e164
    const holder = r.demat_accounts?.holder_name ?? 'Unknown'
    const isOverride = !!r.funder_override
    const existingHolder = card.holderNames.find((h) => h.name === holder)
    if (!existingHolder) card.holderNames.push({ name: holder, isOverride })
    else if (isOverride) existingHolder.isOverride = true
    card.totalLots += r.lots
    card._cutWeightedSum += (r.demat_accounts?.profit_share_percent ?? 25) * r.lots
    if (r.demat_accounts?.account_manager_id && case2ManagerIds.has(r.demat_accounts.account_manager_id)) {
      card.splitWithFunder = false
    }
  }
  const cards = Array.from(cardsByIpo.values()).flat()
  for (const c of cards) {
    if (c.totalLots > 0) c.cutPercent = c._cutWeightedSum / c.totalLots
  }
  return cards.sort((a, b) => a.funderName.localeCompare(b.funderName) || a.ipoName.localeCompare(b.ipoName))
}

// Projected profit, computed PER LOT — that's the unit a funder actually
// thinks in (one lot invested, one lot's worth of profit). Two ways to
// arrive at the "expected sold price":
//  - livePricePerShare given (the IPO's own symbol resolved a live NSE
//    quote via fetch-stock-price, e.g. once actually listed): soldPrice is
//    that live price × lot size — a real, moving number for an allotment
//    that hasn't been marked SOLD yet, not a value frozen at whatever GMP
//    read when the IPO was still pre-listing.
//  - otherwise: the original static estimate, gmp_notes' percentage grossing
//    up the per-lot invested amount (issue price × lot size).
export function expectedProfitBreakdown(card: FunderAllottedCard, livePricePerShare?: number | null) {
  const lotAmount = (card.priceHigh ?? 0) * card.lotSize
  const gmpPercent = card.gmpPercent ?? 0
  const priceSource: 'live' | 'gmp' = livePricePerShare != null ? 'live' : 'gmp'
  const soldPrice =
    priceSource === 'live'
      ? Math.round(livePricePerShare! * card.lotSize)
      : Math.round(lotAmount * (1 + gmpPercent / 100))
  const profitPerLot = soldPrice - lotAmount
  const netProfitPerLot = Math.round(profitPerLot * (1 - card.cutPercent / 100))
  // A CASE_2 shared account's manager IS the funder — nothing left to halve
  // with a separate third party, they just get the whole remainder.
  const yourProfitPerLot = card.splitWithFunder ? Math.round(netProfitPerLot / 2) : netProfitPerLot
  const netYourProfit = yourProfitPerLot * card.totalLots
  const investedTotal = lotAmount * card.totalLots
  const amountToReturn = investedTotal + netYourProfit
  return {
    lotAmount,
    gmpPercent,
    soldPrice,
    profitPerLot,
    netProfitPerLot,
    yourProfitPerLot,
    netYourProfit,
    investedTotal,
    amountToReturn,
    priceSource,
    livePricePerShare: livePricePerShare ?? null,
  }
}

export function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

// REALIZED profit for applications already marked SOLD — computed from the
// actual sell_price entered (via the same computeProfitSplit math "Payouts
// pending" uses), not the GMP/live estimate expectedProfitBreakdown produces
// for still-held allotments. Kept separate from FunderAllottedCard/
// expectedProfitBreakdown's per-card aggregation because each SOLD row has
// its own real sell_price — there's nothing to project or aggregate once
// it's known.
export interface BookedProfitLine {
  ipoName: string
  ipoId: string
  funderName: string
  holderName: string
  profit: number
  soldAmount: number
}

export function buildBookedProfitLines(
  rows: ProfitProjectionRow[],
  profitPersonName: string,
  case2ManagerIds: Set<string> = new Set(),
): BookedProfitLine[] {
  const lines: BookedProfitLine[] = []
  for (const r of rows) {
    if (r.status !== 'SOLD' || !r.ipos || r.ipos.is_archived) continue
    if (r.sell_price == null || r.bid_amount == null) continue
    const funder = effectiveFunder(r)
    const holderName = r.demat_accounts?.holder_name ?? 'Unknown'
    const isCase2 = !!r.demat_accounts?.account_manager_id && case2ManagerIds.has(r.demat_accounts.account_manager_id)
    const result = computeProfitSplit({
      sellPricePerShare: r.sell_price,
      lotSize: r.ipos.lot_size,
      lots: r.lots,
      bidAmount: r.bid_amount,
      cutPercent: r.demat_accounts?.profit_share_percent ?? 25,
      dematHolderName: holderName,
      funderName: funder?.account_holder_name ?? null,
      profitPersonName,
      splitWithFunder: isCase2 ? false : (r.split_profit_with_funder ?? false),
    })
    lines.push({
      ipoName: r.ipos.company_name,
      ipoId: r.ipo_id,
      funderName: funder?.account_holder_name ?? holderName,
      holderName,
      profit: result.profitPersonShare,
      soldAmount: result.totalSoldAmount,
    })
  }
  return lines
}

// Same shape as FunderAllottedCard (NotificationsPage's pre-sale "Allotment
// updates" projection card) plus the one thing that projection doesn't
// have yet: a REAL sell price. Reuses buildFunderAllottedCards internally —
// only ever called with an already-filtered row set (status === 'SOLD' AND
// listing_date === target date), so the aggregation itself doesn't need
// separate logic, just a real price to feed expectedProfitBreakdown's
// `livePricePerShare` param instead of a GMP guess or a live quote.
export interface SoldFunderCard extends FunderAllottedCard {
  sellPricePerShare: number
}

export function buildSoldFunderCards(
  soldTodayRows: ProfitProjectionRow[],
  sameIdentity: (a: string, b: string) => boolean,
): SoldFunderCard[] {
  const cards = buildFunderAllottedCards(soldTodayRows, sameIdentity) as SoldFunderCard[]
  for (const c of cards) {
    const cardRows = soldTodayRows.filter((r) => {
      const funder = effectiveFunder(r)
      return r.ipo_id === c.ipoId && !!funder?.account_holder_name && sameIdentity(funder.account_holder_name, c.funderName)
    })
    const totalLots = cardRows.reduce((s, r) => s + r.lots, 0)
    const weightedSum = cardRows.reduce((s, r) => s + (r.sell_price ?? 0) * r.lots, 0)
    c.sellPricePerShare = totalLots > 0 ? weightedSum / totalLots : 0
  }
  return cards
}
