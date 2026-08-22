import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { showToast } from '../../lib/toast'
import { dispatchAdminWhatsapp, openWhatsAppForNotification, sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { computeProfitSplit, namesMatch } from '../../lib/profitSplit'
import { maybeAutoArchiveIpo } from '../../lib/autoArchive'
import { nowIst } from '../../lib/ipoStatus'
import { parseGmpPercent } from '../../lib/ipoGmp'
import { SaleAmountField, sellPricePerShareFromEntry } from '../../components/SaleAmountField'
import { SearchIcon, PaperAirplaneIcon, CommentDiscussionIcon, CheckCircleFillIcon, FileCheckIcon, TagIcon, PencilIcon } from '@primer/octicons-react'
import type {
  AllotmentBoardRow,
  ApplicationStatus,
  Ipo,
  Notification,
} from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'
import { InfoTooltip } from '../../components/HoverCard'
import { SellReminderComposer } from './SellReminderComposer'
import { buildSellReminderText, resolveSellPdfUrl } from '../../lib/sellReminder'

const statusBadgeClass: Record<ApplicationStatus, string> = {
  APPLIED: 'badge-info',
  ALLOTTED: 'badge-good',
  NOT_ALLOTTED: 'badge-neutral',
  SOLD: 'badge-violet',
}

const notifBadgeClass: Record<Notification['status'], string> = {
  QUEUED: 'badge-neutral',
  SENT: 'badge-info',
  DELIVERED: 'badge-good',
  READ: 'badge-violet',
  FAILED: 'badge-critical',
  SIMULATED: 'badge-warning',
}

type AllottedNotif = Pick<Notification, 'id' | 'status' | 'to_phone' | 'template_name' | 'variables'>

// Sale entry supports two equivalent ways in: a per-share price (with share
// count/invested amount shown as reference) or the total payout received —
// whichever's easier to type in from the broker's contract note. Both funnel
// into the same stored per-share `sell_price`.
interface SoldFormState {
  mode: 'total' | 'perShare'
  sellPrice: string
  totalPayout: string
  split: boolean
}

function sellPricePerShareFrom(form: SoldFormState, row: AllotmentBoardRow): number {
  return sellPricePerShareFromEntry(form.mode, form.sellPrice, form.totalPayout, row.lot_size * row.lots)
}

// "18 Aug" — day + short month, no ordinal suffix (unlike formatOrdinalDate
// elsewhere in this app) — this is a compact card summary line, not prose.
function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return `${d} ${date.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })}`
}

export function AllotmentBoardPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [searchParams] = useSearchParams()
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [selectedIpoId, setSelectedIpoId] = useState('')
  const [rows, setRows] = useState<AllotmentBoardRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [allottedNotifs, setAllottedNotifs] = useState<Record<string, AllottedNotif>>({})
  const [dispatching, setDispatching] = useState<string | null>(null)
  const [soldForms, setSoldForms] = useState<Record<string, SoldFormState>>({})
  const [savingSold, setSavingSold] = useState<string | null>(null)
  const [markingPaid, setMarkingPaid] = useState<string | null>(null)
  const [showSellComposer, setShowSellComposer] = useState(false)

  // Archived IPOs (fully settled, moved to /archives) drop out of this
  // dropdown — their board is still viewable there. Re-run after any action
  // that might have just auto-archived the currently-selected IPO (see
  // maybeAutoArchiveIpo below), so it drops out of the list right away
  // instead of sitting there stale until a manual page reload.
  function loadIpos(onLoaded?: (loaded: Ipo[]) => void) {
    const todayStr = nowIst().dateStr
    supabase
      .from('ipos')
      .select('*')
      .not('allotment_date', 'is', null)
      .lte('allotment_date', todayStr)
      .eq('is_archived', false)
      .order('allotment_date', { ascending: false })
      .then(({ data }) => {
        const loaded = (data ?? []) as Ipo[]
        setIpos(loaded)
        onLoaded?.(loaded)
      })
  }

  useEffect(() => {
    // Deep-link from the Dashboard's "N allotted" badge (?ipo=<id>) —
    // auto-select that IPO's board the moment the dropdown's own options
    // have loaded, instead of leaving the visitor to pick it again by hand.
    // Otherwise default to the most RECENT allotment, which is loadIpos'
    // first row (it already orders by allotment_date desc).
    //
    // This used to pick the earliest listing_date instead, on the theory
    // that it's the one most overdue to sell. In practice that pins the
    // board to the oldest IPO still hanging around — an IPO only
    // auto-archives once every row on it is settled, so one stuck row keeps
    // it unarchived and permanently first. Whichever allotment just came
    // out is the one there's actually work to do on; older ones are still a
    // dropdown pick away.
    const ipoIdParam = searchParams.get('ipo')
    loadIpos((loaded) => {
      if (ipoIdParam && loaded.some((i) => i.id === ipoIdParam)) {
        loadBoard(ipoIdParam)
        return
      }
      if (loaded[0]) loadBoard(loaded[0].id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadBoard(ipoId: string) {
    setSelectedIpoId(ipoId)
    setSelected(new Set())
    if (!ipoId) {
      setRows([])
      return
    }
    setLoading(true)
    const { data, error } = await supabase.from('v_allotment_board').select('*').eq('ipo_id', ipoId)
    if (error) {
      showToast(`Couldn't load the allotment board: ${error.message}`, 'critical')
      setLoading(false)
      return
    }
    const boardRows = (data ?? []) as AllotmentBoardRow[]
    setRows(boardRows)

    const appIds = boardRows.map((r) => r.application_id)
    if (appIds.length > 0) {
      const { data: notifs } = await supabase
        .from('notifications')
        .select('id, application_id, status, to_phone, template_name, variables')
        .eq('type', 'ALLOTTED')
        .in('application_id', appIds)
      const map: Record<string, AllottedNotif> = {}
      for (const n of notifs ?? []) {
        map[n.application_id as string] = {
          id: n.id,
          status: n.status,
          to_phone: n.to_phone,
          template_name: n.template_name,
          variables: n.variables,
        }
      }
      setAllottedNotifs(map)
    } else {
      setAllottedNotifs({})
    }
    setLoading(false)
  }

  async function dispatchNotification(n: AllottedNotif) {
    setDispatching(n.id)
    if (isAdmin) {
      await dispatchAdminWhatsapp(n.id)
    } else {
      await openWhatsAppForNotification(n)
    }
    setDispatching(null)
    loadBoard(selectedIpoId)
  }

  // Allotted rows surface first so a glance at the board shows who's already
  // confirmed before scrolling past everyone still just "applied" — within
  // each group, original load order (registrar-list order) is preserved.
  const statusOrder: Record<AllotmentBoardRow['status'], number> = {
    ALLOTTED: 0,
    SOLD: 1,
    APPLIED: 2,
    NOT_ALLOTTED: 3,
  }
  const sortedRows = [...rows].sort((a, b) => statusOrder[a.status] - statusOrder[b.status])
  // Client-side only, same reasoning as Accounts/Applications' own search —
  // one IPO's board is a household's worth of rows, not worth a server round
  // trip per keystroke.
  const [search, setSearch] = useState('')
  const searchedRows = search.trim()
    ? sortedRows.filter((r) => r.holder_name.toLowerCase().includes(search.trim().toLowerCase()))
    : sortedRows

  const selectedIpo = ipos.find((i) => i.id === selectedIpoId)
  const allottedCount = rows.filter((r) => r.status === 'ALLOTTED').length

  async function markStatus(applicationId: string, status: 'ALLOTTED' | 'NOT_ALLOTTED' | 'APPLIED') {
    await supabase.from('applications').update({ status }).eq('id', applicationId)
    if (status === 'NOT_ALLOTTED') { await maybeAutoArchiveIpo(selectedIpoId); loadIpos() }
    loadBoard(selectedIpoId)
  }

  async function bulkMarkNotAllotted() {
    if (selected.size === 0) return
    await supabase.from('applications').update({ status: 'NOT_ALLOTTED' }).in('id', Array.from(selected))
    await maybeAutoArchiveIpo(selectedIpoId)
    loadIpos()
    loadBoard(selectedIpoId)
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Whether THIS viewer can actually mark this row's status — applications'
  // own RLS write policy (p_apps_member_write, migration 0032) only lets
  // the demat account's owner or an admin update status; a funder-only
  // viewer has read-only access. Without this check, a funder saw the same
  // Allotted/Not-allotted buttons as an owner, clicked them, and the
  // update silently matched zero rows under RLS — no error, the board just
  // reloaded showing the same unchanged status.
  function canMark(row: AllotmentBoardRow): boolean {
    return isAdmin || row.demat_linked_user_id === profile?.id
  }

  // Only APPLIED rows this viewer can actually mark carry a checkbox at all
  // (see the per-row render below) — selecting/deselecting "all" only ever
  // means all of those, matching what the bulk "Mark selected as Not
  // allotted" action can actually act on.
  const selectableIds = rows.filter((r) => r.status === 'APPLIED' && canMark(r)).map((r) => r.application_id)

  function toggleSelectAll() {
    setSelected((s) => (s.size === selectableIds.length ? new Set() : new Set(selectableIds)))
  }

  function openSoldForm(row: AllotmentBoardRow) {
    // Default the split checkbox to "on" when the funder isn't the person
    // doing the accounting — admin can still flip it either way.
    const autoSplit =
      !!row.bank_account_holder_name && !namesMatch(row.bank_account_holder_name, profile?.full_name ?? '')
    const shares = row.lot_size * row.lots
    setSoldForms((f) => ({
      ...f,
      [row.application_id]: {
        mode: 'total',
        sellPrice: row.sell_price != null ? String(row.sell_price) : '',
        totalPayout: row.sell_price != null ? String(Math.round(row.sell_price * shares)) : '',
        split: row.status === 'SOLD' ? row.split_profit_with_funder : autoSplit,
      },
    }))
  }

  function closeSoldForm(id: string) {
    setSoldForms((f) => {
      const next = { ...f }
      delete next[id]
      return next
    })
  }

  async function saveSold(row: AllotmentBoardRow) {
    const form = soldForms[row.application_id]
    const perShare = form ? sellPricePerShareFrom(form, row) : 0
    if (!form || !perShare) return
    setSavingSold(row.application_id)
    await supabase
      .from('applications')
      .update({
        sell_price: Math.round(perShare * 100) / 100,
        status: 'SOLD',
        split_profit_with_funder: form.split,
      })
      .eq('id', row.application_id)
    setSavingSold(null)
    closeSoldForm(row.application_id)
    loadBoard(selectedIpoId)
  }

  async function markPaid(applicationId: string, field: 'demat_cut_paid' | 'funder_share_paid') {
    setMarkingPaid(applicationId + field)
    await supabase.from('applications').update({ [field]: true }).eq('id', applicationId)
    setMarkingPaid(null)
    // This might be the last outstanding payout on the IPO — check whether
    // everything's resolved now and archive immediately if so.
    await maybeAutoArchiveIpo(selectedIpoId)
    loadIpos()
    loadBoard(selectedIpoId)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <h1 className="flex items-center gap-1.5 text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Allotment board
          <InfoTooltip text="Mark results one row at a time. Only IPOs whose allotment is already out are listed below." />
        </h1>
        {/* Sell reminder lives here as an icon (with the allotted count as a
            badge) rather than a wide button in the controls row below. */}
        {isAdmin && selectedIpoId && allottedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowSellComposer(true)}
            aria-label={`Send sell reminder (${allottedCount} allotted)`}
            title={`Send sell reminder (${allottedCount} allotted)`}
            className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover-surface)]"
            style={{ color: 'var(--ink-secondary)' }}
          >
            <PaperAirplaneIcon size={18} />
            <span
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold"
              style={{ background: 'var(--accent)', color: '#ffffff' }}
            >
              {allottedCount}
            </span>
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select value={selectedIpoId} onChange={(e) => loadBoard(e.target.value)} className="input w-full sm:max-w-xs">
          <option value="">Select an IPO</option>
          {ipos.map((i) => (
            <option key={i.id} value={i.id}>
              {i.company_name}
            </option>
          ))}
        </select>
        {selected.size > 0 && (
          <button onClick={bulkMarkNotAllotted} className="btn-secondary">
            Mark {selected.size} selected as Not allotted
          </button>
        )}
      </div>

      {showSellComposer && selectedIpo && (
        <SellReminderComposer
          ipo={{ id: selectedIpo.id, company_name: selectedIpo.company_name, listing_date: selectedIpo.listing_date }}
          allottedRows={rows.filter((r) => r.status === 'ALLOTTED')}
          onClose={() => setShowSellComposer(false)}
        />
      )}

      {loading && <InlineSpinner />}

      {!loading && selectedIpoId && isAdmin && (
        <SoldPayoutsSection
          rows={rows.filter((r) => r.status === 'ALLOTTED' || r.status === 'SOLD')}
          soldForms={soldForms}
          onOpenForm={openSoldForm}
          onCloseForm={closeSoldForm}
          onChangeForm={(id, next) => setSoldForms((f) => ({ ...f, [id]: next }))}
          onSave={saveSold}
          savingSold={savingSold}
          onMarkPaid={markPaid}
          markingPaid={markingPaid}
          profitPersonName={profile?.full_name ?? ''}
          onUndo={(id) => markStatus(id, 'APPLIED')}
        />
      )}

      {!loading && selectedIpoId && (
        <AccountListSection count={sortedRows.length}>
        {rows.length > 0 && (
          <div className="relative mb-3">
            <SearchIcon size={15} fill="var(--ink-muted)" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by holder name…"
              className="input pl-9"
            />
          </div>
        )}
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
              <tr>
                <th className="px-4 py-2.5">
                  {selectableIds.length > 0 && (
                    <input
                      type="checkbox"
                      checked={selected.size === selectableIds.length}
                      ref={(el) => {
                        if (el) el.indeterminate = selected.size > 0 && selected.size < selectableIds.length
                      }}
                      onChange={toggleSelectAll}
                      title="Select all"
                    />
                  )}
                </th>
                <th className="px-4 py-2.5 font-medium">Holder</th>
                <th className="px-4 py-2.5 font-medium">Bank</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Message</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {searchedRows.map((row) => {
                const notif = allottedNotifs[row.application_id]
                return (
                <tr key={row.application_id} className="stagger-item transition-colors duration-150 hover:bg-[var(--hover-surface)]">
                  <td className="px-4 py-2.5">
                    {row.status === 'APPLIED' && canMark(row) && (
                      <input
                        type="checkbox"
                        checked={selected.has(row.application_id)}
                        onChange={() => toggle(row.application_id)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--ink-primary)' }}>
                    <span className="inline-flex items-center gap-1.5">
                      {row.holder_name}
                      {row.is_funder_override && (
                        <span
                          className="shrink-0"
                          title={`Funded by a transfer to a different UPI/bank account (${row.bank_account_holder_name ?? 'unknown'}), not the applicant's own.`}
                        >
                          {'\u{1F3F7}\u{FE0F}'}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{row.bank_account_holder_name ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`badge ${statusBadgeClass[row.status]} ${row.status === 'SOLD' ? 'inline-flex items-center' : ''}`}
                      title={row.status.replace('_', ' ')}
                    >
                      {row.status === 'SOLD' ? <CheckCircleFillIcon size={13} /> : row.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {notif ? (
                      <div className="flex items-center gap-2">
                        <span className={`badge ${notifBadgeClass[notif.status]}`}>{notif.status}</span>
                        {(notif.status === 'QUEUED' || notif.status === 'FAILED') && (
                          <button
                            onClick={() => dispatchNotification(notif)}
                            disabled={dispatching === notif.id}
                            className="link-accent text-xs font-medium disabled:opacity-50"
                          >
                            {dispatching === notif.id
                              ? isAdmin
                                ? 'Sending…'
                                : 'Opening…'
                              : isAdmin
                                ? notif.status === 'FAILED'
                                  ? 'Retry'
                                  : 'Send'
                                : 'Open WhatsApp'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--ink-muted)' }}>—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {/* Marking status is owner/admin-only — applications' own
                        RLS write policy blocks a funder-only viewer from
                        updating status at all, so these controls are hidden
                        for them entirely instead of appearing to work and
                        silently no-op'ing on click. */}
                    {row.status === 'APPLIED' && canMark(row) &&
                      // Defense in depth: the IPO dropdown above only lists IPOs whose
                      // allotment_date has already passed, but re-check here too in case
                      // the IPO's date got edited to a future date after this board was
                      // loaded (stale selectedIpo in an already-open tab).
                      (selectedIpo?.allotment_date && selectedIpo.allotment_date <= nowIst().dateStr ? (
                        <div className="flex gap-3">
                          <button onClick={() => markStatus(row.application_id, 'ALLOTTED')} className="link-accent text-xs font-medium">
                            Allotted
                          </button>
                          <button
                            onClick={() => markStatus(row.application_id, 'NOT_ALLOTTED')}
                            className="text-xs font-medium hover:underline"
                            style={{ color: 'var(--ink-muted)' }}
                          >
                            Not allotted
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--ink-muted)' }} title="Allotment date hasn't passed yet">
                          Awaiting allotment
                        </span>
                      ))}
                    {row.status === 'NOT_ALLOTTED' && canMark(row) && (
                      <button
                        onClick={() => markStatus(row.application_id, 'APPLIED')}
                        className="text-xs font-medium hover:underline"
                        style={{ color: 'var(--ink-muted)' }}
                        title="Revert back to Applied"
                      >
                        Undo
                      </button>
                    )}
                  </td>
                </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
                    No applications for this IPO.
                  </td>
                </tr>
              )}
              {rows.length > 0 && searchedRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
                    No holder matches "{search}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </AccountListSection>
      )}
    </div>
  )
}

// Same collapsible pattern as NotificationsPage's message list / SoldPayoutsSection
// below — the per-account table can run long once an IPO has a lot of
// applicants. Collapsed by default, same as every other list on this page.
function AccountListSection({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-sm font-semibold"
        style={{ color: 'var(--ink-secondary)' }}
      >
        <span
          className="inline-flex transition-transform duration-200"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        >
          ▾
        </span>
        Accounts
        <span className="badge badge-neutral">{count}</span>
      </button>
      {open && children}
    </div>
  )
}

function SoldPayoutsSection({
  rows,
  soldForms,
  onOpenForm,
  onCloseForm,
  onChangeForm,
  onSave,
  savingSold,
  onMarkPaid,
  markingPaid,
  profitPersonName,
  onUndo,
}: {
  rows: AllotmentBoardRow[]
  soldForms: Record<string, SoldFormState>
  onOpenForm: (row: AllotmentBoardRow) => void
  onCloseForm: (id: string) => void
  onChangeForm: (id: string, next: SoldFormState) => void
  onSave: (row: AllotmentBoardRow) => void
  savingSold: string | null
  onMarkPaid: (applicationId: string, field: 'demat_cut_paid' | 'funder_share_paid') => void
  markingPaid: string | null
  profitPersonName: string
  // Marking ALLOTTED (or NOT_ALLOTTED) used to be a one-way door — a
  // mis-click had no way back short of editing the DB row directly. Only
  // offered for ALLOTTED, not SOLD: reverting a sale needs unwinding the
  // sell_price/payout-paid fields too, which this button doesn't touch.
  onUndo: (applicationId: string) => void
}) {
  // Moved above the main applied-list table and made collapsible — sold/
  // payout status is the thing actually worth acting on once allotment's
  // out, so unlike the plain account list below it, this one starts open.
  const [open, setOpen] = useState(true)
  const [notifying, setNotifying] = useState<string | null>(null)

  // Ad-hoc "ping this one holder now" — fetches their stored login details
  // (admin-only under RLS), resolves their platform's how-to-sell PDF to a
  // signed URL, and opens WhatsApp with the whole thing prefilled. Same
  // enriched body the Notifications "Sell today/tomorrow" cards build; this
  // is just the single-holder shortcut right where allotments are worked.
  async function notifyHolder(row: AllotmentBoardRow) {
    setNotifying(row.application_id)
    const { data: demat } = await supabase
      .from('demat_accounts')
      .select('platform, dp_client_id, application_name, login_email, login_password, app_password, t_pin, logged_in_notes')
      .eq('id', row.demat_id)
      .maybeSingle()
    const pdfUrl = await resolveSellPdfUrl(demat?.platform ?? row.platform)
    const listingPhrase = row.listing_date ? `lists on ${formatShortDate(row.listing_date)}` : 'is listing soon'
    const message = buildSellReminderText({
      holderName: row.holder_name,
      ipoName: row.company_name,
      lots: row.lots,
      listingPhrase,
      details: demat ?? { platform: row.platform },
      pdfUrl,
    })
    sendCustomWhatsapp(row.phone_e164, message)
    setNotifying(null)
  }
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div>
          <h2 className="text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
            {open ? '▾' : '▸'} Sold status &amp; payouts
          </h2>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Mark allotted shares as sold and track who still needs to be paid.
          </p>
        </div>
        {rows.length > 0 && <span className="badge badge-neutral shrink-0">{rows.length}</span>}
      </button>
      {open && (rows.length === 0 ? (
        <p className="card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
          Nothing allotted or sold yet for this IPO.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const form = soldForms[row.application_id]
            const isEditing = !!form
            return (
              <div key={row.application_id} className="card stagger-item p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {/* min-w-0 is load-bearing here, not decorative — without
                      it a flex item can't shrink below its content's
                      natural width, so the summary chips row below
                      (truncate on each chip) had nothing to truncate
                      AGAINST and just pushed the card wider than the phone
                      screen instead of wrapping/clipping in place. */}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {row.holder_name}
                      {row.is_funder_override && (
                        <span
                          className="shrink-0"
                          title={`Funded by a transfer to a different UPI/bank account (${row.bank_account_holder_name ?? 'unknown'}), not the applicant's own.`}
                        >
                          {'\u{1F3F7}\u{FE0F}'}
                        </span>
                      )}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {row.lots} lot(s)
                      {row.bid_amount != null && ` · ₹${row.bid_amount.toLocaleString('en-IN')} invested`}
                    </p>
                    {/* Compact summary — first word of the IPO name, funder,
                        listing date, GMP% — deliberately terse (a full
                        company name/funder name/raw GMP string was too much
                        for one line, especially on phone) rather than
                        trying to fit the full facts and truncating them. */}
                    <p className="mt-1 truncate text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                      {row.company_name.split(' ')[0]}
                      {row.bank_account_holder_name && ` · via ${row.bank_account_holder_name}`}
                      {row.listing_date && ` · ${formatShortDate(row.listing_date)}`}
                      {parseGmpPercent(row.gmp_notes) != null && ` · GMP:${parseGmpPercent(row.gmp_notes)}%`}
                    </p>
                  </div>
                  {/* Stacked on phone (flex-col), one row from sm: up —
                      three elements (status, Mark sold/Edit sale, Undo)
                      cramped into one row was the thing getting clipped/
                      unreadable on a narrow screen. */}
                  <div className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <span
                      className={`badge ${statusBadgeClass[row.status]} ${row.status === 'SOLD' ? 'inline-flex items-center' : ''}`}
                      title={row.status.replace('_', ' ')}
                    >
                      {row.status === 'SOLD' ? <CheckCircleFillIcon size={13} /> : row.status.replace('_', ' ')}
                    </span>
                    {/* Icon-only (same pattern as the Message/Paid controls
                        further down) — three text links plus a status badge
                        on one row was the bulk that made this wrap awkwardly
                        on phone. aria-label carries the name the visible text
                        used to, so this stays readable to a screen reader. */}
                    {!isEditing && (
                      <button
                        onClick={() => onOpenForm(row)}
                        className="link-accent inline-flex items-center"
                        aria-label={row.status === 'SOLD' ? 'Edit sale' : 'Mark sold'}
                        title={row.status === 'SOLD' ? 'Edit sale' : 'Mark sold'}
                      >
                        {row.status === 'SOLD' ? <PencilIcon size={15} /> : <TagIcon size={15} />}
                      </button>
                    )}
                    {row.status === 'ALLOTTED' && (
                      <button
                        onClick={() => notifyHolder(row)}
                        disabled={notifying === row.application_id}
                        className="link-accent inline-flex items-center disabled:opacity-50"
                        aria-label="Notify holder"
                        title={
                          notifying === row.application_id
                            ? 'Preparing…'
                            : 'WhatsApp the account holder — sell reminder + their login details + how-to-sell PDF'
                        }
                      >
                        <CommentDiscussionIcon size={15} />
                      </button>
                    )}
                    {row.status === 'ALLOTTED' && (
                      <button
                        onClick={() => onUndo(row.application_id)}
                        className="text-xs font-medium hover:underline"
                        style={{ color: 'var(--ink-muted)' }}
                        title="Revert back to Applied"
                      >
                        Undo
                      </button>
                    )}
                  </div>
                </div>

                {isEditing && form && (
                  <SoldForm
                    row={row}
                    form={form}
                    onChange={(next) => onChangeForm(row.application_id, next)}
                    onCancel={() => onCloseForm(row.application_id)}
                    onSave={() => onSave(row)}
                    saving={savingSold === row.application_id}
                    profitPersonName={profitPersonName}
                  />
                )}

                {!isEditing && row.status === 'SOLD' && (
                  <SoldBreakdown
                    row={row}
                    profitPersonName={profitPersonName}
                    onMarkPaid={(field) => onMarkPaid(row.application_id, field)}
                    markingPaid={markingPaid}
                  />
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function SoldForm({
  row,
  form,
  onChange,
  onCancel,
  onSave,
  saving,
  profitPersonName,
}: {
  row: AllotmentBoardRow
  form: SoldFormState
  onChange: (next: SoldFormState) => void
  onCancel: () => void
  onSave: () => void
  saving: boolean
  profitPersonName: string
}) {
  const shares = row.lot_size * row.lots
  const preview = computeProfitSplit({
    sellPricePerShare: sellPricePerShareFrom(form, row),
    lotSize: row.lot_size,
    lots: row.lots,
    bidAmount: row.bid_amount ?? 0,
    // Genuinely nullable — demat_accounts has no funder-visibility RLS
    // policy, so a non-admin viewer's own copy of a row they didn't
    // personally link (funded but don't own) can come back with this
    // null, which without a fallback silently skipped the demat holder's
    // cut in this preview.
    cutPercent: row.profit_share_percent ?? 25,
    dematHolderName: row.holder_name,
    funderName: row.bank_account_holder_name,
    profitPersonName,
    splitWithFunder: effectiveSplitWithFunder(row, form.split),
  })
  const hasEntry = form.mode === 'total' ? Number(form.totalPayout) > 0 : Number(form.sellPrice) > 0

  return (
    <div className="mt-3 space-y-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      <SaleAmountField
        mode={form.mode}
        onModeChange={(mode) => onChange({ ...form, mode })}
        sellPrice={form.sellPrice}
        onSellPriceChange={(sellPrice) => onChange({ ...form, sellPrice })}
        totalPayout={form.totalPayout}
        onTotalPayoutChange={(totalPayout) => onChange({ ...form, totalPayout })}
        shares={shares}
        invested={Math.round(row.bid_amount ?? 0)}
        extra={
          row.account_manager_case_type !== 'CASE_2' &&
          preview.hasFunder &&
          !preview.isFunderSelf && (
            <label className="flex items-center gap-2 pb-2 text-xs" style={{ color: 'var(--ink-secondary)' }}>
              <input
                type="checkbox"
                checked={form.split}
                onChange={(e) => onChange({ ...form, split: e.target.checked })}
              />
              Split remaining 50/50 with {row.bank_account_holder_name}
            </label>
          )
        }
      />

      {hasEntry && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4" style={{ color: 'var(--ink-secondary)' }}>
          <Stat label="Total sold" value={preview.totalSoldAmount} />
          <Stat label="Gross profit" value={preview.grossProfit} />
          <Stat
            label={`${payoutCutContact(row).name}'s cut (${row.profit_share_percent ?? 25}%)`}
            value={preview.dematCutAmount}
            note={preview.isDematHolderSelf ? 'self' : undefined}
          />
          <Stat label="Your share" value={preview.profitPersonShare} />
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onSave}
          disabled={saving || !hasEntry}
          className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// Exported — the new /payouts page reuses this verbatim so an outstanding
// payout's WhatsApp message reads identically whether it's sent from here
// or from there, instead of a second, silently-drifting copy.
// A shared account (migration 0079) forces splitWithFunder=false when its
// manager is CASE_2 — that person already covers both the account-holder
// and funder roles in their own cut, so there's no separate 50/50 with a
// third-party funder to compute. CASE_1 (and non-shared rows) keep whatever
// the caller/form asked for.
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

export function payoutMessage(
  row: AllotmentBoardRow,
  result: ReturnType<typeof computeProfitSplit>,
  kind: 'cut' | 'share',
): string {
  const shares = row.lot_size * row.lots
  const price = (row.sell_price ?? 0).toFixed(2)
  const total = Math.round(result.totalSoldAmount)
  const invested = Math.round(row.bid_amount ?? 0)
  const profit = total - invested
  // Genuinely nullable — see AllotmentBoardRow's own comment on this
  // field. This builds an actual WhatsApp message someone gets sent, so a
  // silent null-to-0 coercion here wouldn't just mis-render a UI number,
  // it would send a real person a wrong payout figure.
  const cutPct = row.profit_share_percent ?? 25
  // Each line's number feeds the next (cut, then remainder, then the 50/50
  // split) using values already rounded to whole rupees — so the equations
  // in the message add up cleanly instead of showing paise-level fractions.
  const cutAmount = Math.round((profit * cutPct) / 100)

  const saleLine = (prefix: string) =>
    `${prefix}${row.company_name} — sold ${shares.toLocaleString('en-IN')} shares at around  ₹${price}/share.\n` +
    `sold at Total ₹${total.toLocaleString('en-IN')},\n` +
    `${total}-${invested}= ${profit}(Profit)\n`

  const remaining = profit - cutAmount

  if (kind === 'cut') {
    const sendBack = invested + remaining
    return (
      `*${row.company_name}* — sold ${shares.toLocaleString('en-IN')} shares at around ₹${price}/share.\n\n` +
      `• Total sold: ₹${total.toLocaleString('en-IN')}\n` +
      `• Invested: ₹${invested.toLocaleString('en-IN')}\n` +
      `• Profit: ₹${total.toLocaleString('en-IN')} − ₹${invested.toLocaleString('en-IN')} = ₹${profit.toLocaleString('en-IN')}\n\n` +
      `*Your ${cutPct}% profit-sharing (incl. TAX) cut:*\n` +
      `₹${profit.toLocaleString('en-IN')} × ${cutPct}% = ₹${cutAmount.toLocaleString('en-IN')}\n\n` +
      `*Total to send back:*\n` +
      `₹${invested.toLocaleString('en-IN')} + ₹${remaining.toLocaleString('en-IN')} = ₹${sendBack.toLocaleString('en-IN')}\n\n` +
      `I'll share UPI details for the transfer.`
    )
  }

  const funderShare = Math.round(remaining / 2)
  const payout = invested + funderShare
  return (
    saleLine(`${row.holder_name}:- `) +
    `after ${row.holder_name} (${cutPct}%):${profit}-${cutPct}%=${remaining}\n\n` +
    `Here's your share of the profit:${remaining}/2= ₹${funderShare.toLocaleString('en-IN')}.\n` +
    `Total = ${invested}+${funderShare}=${payout}`
  )
}

function SoldBreakdown({
  row,
  profitPersonName,
  onMarkPaid,
  markingPaid,
}: {
  row: AllotmentBoardRow
  profitPersonName: string
  onMarkPaid: (field: 'demat_cut_paid' | 'funder_share_paid') => void
  markingPaid: string | null
}) {
  if (row.sell_price == null) return null
  const result = computeProfitSplit({
    sellPricePerShare: row.sell_price,
    lotSize: row.lot_size,
    lots: row.lots,
    bidAmount: row.bid_amount ?? 0,
    // Genuinely nullable — see AllotmentBoardRow's own comment on this field.
    cutPercent: row.profit_share_percent ?? 25,
    dematHolderName: row.holder_name,
    funderName: row.bank_account_holder_name,
    profitPersonName,
    splitWithFunder: effectiveSplitWithFunder(row, row.split_profit_with_funder),
  })

  return (
    <div className="mt-3 space-y-3 border-t pt-3 text-xs" style={{ borderColor: 'var(--border)' }}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4" style={{ color: 'var(--ink-secondary)' }}>
        <Stat label="Total sold" value={result.totalSoldAmount} />
        <Stat label="Gross profit" value={result.grossProfit} />
        <Stat label="Your share" value={result.profitPersonShare} />
      </div>
      {(!result.isDematHolderSelf && result.dematCutAmount > 0) || result.funderShare > 0 ? (
        <div className="flex flex-col gap-2">
          {!result.isDematHolderSelf && result.dematCutAmount > 0 && (
            <PayoutLine
              label={`${payoutCutContact(row).name} — ₹${Math.round(result.dematCutAmount).toLocaleString('en-IN')} cut`}
              paid={row.demat_cut_paid}
              onMarkPaid={() => onMarkPaid('demat_cut_paid')}
              marking={markingPaid === row.application_id + 'demat_cut_paid'}
              phone={payoutCutContact(row).phone}
              onMessage={() => sendCustomWhatsapp(payoutCutContact(row).phone!, payoutMessage(row, result, 'cut'))}
            />
          )}
          {result.funderShare > 0 && (
            <PayoutLine
              label={`${row.bank_account_holder_name} — ₹${Math.round(result.funderShare).toLocaleString('en-IN')} share`}
              paid={row.funder_share_paid}
              onMarkPaid={() => onMarkPaid('funder_share_paid')}
              marking={markingPaid === row.application_id + 'funder_share_paid'}
              phone={row.bank_account_phone}
              onMessage={
                row.bank_account_phone
                  ? () => sendCustomWhatsapp(row.bank_account_phone!, payoutMessage(row, result, 'share'))
                  : undefined
              }
            />
          )}
        </div>
      ) : (
        <p style={{ color: 'var(--good)' }}>No outstanding payouts — everything stays with you.</p>
      )}
    </div>
  )
}

function PayoutLine({
  label,
  paid,
  onMarkPaid,
  marking,
  phone,
  onMessage,
}: {
  label: string
  paid: boolean
  onMarkPaid: () => void
  marking: boolean
  phone?: string | null
  onMessage?: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="truncate" style={{ color: paid ? 'var(--good)' : 'var(--ink-primary)' }}>{label}</span>
      <div className="flex shrink-0 items-center gap-3">
        {onMessage && phone && (
          <button
            onClick={onMessage}
            className="link-accent inline-flex items-center"
            aria-label="Message"
            title="Message"
          >
            <CommentDiscussionIcon size={15} />
          </button>
        )}
        {paid ? (
          <span className="badge badge-good inline-flex items-center gap-1">
            <FileCheckIcon size={12} />
            Paid
          </span>
        ) : (
          <button onClick={onMarkPaid} disabled={marking} className="link-accent font-medium disabled:opacity-50">
            {marking ? 'Marking…' : 'Mark paid'}
          </button>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div>
      <p style={{ color: 'var(--ink-muted)' }}>{label}</p>
      <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
        ₹{Math.round(value).toLocaleString('en-IN')}
        {note ? ` (${note})` : ''}
      </p>
    </div>
  )
}
