// The two-sided settlement calculation for SOLD applications — extracted
// from PayoutsPage.tsx (where it originally lived as a page-local function)
// so the Payouts analytics dashboard (lib/payoutAnalytics.ts) can reuse the
// exact same "what's still owed" math instead of recomputing it a second
// way. This is the authoritative source for settlement figures in this
// app — PayoutsPage's own settlement cards and the analytics dashboard's
// "Pending Payout" KPI both have to agree with each other, and the only way
// to guarantee that is one function, not two independently-written ones.
import { computeProfitSplit, effectiveSplitWithFunder, payoutCutContact } from './profitSplit'
import type { AllotmentBoardRow, SettlementPayment } from '../types/database'

// What the account holder owes back (principal + all profit except their
// own cut — money COMING IN) and what's owed out to whoever funded it
// (their principal + their profit share, if any — money GOING OUT), for one
// SOLD application. remainingFromHolder/remainingToFunder are the LIVE
// figures — the full amountFromHolder/amountToFunder owed, minus whatever
// settlement_payments rows have actually been logged against this
// application so far (migration 0078). Can go negative if overpaid; shown
// as-is rather than clamped to 0, since an overpayment is worth noticing,
// not hiding.
export interface SettlementCard {
  applicationId: string
  ipoId: string
  ipoName: string
  lots: number
  lotSize: number
  sellPrice: number
  bidAmount: number
  totalSoldAmount: number
  profitTotal: number
  cutPercent: number
  holderName: string
  holderPhone: string | null
  isDematHolderSelf: boolean
  dematCutAmount: number
  amountFromHolder: number
  hasFunder: boolean
  isFunderSelf: boolean
  funderName: string | null
  funderPhone: string | null
  // Portal user who owns the funding bank account (migration 0090) — lets a
  // funder-facing view include only rows THEY funded, rather than every row
  // that merely has a funder. See AllotmentBoardRow's own note.
  funderLinkedUserId: string | null
  funderShare: number
  amountToFunder: number
  // What's actually left over for the profit person (you) once both sides
  // above have moved — incoming minus outgoing, from computeProfitSplit
  // directly rather than re-derived, so it can never drift from the
  // authoritative split even if the two amounts above are ever adjusted.
  myProfit: number
  payments: SettlementPayment[]
  remainingFromHolder: number
  remainingToFunder: number
}

export function buildSettlementCards(
  rows: AllotmentBoardRow[],
  profitPersonName: string,
  paymentsByApp: Map<string, SettlementPayment[]>,
): SettlementCard[] {
  const cards: SettlementCard[] = []
  for (const r of rows) {
    if (r.sell_price == null) continue
    const result = computeProfitSplit({
      sellPricePerShare: r.sell_price,
      lotSize: r.lot_size,
      lots: r.lots,
      bidAmount: r.bid_amount ?? 0,
      // See the comment on Dashboard's buildPendingPayouts — a funder-only
      // viewer's own copy of this row has profit_share_percent nulled out
      // by demat_accounts RLS (they're not linked to the account they
      // funded), which without this fallback silently skipped the demat
      // holder's cut and inflated their own settlement figures.
      cutPercent: r.profit_share_percent ?? 25,
      dematHolderName: r.holder_name,
      funderName: r.bank_account_holder_name,
      profitPersonName,
      splitWithFunder: effectiveSplitWithFunder(r, r.split_profit_with_funder),
    })
    const bidAmount = r.bid_amount ?? 0
    const amountFromHolder = result.isDematHolderSelf ? 0 : result.totalSoldAmount - result.dematCutAmount
    // A CASE_2 shared account's "funder" IS its manager (same person as the
    // holder-side cut recipient, migration 0079) — their bidAmount return is
    // already folded into amountFromHolder above (bidAmount + their share of
    // the remainder, via effectiveSplitWithFunder forcing funderShare to 0).
    // Without this, hasFunder/isFunderSelf would still see a distinct bank
    // account and wrongly add a SECOND "owed to funder" line for the same
    // bidAmount that's already inside amountFromHolder.
    const amountToFunder =
      r.account_manager_case_type === 'CASE_2'
        ? 0
        : result.hasFunder && !result.isFunderSelf
          ? bidAmount + result.funderShare
          : 0
    const cutContact = payoutCutContact(r)
    const payments = paymentsByApp.get(r.application_id) ?? []
    // A holder_to_funder payment reduces BOTH sides at once — it's money
    // that left the holder's pocket (counts against what they still owe)
    // AND money the funder now has (counts against what's still owed to
    // them) — it just never passed through you.
    const paidByHolder = payments
      .filter((p) => p.kind === 'holder_to_admin' || p.kind === 'holder_to_funder')
      .reduce((s, p) => s + p.amount, 0)
    const sentToFunder = payments
      .filter((p) => p.kind === 'admin_to_funder' || p.kind === 'holder_to_funder')
      .reduce((s, p) => s + p.amount, 0)
    cards.push({
      applicationId: r.application_id,
      ipoId: r.ipo_id,
      ipoName: r.company_name,
      lots: r.lots,
      lotSize: r.lot_size,
      sellPrice: r.sell_price,
      bidAmount,
      totalSoldAmount: result.totalSoldAmount,
      profitTotal: result.grossProfit,
      // Display-only field (the "Show calculation" breakdown text) — same
      // fallback as the computeProfitSplit call above, so the number shown
      // always matches what dematCutAmount was actually computed from.
      cutPercent: r.profit_share_percent ?? 25,
      holderName: cutContact.name,
      holderPhone: cutContact.phone,
      isDematHolderSelf: result.isDematHolderSelf,
      dematCutAmount: result.dematCutAmount,
      amountFromHolder,
      hasFunder: result.hasFunder,
      isFunderSelf: result.isFunderSelf,
      funderName: r.bank_account_holder_name,
      funderPhone: r.bank_account_phone,
      funderLinkedUserId: r.bank_account_linked_user_id ?? null,
      funderShare: result.funderShare,
      amountToFunder,
      myProfit: result.profitPersonShare,
      payments,
      remainingFromHolder: amountFromHolder - paidByHolder,
      remainingToFunder: amountToFunder - sentToFunder,
    })
  }
  return cards
}

// Below a rupee, a card's remaining amount is just floating-point noise from
// the split math (halves/percentages), not a real outstanding balance — used
// as the threshold everywhere "still owed" is checked so a fully-settled
// card never shows up as a stray ₹0.4 entry.
export const SETTLED_EPSILON = 1

// Both directions of an application's own obligations done — the holder's
// side (if there was one to begin with) and the funder's side (ditto). A
// self-funded or self-held application is trivially "settled" on the side
// that never applied to it in the first place.
export function isCardFullySettled(c: SettlementCard): boolean {
  const holderDone = c.isDematHolderSelf || c.amountFromHolder <= 0 || c.remainingFromHolder <= SETTLED_EPSILON
  const funderDone = !c.hasFunder || c.isFunderSelf || c.amountToFunder <= 0 || c.remainingToFunder <= SETTLED_EPSILON
  return holderDone && funderDone
}

// Which of the two legacy paid-flags on `applications` a settlement state
// implies. The flags predate the settlement_payments ledger (0078 replaced
// the "one lump payment, all-or-nothing" model they encode) but are still
// what the Dashboard's "Payouts pending" tile, this page's Outstanding/Paid
// sections, and auto-archive all read — so logging enough payments to clear
// a side has to flip the matching flag, or those three keep insisting money
// is owed that the ledger already shows as received.
//
// Deliberately only ever reports true. Payments are append-only (there's no
// delete in the UI), so a remaining balance only ever decreases and a flag
// only ever needs to go unpaid -> paid; nothing here should un-mark a flag
// an admin set by hand.
//
// Takes the remaining amounts as arguments rather than reading them off the
// card, so the caller can pass post-payment figures for a payment that
// hasn't been re-fetched yet.
export function settledPaidFlags(
  c: SettlementCard,
  remainingFromHolder: number,
  remainingToFunder: number,
): { demat_cut_paid?: true; funder_share_paid?: true } {
  const flags: { demat_cut_paid?: true; funder_share_paid?: true } = {}
  if (!c.isDematHolderSelf && c.amountFromHolder > 0 && remainingFromHolder <= SETTLED_EPSILON) {
    flags.demat_cut_paid = true
  }
  if (c.hasFunder && !c.isFunderSelf && c.amountToFunder > 0 && remainingToFunder <= SETTLED_EPSILON) {
    flags.funder_share_paid = true
  }
  return flags
}

export interface IpoSettlementGroup {
  ipoName: string
  cards: SettlementCard[]
  allSettled: boolean
}

// One entry per IPO, not per application — grouped + sorted with any
// still-outstanding IPO first, so the ones needing action surface above the
// fully-settled ones rather than being interleaved by application id order.
export function groupCardsByIpo(cards: SettlementCard[]): IpoSettlementGroup[] {
  const byIpo = new Map<string, SettlementCard[]>()
  for (const c of cards) {
    if (!byIpo.has(c.ipoName)) byIpo.set(c.ipoName, [])
    byIpo.get(c.ipoName)!.push(c)
  }
  return Array.from(byIpo.entries())
    .map(([ipoName, ipoCards]) => ({ ipoName, cards: ipoCards, allSettled: ipoCards.every(isCardFullySettled) }))
    .sort((a, b) => Number(a.allSettled) - Number(b.allSettled) || a.ipoName.localeCompare(b.ipoName))
}
