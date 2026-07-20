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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Applications</h1>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-800"
        >
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
        <p className="text-gray-500">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-3 py-2">IPO</th>
                <th className="px-3 py-2">Holder</th>
                <th className="px-3 py-2">Lots</th>
                <th className="px-3 py-2">Bid amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {applications.map((a) => (
                <tr key={a.id}>
                  <td className="px-3 py-2">{a.ipos?.company_name}</td>
                  <td className="px-3 py-2">{a.demat_accounts?.holder_name}</td>
                  <td className="px-3 py-2">{a.lots}</td>
                  <td className="px-3 py-2">{a.bid_amount ? `₹${a.bid_amount}` : '—'}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={a.status} />
                  </td>
                  <td className="px-3 py-2">
                    {a.status === 'APPLIED' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => markStatus(a.id, 'ALLOTTED')}
                          className="text-xs text-green-700 hover:underline"
                        >
                          Allotted
                        </button>
                        <button
                          onClick={() => markStatus(a.id, 'NOT_ALLOTTED')}
                          className="text-xs text-gray-500 hover:underline"
                        >
                          Not allotted
                        </button>
                      </div>
                    )}
                    {a.status === 'ALLOTTED' && (
                      <button
                        onClick={() => markStatus(a.id, 'SOLD')}
                        className="text-xs text-purple-700 hover:underline"
                      >
                        Mark sold
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {applications.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-gray-400">
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
  const colors: Record<Application['status'], string> = {
    APPLIED: 'bg-blue-100 text-blue-700',
    ALLOTTED: 'bg-green-100 text-green-700',
    NOT_ALLOTTED: 'bg-gray-100 text-gray-600',
    SOLD: 'bg-purple-100 text-purple-700',
  }
  return <span className={`rounded px-2 py-0.5 text-xs ${colors[status]}`}>{status}</span>
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
    <form onSubmit={handleSubmit} className="grid grid-cols-3 gap-3 rounded border bg-white p-4">
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
        <input readOnly value={bidAmount ? `₹${bidAmount.toLocaleString('en-IN')}` : ''} className="input bg-gray-50" />
      </Field>

      {error && <p className="col-span-3 text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting || !ipoId || !dematId}
        className="col-span-3 rounded bg-purple-700 py-2 text-sm font-medium text-white hover:bg-purple-800 disabled:opacity-50"
      >
        {submitting ? 'Saving…' : 'Save application'}
      </button>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm text-gray-700">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}
