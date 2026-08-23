import { describe, expect, it } from 'vitest'
import { buildSettlementCards, isCardFullySettled, settledPaidFlags, groupCardsByIpo, SETTLED_EPSILON } from './settlement'
import type { AllotmentBoardRow, SettlementPayment } from '../types/database'

function boardRow(overrides: Partial<AllotmentBoardRow> = {}): AllotmentBoardRow {
  return {
    application_id: 'app-1',
    ipo_id: 'ipo-1',
    demat_id: 'demat-1',
    company_name: 'Test Co',
    listing_date: null,
    holder_name: 'Holder A',
    pan_masked: 'XXXXX0000X',
    phone_e164: '+910000000001',
    profit_share_percent: 25,
    bank_name: null,
    last4: null,
    lots: 1,
    bid_amount: 80_000,
    status: 'SOLD',
    sell_price: 1000, // lot_size(100) * 1000 = 100,000 sold; profit 20,000
    lot_size: 100,
    split_profit_with_funder: true,
    demat_cut_paid: false,
    funder_share_paid: false,
    upi_id: null,
    bank_account_holder_name: 'Funder B',
    bank_account_phone: '+910000000002',
    mandate_status: 'APPROVED',
    ipo_is_archived: false,
    is_funder_override: false,
    close_date: '2026-01-01',
    demat_linked_user_id: null,
    status_changed_at: '2026-01-01T00:00:00Z',
    gmp_notes: null,
    platform: null,
    account_manager_id: null,
    account_manager_name: null,
    account_manager_phone: null,
    account_manager_case_type: null,
    ...overrides,
  }
}

function payment(overrides: Partial<SettlementPayment> = {}): SettlementPayment {
  return {
    id: 'pay-1',
    application_id: 'app-1',
    kind: 'holder_to_admin',
    amount: 1000,
    note: null,
    created_by: null,
    created_at: '2026-01-02T00:00:00Z',
    idempotency_key: null,
    ...overrides,
  }
}

describe('buildSettlementCards — gross figures', () => {
  it('holder owes back sold amount minus their own cut; funder is owed principal + their share', () => {
    const [c] = buildSettlementCards([boardRow()], 'Admin', new Map())
    // gross profit 20,000; holder cut 25% = 5,000; remainder 15,000, split
    // 50/50 with the funder => funderShare 7,500, myProfit 7,500
    expect(c.dematCutAmount).toBe(5_000)
    expect(c.amountFromHolder).toBe(95_000) // 100,000 total - 5,000 cut
    expect(c.amountToFunder).toBe(87_500) // 80,000 principal + 7,500 share
    expect(c.myProfit).toBe(7_500)
    expect(c.remainingFromHolder).toBe(95_000)
    expect(c.remainingToFunder).toBe(87_500)
  })

  it('skips rows with no sell_price at all (not yet actually sold)', () => {
    const cards = buildSettlementCards([boardRow({ sell_price: null })], 'Admin', new Map())
    expect(cards).toHaveLength(0)
  })

  it('a CASE_2 shared account: manager IS the funder, no second "owed to funder" line for the same principal', () => {
    const row = boardRow({
      account_manager_id: 'mgr-1',
      account_manager_name: 'Person Y',
      account_manager_phone: '+910000000009',
      account_manager_case_type: 'CASE_2',
      profit_share_percent: 70,
    })
    const [c] = buildSettlementCards([row], 'Admin', new Map())
    // Y's 70% cut already covers both roles — nothing separately "owed to a
    // funder" for this application. This is exactly the double-count bug
    // fixed in v1.174.0 (see settlement.ts's own comment on amountToFunder).
    expect(c.amountToFunder).toBe(0)
    expect(c.holderName).toBe('Person Y') // routed to the manager, not the literal PAN holder
    // gross profit 20,000, cut 70% = 14,000, holder(=manager) collects it
    // via amountFromHolder = 100,000 - 14,000 = 86,000
    expect(c.dematCutAmount).toBe(14_000)
    expect(c.amountFromHolder).toBe(86_000)
  })
})

describe('buildSettlementCards — payments reduce what remains', () => {
  it('a holder_to_admin payment reduces ONLY the holder-owed side', () => {
    const paymentsByApp = new Map([['app-1', [payment({ kind: 'holder_to_admin', amount: 30_000 })]]])
    const [c] = buildSettlementCards([boardRow()], 'Admin', paymentsByApp)
    expect(c.remainingFromHolder).toBe(95_000 - 30_000)
    expect(c.remainingToFunder).toBe(87_500) // untouched
  })

  it('a holder_to_funder payment reduces BOTH sides at once — money left the holder AND reached the funder, without passing through the admin', () => {
    const paymentsByApp = new Map([['app-1', [payment({ kind: 'holder_to_funder', amount: 40_000 })]]])
    const [c] = buildSettlementCards([boardRow()], 'Admin', paymentsByApp)
    expect(c.remainingFromHolder).toBe(95_000 - 40_000)
    expect(c.remainingToFunder).toBe(87_500 - 40_000)
  })

  it('overpayment goes negative rather than being clamped to zero, so it stays visible as a real overpayment', () => {
    const paymentsByApp = new Map([['app-1', [payment({ kind: 'holder_to_admin', amount: 200_000 })]]])
    const [c] = buildSettlementCards([boardRow()], 'Admin', paymentsByApp)
    expect(c.remainingFromHolder).toBeLessThan(0)
  })
})

describe('isCardFullySettled / settledPaidFlags', () => {
  it('a card with nothing paid is not settled', () => {
    const [c] = buildSettlementCards([boardRow()], 'Admin', new Map())
    expect(isCardFullySettled(c)).toBe(false)
    expect(settledPaidFlags(c, c.remainingFromHolder, c.remainingToFunder)).toEqual({})
  })

  it('both sides paid down to within SETTLED_EPSILON counts as fully settled', () => {
    const [c] = buildSettlementCards([boardRow()], 'Admin', new Map())
    const flags = settledPaidFlags(c, SETTLED_EPSILON - 0.5, SETTLED_EPSILON - 0.5)
    expect(flags).toEqual({ demat_cut_paid: true, funder_share_paid: true })
  })

  it('settledPaidFlags never reports false — it only ever adds a flag, never removes one an admin already set by hand', () => {
    const [c] = buildSettlementCards([boardRow()], 'Admin', new Map())
    const flags = settledPaidFlags(c, c.remainingFromHolder, c.remainingToFunder)
    expect(Object.values(flags).every((v) => v === true)).toBe(true)
  })

  it('a self-funded, self-held application (no external holder or funder) is trivially settled', () => {
    const row = boardRow({ holder_name: 'Admin', bank_account_holder_name: 'Admin' })
    const [c] = buildSettlementCards([row], 'Admin', new Map())
    expect(c.isDematHolderSelf).toBe(true)
    expect(c.isFunderSelf).toBe(true)
    expect(isCardFullySettled(c)).toBe(true)
  })
})

describe('groupCardsByIpo', () => {
  it('groups by IPO name and puts any still-outstanding IPO first', () => {
    const settledRow = boardRow({
      application_id: 'app-settled',
      ipo_id: 'ipo-settled',
      company_name: 'Settled Co',
      holder_name: 'Admin',
      bank_account_holder_name: 'Admin',
    })
    const outstandingRow = boardRow({ application_id: 'app-outstanding', ipo_id: 'ipo-outstanding', company_name: 'Outstanding Co' })
    const cards = buildSettlementCards([settledRow, outstandingRow], 'Admin', new Map())
    const groups = groupCardsByIpo(cards)
    expect(groups.map((g) => g.ipoName)).toEqual(['Outstanding Co', 'Settled Co'])
    expect(groups[0].allSettled).toBe(false)
    expect(groups[1].allSettled).toBe(true)
  })
})
