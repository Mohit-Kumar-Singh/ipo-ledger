// Expected-profit-from-allotment math, shared between NotificationsPage's
// "Allotment updates" funder cards and the Dashboard's "Expected profit"
// tile — extracted so the two never silently drift apart on how a projected
// payout is computed. Everything here operates on the SAME row shape
// (ProfitProjectionRow) NotificationsPage's admin query already fetches.
import { parseGmpPercent } from './ipoGmp'

export type ProfitProjectionRow = {
  ipo_id: string
  lots: number
  applied_at: string
  status: 'APPLIED' | 'ALLOTTED' | 'NOT_ALLOTTED' | 'SOLD'
  mandate_status: 'PENDING' | 'APPROVED' | 'CANCELLED'
  ipoji_status_text: string | null
  ipos: {
    company_name: string
    open_date: string
    close_date: string
    listing_date: string | null
    price_high: number | null
    lot_size: number
    gmp_notes: string | null
    is_archived?: boolean
  } | null
  demat_accounts: { holder_name: string; profit_share_percent: number; phone_e164: string | null } | null
  bank_accounts: { account_holder_name: string | null; phone_e164: string | null; upi_id: string | null } | null
  // Manual funder-credit override (migration 0063) — wins over bank_accounts
  // wherever "who funded this" is computed, via effectiveFunder() below.
  funder_override: { account_holder_name: string | null; phone_e164: string | null; upi_id: string | null } | null
}

// Falls back to the demat holder's own identity when there's no bank/UPI
// account on file at all — a genuinely self-funded application still needs
// to generate a funder card (e.g. the Expected profit projection), same
// fallback lib/applicationAttribution.ts's pie chart already uses.
function effectiveFunder(r: ProfitProjectionRow) {
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
  // Each holder tagged with whether ANY of their applications in this card
  // were funded via a manual override (funder_override_id) — surfaced as
  // the same 🏷️ tag ApplicationsPage/the allotment board already show.
  holderNames: { name: string; isOverride: boolean }[]
  totalLots: number
  // Weighted-average cut% across every demat account this funder's money
  // ended up in for this IPO — see buildFunderAllottedCards.
  cutPercent: number
  _cutWeightedSum: number
}

export function buildFunderAllottedCards(
  rows: ProfitProjectionRow[],
  sameIdentity: (a: string, b: string) => boolean,
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
        holderNames: [],
        totalLots: 0,
        cutPercent: 25,
        _cutWeightedSum: 0,
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
  }
  const cards = Array.from(cardsByIpo.values()).flat()
  for (const c of cards) {
    if (c.totalLots > 0) c.cutPercent = c._cutWeightedSum / c.totalLots
  }
  return cards.sort((a, b) => a.funderName.localeCompare(b.funderName) || a.ipoName.localeCompare(b.ipoName))
}

// Projected profit, computed PER LOT — that's the unit a funder actually
// thinks in (one lot invested, one lot's worth of profit). gmp_notes stores
// a plain percentage, so the expected sold price is the per-lot invested
// amount grossed up by that percentage.
export function expectedProfitBreakdown(card: FunderAllottedCard) {
  const lotAmount = (card.priceHigh ?? 0) * card.lotSize
  const gmpPercent = card.gmpPercent ?? 0
  const soldPrice = Math.round(lotAmount * (1 + gmpPercent / 100))
  const profitPerLot = soldPrice - lotAmount
  const netProfitPerLot = Math.round(profitPerLot * (1 - card.cutPercent / 100))
  const yourProfitPerLot = Math.round(netProfitPerLot / 2)
  const netYourProfit = yourProfitPerLot * card.totalLots
  const investedTotal = lotAmount * card.totalLots
  const amountToReturn = investedTotal + netYourProfit
  return { lotAmount, gmpPercent, soldPrice, profitPerLot, netProfitPerLot, yourProfitPerLot, netYourProfit, investedTotal, amountToReturn }
}

export function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
