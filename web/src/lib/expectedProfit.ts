// Expected-profit-from-allotment math, shared between NotificationsPage's
// "Allotment updates" funder cards and the Dashboard's "Expected profit"
// tile — extracted so the two never silently drift apart on how a projected
// payout is computed. Everything here operates on the SAME row shape
// (ProfitProjectionRow) NotificationsPage's admin query already fetches.
import { parseGmpPercent } from './ipoGmp'
import { computeProfitSplit } from './profitSplit'

export type ProfitProjectionRow = {
  // Optional — only queries that need to key a line back to its own
  // application row (the Payouts analytics dashboard's trend chart and
  // transaction table) select it; every other existing caller of this
  // shape leaves it undefined, same "optional per-caller" convention as
  // bid_amount/sell_price below.
  id?: string
  ipo_id: string
  lots: number
  applied_at: string
  // Optional -- same "only who needs it selects it" convention. Used as the
  // realization-date proxy for SOLD rows in buildBookedProfitLines (this
  // schema has no dedicated "sold on" column; see payoutAnalytics.ts).
  status_changed_at?: string
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
    // Only a CASE_2 shared account (its manager IS the funder, migration
    // 0079) legitimately has no third party to split with here — NOT
    // r.split_profit_with_funder, which defaults to false at the DB level
    // (migration 0023) and is only ever actually set by an admin decision
    // made at the moment of marking an application SOLD. Nothing has been
    // decided yet for a still-ALLOTTED row, so this projection assumes the
    // standard 3-way split rather than the column's idle pre-sale default —
    // see the matching, more detailed comment on buildUnrealizedProfitLines.
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
  // The account holder's own cut, per lot — profitPerLot minus what's left
  // after it, so this always sums exactly back to profitPerLot with
  // netProfitPerLot (both derived from the same rounding), rather than a
  // second independently-rounded multiply that could drift by a rupee.
  const holderCutPerLot = profitPerLot - netProfitPerLot
  // A CASE_2 shared account's manager IS the funder, or this specific
  // application had its own "don't split with funder" override on
  // (card.splitWithFunder, set in buildFunderAllottedCards) — either way
  // there's no separate third party to halve the remainder with; the whole
  // remainder is the admin's own profit, and the funder gets only their
  // principal back, nothing extra.
  const funderSharePerLot = card.splitWithFunder ? Math.round(netProfitPerLot / 2) : 0
  const yourProfitPerLot = netProfitPerLot - funderSharePerLot
  const netYourProfit = yourProfitPerLot * card.totalLots
  const holderCutTotal = holderCutPerLot * card.totalLots
  const funderShareTotal = funderSharePerLot * card.totalLots
  const investedTotal = lotAmount * card.totalLots
  // What to actually send the funder: their principal back plus THEIR OWN
  // share of the remainder — never the admin's own share. Those two only
  // happen to be equal when splitWithFunder is true (an even 50/50 split);
  // this used to just reuse netYourProfit unconditionally, which silently
  // handed the funder credit for the admin's own money whenever a specific
  // application's split was turned off. See the case-by-case comment above.
  const amountToReturn = investedTotal + funderShareTotal
  return {
    lotAmount,
    gmpPercent,
    soldPrice,
    profitPerLot,
    netProfitPerLot,
    yourProfitPerLot,
    netYourProfit,
    holderCutTotal,
    funderShareTotal,
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
  // The profit-taking admin's own share — NOT what a funder gets. A funder
  // viewer's own realized profit is funderShare below; showing this field
  // to them instead (as several call sites used to) tells them the ADMIN's
  // cut on their own money, not their own.
  profit: number
  // The funder's own share of this application's profit — 0 if there's no
  // separate funder, or the split was off for this sale.
  funderShare: number
  soldAmount: number
  // Optional — added for the Payouts analytics dashboard (which needs to
  // key a line back to its own application row, sum investment, and place
  // it on a date axis); Dashboard's own "Owed to you" consumer of this
  // function predates these and doesn't read them.
  applicationId?: string
  investedAmount?: number
  lots?: number
  // status_changed_at at fetch time — the closest real proxy this schema
  // has for "when the sale was realized" (there's no separate sold-on
  // date column; see payoutAnalytics.ts's own note on this).
  realizedAt?: string
}

export function buildBookedProfitLines(
  rows: ProfitProjectionRow[],
  profitPersonName: string,
  case2ManagerIds: Set<string> = new Set(),
): BookedProfitLine[] {
  const lines: BookedProfitLine[] = []
  for (const r of rows) {
    // Archived-or-not is deliberately NOT checked here — that's a caller-
    // level decision (Dashboard's "Expected profit" tile wants active-only;
    // Payouts' lifetime "Profit till date" explicitly does not, since
    // archiving only ever happens once an IPO is fully settled and paid
    // out, meaning "archived" is the single most common state for a real,
    // already-realized profit to end up in). This function used to bake the
    // exclusion in here, which meant no caller could ever see archived
    // profit even if it filtered nothing itself — confirmed as the actual
    // cause of a sold, fully-paid IPO's profit silently vanishing from
    // Payouts the moment it archived.
    if (r.status !== 'SOLD' || !r.ipos) continue
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
      funderShare: result.funderShare,
      soldAmount: result.totalSoldAmount,
      applicationId: r.id,
      investedAmount: r.bid_amount,
      lots: r.lots,
      realizedAt: r.status_changed_at,
    })
  }
  return lines
}

// UNREALIZED profit for applications that are ALLOTTED but not yet sold —
// the estimate (live price once listed, GMP-based guess otherwise) rather
// than a real figure, same source expectedProfitBreakdown already uses for
// Dashboard's "Expected profit" tile, just computed per-application here
// instead of aggregated per funder-card. Named and shaped to mirror
// BookedProfitLine exactly (profit/investedAmount/lots/applicationId) so
// the Payouts analytics dashboard can concatenate realized + unrealized
// lines onto one timeline/table without a third shape to reconcile.
export interface UnrealizedProfitLine {
  ipoName: string
  ipoId: string
  funderName: string
  funderPhone: string | null
  holderName: string
  holderPhone: string | null
  profit: number
  // The account holder's own cut and the funder's own share of what's
  // left, straight off the same computeProfitSplit result `profit` (the
  // admin's own share) is already taken from — exposed so a consumer can
  // show/send all three real shares of one application's expected profit
  // instead of just the admin's net number.
  holderCut: number
  funderShare: number
  investedAmount: number
  lots: number
  applicationId?: string
  allottedAt?: string
  // Whether `profit` came from a live quote or the static GMP estimate —
  // surfaced so the UI can say "estimated" rather than imply certainty.
  priceSource: 'live' | 'gmp'
}

// Optional — only PayoutsPage's calls pass this (see its own note on why
// this is scoped to that page and not the shared Dashboard/Notifications
// callers of this same function). When given, any row whose IPO lists TODAY
// and it's still before 10am IST gets skipped entirely rather than counted
// off a live quote that may still be NSE's pre-open indicative price, not a
// real traded one.
export interface ListingCutoff {
  todayIstStr: string
  hour: number
}

function blockedByListingCutoff(listingDate: string | null | undefined, cutoff?: ListingCutoff): boolean {
  return !!cutoff && listingDate === cutoff.todayIstStr && cutoff.hour < 10
}

export function buildUnrealizedProfitLines(
  rows: ProfitProjectionRow[],
  profitPersonName: string,
  livePriceBySymbol: Record<string, number | null>,
  case2ManagerIds: Set<string> = new Set(),
  listingCutoff?: ListingCutoff,
): UnrealizedProfitLine[] {
  const lines: UnrealizedProfitLine[] = []
  for (const r of rows) {
    // Same reasoning as buildBookedProfitLines above — archived status is a
    // caller decision, not baked in here. Practically near-impossible to hit
    // for an ALLOTTED row anyway (auto-archive requires every row on the
    // IPO already resolved), kept only for consistency with that function.
    if (r.status !== 'ALLOTTED' || !r.ipos) continue
    if (r.bid_amount == null || !r.ipos.price_high) continue
    if (blockedByListingCutoff(r.ipos.listing_date, listingCutoff)) continue
    const funder = effectiveFunder(r)
    const holderName = r.demat_accounts?.holder_name ?? 'Unknown'
    const isCase2 = !!r.demat_accounts?.account_manager_id && case2ManagerIds.has(r.demat_accounts.account_manager_id)
    const livePrice = r.ipos.symbol ? livePriceBySymbol[r.ipos.symbol] : null
    const gmpPercent = parseGmpPercent(r.ipos.gmp_notes) ?? 0
    const priceSource: 'live' | 'gmp' = livePrice != null ? 'live' : 'gmp'
    const sellPricePerShare = livePrice != null ? livePrice : r.ipos.price_high * (1 + gmpPercent / 100)
    const result = computeProfitSplit({
      sellPricePerShare,
      lotSize: r.ipos.lot_size,
      lots: r.lots,
      bidAmount: r.bid_amount,
      cutPercent: r.demat_accounts?.profit_share_percent ?? 25,
      dematHolderName: holderName,
      funderName: funder?.account_holder_name ?? null,
      profitPersonName,
      // NOT r.split_profit_with_funder — that column defaults to false at
      // the DB level (migration 0023) and is only ever actually SET by an
      // admin decision at the moment of marking an application SOLD (the
      // "Split remaining 50/50" checkbox on AllotmentBoardPage's sale
      // form). For anything still just ALLOTTED, nobody has decided
      // anything yet — reading the column here silently treated every
      // not-yet-sold application as "don't split," which is the column's
      // idle default, not a real choice. The standard 3-way split (holder
      // cut, then the remainder 50/50 between funder and admin) is the
      // correct assumption for a projection with no sale-time decision on
      // record yet; only a CASE_2 shared account (whose manager IS the
      // funder) genuinely has no third party to split with.
      splitWithFunder: !isCase2,
    })
    lines.push({
      ipoName: r.ipos.company_name,
      ipoId: r.ipo_id,
      funderName: funder?.account_holder_name ?? holderName,
      funderPhone: funder?.phone_e164 ?? null,
      holderName,
      holderPhone: r.demat_accounts?.phone_e164 ?? null,
      profit: result.profitPersonShare,
      holderCut: result.isDematHolderSelf ? 0 : result.dematCutAmount,
      funderShare: result.funderShare,
      investedAmount: r.bid_amount,
      lots: r.lots,
      applicationId: r.id,
      allottedAt: r.applied_at,
      priceSource,
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
