// Shared data-fetching for PayoutsPage and FunderPayoutsPage — both need the
// exact same settlement/expected-profit figures (whole-portal for admin on
// PayoutsPage, RLS-scoped to just their own data for a funder on either
// page), so this is one hook instead of two independently-maintained copies
// that could silently drift apart on the math.
import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import { useAllotmentBoardAll, queryKeys } from './queries'
import { useAuth } from '../contexts/AuthContext'
import { showToast } from './toast'
import { sameIdentity } from './applicationAttribution'
import { nowIst } from './ipoStatus'
import { buildFunderAllottedCards, type ProfitProjectionRow, type ListingCutoff } from './expectedProfit'
import { buildSettlementCards, groupCardsByIpo } from './settlement'
import { hydrateDematAccounts } from './hydrateDemat'
import type { SettlementPayment } from '../types/database'

const EMPTY_PROJECTION_ROWS: ProfitProjectionRow[] = []
const EMPTY_LIVE_PRICES: Record<string, number | null> = {}
const EMPTY_CASE2_IDS: Set<string> = new Set()
const EMPTY_PAYMENTS: SettlementPayment[] = []

interface LocalPayoutsData {
  payments: SettlementPayment[]
  expectedCards: ReturnType<typeof buildFunderAllottedCards>
  livePriceBySymbol: Record<string, number | null>
  allRows: ProfitProjectionRow[]
  case2ManagerIds: Set<string>
}

export function usePayoutsData() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const queryClient = useQueryClient()
  const boardQuery = useAllotmentBoardAll()
  // NOT filtered by ipo_is_archived — archiving is a housekeeping action
  // for the active-tracking pages (Dashboard, Applications, Allotment
  // board), never a "this money never happened" action. A SOLD application
  // whose IPO later archives still has real settlement obligations
  // (unpaid amounts, log-a-payment) that shouldn't disappear the moment it
  // archives — confirmed live: an archived, still-unpaid IPO's whole
  // settlement card used to vanish from every section of this page.
  const rows = useMemo(() => (boardQuery.data ?? []).filter((r) => r.status === 'SOLD'), [boardQuery.data])

  const localPayoutsQuery = useQuery<LocalPayoutsData>({
    queryKey: queryKeys.payoutsLocal,
    queryFn: async () => {
      const [paymentsRes, expectedRes, case2ManagersRes, allRowsRes] = await Promise.all([
        supabase.from('settlement_payments').select('*').order('created_at', { ascending: false }),
        supabase
          .from('applications')
          .select(
            'demat_id, ipo_id, lots, applied_at, status, mandate_status, ipoji_status_text, bid_amount, sell_price, split_profit_with_funder, ' +
              'ipos(company_name, open_date, close_date, listing_date, price_high, lot_size, gmp_notes, is_archived, symbol), ' +
              'demat_accounts(holder_name, profit_share_percent, phone_e164, account_manager_id), ' +
              'bank_accounts!bank_account_id(account_holder_name, phone_e164, upi_id), ' +
              'funder_override:bank_accounts!funder_override_id(account_holder_name, phone_e164, upi_id)',
          )
          .eq('status', 'ALLOTTED')
          .or('bank_account_id.not.is.null,funder_override_id.not.is.null'),
        supabase.from('account_managers').select('id').eq('case_type', 'CASE_2'),
        supabase
          .from('applications')
          .select(
            'id, demat_id, ipo_id, lots, applied_at, status, status_changed_at, mandate_status, ipoji_status_text, bid_amount, sell_price, split_profit_with_funder, ' +
              'ipos(company_name, open_date, close_date, listing_date, price_high, lot_size, gmp_notes, is_archived, symbol), ' +
              'demat_accounts(holder_name, profit_share_percent, phone_e164, account_manager_id), ' +
              'bank_accounts!bank_account_id(account_holder_name, phone_e164, upi_id), ' +
              'funder_override:bank_accounts!funder_override_id(account_holder_name, phone_e164, upi_id)',
          ),
      ])
      if (paymentsRes.error) showToast(`Couldn't load settlement payments: ${paymentsRes.error.message}`, 'warning')
      const payments = (paymentsRes.data as SettlementPayment[]) ?? []

      if (allRowsRes.error) showToast(`Couldn't load applications for analytics: ${allRowsRes.error.message}`, 'warning')
      // See lib/hydrateDemat.ts — a funder-only viewer's demat embed is
      // RLS-blocked, and the `?? 25` cut fallback would silently compute
      // their figures off a made-up percentage. No-ops for admin.
      const allRows = await hydrateDematAccounts((allRowsRes.data ?? []) as unknown as ProfitProjectionRow[])

      if (expectedRes.error) {
        showToast(`Couldn't load expected payouts: ${expectedRes.error.message}`, 'warning')
        return { payments, expectedCards: [], livePriceBySymbol: {}, allRows, case2ManagerIds: new Set<string>() }
      }
      const expectedRowsBaseAll = await hydrateDematAccounts(
        (expectedRes.data ?? []) as unknown as ProfitProjectionRow[],
      )
      // 10am-listing-day hold-back (see lib/expectedProfit.ts's ListingCutoff)
      // — scoped to this page's own projections only.
      const { dateStr: todayIstStrLocal, hour: nowIstHourLocal } = nowIst()
      const expectedRowsBase = expectedRowsBaseAll.filter(
        (r) => !(r.ipos?.listing_date === todayIstStrLocal && nowIstHourLocal < 10),
      )
      const case2ManagerIds = new Set((case2ManagersRes.data ?? []).map((m) => m.id as string))
      const expectedCards = buildFunderAllottedCards(expectedRowsBase, sameIdentity, case2ManagerIds).filter((c) => c.priceHigh)
      const symbols = Array.from(
        new Set([
          ...expectedCards.map((c) => c.symbol).filter((s): s is string => !!s),
          ...allRows.filter((r) => r.status === 'ALLOTTED').map((r) => r.ipos?.symbol).filter((s): s is string => !!s),
        ]),
      )
      let livePriceBySymbol: Record<string, number | null> = {}
      if (symbols.length > 0) {
        const { data: priceData } = await supabase.functions.invoke<{
          prices?: Record<string, { price: number | null; stale: boolean }>
        }>('fetch-stock-price', { body: { symbols } })
        for (const [sym, p] of Object.entries(priceData?.prices ?? {})) livePriceBySymbol[sym] = p.price
      }
      return { payments, expectedCards, livePriceBySymbol, allRows, case2ManagerIds }
    },
  })
  const payments = localPayoutsQuery.data?.payments ?? EMPTY_PAYMENTS
  const expectedCards = localPayoutsQuery.data?.expectedCards ?? []
  const livePriceBySymbol = localPayoutsQuery.data?.livePriceBySymbol ?? EMPTY_LIVE_PRICES
  const allRows = localPayoutsQuery.data?.allRows ?? EMPTY_PROJECTION_ROWS
  const case2ManagerIds = localPayoutsQuery.data?.case2ManagerIds ?? EMPTY_CASE2_IDS
  const loading = boardQuery.isPending || localPayoutsQuery.isPending
  const loadError = localPayoutsQuery.error instanceof Error ? localPayoutsQuery.error.message : null

  function invalidatePayoutsData() {
    queryClient.invalidateQueries({ queryKey: queryKeys.allotmentBoard })
    queryClient.invalidateQueries({ queryKey: queryKeys.payoutsLocal })
  }

  const paymentsByApp = useMemo(() => {
    const m = new Map<string, SettlementPayment[]>()
    for (const p of payments) {
      if (!m.has(p.application_id)) m.set(p.application_id, [])
      m.get(p.application_id)!.push(p)
    }
    return m
  }, [payments])

  // '' for a non-admin, not their own name — computeProfitSplit uses this to
  // detect "is the funder ALSO the profit-taking admin," and a funder's own
  // name here would spuriously match their own row, zeroing what they're
  // owed. A non-admin viewer is never the profit-taking admin by construction.
  const profitPersonName = isAdmin ? (profile?.full_name ?? '') : ''
  const settlementCards = useMemo(
    () => buildSettlementCards(rows, profitPersonName, paymentsByApp),
    [rows, profitPersonName, paymentsByApp],
  )
  const ipoSettlementGroups = useMemo(() => groupCardsByIpo(settlementCards), [settlementCards])
  const { dateStr: todayIstStr, hour: nowIstHour } = nowIst()
  const listingCutoff: ListingCutoff = useMemo(() => ({ todayIstStr, hour: nowIstHour }), [todayIstStr, nowIstHour])

  return {
    isAdmin,
    profile,
    boardQuery,
    rows,
    allRows,
    payments,
    paymentsByApp,
    expectedCards,
    livePriceBySymbol,
    case2ManagerIds,
    settlementCards,
    ipoSettlementGroups,
    profitPersonName,
    listingCutoff,
    loading,
    loadError,
    invalidatePayoutsData,
  }
}
