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
