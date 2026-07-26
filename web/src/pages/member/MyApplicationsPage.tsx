import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { buildWaMeLink, renderMessageBody } from '../../lib/notificationTemplates'
import type { Application, ApplicationCategory, BankAccount, DematAccount, Ipo, Notification } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

const categories: ApplicationCategory[] = ['RETAIL', 'SHNI', 'BHNI', 'SHAREHOLDER', 'EMPLOYEE']

type ApplicationRow = Application & {
  ipos: Pick<Ipo, 'company_name' | 'listing_date'>
  demat_accounts: Pick<DematAccount, 'holder_name'>
  bank_accounts: Pick<BankAccount, 'account_holder_name' | 'bank_name' | 'last4' | 'upi_id'> | null
  notifications: Pick<Notification, 'id' | 'type' | 'status' | 'to_phone' | 'template_name' | 'variables'>[]
}

export function MyApplicationsPage() {
  const { profile } = useAuth()
  const [applications, setApplications] = useState<ApplicationRow[]>([])
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [accounts, setAccounts] = useState<DematAccount[]>([])
  const [banks, setBanks] = useState<BankAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [formDataLoading, setFormDataLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [sending, setSending] = useState<string | null>(null)

  async function loadApplications() {
    setLoading(true)
    const { data } = await supabase
      .from('applications')
      .select(
        '*, ipos(company_name, listing_date), demat_accounts(holder_name), bank_accounts(account_holder_name, bank_name, last4, upi_id), notifications(id, type, status, to_phone, template_name, variables)',
      )
      .order('applied_at', { ascending: false })
    setApplications((data ?? []) as ApplicationRow[])
    setLoading(false)
  }

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
    loadFormData()
  }

  async function markStatus(id: string, status: Application['status']) {
    await supabase.from('applications').update({ status }).eq('id', id)
    loadApplications()
  }

  async function openWhatsApp(n: Pick<Notification, 'id' | 'to_phone' | 'template_name' | 'variables'>) {
    const params = (n.variables as { params?: string[] } | null)?.params ?? []
    const text = renderMessageBody(n.template_name, params, profile?.full_name ?? 'there')
    window.open(buildWaMeLink(n.to_phone, text), '_blank', 'noopener,noreferrer')

    setSending(n.id)
    await supabase.from('notifications').update({ status: 'SENT', updated_at: new Date().toISOString() }).eq('id', n.id)
    setSending(null)
    loadApplications()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Your applications
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {applications.length} total
          </p>
        </div>
        <button onClick={() => (showForm ? setShowForm(false) : openForm())} className="btn-primary">
          {showForm ? 'Cancel' : '+ New application'}
        </button>
      </div>

      {showForm && formDataLoading && <InlineSpinner label="Loading form…" />}

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

      {loading ? (
        <InlineSpinner />
      ) : (
        <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
          {applications.map((a) => (
            <div key={a.id} className="p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {a.ipos?.company_name}
                </p>
                <StatusBadge status={a.status} />
              </div>
              <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
                {a.demat_accounts?.holder_name} · {a.lots} lot(s) · ₹{a.bid_amount ?? '—'}
                {a.ipos?.listing_date && ` · listing ${a.ipos.listing_date}`}
              </p>
              {a.bank_accounts && (
                <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
                  via{' '}
                  {[a.bank_accounts.account_holder_name, a.bank_accounts.bank_name, a.bank_accounts.upi_id]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
              {a.status === 'APPLIED' && (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button onClick={() => markStatus(a.id, 'ALLOTTED')} className="link-accent text-xs font-medium">
                    Mark allotted
                  </button>
                  <button
                    onClick={() => markStatus(a.id, 'NOT_ALLOTTED')}
                    className="text-xs font-medium hover:underline"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    Not allotted
                  </button>
                </div>
              )}
              {a.status === 'ALLOTTED' && (
                <>
                  <p className="mt-1 text-sm font-medium" style={{ color: 'var(--good)' }}>
                    Allotted — please sell on listing day{a.ipos?.listing_date ? ` (${a.ipos.listing_date})` : ''}.
                  </p>
                  <button onClick={() => markStatus(a.id, 'SOLD')} className="link-accent mt-1 text-xs font-medium">
                    Mark sold
                  </button>
                </>
              )}
              {a.notifications && a.notifications.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {a.notifications.map((notif) => (
                    <div key={notif.id} className="flex items-center gap-2">
                      <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                        Notify {notif.to_phone}
                      </span>
                      <NotifBadge status={notif.status} />
                      {(notif.status === 'QUEUED' || notif.status === 'FAILED') && (
                        <button
                          onClick={() => openWhatsApp(notif)}
                          disabled={sending === notif.id}
                          className="link-accent text-xs font-medium disabled:opacity-50"
                        >
                          {sending === notif.id ? 'Opening…' : 'Open WhatsApp'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {applications.length === 0 && (
            <p className="p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
              No applications yet.
            </p>
          )}
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
  onDone,
}: {
  ipos: Ipo[]
  accounts: DematAccount[]
  banks: BankAccount[]
  onDone: () => void
}) {
  const [ipoId, setIpoId] = useState('')
  const [dematId, setDematId] = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [lots, setLots] = useState('1')
  const [category, setCategory] = useState<ApplicationCategory>('RETAIL')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const selectedIpo = ipos.find((i) => i.id === ipoId)
  const cutoffPrice = selectedIpo?.price_high ?? 0
  const bidAmount = selectedIpo ? Number(lots || 0) * selectedIpo.lot_size * cutoffPrice : 0

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

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
      setError(error.code === '23505' ? 'Already applied from this account for this IPO.' : error.message)
      return
    }
    onDone()
  }

  if (accounts.length === 0) {
    return (
      <p className="card p-5 text-sm" style={{ color: 'var(--ink-muted)' }}>
        Add a demat account first (My account page) before applying for an IPO.
      </p>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="IPO">
        <select required value={ipoId} onChange={(e) => setIpoId(e.target.value)} className="input">
          <option value="">Select IPO</option>
          {ipos.map((i) => (
            <option key={i.id} value={i.id}>
              {i.company_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Demat account">
        <select required value={dematId} onChange={(e) => setDematId(e.target.value)} className="input">
          <option value="">Select account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.holder_name}
            </option>
          ))}
        </select>
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

      {error && <p className="badge badge-critical col-span-1 w-fit sm:col-span-2 lg:col-span-3">{error}</p>}

      <div className="col-span-1 flex gap-2 sm:col-span-2 lg:col-span-3">
        <button type="submit" disabled={submitting || !ipoId || !dematId} className="btn-primary flex-1 py-2.5">
          {submitting ? 'Saving…' : 'Save application'}
        </button>
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
