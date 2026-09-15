import { describe, expect, it } from 'vitest'
import { computeHoldingPnl, pnlAttribution, summarizeCompanyHoldings } from './parentCompanyPnl'
import type { ParentCompanyHolding } from '../types/database'

function holding(overrides: Partial<ParentCompanyHolding> = {}): ParentCompanyHolding {
  return {
    id: 'h1',
    parent_company_id: 'c1',
    demat_id: 'd1',
    quantity: 10,
    buy_price: 100,
    funder_id: null,
    loss_bearer_id: null,
    status: 'HELD',
    sell_price: null,
    created_at: '2026-01-01T00:00:00Z',
    bought_at: null,
    ...overrides,
  }
}

describe('computeHoldingPnl', () => {
  it('returns null current value and pnl for a HELD lot with no live price', () => {
    const result = computeHoldingPnl(holding(), null)
    expect(result).toEqual({ investedAmount: 1000, currentValue: null, pnl: null, isRealized: false })
  })

  it('computes unrealized pnl for a HELD lot against the live price', () => {
    const result = computeHoldingPnl(holding(), 120)
    expect(result).toEqual({ investedAmount: 1000, currentValue: 1200, pnl: 200, isRealized: false })
  })

  it('computes unrealized loss when the live price is below the buy price', () => {
    const result = computeHoldingPnl(holding(), 80)
    expect(result).toEqual({ investedAmount: 1000, currentValue: 800, pnl: -200, isRealized: false })
  })

  it('uses the recorded sell price for a SOLD lot, ignoring any live price passed in', () => {
    const result = computeHoldingPnl(holding({ status: 'SOLD', sell_price: 150 }), 999)
    expect(result).toEqual({ investedAmount: 1000, currentValue: 1500, pnl: 500, isRealized: true })
  })
})

describe('pnlAttribution', () => {
  it('gives the funder both profit and loss when the purchase was funded by someone else', () => {
    expect(pnlAttribution({ funder_id: 'b1', loss_bearer_id: null })).toEqual({
      profitBearer: 'funder',
      lossBearer: 'funder',
    })
  })

  it('gives the holder both profit and loss on a fully self-funded lot with no arrangement', () => {
    expect(pnlAttribution({ funder_id: null, loss_bearer_id: null })).toEqual({
      profitBearer: 'holder',
      lossBearer: 'holder',
    })
  })

  it('keeps profit with the holder but redirects loss when self-funded with a loss-bearer set', () => {
    expect(pnlAttribution({ funder_id: null, loss_bearer_id: 'b2' })).toEqual({
      profitBearer: 'holder',
      lossBearer: 'loss_bearer',
    })
  })

  it('ignores loss_bearer_id when a funder is present — funder wins', () => {
    expect(pnlAttribution({ funder_id: 'b1', loss_bearer_id: 'b2' })).toEqual({
      profitBearer: 'funder',
      lossBearer: 'funder',
    })
  })
})

describe('summarizeCompanyHoldings', () => {
  const isMe = (id: string | null) => id === 'me-bank'

  it('counts a lot the admin funded fully into fundedByMeTotal and myPnl', () => {
    const summary = summarizeCompanyHoldings(
      [holding({ funder_id: 'me-bank', quantity: 10, buy_price: 100 })],
      120,
      isMe,
    )
    expect(summary).toEqual({
      investedTotal: 1000,
      fundedByMeTotal: 1000,
      myPnl: 200,
      hasUnpriced: false,
      holderGains: [],
    })
  })

  it('excludes a lot funded by someone other than the admin from fundedByMeTotal/myPnl', () => {
    const summary = summarizeCompanyHoldings(
      [holding({ funder_id: 'someone-else-bank', quantity: 10, buy_price: 100 })],
      120,
      isMe,
    )
    expect(summary.fundedByMeTotal).toBe(0)
    expect(summary.myPnl).toBe(0)
  })

  it('reports a self-funded holder gain for visibility without adding it to myPnl', () => {
    const summary = summarizeCompanyHoldings(
      [holding({ demat_id: 'kannu', funder_id: null, loss_bearer_id: null, quantity: 5, buy_price: 100 })],
      140,
      isMe,
    )
    expect(summary.myPnl).toBe(0)
    expect(summary.holderGains).toEqual([{ dematId: 'kannu', pnl: 200 }])
  })

  it('does not report a self-funded loss with no loss-bearer arrangement as a holder gain', () => {
    const summary = summarizeCompanyHoldings(
      [holding({ funder_id: null, loss_bearer_id: null, quantity: 5, buy_price: 100 })],
      60,
      isMe,
    )
    expect(summary.myPnl).toBe(0)
    expect(summary.holderGains).toEqual([])
  })

  it('charges the admin a loss on a self-funded lot where they are the named loss bearer, but not a gain', () => {
    const lossCase = summarizeCompanyHoldings(
      [holding({ funder_id: null, loss_bearer_id: 'me-bank', quantity: 5, buy_price: 100 })],
      60,
      isMe,
    )
    expect(lossCase.myPnl).toBe(-200)
    expect(lossCase.holderGains).toEqual([])

    const gainCase = summarizeCompanyHoldings(
      [holding({ demat_id: 'kannu', funder_id: null, loss_bearer_id: 'me-bank', quantity: 5, buy_price: 100 })],
      140,
      isMe,
    )
    expect(gainCase.myPnl).toBe(0)
    expect(gainCase.holderGains).toEqual([{ dematId: 'kannu', pnl: 200 }])
  })

  it('flags hasUnpriced when a HELD lot has no live price, without throwing off other totals', () => {
    const summary = summarizeCompanyHoldings([holding({ funder_id: 'me-bank' })], null, isMe)
    expect(summary.hasUnpriced).toBe(true)
    expect(summary.myPnl).toBe(0)
    expect(summary.fundedByMeTotal).toBe(1000)
  })
})
