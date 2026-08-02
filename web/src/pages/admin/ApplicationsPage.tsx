import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { isLiveIpo } from '../../lib/ipoStatus'
import { dispatchAdminWhatsapp, openWhatsAppForNotification } from '../../lib/dispatchWhatsapp'
import { SaleAmountField, sellPricePerShareFromEntry, type SaleEntryMode } from '../../components/SaleAmountField'
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
  const [backdatedMode, setBackdatedMode] = useState(false)

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

  function openForm(backdated = false) {
    setShowForm(true)
    setBackdatedMode(backdated)
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
      await dispatchAdminWhatsapp(n.id, profile?.full_name ?? 'there')
    } else {
      await openWhatsAppForNotification(n, profile?.full_name ?? 'there')
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

  // applications is already fetched newest-applied-first, so grouping into a
  // Map (which preserves insertion order) naturally puts each IPO's group at
  // the position of its own most recent application — i.e. latest IPO on top
  // — without needing a second sort pass.
  const groupedApplications = useMemo(() => {
    const groups = new Map<string, { ipoName: string; items: ApplicationRow[] }>()
    for (const a of applications) {
      const key = a.ipo_id
      if (!groups.has(key)) groups.set(key, { ipoName: a.ipos?.company_name ?? 'Unknown IPO', items: [] })
      groups.get(key)!.items.push(a)
    }
    return Array.from(groups.values())
  }, [applications])

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
          {showForm ? (
            <button onClick={() => setShowForm(false)} className="btn-primary">
              Cancel
            </button>
          ) : (
            <>
              <button onClick={() => openForm(true)} className="btn-secondary">
                + Backdated application
              </button>
              <button onClick={() => openForm(false)} className="btn-primary">
                + New application
              </button>
            </>
          )}
        </div>
      </div>

      {showForm && formDataLoading && <InlineSpinner label="Loading form…" />}

      {showForm && !formDataLoading && (
        <NewApplicationForm
          ipos={ipos}
          accounts={accounts}
          banks={banks}
          backdated={backdatedMode}
          onDone={() => {
            setShowForm(false)
            loadApplications()
          }}
        />
      )}

      {loading ? (
        <InlineSpinner />
      ) : applications.length === 0 ? (
        <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No applications yet.
        </p>
      ) : (
        <div className="space-y-6">
          {groupedApplications.map(({ ipoName, items }) => (
            <div key={items[0].ipo_id}>
              <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
                {ipoName}
              </h2>
              <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
                {items.map((a) => {
                  if (editingApplication?.id === a.id) {
                    return formDataLoading ? (
                      <div key={a.id} className="p-4">
                        <InlineSpinner label="Loading form…" />
                      </div>
                    ) : (
                      <div key={a.id} className="p-4">
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
                      </div>
                    )
                  }

                  const tone = { APPLIED: 'info', ALLOTTED: 'good', NOT_ALLOTTED: 'neutral', SOLD: 'violet' }[a.status]

                  return (
                    <div key={a.id} className="stagger-item flex flex-wrap items-center gap-3 p-4">
                      <div
                        className={`icon-badge icon-badge-${tone} shrink-0 text-xs font-semibold`}
                        style={{ width: '2.25rem', height: '2.25rem' }}
                      >
                        {a.demat_accounts?.holder_name?.[0]?.toUpperCase()}
                      </div>

                      <div className="min-w-[9rem] flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                            {a.demat_accounts?.holder_name}
                          </p>
                          {a.is_backdated && (
                            <span
                              className="badge badge-warning shrink-0"
                              title="This application was created in backdated format."
                            >
                              Backdated
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="w-32 shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
                        <p>{a.lots} lot(s)</p>
                        <p>{a.bid_amount ? `₹${a.bid_amount.toLocaleString('en-IN')}` : '—'}</p>
                      </div>

                      {a.sell_price != null && (
                        <div className="w-24 shrink-0 text-xs" style={{ color: 'var(--good)' }}>
                          Sold ₹{a.sell_price.toLocaleString('en-IN')}
                        </div>
                      )}

                      <StatusBadge status={a.status} />

                      <div className="min-w-[8rem] flex-1">
                        {a.notifications && a.notifications.length > 0 ? (
                          <div className="flex flex-col gap-1">
                            {a.notifications.map((notif) => (
                              <div key={notif.id} className="flex items-center gap-1.5">
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
                          <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                            —
                          </span>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                        <button
                          onClick={() => openEdit(a)}
                          aria-label={`Edit application for ${a.demat_accounts?.holder_name}`}
                          className="rounded-lg p-1.5 transition-colors hover:bg-[var(--hover-surface)]"
                          style={{ color: 'var(--ink-muted)' }}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => deleteApplication(a.id)}
                          aria-label={`Delete application for ${a.demat_accounts?.holder_name}`}
                          className="rounded-lg p-1.5 transition-colors hover:bg-[var(--critical-tint)]"
                          style={{ color: 'var(--critical)' }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
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
  backdated = false,
  onCancel,
  onDone,
}: {
  ipos: Ipo[]
  accounts: DematAccount[]
  banks: BankAccount[]
  existing?: ApplicationRow
  backdated?: boolean
  onCancel?: () => void
  onDone: () => void
}) {
  const existingIpo = existing ? ipos.find((i) => i.id === existing.ipo_id) : undefined
  const [ipoId, setIpoId] = useState(existing?.ipo_id ?? '')
  const [dematId, setDematId] = useState(existing?.demat_id ?? '')
  const [bankAccountId, setBankAccountId] = useState(existing?.bank_account_id ?? '')
  const [lots, setLots] = useState(existing ? String(existing.lots) : '1')
  const [category, setCategory] = useState<ApplicationCategory>(existing?.category ?? 'RETAIL')
  const [saleMode, setSaleMode] = useState<SaleEntryMode>('total')
  const [sellPrice, setSellPrice] = useState(existing?.sell_price != null ? String(existing.sell_price) : '')
  const [totalPayout, setTotalPayout] = useState(
    existing?.sell_price != null && existingIpo
      ? String(Math.round(existing.sell_price * existingIpo.lot_size * existing.lots))
      : '',
  )
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Only IPOs currently open for bidding make sense to apply for — a closed
  // or not-yet-open one would just be a mistake waiting to happen. Backdated
  // mode is the deliberate escape hatch for catching up a record after the
  // fact, so it lists every IPO instead.
  const liveIpos = ipos.filter(isLiveIpo)
  const selectableIpos = backdated ? ipos : liveIpos
  const selectedIpo = ipos.find((i) => i.id === ipoId)
  const selectedAccount = accounts.find((a) => a.id === dematId)
  const cutoffPrice = selectedIpo?.price_high ?? 0
  const bidAmount = selectedIpo ? Number(lots || 0) * selectedIpo.lot_size * cutoffPrice : 0
  const soldShares = selectedIpo ? selectedIpo.lot_size * Number(lots || 0) : 0
  const finalSellPrice = sellPricePerShareFromEntry(saleMode, sellPrice, totalPayout, soldShares)

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
          // Optional here — marking an application Sold (the "Mark sold"
          // button) no longer requires a price. The payment amount is
          // normally filled in afterward on the Allotment board instead;
          // this just lets it be recorded here too if it's already known.
          sell_price: finalSellPrice ? Math.round(finalSellPrice * 100) / 100 : null,
          status: existing.status,
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
      is_backdated: backdated,
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
    <form onSubmit={handleSubmit} className="card animate-page-in grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
      {!existing && backdated && (
        <p className="col-span-full text-xs font-medium" style={{ color: 'var(--warning)' }}>
          Backdated application — any past IPO can be selected, and it'll be flagged as backdated once saved.
        </p>
      )}
      <Field label="IPO">
        {existing ? (
          <p className="input" style={{ background: 'var(--page)' }}>
            {selectedIpo?.company_name ?? existing.ipos?.company_name}
          </p>
        ) : (
          <>
            <select required value={ipoId} onChange={(e) => setIpoId(e.target.value)} className="input">
              <option value="">
                {selectableIpos.length === 0 ? (backdated ? 'No IPOs yet' : 'No live IPOs right now') : 'Select IPO'}
              </option>
              {selectableIpos.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.company_name}
                </option>
              ))}
            </select>
            {selectableIpos.length === 0 && !backdated && (
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                No IPOs currently between open and listing date.
              </p>
            )}
          </>
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
            {accounts.filter((a) => a.is_active).length > 0 && (
              <optgroup label="Active accounts">
                {accounts
                  .filter((a) => a.is_active)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.holder_name}
                    </option>
                  ))}
              </optgroup>
            )}
            {accounts.filter((a) => !a.is_active).length > 0 && (
              <optgroup label="Inactive accounts">
                {accounts
                  .filter((a) => !a.is_active)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.holder_name}
                    </option>
                  ))}
              </optgroup>
            )}
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
      {existing && (existing.status === 'ALLOTTED' || existing.status === 'SOLD') && (
        <div className="col-span-1 sm:col-span-2 lg:col-span-3">
          <SaleAmountField
            mode={saleMode}
            onModeChange={setSaleMode}
            sellPrice={sellPrice}
            onSellPriceChange={setSellPrice}
            totalPayout={totalPayout}
            onTotalPayoutChange={setTotalPayout}
            shares={soldShares}
            invested={Math.round(bidAmount)}
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
            Optional — use "Mark sold" to flip status without this; the payment amount is normally filled in on the
            Allotment board afterward.
          </p>
        </div>
      )}

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

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
      <span className="flex items-baseline justify-between gap-2">
        {label}
        {hint && (
          <span className="text-xs font-normal" style={{ color: 'var(--ink-muted)' }}>
            {hint}
          </span>
        )}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  )
}
