import type { AllotmentBoardRow } from '../types/database'

export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export interface ProfitSplitInput {
  sellPricePerShare: number
  lotSize: number
  lots: number
  bidAmount: number
  cutPercent: number
  dematHolderName: string
  funderName: string | null
  profitPersonName: string
  splitWithFunder: boolean
}

export interface ProfitSplitResult {
  totalSoldAmount: number
  grossProfit: number
  dematCutAmount: number
  isDematHolderSelf: boolean
  remainingAfterCut: number
  hasFunder: boolean
  isFunderSelf: boolean
  funderShare: number
  profitPersonShare: number
}

export function computeProfitSplit(input: ProfitSplitInput): ProfitSplitResult {
  const totalSoldAmount = input.sellPricePerShare * input.lotSize * input.lots
  const grossProfit = totalSoldAmount - input.bidAmount
  const isDematHolderSelf = namesMatch(input.dematHolderName, input.profitPersonName)
  const hasFunder = input.funderName != null && input.funderName.trim() !== ''
  const isFunderSelf = hasFunder ? namesMatch(input.funderName, input.profitPersonName) : true

  // A LOSS is never the account holder's to share — their "cut" is
  // compensation for lending their demat account to hold someone else's
  // money, not a stake in capital they never risked, so there's nothing of
  // theirs to deduct when the sale comes in under cost. Confirmed as an
  // actual live bug, not just a missing feature: applying the same
  // percentage-of-profit formula to a NEGATIVE grossProfit (the old
  // behavior below) made dematCutAmount negative too, which made
  // amountFromHolder (settlement.ts) exceed totalSoldAmount — the holder
  // was being asked to hand back MORE than the sale actually returned.
  // Splits the whole loss 50/50 with a genuine third-party funder
  // regardless of that sale's splitWithFunder toggle (that toggle only
  // ever governs how a PROFIT's remainder splits, not this) — falls
  // entirely to the admin alone when there's no separate funder to split
  // with, same as a profit would. The one case NOT covered here: the
  // demat holder genuinely funded their own application (isDematHolderSelf)
  // — that's real capital they put up themselves, so they bear their own
  // loss same as anyone would; the branch below already handles that
  // correctly by folding dematCutAmount back into their own share.
  if (grossProfit < 0 && !isDematHolderSelf) {
    const hasRealFunder = hasFunder && !isFunderSelf
    const funderShare = hasRealFunder ? grossProfit / 2 : 0
    const profitPersonShare = grossProfit - funderShare
    return {
      totalSoldAmount,
      grossProfit,
      dematCutAmount: 0,
      isDematHolderSelf,
      remainingAfterCut: grossProfit,
      hasFunder,
      isFunderSelf,
      funderShare,
      profitPersonShare,
    }
  }

  // The cut is always computed the same way; when the demat holder *is* the
  // profit person it just isn't an external payout — it flows back into
  // their own share below instead of being a line item owed to someone else.
  const dematCutAmount = grossProfit * (input.cutPercent / 100)
  const remainingAfterCut = grossProfit - dematCutAmount
  const funderShare = hasFunder && input.splitWithFunder && !isFunderSelf ? remainingAfterCut / 2 : 0
  const profitPersonShare = remainingAfterCut - funderShare + (isDematHolderSelf ? dematCutAmount : 0)

  return {
    totalSoldAmount,
    grossProfit,
    dematCutAmount,
    isDematHolderSelf,
    remainingAfterCut,
    hasFunder,
    isFunderSelf,
    funderShare,
    profitPersonShare,
  }
}

// A shared account (migration 0079) forces splitWithFunder=false when its
// manager is CASE_2 — that person already covers both the account-holder
// and funder roles in their own cut, so there's no separate 50/50 with a
// third-party funder to compute. CASE_1 (and non-shared rows) keep whatever
// the caller/form asked for. Used by AllotmentBoardPage, PayoutsPage,
// DashboardPage, ArchivesPage, and settlement.ts — moved here (not living on
// whichever page needed it first) so a lib file depending on it isn't
// importing from a page component.
export function effectiveSplitWithFunder(row: AllotmentBoardRow, requested: boolean): boolean {
  return row.account_manager_case_type === 'CASE_2' ? false : requested
}

// Who actually receives the demat-side cut/message for this row — the
// shared-account manager (Person X/Y) when one's assigned, since they
// manage the relationship end-to-end and the real PAN holder isn't the
// point of contact for these accounts (migration 0079). Falls back to the
// literal holder for every normal, non-shared account.
export function payoutCutContact(row: AllotmentBoardRow): { name: string; phone: string | null } {
  return row.account_manager_id
    ? { name: row.account_manager_name ?? row.holder_name, phone: row.account_manager_phone }
    : { name: row.holder_name, phone: row.phone_e164 }
}
