import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { dispatchAdminWhatsapp, openWhatsAppForNotification } from '../../lib/dispatchWhatsapp'
import { computeProfitSplit, namesMatch } from '../../lib/profitSplit'
import type {
  AllotmentBoardRow,
  ApplicationStatus,
  Ipo,
  Notification,
  RegistrarLink,
} from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

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

export function AllotmentBoardPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [selectedIpoId, setSelectedIpoId] = useState('')
  const [rows, setRows] = useState<AllotmentBoardRow[]>([])
  const [registrarLinks, setRegistrarLinks] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [allottedNotifs, setAllottedNotifs] = useState<Record<string, AllottedNotif>>({})
  const [dispatching, setDispatching] = useState<string | null>(null)
  const [soldForms, setSoldForms] = useState<Record<string, { sellPrice: string; split: boolean }>>({})
  const [savingSold, setSavingSold] = useState<string | null>(null)
  const [markingPaid, setMarkingPaid] = useState<string | null>(null)

  useEffect(() => {
    const todayStr = new Date().toISOString().slice(0, 10)
    supabase
      .from('ipos')
      .select('*')
      .not('allotment_date', 'is', null)
      .lte('allotment_date', todayStr)
      .order('allotment_date', { ascending: false })
      .then(({ data }) => setIpos((data ?? []) as Ipo[]))
    supabase
      .from('registrar_links')
      .select('*')
      .then(({ data }) => {
        const map: Record<string, string> = {}
        for (const l of (data ?? []) as RegistrarLink[]) map[l.registrar] = l.check_url
        setRegistrarLinks(map)
      })
  }, [])

  async function loadBoard(ipoId: string) {
    setSelectedIpoId(ipoId)
    setSelected(new Set())
    if (!ipoId) {
      setRows([])
      return
    }
    setLoading(true)
    const { data } = await supabase.from('v_allotment_board').select('*').eq('ipo_id', ipoId)
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
      await dispatchAdminWhatsapp(n.id, profile?.full_name ?? 'there')
    } else {
      await openWhatsAppForNotification(n, profile?.full_name ?? 'there')
    }
    setDispatching(null)
    loadBoard(selectedIpoId)
  }

  const selectedIpo = ipos.find((i) => i.id === selectedIpoId)
  const registrarUrl = selectedIpo?.registrar_url || registrarLinks[selectedIpo?.registrar ?? '']

  async function markStatus(applicationId: string, status: 'ALLOTTED' | 'NOT_ALLOTTED') {
    await supabase.from('applications').update({ status }).eq('id', applicationId)
    loadBoard(selectedIpoId)
  }

  async function bulkMarkNotAllotted() {
    if (selected.size === 0) return
    await supabase.from('applications').update({ status: 'NOT_ALLOTTED' }).in('id', Array.from(selected))
    loadBoard(selectedIpoId)
  }

  async function revealPan(row: AllotmentBoardRow) {
    const { data, error } = await supabase.functions.invoke<{ pan: string }>('reveal-pan', {
      body: { demat_id: row.demat_id },
    })
    if (!error && data) setRevealed((r) => ({ ...r, [row.application_id]: data.pan }))
  }

  function copyPan(row: AllotmentBoardRow) {
    const pan = revealed[row.application_id] ?? row.pan_masked
    navigator.clipboard.writeText(pan)
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function openSoldForm(row: AllotmentBoardRow) {
    // Default the split checkbox to "on" when the funder isn't the person
    // doing the accounting — admin can still flip it either way.
    const autoSplit =
      !!row.bank_account_holder_name && !namesMatch(row.bank_account_holder_name, profile?.full_name ?? '')
    setSoldForms((f) => ({
      ...f,
      [row.application_id]: {
        sellPrice: row.sell_price != null ? String(row.sell_price) : '',
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
    if (!form || !form.sellPrice) return
    setSavingSold(row.application_id)
    await supabase
      .from('applications')
      .update({
        sell_price: Number(form.sellPrice),
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
    loadBoard(selectedIpoId)
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Allotment board
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Copy PAN, open the registrar, mark results — one row at a time. Only IPOs whose allotment is already out
          are listed below.
        </p>
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
        {registrarUrl && (
          <a href={registrarUrl} target="_blank" rel="noreferrer" className="btn-secondary">
            Open registrar page ↗
          </a>
        )}
        {selected.size > 0 && (
          <button onClick={bulkMarkNotAllotted} className="btn-secondary">
            Mark {selected.size} selected as Not allotted
          </button>
        )}
      </div>

      {loading && <InlineSpinner />}

      {!loading && selectedIpoId && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
              <tr>
                <th className="px-4 py-2.5"></th>
                <th className="px-4 py-2.5 font-medium">Holder</th>
                <th className="px-4 py-2.5 font-medium">PAN</th>
                <th className="px-4 py-2.5 font-medium">Bank</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Message</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {rows.map((row) => {
                const notif = allottedNotifs[row.application_id]
                return (
                <tr key={row.application_id} className="stagger-item transition-colors duration-150 hover:bg-[var(--hover-surface)]">
                  <td className="px-4 py-2.5">
                    {row.status === 'APPLIED' && (
                      <input
                        type="checkbox"
                        checked={selected.has(row.application_id)}
                        onChange={() => toggle(row.application_id)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {row.holder_name}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono" style={{ color: 'var(--ink-secondary)' }}>
                      {revealed[row.application_id] ?? row.pan_masked}
                    </span>
                    <button onClick={() => revealPan(row)} className="link-accent ml-2 text-xs font-medium">
                      Reveal
                    </button>
                    <button onClick={() => copyPan(row)} className="link-accent ml-2 text-xs font-medium">
                      Copy
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    {[
                      row.bank_name && row.last4 ? `${row.bank_name} ••${row.last4}` : row.bank_name,
                      row.upi_id,
                    ]
                      .filter(Boolean)
                      .join(' / ') || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`badge ${statusBadgeClass[row.status]}`}>{row.status.replace('_', ' ')}</span>
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
                    {row.status === 'APPLIED' && (
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
                    )}
                  </td>
                </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
                    No applications for this IPO.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

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
        />
      )}
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
}: {
  rows: AllotmentBoardRow[]
  soldForms: Record<string, { sellPrice: string; split: boolean }>
  onOpenForm: (row: AllotmentBoardRow) => void
  onCloseForm: (id: string) => void
  onChangeForm: (id: string, next: { sellPrice: string; split: boolean }) => void
  onSave: (row: AllotmentBoardRow) => void
  savingSold: string | null
  onMarkPaid: (applicationId: string, field: 'demat_cut_paid' | 'funder_share_paid') => void
  markingPaid: string | null
  profitPersonName: string
}) {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Sold status &amp; payouts
        </h2>
        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          Mark allotted shares as sold and track who still needs to be paid.
        </p>
      </div>
      {rows.length === 0 ? (
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
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {row.holder_name}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>{row.lots} lot(s)</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`badge ${statusBadgeClass[row.status]}`}>{row.status.replace('_', ' ')}</span>
                    {!isEditing && (
                      <button onClick={() => onOpenForm(row)} className="link-accent text-xs font-medium">
                        {row.status === 'SOLD' ? 'Edit sale' : 'Mark sold'}
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
      )}
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
  form: { sellPrice: string; split: boolean }
  onChange: (next: { sellPrice: string; split: boolean }) => void
  onCancel: () => void
  onSave: () => void
  saving: boolean
  profitPersonName: string
}) {
  const preview = computeProfitSplit({
    sellPricePerShare: Number(form.sellPrice || 0),
    lotSize: row.lot_size,
    lots: row.lots,
    bidAmount: row.bid_amount ?? 0,
    cutPercent: row.profit_share_percent,
    dematHolderName: row.holder_name,
    funderName: row.bank_account_holder_name,
    profitPersonName,
    splitWithFunder: form.split,
  })

  return (
    <div className="mt-3 space-y-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-end gap-4">
        <label className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          Sell price per share
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.sellPrice}
            onChange={(e) => onChange({ ...form, sellPrice: e.target.value })}
            className="input mt-1 block w-36"
            autoFocus
          />
        </label>
        {preview.hasFunder && !preview.isFunderSelf && (
          <label className="flex items-center gap-2 pb-2 text-xs" style={{ color: 'var(--ink-secondary)' }}>
            <input
              type="checkbox"
              checked={form.split}
              onChange={(e) => onChange({ ...form, split: e.target.checked })}
            />
            Split remaining 50/50 with {row.bank_account_holder_name}
          </label>
        )}
      </div>

      {Number(form.sellPrice) > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4" style={{ color: 'var(--ink-secondary)' }}>
          <Stat label="Total sold" value={preview.totalSoldAmount} />
          <Stat label="Gross profit" value={preview.grossProfit} />
          <Stat
            label={`${row.holder_name}'s cut (${row.profit_share_percent}%)`}
            value={preview.dematCutAmount}
            note={preview.isDematHolderSelf ? 'self' : undefined}
          />
          <Stat label="Your share" value={preview.profitPersonShare} />
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onSave}
          disabled={saving || !form.sellPrice}
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
    cutPercent: row.profit_share_percent,
    dematHolderName: row.holder_name,
    funderName: row.bank_account_holder_name,
    profitPersonName,
    splitWithFunder: row.split_profit_with_funder,
  })

  return (
    <div className="mt-3 space-y-3 border-t pt-3 text-xs" style={{ borderColor: 'var(--border)' }}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4" style={{ color: 'var(--ink-secondary)' }}>
        <Stat label="Total sold" value={result.totalSoldAmount} />
        <Stat label="Gross profit" value={result.grossProfit} />
        <Stat label="Your share" value={result.profitPersonShare} />
      </div>
      {(!result.isDematHolderSelf && result.dematCutAmount > 0) || result.funderShare > 0 ? (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {!result.isDematHolderSelf && result.dematCutAmount > 0 && (
            <PayoutLine
              label={`${row.holder_name} — ₹${Math.round(result.dematCutAmount).toLocaleString('en-IN')} cut`}
              paid={row.demat_cut_paid}
              onMarkPaid={() => onMarkPaid('demat_cut_paid')}
              marking={markingPaid === row.application_id + 'demat_cut_paid'}
            />
          )}
          {result.funderShare > 0 && (
            <PayoutLine
              label={`${row.bank_account_holder_name} — ₹${Math.round(result.funderShare).toLocaleString('en-IN')} share`}
              paid={row.funder_share_paid}
              onMarkPaid={() => onMarkPaid('funder_share_paid')}
              marking={markingPaid === row.application_id + 'funder_share_paid'}
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
}: {
  label: string
  paid: boolean
  onMarkPaid: () => void
  marking: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span style={{ color: paid ? 'var(--good)' : 'var(--ink-primary)' }}>{label}</span>
      {paid ? (
        <span className="badge badge-good">Paid</span>
      ) : (
        <button onClick={onMarkPaid} disabled={marking} className="link-accent font-medium disabled:opacity-50">
          {marking ? 'Marking…' : 'Mark paid'}
        </button>
      )}
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
