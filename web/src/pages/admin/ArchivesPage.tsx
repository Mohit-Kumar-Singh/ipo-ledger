import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { UndoIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useIpos, useAllotmentBoardAll, queryKeys } from '../../lib/queries'
import { useAuth } from '../../contexts/AuthContext'
import { showToast } from '../../lib/toast'
import { computeProfitSplit, effectiveSplitWithFunder } from '../../lib/profitSplit'
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
  const queryClient = useQueryClient()
  // Shared caches (lib/queries.ts) — both ipos and v_allotment_board are
  // fetched unfiltered by useIpos/useAllotmentBoardAll (also read by
  // Dashboard, Applications, Allotment board, Payouts); this page's own
  // archived-only view is a client-side filter over the same cached rows
  // instead of its own separate `.eq('is_archived', true)` network query.
  const iposQuery = useIpos()
  const boardQuery = useAllotmentBoardAll()
  const ipos = useMemo(
    () =>
      (iposQuery.data ?? [])
        .filter((i) => i.is_archived)
        .sort((a, b) => (b.listing_date ?? '').localeCompare(a.listing_date ?? '')),
    [iposQuery.data],
  )
  const rows = useMemo(() => (boardQuery.data ?? []).filter((r) => r.ipo_is_archived), [boardQuery.data])
  const loading = iposQuery.isPending || boardQuery.isPending
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [unarchiving, setUnarchiving] = useState<string | null>(null)
  // The last IPO unarchived this visit — an accidental tap on "Unarchive"
  // otherwise meant hunting it back down on the IPOs page (Live/Upcoming/
  // Closed, wherever it landed) to archive it again. A quick "Re-archive"
  // right where the mistake happened instead. Cleared once re-archived, or
  // just left stale/ignored if the user moves on — not persisted, so a
  // page reload naturally forgets it (nothing to accidentally undo days
  // later from a stale banner).
  const [justUnarchived, setJustUnarchived] = useState<Ipo | null>(null)
  const [reArchiving, setReArchiving] = useState(false)

  // Both unarchive/reArchive below write ipos.is_archived, which changes
  // both what belongs in the filtered `ipos` list above AND every board
  // row's ipo_is_archived (the view joins ipos) — invalidate both shared
  // caches so this page and any other currently-mounted page reading them
  // (Dashboard, Applications, Allotment board, Payouts) pick up the change.
  async function invalidateArchiveState() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.ipos }),
      queryClient.invalidateQueries({ queryKey: queryKeys.allotmentBoard }),
    ])
  }

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
    setJustUnarchived(ipo)
    await invalidateArchiveState()
  }

  async function reArchive(ipo: Ipo) {
    setReArchiving(true)
    const { error } = await supabase.from('ipos').update({ is_archived: true }).eq('id', ipo.id)
    setReArchiving(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    setJustUnarchived(null)
    await invalidateArchiveState()
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

      {justUnarchived && (
        <div
          className="card flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
          style={{ borderColor: 'var(--accent-tint)', background: 'var(--accent-tint)' }}
        >
          <span style={{ color: 'var(--ink-primary)' }}>
            Unarchived <span className="font-medium">{justUnarchived.company_name}</span>.
          </span>
          <div className="flex shrink-0 items-center gap-3">
            <button
              onClick={() => reArchive(justUnarchived)}
              disabled={reArchiving}
              className="link-accent text-xs font-medium disabled:opacity-50"
            >
              {reArchiving ? 'Re-archiving…' : 'Re-archive'}
            </button>
            <button
              onClick={() => setJustUnarchived(null)}
              className="text-xs font-medium hover:underline"
              style={{ color: 'var(--ink-muted)' }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

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
              // SOLD counts as allotted too — it's a further stage of the
              // same outcome, not a separate bucket that skipped allotment.
              // The page-header total just above already uses this same
              // definition ("every application that ever reached that
              // state, including ones later sold") — this used to disagree
              // with it, showing "1 allotted" + "1 sold" as if they were
              // exclusive when someone who was allotted and then sold
              // should count as allotted in both places.
              allotted: items.filter((r) => r.status === 'ALLOTTED' || r.status === 'SOLD').length,
              notAllotted: items.filter((r) => r.status === 'NOT_ALLOTTED').length,
              sold: items.filter((r) => r.status === 'SOLD').length,
            }
            // Per-row profit split, computed ONCE per application — reused
            // both for the IPO-level total badge below AND for the
            // per-application breakdown columns in the expanded table.
            // Previously only the summed total existed anywhere on this
            // page; once an IPO is archived, this was the only place left
            // that could show the per-application numbers at all (the live
            // Allotment board and Payouts page both filter archived IPOs
            // out entirely), so the actual holder-cut/funder-share/your-
            // share breakdown was effectively gone the moment something
            // got archived.
            const splitByAppId = new Map<string, ReturnType<typeof computeProfitSplit>>()
            for (const r of items) {
              if (r.status !== 'SOLD' || r.sell_price == null) continue
              splitByAppId.set(
                r.application_id,
                computeProfitSplit({
                  sellPricePerShare: r.sell_price,
                  lotSize: r.lot_size,
                  lots: r.lots,
                  bidAmount: r.bid_amount ?? 0,
                  // v_allotment_board resolves this through
                  // get_demat_profit_share_percent() (migration 0088), so
                  // it's never actually null for anyone by the time it gets
                  // here — the fallback is just defensive, matching every
                  // other call site's convention.
                  cutPercent: r.profit_share_percent ?? 25,
                  dematHolderName: r.holder_name,
                  funderName: r.bank_account_holder_name,
                  // '' for a non-admin, NOT profile.full_name — this page
                  // is NOT admin-only (no route/nav gate; `rows` is the
                  // same RLS-scoped v_allotment_board every other page
                  // shares, so a funder's own archived, sold applications
                  // show up here too). Passing their own name here computed
                  // `profitPersonShare` as the admin's own cut and labelled
                  // it "profit"/"Your share" to them with no indication it
                  // wasn't theirs — same bug already fixed on Dashboard
                  // (v1.203.2), Notifications (v1.204.2), and
                  // AllotmentBoardPage's post-sale breakdown (v1.206.0);
                  // this page's own isAdmin (line 48) just wasn't applied
                  // here yet.
                  profitPersonName: isAdmin ? (profile?.full_name ?? '') : '',
                  splitWithFunder: effectiveSplitWithFunder(r, r.split_profit_with_funder),
                }),
              )
            }
            // Admin-only total — see profitPersonName's own comment just
            // above. 0 for a non-admin (profitPersonName is '', so nothing
            // ever matches admin's own share here), which correctly
            // suppresses the "· ₹X profit" summary line below via the
            // `totalProfit !== 0` check already in place.
            const totalProfit = isAdmin
              ? Array.from(splitByAppId.values()).reduce((sum, result) => sum + result.profitPersonShare, 0)
              : 0
            // Compact, single-line, plain-text summary rather than a row of
            // colored pill badges — Archives is a put-away section by
            // design, and a badge per status was both visually loud for
            // data nobody's acting on anymore AND the direct cause of the
            // overflow bug (a shrink-0 flex group fighting its own
            // flex-wrap). One wrapping text line, styled like the subtitle
            // line above it, can't overflow the same way — it wraps a WORD
            // at a time, not a whole pill at a time. Profit is the one
            // figure worth a little visual weight, so it keeps its own
            // accent color inline; everything else is plain muted text.
            const summaryParts = [
              counts.notAllotted > 0 ? `${counts.notAllotted} not allotted` : null,
              counts.allotted > 0 ? `${counts.allotted} allotted` : null,
              counts.sold > 0 ? `${counts.sold} sold` : null,
            ].filter(Boolean)
            return (
              <div key={ipo.id} className="card stagger-item p-4">
                {/* No flex-wrap here on purpose — with it, Unarchive's
                    position depended on how much the title block grew
                    (extra summary line, longer company name): sometimes
                    same line as the title, sometimes wrapped onto its own
                    line below. min-w-0 + truncate on the title lets IT
                    shrink instead, so Unarchive stays pinned top-right at
                    the exact same spot on every card regardless of content. */}
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(ipo.id)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 items-start gap-1.5 text-left"
                  >
                    <span className="shrink-0 pt-0.5 text-sm" style={{ color: 'var(--ink-muted)' }}>
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
                      {(summaryParts.length > 0 || totalProfit !== 0) && (
                        <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                          {summaryParts.join(' · ')}
                          {totalProfit !== 0 && (
                            <>
                              {summaryParts.length > 0 ? ' · ' : ''}
                              <span style={{ color: 'var(--good-text)' }}>{rupees(totalProfit)} profit</span>
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => unarchive(ipo)}
                      disabled={unarchiving === ipo.id}
                      title="Unarchive"
                      aria-label={`Unarchive ${ipo.company_name}`}
                      className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-[var(--hover-surface)] disabled:opacity-50"
                      style={{ color: 'var(--accent)' }}
                    >
                      <UndoIcon size={13} />
                      {unarchiving === ipo.id ? 'Restoring…' : 'Unarchive'}
                    </button>
                  )}
                </div>

                {isOpen && (
                  <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                    {items.length === 0 ? (
                      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                        No applications recorded for this IPO.
                      </p>
                    ) : (
                      <>
                        {/* Who it actually went to, and at what price, read
                            plainly before the dense table below — the
                            table has every column for the rare time you
                            need one, but "who got allotted and what did it
                            sell for" is the actual question worth
                            answering first, not something to reconstruct
                            by scanning a Holder/Sell price/Payouts row. */}
                        {(counts.allotted > 0 || counts.sold > 0) && (
                          <div className="mb-3 space-y-1">
                            <p className="text-[11px] font-medium tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
                              Allotment & sale
                            </p>
                            {items
                              .filter((r) => r.status === 'ALLOTTED' || r.status === 'SOLD')
                              .map((r) => {
                                const split = splitByAppId.get(r.application_id)
                                return (
                                  <p key={r.application_id} className="text-sm" style={{ color: 'var(--ink-secondary)' }}>
                                    <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                                      {r.holder_name}
                                    </span>
                                    {r.status === 'SOLD' && r.sell_price != null ? (
                                      <>
                                        {' — sold at ₹'}
                                        {r.sell_price}
                                        {'/share'}
                                        {isAdmin && split && (
                                          <span style={{ color: 'var(--good-text)' }}> · {rupees(split.profitPersonShare)} profit</span>
                                        )}
                                      </>
                                    ) : (
                                      ' — allotted, not yet sold'
                                    )}
                                  </p>
                                )
                              })}
                          </div>
                        )}
                        <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead style={{ color: 'var(--ink-muted)' }} className="text-left">
                          <tr>
                            <th className="py-1.5 pr-3 font-medium">Holder</th>
                            <th className="py-1.5 pr-3 font-medium">Bank / funder</th>
                            <th className="py-1.5 pr-3 font-medium">Status</th>
                            <th className="py-1.5 pr-3 font-medium">Sell price</th>
                            <th className="py-1.5 pr-3 font-medium">Gross profit</th>
                            <th className="py-1.5 pr-3 font-medium">Holder cut</th>
                            <th className="py-1.5 pr-3 font-medium">Funder share</th>
                            {/* Admin-only — see profitPersonName's own comment
                                above; this column's value is specifically the
                                admin's own cut, not whoever's actually looking. */}
                            {isAdmin && <th className="py-1.5 pr-3 font-medium">Your share</th>}
                            <th className="py-1.5 font-medium">Payouts</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
                          {items.map((r) => {
                            const split = splitByAppId.get(r.application_id)
                            return (
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
                                <td className="py-1.5 pr-3" style={{ color: 'var(--ink-secondary)' }}>
                                  {split ? rupees(split.grossProfit) : '—'}
                                </td>
                                <td className="py-1.5 pr-3" style={{ color: 'var(--ink-secondary)' }}>
                                  {/* No separate line for the holder when
                                      they're also the profit person — same
                                      "not an external payout" reasoning
                                      computeProfitSplit itself uses. */}
                                  {split ? (split.isDematHolderSelf ? 'self' : rupees(split.dematCutAmount)) : '—'}
                                </td>
                                <td className="py-1.5 pr-3" style={{ color: 'var(--ink-secondary)' }}>
                                  {split ? (!split.hasFunder || split.isFunderSelf ? 'self' : rupees(split.funderShare)) : '—'}
                                </td>
                                {isAdmin && (
                                  <td className="py-1.5 pr-3 font-medium" style={{ color: 'var(--good)' }}>
                                    {split ? rupees(split.profitPersonShare) : '—'}
                                  </td>
                                )}
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
                            )
                          })}
                        </tbody>
                      </table>
                        </div>
                      </>
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
