import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { describeFunctionError, supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import type { DematAccount, Profile } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

type EditingAccount = {
  id: string
  holderName: string
  phoneDigits: string
  pan: string
  dematAccountNo: string
  profitSharePercent: string
}

export function AccountsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [accounts, setAccounts] = useState<DematAccount[]>([])
  const [unlinkedMembers, setUnlinkedMembers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingAccount, setEditingAccount] = useState<EditingAccount | null>(null)
  const [revealing, setRevealing] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [linking, setLinking] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  async function load() {
    setLoading(true)
    const [accountsRes, membersRes] = await Promise.all([
      supabase.from('demat_accounts').select('*').order('created_at', { ascending: false }),
      supabase.from('profiles').select('*').eq('role', 'member'),
    ])
    const loadedAccounts = (accountsRes.data ?? []) as DematAccount[]
    const linkedIds = new Set(loadedAccounts.map((a) => a.linked_user_id).filter(Boolean))
    setAccounts(loadedAccounts)
    setUnlinkedMembers(((membersRes.data ?? []) as Profile[]).filter((p) => !linkedIds.has(p.id)))
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function linkMember(dematId: string, userId: string) {
    setLinking(dematId)
    const { error } = await supabase.from('demat_accounts').update({ linked_user_id: userId }).eq('id', dematId)
    setLinking(null)
    if (error) {
      alert(error.message)
      return
    }
    load()
  }

  async function fetchPan(id: string): Promise<string | null> {
    if (revealed[id]) return revealed[id]
    const { data, error } = await supabase.functions.invoke<{ pan: string }>('reveal-pan', {
      body: { demat_id: id },
    })
    if (error || !data) return null
    setRevealed((r) => ({ ...r, [id]: data.pan }))
    return data.pan
  }

  async function revealPan(id: string) {
    setRevealing(id)
    await fetchPan(id)
    setRevealing(null)
  }

  async function startEdit(a: DematAccount) {
    setRevealing(a.id)
    const pan = await fetchPan(a.id)
    setRevealing(null)
    if (!pan) {
      alert("Couldn't reveal PAN — can't edit without it.")
      return
    }
    setShowAddForm(false)
    setEditingAccount({
      id: a.id,
      holderName: a.holder_name,
      phoneDigits: a.phone_e164.replace(/^\+91/, ''),
      pan,
      dematAccountNo: a.dp_client_id ?? '',
      profitSharePercent: String(a.profit_share_percent),
    })
  }

  async function deleteAccount(id: string, name: string) {
    if (!window.confirm(`Delete ${name}? This is only possible if they have no applications or messages on record.`))
      return
    const { error } = await supabase.from('demat_accounts').delete().eq('id', id)
    if (error) {
      alert(
        error.code === '23503'
          ? `Can't delete ${name} — they have applications or messages on record. Delete those first.`
          : error.message,
      )
      return
    }
    load()
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
    setSelected((s) => (s.size === accounts.length ? new Set() : new Set(accounts.map((a) => a.id))))
  }

  async function bulkDelete() {
    if (selected.size === 0) return
    if (
      !window.confirm(
        `Delete ${selected.size} account(s)? This is only possible for accounts with no applications or messages on record.`,
      )
    )
      return
    const { error } = await supabase.from('demat_accounts').delete().in('id', Array.from(selected))
    if (error) {
      alert(
        error.code === '23503'
          ? "Can't delete — one or more selected accounts have applications or messages on record. Delete those first."
          : error.message,
      )
      return
    }
    setSelected(new Set())
    load()
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Demat accounts
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {accounts.length} registered ·{' '}
            <Link to="/bank-accounts" className="link-accent">
              Manage bank/UPI accounts →
            </Link>
          </p>
        </div>
        <button
          onClick={() => {
            setEditingAccount(null)
            setShowAddForm((s) => !s)
          }}
          className="btn-primary"
        >
          {showAddForm ? 'Cancel' : '+ Add account'}
        </button>
      </div>

      {showAddForm && (
        <AccountForm
          onCancel={() => setShowAddForm(false)}
          onDone={() => {
            setShowAddForm(false)
            load()
          }}
        />
      )}

      {editingAccount && (
        <AccountForm
          existing={editingAccount}
          onCancel={() => setEditingAccount(null)}
          onDone={() => {
            setEditingAccount(null)
            load()
          }}
        />
      )}

      {loading ? (
        <InlineSpinner />
      ) : (
        <>
          {accounts.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--ink-secondary)' }}>
                <input
                  type="checkbox"
                  checked={selected.size > 0 && selected.size === accounts.length}
                  ref={(el) => {
                    if (el) el.indeterminate = selected.size > 0 && selected.size < accounts.length
                  }}
                  onChange={toggleSelectAll}
                />
                Select all
              </label>
              {selected.size > 0 && (
                <button
                  onClick={bulkDelete}
                  className="text-sm font-medium hover:underline"
                  style={{ color: 'var(--critical)' }}
                >
                  Delete {selected.size} selected
                </button>
              )}
            </div>
          )}
          <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
          {accounts.map((a) => (
            <div key={a.id} className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0"
                    checked={selected.has(a.id)}
                    onChange={() => toggleSelected(a.id)}
                    aria-label={`Select ${a.holder_name}`}
                  />
                  <div className="min-w-0">
                  <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {a.holder_name}
                  </p>
                  <p className="break-words text-sm" style={{ color: 'var(--ink-muted)' }}>
                    {a.phone_e164}
                    {a.dp_client_id && ` · Demat a/c ${a.dp_client_id}`} ·{' '}
                    <span className="font-mono" style={{ color: 'var(--ink-secondary)' }}>
                      {revealed[a.id] ?? a.pan_masked}
                    </span>
                    {' · '}
                    <span>Profit cut {a.profit_share_percent}%</span>
                    {!revealed[a.id] && (
                      <button
                        onClick={() => revealPan(a.id)}
                        disabled={revealing === a.id}
                        className="link-accent ml-2 text-sm font-medium disabled:opacity-50"
                      >
                        {revealing === a.id ? 'Revealing…' : 'Reveal PAN'}
                      </button>
                    )}
                  </p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  {!a.linked_user_id && (
                    <>
                      <span className="badge badge-neutral">not linked</span>
                      {isAdmin && unlinkedMembers.length > 0 && (
                        <select
                          value=""
                          disabled={linking === a.id}
                          onChange={(e) => e.target.value && linkMember(a.id, e.target.value)}
                          className="input w-auto py-1 text-xs"
                          aria-label={`Link ${a.holder_name} to a registered member`}
                        >
                          <option value="">
                            {linking === a.id ? 'Linking…' : 'Link to registered member…'}
                          </option>
                          {unlinkedMembers.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.full_name}
                            </option>
                          ))}
                        </select>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => startEdit(a)}
                    disabled={revealing === a.id}
                    className="link-accent text-xs font-medium disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteAccount(a.id, a.holder_name)}
                    className="text-xs font-medium hover:underline"
                    style={{ color: 'var(--critical)' }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
              No accounts yet.
            </p>
          )}
          </div>
        </>
      )}
    </div>
  )
}

const PHONE_RE = /^[0-9]{10}$/
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

function AccountForm({
  existing,
  onCancel,
  onDone,
}: {
  existing?: EditingAccount
  onCancel: () => void
  onDone: () => void
}) {
  const [holderName, setHolderName] = useState(existing?.holderName ?? '')
  const [phoneDigits, setPhoneDigits] = useState(existing?.phoneDigits ?? '')
  const [pan, setPan] = useState(existing?.pan ?? '')
  const [dematAccountNo, setDematAccountNo] = useState(existing?.dematAccountNo ?? '')
  const [profitSharePercent, setProfitSharePercent] = useState(existing?.profitSharePercent ?? '25')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const phoneValid = PHONE_RE.test(phoneDigits)
  const panValid = PAN_RE.test(pan)
  const profitShareNum = Number(profitSharePercent)
  const profitShareValid = profitSharePercent !== '' && !Number.isNaN(profitShareNum) && profitShareNum >= 0 && profitShareNum <= 100

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (!phoneValid) {
      setError('Phone number must be exactly 10 digits.')
      return
    }
    if (!panValid) {
      setError('PAN must be in the format ABCPD1234E (5 letters, 4 digits, 1 letter).')
      return
    }
    if (!profitShareValid) {
      setError('Profit sharing cut must be a number between 0 and 100.')
      return
    }

    setSubmitting(true)
    const { data, error: fnError } = await supabase.functions.invoke<{ id?: string; error?: string }>(
      'add-demat',
      {
        body: {
          demat_id: existing?.id,
          holder_name: holderName,
          phone_digits: phoneDigits,
          pan,
          dp_client_id: dematAccountNo || null,
          profit_share_percent: profitShareNum,
        },
      },
    )

    setSubmitting(false)
    if (fnError || !data?.id) {
      setError(await describeFunctionError(fnError, data))
      return
    }
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
      <Field label="Holder name">
        <input required value={holderName} onChange={(e) => setHolderName(e.target.value)} className="input" />
      </Field>
      <Field label="Phone number" hint="10 digits, no country code">
        <div className="flex items-center gap-2">
          <span
            className="rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-muted)' }}
          >
            +91
          </span>
          <input
            required
            inputMode="numeric"
            maxLength={10}
            value={phoneDigits}
            onChange={(e) => setPhoneDigits(e.target.value.replace(/[^0-9]/g, ''))}
            className="input"
            placeholder="9876543210"
          />
        </div>
        {phoneDigits.length > 0 && !phoneValid && (
          <p className="mt-1 text-xs" style={{ color: 'var(--critical)' }}>
            Must be exactly 10 digits.
          </p>
        )}
      </Field>
      <Field label="PAN" hint="5 letters, 4 digits, 1 letter">
        <input
          required
          maxLength={10}
          value={pan}
          onChange={(e) => setPan(e.target.value.toUpperCase())}
          className="input font-mono"
          placeholder="ABCPD1234E"
        />
        {pan.length > 0 && !panValid && (
          <p className="mt-1 text-xs" style={{ color: 'var(--critical)' }}>
            e.g. ABCPD1234E — 5 letters, 4 digits, 1 letter.
          </p>
        )}
      </Field>
      <Field label="Demat account no.">
        <input
          required
          value={dematAccountNo}
          onChange={(e) => setDematAccountNo(e.target.value)}
          className="input"
        />
      </Field>
      <Field label="Profit sharing cut" hint="default 25%">
        <div className="flex items-center gap-2">
          <input
            required
            type="number"
            min={0}
            max={100}
            step="0.01"
            value={profitSharePercent}
            onChange={(e) => setProfitSharePercent(e.target.value)}
            className="input"
          />
          <span style={{ color: 'var(--ink-muted)' }}>%</span>
        </div>
        {profitSharePercent.length > 0 && !profitShareValid && (
          <p className="mt-1 text-xs" style={{ color: 'var(--critical)' }}>
            Must be a number between 0 and 100.
          </p>
        )}
      </Field>

      {error && <p className="badge badge-critical col-span-1 w-fit sm:col-span-2">{error}</p>}

      <div className="col-span-1 flex gap-2 sm:col-span-2">
        <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2.5">
          {submitting ? 'Saving…' : existing ? 'Save changes' : 'Save account'}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
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
