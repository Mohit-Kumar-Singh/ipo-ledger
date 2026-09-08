import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { InlineSpinner } from '../../components/PageSpinner'
import { buildHoldings, soldSharesByApplication, type HoldingSourceRow } from '../../lib/partialSells'
import type { ApplicationSell } from '../../types/database'

function rupees(n: number): string {
  const sign = n < 0 ? '−' : ''
  return `${sign}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`
}

// Shares still sitting in a demat account after a partial sale, grouped by
// the account holder they're held under and valued at the live market
// price. "Open positions" — the counterpart to Payouts (which is about
// money already realized). Only ALLOTTED / PARTIALLY_SOLD applications can
// contribute; a fully SOLD one has nothing left to show here.
//
// RLS scopes the rows: an admin sees every holding, a member sees holdings
// on demat accounts they're linked to plus applications they funded.
//
// Valuation is live-price-only by design — an IPO with no resolvable symbol
// (or one the quote service can't price) shows its share count but no rupee
// value, rather than a GMP/issue-price guess dressed up as a real number.
export function HoldingsPage() {
  const holdingsQuery = useQuery({
    queryKey: ['holdings'],
    queryFn: async () => {
      const { data: apps, error } = await supabase
        .from('applications')
        .select(
          'id, ipo_id, demat_id, lots, bid_amount, status, ipos(company_name, lot_size, symbol), demat_accounts(holder_name)',
        )
        .in('status', ['ALLOTTED', 'PARTIALLY_SOLD'])
      if (error) throw error

      const rows: HoldingSourceRow[] = (apps ?? [])
        .filter((a) => a.ipos)
        .map((a) => {
          const ipo = a.ipos as unknown as { company_name: string; lot_size: number; symbol: string | null }
          const demat = a.demat_accounts as unknown as { holder_name: string } | null
          return {
            application_id: a.id as string,
            demat_id: a.demat_id as string,
            holder_name: demat?.holder_name ?? 'Account holder',
            ipo_id: a.ipo_id as string,
            ipo_name: ipo.company_name,
            symbol: ipo.symbol,
            lot_size: ipo.lot_size,
            lots: a.lots as number,
            bid_amount: (a.bid_amount as number | null) ?? null,
            status: a.status as string,
          }
        })

      const appIds = rows.map((r) => r.application_id)
      let sells: Pick<ApplicationSell, 'application_id' | 'shares'>[] = []
      if (appIds.length > 0) {
        const { data: sellRows, error: sellErr } = await supabase
          .from('application_sells')
          .select('application_id, shares')
          .in('application_id', appIds)
        if (sellErr) throw sellErr
        sells = (sellRows ?? []) as Pick<ApplicationSell, 'application_id' | 'shares'>[]
      }

      const symbols = Array.from(new Set(rows.map((r) => r.symbol).filter((s): s is string => !!s)))
      let livePriceBySymbol: Record<string, number | null> = {}
      if (symbols.length > 0) {
        const { data: priceData } = await supabase.functions.invoke<{
          prices?: Record<string, { price: number | null; stale: boolean }>
        }>('fetch-stock-price', { body: { symbols } })
        for (const [sym, p] of Object.entries(priceData?.prices ?? {})) livePriceBySymbol[sym] = p.price
      }

      return buildHoldings(rows, soldSharesByApplication(sells), livePriceBySymbol)
    },
  })

  const data = holdingsQuery.data
  const totalLiveValue = data?.byHolder.reduce((s, h) => s + h.liveValue, 0) ?? 0
  const anyUnpriced = data?.byHolder.some((h) => h.hasUnpricedHolding) ?? false

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Open positions
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--ink-muted)' }}>
          Shares still held after a partial sale, by account holder, valued at the live market price.
        </p>
      </div>

      {holdingsQuery.isPending && <InlineSpinner />}
      {holdingsQuery.error instanceof Error && (
        <p className="text-sm" style={{ color: 'var(--critical)' }}>
          Couldn't load holdings: {holdingsQuery.error.message}
        </p>
      )}

      {data && data.byHolder.length === 0 && !holdingsQuery.isPending && (
        <div className="card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
          No open positions — every allotment is either fully sold or not yet partially sold.
        </div>
      )}

      {data && data.byHolder.length > 0 && (
        <>
          <div className="card p-4">
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
              Total live value held
            </p>
            <p className="font-mono-ipo text-2xl font-semibold" style={{ color: 'var(--ink-primary)' }}>
              {rupees(totalLiveValue)}
            </p>
            {anyUnpriced && (
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                Some positions have no live price and aren't counted in this total.
              </p>
            )}
          </div>

          {data.byHolder.map((holder) => (
            <div key={holder.dematId} className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
                  {holder.holderName}
                </h2>
                <span className="font-mono-ipo text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {holder.liveValue > 0 ? rupees(holder.liveValue) : '—'}
                  {holder.hasUnpricedHolding && (
                    <span style={{ color: 'var(--ink-muted)' }}> +unpriced</span>
                  )}
                </span>
              </div>
              <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                {holder.remainingShares.toLocaleString('en-IN')} shares across {holder.positions.length} IPO
                {holder.positions.length === 1 ? '' : 's'}
              </p>
              <div className="mt-3 space-y-1.5">
                {holder.positions.map((p) => (
                  <div
                    key={p.key}
                    className="flex items-center justify-between gap-2 border-t pt-1.5 text-sm"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <span style={{ color: 'var(--ink-primary)' }}>
                      {p.ipoName}
                      {p.symbol && (
                        <span className="ml-1 font-mono-ipo text-xs" style={{ color: 'var(--ink-muted)' }}>
                          {p.symbol}
                        </span>
                      )}
                    </span>
                    <span className="font-mono-ipo text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {p.remainingShares.toLocaleString('en-IN')} sh
                      {p.livePricePerShare != null ? (
                        <>
                          {' '}
                          × ₹{p.livePricePerShare.toLocaleString('en-IN')} ={' '}
                          <span style={{ color: 'var(--ink-primary)' }}>{rupees(p.liveValue ?? 0)}</span>
                        </>
                      ) : (
                        <span> · no live price</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
