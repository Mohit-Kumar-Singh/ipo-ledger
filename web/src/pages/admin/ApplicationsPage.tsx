import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import type {
  Application,
  ApplicationCategory,
  BankAccount,
  DematAccount,
  Ipo,
} from '../../types/database'

const categories: ApplicationCategory[] = ['RETAIL', 'SHNI', 'BHNI', 'SHAREHOLDER', 'EMPLOYEE']

type ApplicationRow = Application & {
  ipos: Pick<Ipo, 'company_name'>
  demat_accounts: Pick<DematAccount, 'holder_name'>
}

export function ApplicationsPage() {
  const [applications, setApplications] = useState<ApplicationRow[]>([])
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [accounts, setAccounts] = useState<(DematAccount & { bank_accounts: BankAccount[] })[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  async function load() {
    setLoading(true)
    const [appsRes, iposRes, accountsRes] = await Promise.all([
      supabase
        .from('applications')
        .select('*, ipos(company_name), demat_accounts(holder_name)')
        .order('applied_at', { ascending: false }),
      supabase.from('ipos').select('*').order('company_name'),
      supabase.from('demat_accounts').select('*, bank_accounts(*)').order('holder_name'),
    ])
    setApplications((appsRes.data ?? []) as ApplicationRow[])
    setIpos((iposRes.data ?? []) as Ipo[])
    setAccounts((accountsRes.data ?? []) as (DematAccount & { bank_accounts: BankAccount[] })[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function markStatus(id: string, status: Application['status']) {
    await supabase.from('applications').update({ status }).eq('id', id)
    load()
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Applications
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {applications.length} total
          </p>
        </div>
        <button onClick={() => setShowForm((s) => !s)} className="btn-primary">
          {showForm ? 'Cancel' : '+ New application'}
        </button>
      </div>

      {showForm && (
        <NewApplicationForm
          ipos={ipos}
          accounts={accounts}
          onDone={() => {
            setShowForm(false)
            load()
          }}
        />
      )}

      {loading ? (
        <p style={{ color: 'var(--ink-muted)' }}>Loading…</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
              <tr>
                <th className="px-4 py-2.5 font-medium">IPO</th>
                <th className="px-4 py-2.5 font-medium">Holder</th>
                <th className="px-4 py-2.5 font-medium">Lots</th>
                <th className="px-4 py-2.5 font-medium">Bid amount</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {applications.map((a) => (
                <tr key={a.id} className="hover:bg-[var(--hover-surface)]">
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
                    {a.status === 'APPLIED' && (
                      <div className="flex gap-3">
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
                      </div>
                    )}
                    {a.status === 'ALLOTTED' && (
                      <button onClick={() => markStatus(a.id, 'SOLD')} className="link-accent text-xs font-medium">
                        Mark sold
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {applications.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
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

function NewApplicationForm({
  ipos,
  accounts,
  onDone,
}: {
  ipos: Ipo[]
  accounts: (DematAccount & { bank_accounts: BankAccount[] })[]
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
  const selectedAccount = accounts.find((a) => a.id === dematId)
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
    <form onSubmit={handleSubmit} className="card grid grid-cols-3 gap-4 p-5">
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
        <select
          required
          value={dematId}
          onChange={(e) => {
            setDematId(e.target.value)
            setBankAccountId('')
          }}
          className="input"
        >
          <option value="">Select account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.holder_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Bank account used">
        <select
          value={bankAccountId}
          onChange={(e) => setBankAccountId(e.target.value)}
          className="input"
          disabled={!selectedAccount}
        >
          <option value="">Select bank</option>
          {selectedAccount?.bank_accounts.map((b) => (
            <option key={b.id} value={b.id}>
              {b.bank_name} ••{b.last4}
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
        <p className="badge badge-critical col-span-3 w-fit">{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting || !ipoId || !dematId}
        className="btn-primary col-span-3 py-2.5"
      >
        {submitting ? 'Saving…' : 'Save application'}
      </button>
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
