import { describe, expect, it } from 'vitest'
import { estimateLotProfit } from './lotProfitEstimate'

describe('estimateLotProfit', () => {
  it('matches the user-specified formula exactly: lotAmount * gmp%, minus 25% holder cut, /2', () => {
    // 1 lot @ price_high 150, lot_size 100 -> lot amount 15,000.
    // GMP 17% -> gross profit = 15,000 * 0.17 = 2,550.
    // Holder cut (25%) = 637.5. Remainder = 1,912.5. Your half = 956.25.
    const e = estimateLotProfit(150, 100, 'GMP: ₹25-26 (17%)')
    expect(e).not.toBeNull()
    expect(e!.lotAmount).toBe(15000)
    expect(e!.gmpPercent).toBe(17)
    expect(e!.grossProfit).toBeCloseTo(2550, 6)
    expect(e!.holderCut).toBeCloseTo(637.5, 6)
    expect(e!.yourShare).toBeCloseTo(956.25, 6)
  })

  it('reproduces the 15,000-lot example from the request 1:1', () => {
    // price_high * lot_size = 15,000 exactly (e.g. 100 shares @ ₹150).
    const e = estimateLotProfit(150, 100, '(20%)')
    // gross = 15000 * 0.20 = 3000; holder cut 25% = 750; remainder 2250; /2 = 1125.
    expect(e!.grossProfit).toBe(3000)
    expect(e!.holderCut).toBe(750)
    expect(e!.yourShare).toBe(1125)
  })

  it('returns null with no price band yet (price_high not announced)', () => {
    expect(estimateLotProfit(null, 100, '(17%)')).toBeNull()
  })

  it('returns null with no parseable GMP percentage', () => {
    expect(estimateLotProfit(150, 100, null)).toBeNull()
    expect(estimateLotProfit(150, 100, 'GMP: not available')).toBeNull()
  })

  it('never charges the holder for a loss (negative GMP) — same rule as computeProfitSplit', () => {
    const e = estimateLotProfit(150, 100, '(-10%)')
    expect(e!.grossProfit).toBeCloseTo(-1500, 6)
    expect(e!.holderCut).toBe(0)
    // Loss still splits 50/50 with the funder.
    expect(e!.yourShare).toBeCloseTo(-750, 6)
  })

  it('honors a custom holder cut percentage when given one', () => {
    const e = estimateLotProfit(150, 100, '(20%)', 20)
    // gross 3000, holder cut 20% = 600, remainder 2400, /2 = 1200.
    expect(e!.holderCut).toBe(600)
    expect(e!.yourShare).toBe(1200)
  })
})
