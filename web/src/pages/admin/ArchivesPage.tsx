import { useEffect, useState } from 'react'
import { UndoIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { showToast } from '../../lib/toast'
import { computeProfitSplit } from '../../lib/profitSplit'
import { InlineSpinner } from '../../components/PageSpinner'
import type { AllotmentBoardRow, Ipo } from '../../types/database'

const statusBadgeClass: Record<AllotmentBoardRow['status'], string> = {
  APPLIED: 'badge-info',
  ALLOTTED: 'badge-good',
  NOT_ALLOTTED: 'badge-neutral',
  SOLD: 'badge-violet',
}

function rupees(n: number): string {
  const sign = n < 0 ? '−' : ''
  return `${sign}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`
}

// "22/Aug/26" — day/short-month-name/2-digit-year. UTC, not local time, so
// a date-only string (no time component, same convention every other
// date-only field in this app already follows — see AllotmentBoardPage's
// own day+month formatter) doesn't shift a day depending on the viewer's
// timezone.
function formatArchiveDate(dateStr: string): string {
  const d = new Date(dateStr)
  const day = d.toLocaleDateString('en-IN', { day: '2-digit', timeZone: 'UTC' })
  const month = d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })
  const year = d.toLocaleDateString('en-IN', { year: '2-digit', timeZone: 'UTC' })
  return `${day}/${month}/${year}`
}

// Everything settled and moved out of the way — an IPO ends up here once
// it's either fully NOT_ALLOTTED (nothing left to track) or an admin
// archives it manually once allotment's run and payouts are settled (the
// existing per-IPO archive toggle, now surfaced only here rather than on
// the IPOs page). Nothing is ever deleted by archiving; this page is the
// one place all of it still lives, in full, collapsed by default so it
// doesn't turn into a second long scroll — the whole point is to get this
// data OUT of Dashboard/Applications/Allotment board/IPOs, not just hide it
// behind one more toggle on each of those pages.
export function ArchivesPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [rows, setRows] = useState<AllotmentBoardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [unarchiving, setUnarchiving] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const [iposRes, boardRes] = await Promise.all([
      supabase.from('ipos').select('*').eq('is_archived', true).order('listing_date', { ascending: false }),
      supabase.from('v_allotment_board').select('*').eq('ipo_is_archived', true),
    ])
    setIpos((iposRes.data ?? []) as Ipo[])
    setRows((boardRes.data ?? []) as AllotmentBoardRow[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  function toggleExpanded(ipoId: string) {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(ipoId)) next.delete(ipoId)
      else next.add(ipoId)
      return next
    })
  }

  async function unarchive(ipo: Ipo) {
    setUnarchiving(ipo.id)
    const { error } = await supabase.from('ipos').update({ is_archived: false }).eq('id', ipo.id)
    setUnarchiving(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    load()
  }

  const rowsByIpo = new Map<string, AllotmentBoardRow[]>()
  for (const r of rows) {
    if (!rowsByIpo.has(r.ipo_id)) rowsByIpo.set(r.ipo_id, [])
    rowsByIpo.get(r.ipo_id)!.push(r)
  }

  // An archived IPO nobody ever actually applied to (auto-archived once
  // fully NOT_ALLOTTED, or archived by hand before anything was tracked
  // against it) isn't a "settled" record worth keeping in view here — just
  // noise with nothing underneath it to expand into.
  const visibleIpos = ipos.filter((ipo) => (rowsByIpo.get(ipo.id)?.length ?? 0) > 0)

  const totals = visibleIpos.reduce(
    (acc, ipo) => {
      const items = rowsByIpo.get(ipo.id) ?? []
      acc.applications += items.length
      // "Allotted" here counts every application that ever reached that
      // state, including ones later sold — SOLD is a subsequent status,
      // not a separate bucket that never went through allotment.
      acc.allotted += items.filter((r) => r.status === 'ALLOTTED' || r.status === 'SOLD').length
      return acc
    },
    { applications: 0, allotted: 0 },
  )

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Archives
        </h1>
        {visibleIpos.length > 0 && (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {visibleIpos.length} IPO{visibleIpos.length === 1 ? '' : 's'} · {totals.applications} application
            {totals.applications === 1 ? '' : 's'} · {totals.allotted} allotted
          </p>
        )}
      </div>

      {loading ? (
        <InlineSpinner />
      ) : visibleIpos.length === 0 ? (
        <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          Nothing archived yet.
        </p>
      ) : (
        <div className="space-y-3">
          {visibleIpos.map((ipo) => {
            const items = rowsByIpo.get(ipo.id) ?? []
            const isOpen = expanded.has(ipo.id)
            const counts = {
              allotted: items.filter((r) => r.status === 'ALLOTTED').length,
              notAllotted: items.filter((r) => r.status === 'NOT_ALLOTTED').length,
              sold: items.filter((r) => r.status === 'SOLD').length,
            }
            // Total profit (the profit-person's own share, same computation
            // PayoutsPage uses) across every SOLD application under this
            // IPO — only meaningful once something's actually been sold.
            const totalProfit = items
              .filter((r) => r.status === 'SOLD' && r.sell_price != null)
              .reduce((sum, r) => {
                const result = computeProfitSplit({
                  sellPricePerShare: r.sell_price!,
                  lotSize: r.lot_size,
                  lots: r.lots,
                  bidAmount: r.bid_amount ?? 0,
                  cutPercent: r.profit_share_percent,
                  dematHolderName: r.holder_name,
                  funderName: r.bank_account_holder_name,
                  profitPersonName: profile?.full_name ?? '',
                  splitWithFunder: r.split_profit_with_funder,
                })
                return sum + result.profitPersonShare
              }, 0)
            return (
              <div key={ipo.id} className="card stagger-item p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(ipo.id)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 items-center gap-1.5 text-left"
                  >
                    <span className="shrink-0 text-sm" style={{ color: 'var(--ink-muted)' }}>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
                        {ipo.company_name}
                      </p>
                      <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {ipo.listing_date
                          ? `Listed ${formatArchiveDate(ipo.listing_date)}`
                          : ipo.allotment_date
                            ? `Allotment ${formatArchiveDate(ipo.allotment_date)}`
                            : 'No dates'}
                        {` · ${items.length} application${items.length === 1 ? '' : 's'}`}
                      </p>
                    </div>
                  </button>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {counts.notAllotted > 0 && <span className="badge badge-neutral text-xs">{counts.notAllotted} not allotted</span>}
                    {counts.allotted > 0 && <span className="badge badge-good text-xs">{counts.allotted} allotted</span>}
                    {counts.sold > 0 && <span className="badge badge-violet text-xs">{counts.sold} sold</span>}
                    {totalProfit !== 0 && (
                      <span className="badge text-xs" style={{ background: 'var(--good-tint)', color: 'var(--good-text)' }}>
                        {rupees(totalProfit)} profit
                      </span>
                    )}
                    {isAdmin && (
                      <button
                        onClick={() => unarchive(ipo)}
                        disabled={unarchiving === ipo.id}
                        title="Unarchive"
                        aria-label={`Unarchive ${ipo.company_name}`}
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-[var(--hover-surface)] disabled:opacity-50"
                        style={{ color: 'var(--accent)' }}
                      >
                        <UndoIcon size={13} />
                        {unarchiving === ipo.id ? 'Restoring…' : 'Unarchive'}
                      </button>
                    )}
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-3 overflow-x-auto border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                    {items.length === 0 ? (
                      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                        No applications recorded for this IPO.
                      </p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead style={{ color: 'var(--ink-muted)' }} className="text-left">
                          <tr>
                            <th className="py-1.5 pr-3 font-medium">Holder</th>
                            <th className="py-1.5 pr-3 font-medium">Bank / funder</th>
                            <th className="py-1.5 pr-3 font-medium">Status</th>
                            <th className="py-1.5 pr-3 font-medium">Sell price</th>
                            <th className="py-1.5 font-medium">Payouts</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
                          {items.map((r) => (
                            <tr key={r.application_id}>
                              <td className="py-1.5 pr-3 font-medium" style={{ color: 'var(--ink-primary)' }}>
                                {r.holder_name}
                              </td>
                              <td className="py-1.5 pr-3" style={{ color: 'var(--ink-secondary)' }}>
                                {r.bank_account_holder_name ?? '—'}
                              </td>
                              <td className="py-1.5 pr-3">
                                <span className={`badge ${statusBadgeClass[r.status]}`}>{r.status.replace('_', ' ')}</span>
                              </td>
                              <td className="py-1.5 pr-3" style={{ color: 'var(--ink-secondary)' }}>
                                {r.sell_price != null ? `₹${r.sell_price}` : '—'}
                              </td>
                              <td className="py-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                {r.status === 'SOLD'
                                  ? [
                                      r.demat_cut_paid ? null : 'demat cut pending',
                                      r.funder_share_paid ? null : 'funder share pending',
                                    ]
                                      .filter(Boolean)
                                      .join(', ') || 'settled'
                                  : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
