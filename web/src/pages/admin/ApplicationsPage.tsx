import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { buildWaMeLink, renderMessageBody } from '../../lib/notificationTemplates'
import type {
  Application,
  ApplicationCategory,
  BankAccount,
  DematAccount,
  Ipo,
  Notification,
} from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

const categories: ApplicationCategory[] = ['RETAIL', 'SHNI', 'BHNI', 'SHAREHOLDER', 'EMPLOYEE']

type ApplicationRow = Application & {
  ipos: Pick<Ipo, 'company_name'>
  demat_accounts: Pick<DematAccount, 'holder_name'>
  notifications: Pick<Notification, 'id' | 'type' | 'status' | 'to_phone' | 'template_name' | 'variables'>[]
}

export function ApplicationsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [applications, setApplications] = useState<ApplicationRow[]>([])
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [accounts, setAccounts] = useState<DematAccount[]>([])
  const [banks, setBanks] = useState<BankAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [formDataLoading, setFormDataLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingApplication, setEditingApplication] = useState<ApplicationRow | null>(null)
  const [dispatching, setDispatching] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  async function loadApplications() {
    setLoading(true)
    const { data } = await supabase
      .from('applications')
      .select(
        '*, ipos(company_name), demat_accounts(holder_name), notifications(id, type, status, to_phone, template_name, variables)',
      )
      .order('applied_at', { ascending: false })
    setApplications((data ?? []) as ApplicationRow[])
    setLoading(false)
  }

  // IPOs + demat accounts + bank/UPI accounts are only needed to populate the
  // "New application" form's dropdowns — no point fetching them on every page
  // load when most visits are just reviewing the table. Re-fetched every time
  // the form opens (not cached after the first load) so newly added IPOs/
  // accounts/bank-UPI entries show up immediately instead of needing a page
  // refresh. Demat accounts and bank/UPI accounts are independent lists now —
  // any combination of the two can be picked per application.
  async function loadFormData() {
    setFormDataLoading(true)
    const [iposRes, accountsRes, banksRes] = await Promise.all([
      supabase.from('ipos').select('*').order('company_name'),
      supabase.from('demat_accounts').select('*').order('holder_name'),
      supabase.from('bank_accounts').select('*').order('is_default', { ascending: false }),
    ])
    setIpos((iposRes.data ?? []) as Ipo[])
    setAccounts((accountsRes.data ?? []) as DematAccount[])
    setBanks((banksRes.data ?? []) as BankAccount[])
    setFormDataLoading(false)
  }

  useEffect(() => {
    loadApplications()
  }, [])

  function openForm() {
    setShowForm(true)
    setEditingApplication(null)
    loadFormData()
  }

  function openEdit(a: ApplicationRow) {
    setEditingApplication(a)
    setShowForm(false)
    loadFormData()
  }

  async function markStatus(id: string, status: Application['status']) {
    await supabase.from('applications').update({ status }).eq('id', id)
    loadApplications()
  }

  async function dispatchNotification(n: ApplicationRow['notifications'][number]) {
    setDispatching(n.id)
    if (isAdmin) {
      await supabase.functions.invoke('send-whatsapp', { body: { notification_id: n.id } })
    } else {
      const params = (n.variables as { params?: string[] } | null)?.params ?? []
      const text = renderMessageBody(n.template_name, params, profile?.full_name ?? 'there')
      window.open(buildWaMeLink(n.to_phone, text), '_blank', 'noopener,noreferrer')
      await supabase
        .from('notifications')
        .update({ status: 'SENT', updated_at: new Date().toISOString() })
        .eq('id', n.id)
    }
    setDispatching(null)
    loadApplications()
  }

  async function deleteApplication(id: string) {
    if (!window.confirm('Delete this application? This cannot be undone.')) return
    const { error } = await supabase.from('applications').delete().eq('id', id)
    if (error) {
      alert(error.message)
      return
    }
    loadApplications()
  }

  function toggleSelected(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((s) => (s.size === applications.length ? new Set() : new Set(applications.map((a) => a.id))))
  }

  async function bulkDelete() {
    if (selected.size === 0) return
    if (!window.confirm(`Delete ${selected.size} application(s)? This cannot be undone.`)) return
    const { error } = await supabase.from('applications').delete().in('id', Array.from(selected))
    if (error) {
      alert(error.message)
      return
    }
    setSelected(new Set())
    loadApplications()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Applications
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {applications.length} total
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {selected.size > 0 && (
            <button
              onClick={bulkDelete}
              className="text-sm font-medium hover:underline"
              style={{ color: 'var(--critical)' }}
            >
              Delete {selected.size} selected
            </button>
          )}
          <button onClick={() => (showForm ? setShowForm(false) : openForm())} className="btn-primary">
            {showForm ? 'Cancel' : '+ New application'}
          </button>
        </div>
      </div>

      {(showForm || editingApplication) && formDataLoading && <InlineSpinner label="Loading form…" />}

      {showForm && !formDataLoading && (
        <NewApplicationForm
          ipos={ipos}
          accounts={accounts}
          banks={banks}
          onDone={() => {
            setShowForm(false)
            loadApplications()
          }}
        />
      )}

      {editingApplication && !formDataLoading && (
        <NewApplicationForm
          ipos={ipos}
          accounts={accounts}
          banks={banks}
          existing={editingApplication}
          onCancel={() => setEditingApplication(null)}
          onDone={() => {
            setEditingApplication(null)
            loadApplications()
          }}
        />
      )}

      {loading ? (
        <InlineSpinner />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
              <tr>
                <th className="px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={applications.length > 0 && selected.size === applications.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && selected.size < applications.length
                    }}
                    onChange={toggleSelectAll}
                    aria-label="Select all applications"
                  />
                </th>
                <th className="px-4 py-2.5 font-medium">IPO</th>
                <th className="px-4 py-2.5 font-medium">Holder</th>
                <th className="px-4 py-2.5 font-medium">Lots</th>
                <th className="px-4 py-2.5 font-medium">Bid amount</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Message</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {applications.map((a) => {
                return (
                <tr key={a.id} className="hover:bg-[var(--hover-surface)]">
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggleSelected(a.id)}
                      aria-label={`Select application for ${a.ipos?.company_name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {a.ipos?.company_name}
                  </td>
                  <td className="px-4 py-2.5">{a.demat_accounts?.holder_name}</td>
                  <td className="px-4 py-2.5">{a.lots}</td>
                  <td className="px-4 py-2.5">{a.bid_amount ? `₹${a.bid_amount.toLocaleString('en-IN')}` : '—'}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={a.status} />
                  </td>
                  <td className="px-4 py-2.5">
                    {a.notifications && a.notifications.length > 0 ? (
                      <div className="flex flex-col gap-1.5">
                        {a.notifications.map((notif) => (
                          <div key={notif.id} className="flex items-center gap-2">
                            <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                              {notif.to_phone}
                            </span>
                            <NotifBadge status={notif.status} />
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
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--ink-muted)' }}>—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-3">
                      {a.status === 'APPLIED' && (
                        <>
                          <button onClick={() => markStatus(a.id, 'ALLOTTED')} className="link-accent text-xs font-medium">
                            Allotted
                          </button>
                          <button
                            onClick={() => markStatus(a.id, 'NOT_ALLOTTED')}
                            className="text-xs font-medium hover:underline"
                            style={{ color: 'var(--ink-muted)' }}
                          >
                            Not allotted
                          </button>
                        </>
                      )}
                      {a.status === 'ALLOTTED' && (
                        <button onClick={() => markStatus(a.id, 'SOLD')} className="link-accent text-xs font-medium">
                          Mark sold
                        </button>
                      )}
                      <button onClick={() => openEdit(a)} className="link-accent text-xs font-medium">
                        Edit
                      </button>
                      <button
                        onClick={() => deleteApplication(a.id)}
                        className="text-xs font-medium hover:underline"
                        style={{ color: 'var(--critical)' }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
                )
              })}
              {applications.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
                    No applications yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: Application['status'] }) {
  const classes: Record<Application['status'], string> = {
    APPLIED: 'badge-info',
    ALLOTTED: 'badge-good',
    NOT_ALLOTTED: 'badge-neutral',
    SOLD: 'badge-violet',
  }
  return <span className={`badge ${classes[status]}`}>{status.replace('_', ' ')}</span>
}

function NotifBadge({ status }: { status: Notification['status'] }) {
  const classes: Record<Notification['status'], string> = {
    QUEUED: 'badge-neutral',
    SENT: 'badge-info',
    DELIVERED: 'badge-good',
    READ: 'badge-violet',
    FAILED: 'badge-critical',
    SIMULATED: 'badge-warning',
  }
  return <span className={`badge ${classes[status]}`}>{status}</span>
}

function NewApplicationForm({
  ipos,
  accounts,
  banks,
  existing,
  onCancel,
  onDone,
}: {
  ipos: Ipo[]
  accounts: DematAccount[]
  banks: BankAccount[]
  existing?: ApplicationRow
  onCancel?: () => void
  onDone: () => void
}) {
  const [ipoId, setIpoId] = useState(existing?.ipo_id ?? '')
  const [dematId, setDematId] = useState(existing?.demat_id ?? '')
  const [bankAccountId, setBankAccountId] = useState(existing?.bank_account_id ?? '')
  const [lots, setLots] = useState(existing ? String(existing.lots) : '1')
  const [category, setCategory] = useState<ApplicationCategory>(existing?.category ?? 'RETAIL')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const selectedIpo = ipos.find((i) => i.id === ipoId)
  const selectedAccount = accounts.find((a) => a.id === dematId)
  const cutoffPrice = selectedIpo?.price_high ?? 0
  const bidAmount = selectedIpo ? Number(lots || 0) * selectedIpo.lot_size * cutoffPrice : 0

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    if (existing) {
      // IPO/demat account are fixed once created — changing either is really
      // a different application (and demat_id is part of the WhatsApp
      // message trail), so only category/lots/bank account are editable.
      const { error } = await supabase
        .from('applications')
        .update({
          bank_account_id: bankAccountId || null,
          category,
          lots: Number(lots),
          bid_amount: bidAmount || null,
        })
        .eq('id', existing.id)
      setSubmitting(false)
      if (error) {
        setError(error.message)
        return
      }
      onDone()
      return
    }

    const { error } = await supabase.from('applications').insert({
      ipo_id: ipoId,
      demat_id: dematId,
      bank_account_id: bankAccountId || null,
      category,
      lots: Number(lots),
      bid_amount: bidAmount || null,
    })
    setSubmitting(false)
    if (error) {
      setError(
        error.code === '23505'
          ? 'Already applied from this PAN for this IPO.'
          : error.message,
      )
      return
    }
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="IPO">
        {existing ? (
          <p className="input" style={{ background: 'var(--page)' }}>
            {selectedIpo?.company_name ?? existing.ipos?.company_name}
          </p>
        ) : (
          <select required value={ipoId} onChange={(e) => setIpoId(e.target.value)} className="input">
            <option value="">Select IPO</option>
            {ipos.map((i) => (
              <option key={i.id} value={i.id}>
                {i.company_name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Demat account">
        {existing ? (
          <p className="input" style={{ background: 'var(--page)' }}>
            {selectedAccount?.holder_name ?? existing.demat_accounts?.holder_name}
          </p>
        ) : (
          <select
            required
            value={dematId}
            onChange={(e) => setDematId(e.target.value)}
            className="input"
          >
            <option value="">Select account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.holder_name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Bank account used">
        <select value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)} className="input">
          <option value="">Select bank/UPI</option>
          {banks.map((b) => (
            <option key={b.id} value={b.id}>
              {[b.account_holder_name, b.bank_name, b.upi_id].filter(Boolean).join(' · ') || 'Bank account'}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Category">
        <select value={category} onChange={(e) => setCategory(e.target.value as ApplicationCategory)} className="input">
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Lots">
        <input required type="number" min={1} value={lots} onChange={(e) => setLots(e.target.value)} className="input" />
      </Field>
      <Field label="Bid amount (auto)">
        <input
          readOnly
          value={bidAmount ? `₹${bidAmount.toLocaleString('en-IN')}` : ''}
          className="input"
          style={{ background: 'var(--page)' }}
        />
      </Field>

      {error && (
        <p className="badge badge-critical col-span-1 w-fit sm:col-span-2 lg:col-span-3">{error}</p>
      )}

      <div className="col-span-1 flex gap-2 sm:col-span-2 lg:col-span-3">
        <button
          type="submit"
          disabled={submitting || !ipoId || !dematId}
          className="btn-primary flex-1 py-2.5"
        >
          {submitting ? 'Saving…' : existing ? 'Save changes' : 'Save application'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}
