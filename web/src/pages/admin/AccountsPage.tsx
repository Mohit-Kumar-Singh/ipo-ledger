import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, CreditCard, Hash, Phone } from 'lucide-react'
import { describeFunctionError, supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { clearDraft, loadDraft, saveDraft } from '../../lib/formDraft'
import { CopyButton } from '../../components/CopyButton'
import type { DematAccount, Profile } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

type EditingAccount = {
  id: string
  holderName: string
  phoneDigits: string
  pan: string
  dematAccountNo: string
  profitSharePercent: string
  isActive: boolean
}

// Alphabetical, case-insensitive, regardless of when an account was added —
// a standing rule, not a one-off sort.
function byHolderName(a: DematAccount, b: DematAccount): number {
  return a.holder_name.localeCompare(b.holder_name, undefined, { sensitivity: 'base' })
}

const ADD_DRAFT_KEY = 'draft:add-demat'

// If Chrome discards/reloads this tab mid-entry, showAddForm resets to false
// like every other piece of React state — so the "+ Add account" form itself
// (not just its field values, which formDraft.ts already restores once it's
// open) needs to come back open on its own, otherwise the saved draft is
// invisible until the user thinks to reopen it manually.
function hasAddDraft(): boolean {
  const draft = loadDraft<EditingAccount>(ADD_DRAFT_KEY)
  if (!draft) return false
  return Boolean(draft.holderName || draft.phoneDigits || draft.pan || draft.dematAccountNo)
}

export function AccountsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [accounts, setAccounts] = useState<DematAccount[]>([])
  const [unlinkedMembers, setUnlinkedMembers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(hasAddDraft)
  const [editingAccount, setEditingAccount] = useState<EditingAccount | null>(null)
  const [revealing, setRevealing] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [linking, setLinking] = useState<string | null>(null)
  const [togglingActive, setTogglingActive] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  async function load() {
    setLoading(true)
    const [accountsRes, membersRes] = await Promise.all([
      supabase.from('demat_accounts').select('*').order('holder_name', { ascending: true }),
      supabase.from('profiles').select('*').eq('role', 'member'),
    ])
    const loadedAccounts = ((accountsRes.data ?? []) as DematAccount[]).sort(byHolderName)
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
      isActive: a.is_active,
    })
  }

  async function toggleActive(a: DematAccount) {
    setTogglingActive(a.id)
    const { error } = await supabase.functions.invoke('add-demat', {
      body: { demat_id: a.id, is_active: !a.is_active },
    })
    setTogglingActive(null)
    if (error) {
      alert('Could not update — please try again.')
      return
    }
    load()
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

  const activeAccounts = accounts.filter((a) => a.is_active)
  const inactiveAccounts = accounts.filter((a) => !a.is_active)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Demat accounts
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {accounts.length} registered, A–Z ·{' '}
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
      ) : accounts.length === 0 ? (
        <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No accounts yet.
        </p>
      ) : (
        <>
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

          <AccountSection
            title="Active accounts"
            subtitle="Used regularly — these are what you'll usually apply IPOs from."
            accounts={activeAccounts}
            emptyLabel="No active accounts."
            isAdmin={isAdmin}
            unlinkedMembers={unlinkedMembers}
            linking={linking}
            revealing={revealing}
            revealed={revealed}
            togglingActive={togglingActive}
            selected={selected}
            onToggleSelected={toggleSelected}
            onLinkMember={linkMember}
            onRevealPan={revealPan}
            onToggleActive={toggleActive}
            onEdit={startEdit}
            onDelete={deleteAccount}
          />

          <AccountSection
            title="Inactive accounts"
            subtitle="Shared with other people / not used regularly. Reactivate to apply from these."
            accounts={inactiveAccounts}
            emptyLabel="No inactive accounts."
            collapsedByDefault
            isAdmin={isAdmin}
            unlinkedMembers={unlinkedMembers}
            linking={linking}
            revealing={revealing}
            revealed={revealed}
            togglingActive={togglingActive}
            selected={selected}
            onToggleSelected={toggleSelected}
            onLinkMember={linkMember}
            onRevealPan={revealPan}
            onToggleActive={toggleActive}
            onEdit={startEdit}
            onDelete={deleteAccount}
          />
        </>
      )}
    </div>
  )
}

function AccountSection({
  title,
  subtitle,
  accounts,
  emptyLabel,
  collapsedByDefault,
  isAdmin,
  unlinkedMembers,
  linking,
  revealing,
  revealed,
  togglingActive,
  selected,
  onToggleSelected,
  onLinkMember,
  onRevealPan,
  onToggleActive,
  onEdit,
  onDelete,
}: {
  title: string
  subtitle: string
  accounts: DematAccount[]
  emptyLabel: string
  collapsedByDefault?: boolean
  isAdmin: boolean
  unlinkedMembers: Profile[]
  linking: string | null
  revealing: string | null
  revealed: Record<string, string>
  togglingActive: string | null
  selected: Set<string>
  onToggleSelected: (id: string) => void
  onLinkMember: (dematId: string, userId: string) => void
  onRevealPan: (id: string) => void
  onToggleActive: (a: DematAccount) => void
  onEdit: (a: DematAccount) => void
  onDelete: (id: string, name: string) => void
}) {
  const [open, setOpen] = useState(!collapsedByDefault || accounts.length > 0)

  if (accounts.length === 0 && collapsedByDefault) return null

  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            {title} <span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>({accounts.length})</span>
          </h2>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            {subtitle}
          </p>
        </div>
        <ChevronDown
          size={16}
          className="shrink-0 transition-transform duration-200 ease-out"
          style={{ color: 'var(--ink-muted)', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>

      {open &&
        (accounts.length === 0 ? (
          <p className="card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            {emptyLabel}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {accounts.map((a) => {
              const pan = revealed[a.id] ?? a.pan_masked
              return (
                <div key={a.id} className="card stagger-item p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <input
                        type="checkbox"
                        className="shrink-0"
                        checked={selected.has(a.id)}
                        onChange={() => onToggleSelected(a.id)}
                        aria-label={`Select ${a.holder_name}`}
                      />
                      <div
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                        style={{ background: 'linear-gradient(135deg, var(--violet), var(--accent))', color: 'white' }}
                      >
                        {a.holder_name[0]?.toUpperCase()}
                      </div>
                      <p className="min-w-0 truncate text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
                        {a.holder_name}
                      </p>
                      <CopyButton value={a.holder_name} label="name" />
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {!a.linked_user_id && <span className="badge badge-neutral">not linked</span>}
                      <Switch
                        checked={a.is_active}
                        disabled={togglingActive === a.id}
                        onChange={() => onToggleActive(a)}
                        label={`Mark ${a.holder_name} ${a.is_active ? 'inactive' : 'active'}`}
                      />
                    </div>
                  </div>

                  <div
                    className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-3 text-sm"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <span className="flex items-center gap-1.5" style={{ color: 'var(--ink-secondary)' }}>
                      <CreditCard size={14} className="shrink-0" style={{ color: 'var(--ink-muted)' }} />
                      <span className="font-mono">{pan}</span>
                      {revealed[a.id] ? (
                        <CopyButton value={pan} label="PAN" />
                      ) : (
                        <button
                          onClick={() => onRevealPan(a.id)}
                          disabled={revealing === a.id}
                          className="link-accent text-xs font-medium disabled:opacity-50"
                        >
                          {revealing === a.id ? 'Revealing…' : 'Reveal'}
                        </button>
                      )}
                    </span>
                    {a.dp_client_id && (
                      <span className="flex items-center gap-1.5" style={{ color: 'var(--ink-secondary)' }}>
                        <Hash size={14} className="shrink-0" style={{ color: 'var(--ink-muted)' }} />
                        Client ID: <span style={{ color: 'var(--ink-primary)' }}>{a.dp_client_id}</span>
                        <CopyButton value={a.dp_client_id} label="Client ID" />
                      </span>
                    )}
                    <span className="flex items-center gap-1.5" style={{ color: 'var(--ink-secondary)' }}>
                      <Phone size={14} className="shrink-0" style={{ color: 'var(--ink-muted)' }} />
                      {a.phone_e164}
                      <CopyButton value={a.phone_e164} label="phone number" />
                    </span>
                    <span style={{ color: 'var(--ink-muted)' }}>Profit cut {a.profit_share_percent}%</span>
                  </div>

                  {!a.linked_user_id && isAdmin && unlinkedMembers.length > 0 && (
                    <div className="mt-3">
                      <select
                        value=""
                        disabled={linking === a.id}
                        onChange={(e) => e.target.value && onLinkMember(a.id, e.target.value)}
                        className="input w-auto py-1 text-xs"
                        aria-label={`Link ${a.holder_name} to a registered member`}
                      >
                        <option value="">{linking === a.id ? 'Linking…' : 'Link to member…'}</option>
                        {unlinkedMembers.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.full_name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="mt-3 flex gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
                    <button
                      onClick={() => onEdit(a)}
                      disabled={revealing === a.id}
                      className="btn-warning flex-1 disabled:opacity-50"
                    >
                      Edit
                    </button>
                    <button onClick={() => onDelete(a.id, a.holder_name)} className="btn-danger flex-1">
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
    </section>
  )
}

function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ease-out disabled:opacity-50"
      style={{ background: checked ? 'var(--btn-primary-bg)' : 'var(--border-strong)' }}
    >
      <span
        className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform duration-200 ease-out"
        style={{ transform: checked ? 'translateX(18px)' : 'translateX(2px)', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}
      />
    </button>
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
  const draftKey = existing ? `draft:edit-demat:${existing.id}` : ADD_DRAFT_KEY
  const draft = loadDraft<EditingAccount>(draftKey)

  const [holderName, setHolderName] = useState(draft?.holderName ?? existing?.holderName ?? '')
  const [phoneDigits, setPhoneDigits] = useState(draft?.phoneDigits ?? existing?.phoneDigits ?? '')
  const [pan, setPan] = useState(draft?.pan ?? existing?.pan ?? '')
  const [dematAccountNo, setDematAccountNo] = useState(draft?.dematAccountNo ?? existing?.dematAccountNo ?? '')
  const [profitSharePercent, setProfitSharePercent] = useState(
    draft?.profitSharePercent ?? existing?.profitSharePercent ?? '25',
  )
  const [isActive, setIsActive] = useState(draft?.isActive ?? existing?.isActive ?? true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Keeps the in-progress form on localStorage so it survives Chrome
  // discarding/reloading a backgrounded tab — restored above on mount,
  // cleared on cancel or successful save.
  useEffect(() => {
    saveDraft(draftKey, { holderName, phoneDigits, pan, dematAccountNo, profitSharePercent, isActive })
  }, [draftKey, holderName, phoneDigits, pan, dematAccountNo, profitSharePercent, isActive])

  function handleCancel() {
    clearDraft(draftKey)
    onCancel()
  }

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
          is_active: isActive,
        },
      },
    )

    setSubmitting(false)
    if (fnError || !data?.id) {
      setError(await describeFunctionError(fnError, data))
      return
    }
    clearDraft(draftKey)
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card animate-page-in grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
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
      <Field label="Status">
        <div className="flex items-center gap-2 py-2 text-sm" style={{ color: 'var(--ink-primary)' }}>
          <Switch checked={isActive} onChange={() => setIsActive((v) => !v)} label="Active account" />
          {isActive ? 'Active — used regularly' : 'Inactive — not used regularly'}
        </div>
      </Field>

      {error && <p className="badge badge-critical col-span-1 w-fit sm:col-span-2">{error}</p>}

      <div className="col-span-1 flex gap-2 sm:col-span-2">
        <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2.5">
          {submitting ? 'Saving…' : existing ? 'Save changes' : 'Save account'}
        </button>
        <button type="button" onClick={handleCancel} className="btn-secondary">
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
