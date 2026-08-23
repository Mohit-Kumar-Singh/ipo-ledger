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
  // The cut is always computed the same way; when the demat holder *is* the
  // profit person it just isn't an external payout — it flows back into
  // their own share below instead of being a line item owed to someone else.
  const dematCutAmount = grossProfit * (input.cutPercent / 100)
  const remainingAfterCut = grossProfit - dematCutAmount
  const hasFunder = input.funderName != null && input.funderName.trim() !== ''
  const isFunderSelf = hasFunder ? namesMatch(input.funderName, input.profitPersonName) : true
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
