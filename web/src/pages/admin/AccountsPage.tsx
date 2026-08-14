import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LinkIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from '@primer/octicons-react'
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
  linkedUserId: string | null
  // Broker-app login details — plaintext, optional, shown directly (no
  // reveal step, unlike PAN).
  applicationName: string
  loginEmail: string
  loginPassword: string
  appPassword: string
  tPin: string
  loggedInNotes: string
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
  const [linkableMembers, setLinkableMembers] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(hasAddDraft)
  const [editingAccount, setEditingAccount] = useState<EditingAccount | null>(null)
  const [revealing, setRevealing] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [linking, setLinking] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setLoadError(null)
    const [accountsRes, membersRes] = await Promise.all([
      supabase.from('demat_accounts').select('*').order('holder_name', { ascending: true }),
      supabase.from('profiles').select('*').eq('role', 'member'),
    ])
    if (accountsRes.error || membersRes.error) {
      setLoadError((accountsRes.error ?? membersRes.error)?.message ?? 'Failed to load accounts.')
      setLoading(false)
      return
    }
    const loadedAccounts = ((accountsRes.data ?? []) as DematAccount[]).sort(byHolderName)
    setAccounts(loadedAccounts)
    // Every member is a valid link target here, even one already linked to
    // another account — a person can hold more than one demat account, and
    // excluding them made the dropdown empty for their other account(s).
    setLinkableMembers((membersRes.data ?? []) as Profile[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // pan_hash is a one-way hash (safe to compare client-side without
  // decrypting) — surfaces accounts that already collide on PAN *before*
  // someone hits the opaque "duplicate key" error trying to edit one of them.
  const duplicatePanIds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of accounts) counts.set(a.pan_hash, (counts.get(a.pan_hash) ?? 0) + 1)
    return new Set(accounts.filter((a) => (counts.get(a.pan_hash) ?? 0) > 1).map((a) => a.id))
  }, [accounts])

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

  async function unlinkMember(dematId: string) {
    setLinking(dematId)
    const { error } = await supabase.from('demat_accounts').update({ linked_user_id: null }).eq('id', dematId)
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
      linkedUserId: a.linked_user_id,
      applicationName: a.application_name ?? '',
      loginEmail: a.login_email ?? '',
      loginPassword: a.login_password ?? '',
      appPassword: a.app_password ?? '',
      tPin: a.t_pin ?? '',
      loggedInNotes: a.logged_in_notes ?? '',
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

  // Client-side only — the whole list is already fetched, and it's small
  // enough (a household's worth of accounts, not thousands) that filtering
  // in memory is simpler than a server round-trip per keystroke.
  const [search, setSearch] = useState('')
  const searchedAccounts = search.trim()
    ? accounts.filter((a) => a.holder_name.toLowerCase().includes(search.trim().toLowerCase()))
    : accounts
  const activeAccounts = searchedAccounts.filter((a) => a.is_active)
  const inactiveAccounts = searchedAccounts.filter((a) => !a.is_active)

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

      {accounts.length > 0 && (
        <div className="relative">
          <SearchIcon size={15} fill="var(--ink-muted)" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by holder name…"
            className="input pl-9"
          />
        </div>
      )}

      {duplicatePanIds.size > 0 && (
        <div className="card flex items-start gap-3 p-4" style={{ borderColor: 'var(--critical)' }}>
          <AlertIcon size={18} className="mt-0.5 shrink-0" fill="var(--critical)" />
          <p className="text-sm" style={{ color: 'var(--ink-primary)' }}>
            {duplicatePanIds.size} accounts share a PAN with another account (marked below) — that's why saving an
            edit on one of them can fail with "already exists." Delete or fix the duplicate to resolve it.
          </p>
        </div>
      )}

      {loadError && (
        <div className="card flex items-start gap-3 p-4" style={{ borderColor: 'var(--critical)' }}>
          <AlertIcon size={18} className="mt-0.5 shrink-0" fill="var(--critical)" />
          <p className="text-sm" style={{ color: 'var(--ink-primary)' }}>
            Couldn't load accounts: {loadError}
          </p>
        </div>
      )}

      {loading ? (
        <InlineSpinner />
      ) : loadError ? null : accounts.length === 0 ? (
        <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No accounts yet.
        </p>
      ) : (
        <>
          <AccountSection
            title="Active accounts"
            subtitle="Used regularly — these are what you'll usually apply IPOs from."
            accounts={activeAccounts}
            emptyLabel="No active accounts."
            isAdmin={isAdmin}
            linkableMembers={linkableMembers}
            linking={linking}
            revealing={revealing}
            revealed={revealed}
            duplicatePanIds={duplicatePanIds}
            editingAccount={editingAccount}
            onLinkMember={linkMember}
            onUnlinkMember={unlinkMember}
            onRevealPan={revealPan}
            onEdit={startEdit}
            onCancelEdit={() => setEditingAccount(null)}
            onSavedEdit={() => {
              setEditingAccount(null)
              load()
            }}
            onDelete={deleteAccount}
          />

          <AccountSection
            title="Inactive accounts"
            subtitle="Shared with other people / not used regularly. Reactivate to apply from these."
            accounts={inactiveAccounts}
            emptyLabel="No inactive accounts."
            collapsedByDefault
            isAdmin={isAdmin}
            linkableMembers={linkableMembers}
            linking={linking}
            revealing={revealing}
            revealed={revealed}
            duplicatePanIds={duplicatePanIds}
            editingAccount={editingAccount}
            onLinkMember={linkMember}
            onUnlinkMember={unlinkMember}
            onRevealPan={revealPan}
            onEdit={startEdit}
            onCancelEdit={() => setEditingAccount(null)}
            onSavedEdit={() => {
              setEditingAccount(null)
              load()
            }}
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
  linkableMembers,
  linking,
  revealing,
  revealed,
  duplicatePanIds,
  editingAccount,
  onLinkMember,
  onUnlinkMember,
  onRevealPan,
  onEdit,
  onCancelEdit,
  onSavedEdit,
  onDelete,
}: {
  title: string
  subtitle: string
  accounts: DematAccount[]
  emptyLabel: string
  collapsedByDefault?: boolean
  isAdmin: boolean
  linkableMembers: Profile[]
  linking: string | null
  revealing: string | null
  revealed: Record<string, string>
  duplicatePanIds: Set<string>
  editingAccount: EditingAccount | null
  onLinkMember: (dematId: string, userId: string) => void
  onUnlinkMember: (dematId: string) => void
  onRevealPan: (id: string) => void
  onEdit: (a: DematAccount) => void
  onCancelEdit: () => void
  onSavedEdit: () => void
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
        <span
          className="shrink-0 transition-transform duration-200 ease-out"
          style={{ display: 'inline-flex', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <ChevronDownIcon size={16} fill="var(--ink-muted)" />
        </span>
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

              if (editingAccount?.id === a.id) {
                return (
                  <AccountForm
                    key={a.id}
                    existing={editingAccount}
                    isAdmin={isAdmin}
                    linkableMembers={linkableMembers}
                    linking={linking === a.id}
                    onLinkMember={onLinkMember}
                    onUnlinkMember={onUnlinkMember}
                    onCancel={onCancelEdit}
                    onDone={onSavedEdit}
                  />
                )
              }

              const hasCredentials =
                a.application_name || a.login_email || a.login_password || a.app_password || a.t_pin || a.logged_in_notes
              const hasShareableCredentials = a.login_email || a.login_password || a.app_password || a.t_pin

              return (
                <div key={a.id} className="card stagger-item p-3 sm:p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                        style={{ background: 'linear-gradient(135deg, var(--violet), var(--accent))', color: 'white' }}
                      >
                        {a.holder_name[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                          <p className="min-w-0 truncate text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
                            {a.holder_name}
                          </p>
                          {a.linked_user_id && (
                            <LinkIcon size={12} className="shrink-0" fill="var(--good)" aria-label="Linked to a member" />
                          )}
                          {duplicatePanIds.has(a.id) && (
                            <span className="badge badge-critical shrink-0">duplicate PAN</span>
                          )}
                        </div>
                        {/* PAN + profit cut on one compact line instead of
                            two — this card was creeping taller every time a
                            new field got added; folding these two together
                            (they're both short) claws back a full row. */}
                        <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--ink-secondary)' }}>
                          <span className="font-mono">{pan}</span>
                          {revealed[a.id] ? (
                            <CopyButton value={pan} label="PAN" />
                          ) : (
                            <button
                              onClick={() => onRevealPan(a.id)}
                              disabled={revealing === a.id}
                              className="link-accent font-medium disabled:opacity-50"
                            >
                              {revealing === a.id ? 'Revealing…' : 'Reveal'}
                            </button>
                          )}
                          <span style={{ color: 'var(--ink-muted)' }}>· {a.profit_share_percent}% cut</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {hasShareableCredentials && <ShareDetailsButton account={a} />}
                      <button
                        onClick={() => onEdit(a)}
                        disabled={revealing === a.id}
                        aria-label={`Edit ${a.holder_name}`}
                        className="rounded-lg p-1.5 transition-colors hover:bg-[var(--hover-surface)] disabled:opacity-50"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        <PencilIcon size={14} />
                      </button>
                      <button
                        onClick={() => onDelete(a.id, a.holder_name)}
                        aria-label={`Delete ${a.holder_name}`}
                        className="rounded-lg p-1.5 transition-colors hover:bg-[var(--critical-tint)]"
                        style={{ color: 'var(--critical)' }}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Demat account no. and phone number no longer show on the
                      card itself — both are still fully editable in edit
                      mode (nothing is lost), they were just taking up card
                      space that isn't needed for a quick glance. A compact
                      label:value grid instead of flex-wrap — flex-wrap's
                      gap-x-6 reserved a fixed gutter after every item
                      regardless of how short it was, so 3-4 fields routinely
                      wrapped to 2-3 rows; the grid packs 2-3 per row based on
                      actual available width. */}
                  {hasCredentials && (
                    <div
                      className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t pt-2 text-xs sm:grid-cols-3"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      {a.application_name && (
                        <CredentialField label="App" value={a.application_name} />
                      )}
                      {a.login_email && <CredentialField label="Login ID" value={a.login_email} copyLabel="login ID" />}
                      {a.login_password && (
                        <CredentialField label="Password" value={a.login_password} mono copyLabel="login password" />
                      )}
                      {a.app_password && (
                        <CredentialField label="App password" value={a.app_password} mono copyLabel="app password" />
                      )}
                      {a.t_pin && <CredentialField label="T-PIN" value={a.t_pin} mono copyLabel="T-PIN" />}
                      {a.logged_in_notes && <CredentialField label="Logged in" value={a.logged_in_notes} />}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
    </section>
  )
}

// Copies every broker-app credential field for one account as a single
// plain-text block, ready to paste straight into WhatsApp/SMS to hand the
// login over to the account holder — the per-field CopyButtons above cover
// "I need just this one field," this covers "share the whole login."
function ShareDetailsButton({ account }: { account: DematAccount }) {
  const [copied, setCopied] = useState(false)

  function buildText(): string {
    const lines = [`Account: ${account.holder_name}`]
    if (account.application_name) lines.push(`App: ${account.application_name}`)
    if (account.login_email) lines.push(`Login ID: ${account.login_email}`)
    if (account.login_password) lines.push(`Password: ${account.login_password}`)
    if (account.app_password) lines.push(`App password: ${account.app_password}`)
    if (account.t_pin) lines.push(`T-PIN: ${account.t_pin}`)
    return lines.join('\n')
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(buildText())
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  // Icon-only, matching the Edit/Delete buttons it sits next to — a
  // full-text "Copy login details" button was one of the things making
  // every card taller than it needed to be.
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${account.holder_name}'s login details`}
      title={copied ? 'Copied!' : 'Copy login details'}
      className="rounded-lg p-1.5 transition-colors hover:bg-[var(--hover-surface)]"
      style={{ color: copied ? 'var(--good)' : 'var(--ink-muted)' }}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  )
}

// Compact label:value cell for the credentials grid — a shared shape so
// each of the six possible fields renders identically instead of six
// slightly-different inline blocks.
function CredentialField({
  label,
  value,
  mono,
  copyLabel,
}: {
  label: string
  value: string
  mono?: boolean
  copyLabel?: string
}) {
  return (
    <div className="min-w-0">
      <p className="truncate" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </p>
      <div className="flex items-center gap-1">
        <p className={`min-w-0 truncate ${mono ? 'font-mono' : ''}`} style={{ color: 'var(--ink-primary)' }}>
          {value}
        </p>
        {copyLabel && <CopyButton value={value} label={copyLabel} />}
      </div>
    </div>
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
  isAdmin,
  linkableMembers,
  linking,
  onLinkMember,
  onUnlinkMember,
  onCancel,
  onDone,
}: {
  existing?: EditingAccount
  isAdmin?: boolean
  linkableMembers?: Profile[]
  linking?: boolean
  onLinkMember?: (dematId: string, userId: string) => void
  onUnlinkMember?: (dematId: string) => void
  onCancel: () => void
  onDone: () => void
}) {
  const draftKey = existing ? `draft:edit-demat:${existing.id}` : ADD_DRAFT_KEY
  // A stale draft must never silently win over the real fetched value for an
  // EXISTING account — that's exactly what caused an admin to see "Active"
  // in the edit form for an account that was actually inactive (someone
  // opened this edit form once, didn't explicitly Cancel/Save — a tab
  // close, browser back, or crash skips handleCancel's clearDraft — and a
  // stale localStorage draft outlived the account's real state changing
  // elsewhere). The draft-recovery feature only makes sense for the ADD
  // flow, where there's no "real" value to contradict yet.
  const draft = existing ? null : loadDraft<EditingAccount>(draftKey)

  const [holderName, setHolderName] = useState(draft?.holderName ?? existing?.holderName ?? '')
  const [phoneDigits, setPhoneDigits] = useState(draft?.phoneDigits ?? existing?.phoneDigits ?? '')
  const [pan, setPan] = useState(draft?.pan ?? existing?.pan ?? '')
  const [dematAccountNo, setDematAccountNo] = useState(draft?.dematAccountNo ?? existing?.dematAccountNo ?? '')
  const [profitSharePercent, setProfitSharePercent] = useState(
    draft?.profitSharePercent ?? existing?.profitSharePercent ?? '25',
  )
  const [isActive, setIsActive] = useState(draft?.isActive ?? existing?.isActive ?? true)
  const [applicationName, setApplicationName] = useState(draft?.applicationName ?? existing?.applicationName ?? '')
  const [loginEmail, setLoginEmail] = useState(draft?.loginEmail ?? existing?.loginEmail ?? '')
  const [loginPassword, setLoginPassword] = useState(draft?.loginPassword ?? existing?.loginPassword ?? '')
  const [appPassword, setAppPassword] = useState(draft?.appPassword ?? existing?.appPassword ?? '')
  const [tPin, setTPin] = useState(draft?.tPin ?? existing?.tPin ?? '')
  const [loggedInNotes, setLoggedInNotes] = useState(draft?.loggedInNotes ?? existing?.loggedInNotes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Keeps the in-progress form on localStorage so it survives Chrome
  // discarding/reloading a backgrounded tab — restored above on mount,
  // cleared on cancel or successful save.
  useEffect(() => {
    saveDraft(draftKey, {
      holderName,
      phoneDigits,
      pan,
      dematAccountNo,
      profitSharePercent,
      isActive,
      applicationName,
      loginEmail,
      loginPassword,
      appPassword,
      tPin,
      loggedInNotes,
    })
  }, [
    draftKey,
    holderName,
    phoneDigits,
    pan,
    dematAccountNo,
    profitSharePercent,
    isActive,
    applicationName,
    loginEmail,
    loginPassword,
    appPassword,
    tPin,
    loggedInNotes,
  ])

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
          application_name: applicationName || null,
          login_email: loginEmail || null,
          login_password: loginPassword || null,
          app_password: appPassword || null,
          t_pin: tPin || null,
          logged_in_notes: loggedInNotes || null,
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
    <form onSubmit={handleSubmit} className="card animate-page-in grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
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
            step="1"
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

      {/* Denser 3-across grid + a bordered box, distinct from the core
          fields above it — this is 6 optional fields that would otherwise
          double the form's height at 2-per-row; keeping them visually
          grouped also makes clear they're all "broker-app login" info, not
          part of the required account record above. */}
      <div
        className="col-span-1 grid grid-cols-2 gap-3 rounded-lg border p-3 sm:col-span-2 sm:grid-cols-3"
        style={{ borderColor: 'var(--border)' }}
      >
        <p className="col-span-2 text-xs font-medium sm:col-span-3" style={{ color: 'var(--ink-muted)' }}>
          Broker-app login (all optional)
        </p>
        <Field label="Application name" hint="which app">
          <input value={applicationName} onChange={(e) => setApplicationName(e.target.value)} className="input" />
        </Field>
        <Field label="Email ID / User ID">
          <input value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} className="input" />
        </Field>
        <Field label="Login password">
          <input value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} className="input" />
        </Field>
        <Field label="App password">
          <input value={appPassword} onChange={(e) => setAppPassword(e.target.value)} className="input" />
        </Field>
        <Field label="T-PIN">
          <input value={tPin} onChange={(e) => setTPin(e.target.value)} className="input" />
        </Field>
        <Field label="Logged in earlier" hint="notes">
          <input
            value={loggedInNotes}
            onChange={(e) => setLoggedInNotes(e.target.value)}
            className="input"
            placeholder="e.g. already logged in on Dad's phone"
          />
        </Field>
      </div>
      {existing && existing.linkedUserId && isAdmin && (
        <Field label="Linked member">
          <div className="flex items-center gap-2 py-2">
            <span className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--ink-primary)' }}>
              <LinkIcon size={14} fill="var(--good)" />
              {linkableMembers?.find((m) => m.id === existing.linkedUserId)?.full_name ?? existing.linkedUserId}
            </span>
            <button
              type="button"
              disabled={linking}
              onClick={() => onUnlinkMember?.(existing.id)}
              className="link-accent text-xs font-medium disabled:opacity-50"
              style={{ color: 'var(--critical)' }}
            >
              {linking ? 'Unlinking…' : 'Unlink'}
            </button>
          </div>
        </Field>
      )}

      {existing && !existing.linkedUserId && isAdmin && linkableMembers && linkableMembers.length > 0 && (
        <Field label="Link to member">
          <select
            value=""
            disabled={linking}
            onChange={(e) => e.target.value && onLinkMember?.(existing.id, e.target.value)}
            className="input"
            aria-label={`Link ${existing.holderName} to a registered member`}
          >
            <option value="">{linking ? 'Linking…' : 'Select a member…'}</option>
            {linkableMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name}
              </option>
            ))}
          </select>
        </Field>
      )}

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
