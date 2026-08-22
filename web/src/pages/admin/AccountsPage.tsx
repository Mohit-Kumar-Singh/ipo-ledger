import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  CommentDiscussionIcon,
  CopyIcon,
  LinkIcon,
  PencilIcon,
  SearchIcon,
  TrashIcon,
} from '@primer/octicons-react'
import { describeFunctionError, supabase } from '../../lib/supabase'
import { useDematAccounts, queryKeys } from '../../lib/queries'
import { useAuth } from '../../contexts/AuthContext'
import { showToast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirmDialog'
import { clearDraft, loadDraft, saveDraft } from '../../lib/formDraft'
import { sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { CopyButton } from '../../components/CopyButton'
import { Combobox } from '../../components/Combobox'
import type { DematAccount, Profile } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'
import { PLATFORM_OPTIONS, platformLabel, type DematPlatform } from '../../lib/platforms'

type EditingAccount = {
  id: string
  holderName: string
  phoneDigits: string
  pan: string
  dematAccountNo: string
  profitSharePercent: string
  isActive: boolean
  linkedUserId: string | null
  // Constrained trading platform (migration 0074) — replaces the old free-
  // text "Application name" as the "which app" field. '' = not set.
  platform: DematPlatform | ''
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
  const queryClient = useQueryClient()
  // Shared cache (lib/queries.ts) — demat_accounts is also read in full by
  // Applications/SharedAccounts/BankAccounts/Dashboard; this page's own
  // mutations (link/unlink member, edit, delete, add) write demat_accounts
  // rows, so they invalidate the shared cache rather than only updating
  // page-local state, keeping every other page's copy in sync too.
  const accountsQuery = useDematAccounts()
  const accounts = useMemo(() => [...(accountsQuery.data ?? [])].sort(byHolderName), [accountsQuery.data])
  const [linkableMembers, setLinkableMembers] = useState<Profile[]>([])
  const loading = accountsQuery.isPending
  const loadError = accountsQuery.error instanceof Error ? accountsQuery.error.message : null
  const [showAddForm, setShowAddForm] = useState(hasAddDraft)
  const [editingAccount, setEditingAccount] = useState<EditingAccount | null>(null)
  const [revealing, setRevealing] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [linking, setLinking] = useState<string | null>(null)

  // Was a full Promise.all of both tables — now just invalidates the shared
  // demat_accounts cache (accountsQuery above re-renders from it automatically).
  async function load() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.dematAccounts })
  }

  // Members list is page-local and fetched once — no mutation on this page
  // can change who holds the 'member' role, so unlike accounts it never
  // needs to be part of load()'s refresh.
  useEffect(() => {
    // Every member is a valid link target here, even one already linked to
    // another account — a person can hold more than one demat account, and
    // excluding them made the dropdown empty for their other account(s).
    supabase
      .from('profiles')
      .select('*')
      .eq('role', 'member')
      .then(({ data }) => setLinkableMembers((data ?? []) as Profile[]))
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
      showToast(error.message, 'critical')
      return
    }
    load()
  }

  async function unlinkMember(dematId: string) {
    setLinking(dematId)
    const { error } = await supabase.from('demat_accounts').update({ linked_user_id: null }).eq('id', dematId)
    setLinking(null)
    if (error) {
      showToast(error.message, 'critical')
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
      showToast("Couldn't reveal PAN — can't edit without it.", 'critical')
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
      platform: a.platform ?? '',
      applicationName: a.application_name ?? '',
      loginEmail: a.login_email ?? '',
      loginPassword: a.login_password ?? '',
      appPassword: a.app_password ?? '',
      tPin: a.t_pin ?? '',
      loggedInNotes: a.logged_in_notes ?? '',
    })
  }

  async function deleteAccount(id: string, name: string) {
    if (
      !(await confirmDialog(`Delete ${name}? This is only possible if they have no applications or messages on record.`, {
        tone: 'critical',
        confirmLabel: 'Delete',
      }))
    )
      return
    const { error } = await supabase.from('demat_accounts').delete().eq('id', id)
    if (error) {
      showToast(
        error.code === '23503'
          ? `Can't delete ${name} — they have applications or messages on record. Delete those first.`
          : error.message,
        'critical',
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
            onGetPan={fetchPan}
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
            onGetPan={fetchPan}
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
  onGetPan,
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
  // Returns the decrypted PAN (reveal-pan Edge Function, which also writes a
  // pan_access_log row) — distinct from onRevealPan, which only updates the
  // card's own displayed value and returns nothing.
  onGetPan: (id: string) => Promise<string | null>
  onEdit: (a: DematAccount) => void
  onCancelEdit: () => void
  onSavedEdit: () => void
  onDelete: (id: string, name: string) => void
}) {
  const [open, setOpen] = useState(!collapsedByDefault || accounts.length > 0)
  // Per-card expansion for the PAN/credentials panel. A Set rather than a
  // single id — these are independent disclosures, so opening one shouldn't
  // collapse another the user already opened to read off.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
              const isExpanded = expandedIds.has(a.id)

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
                    onDelete={onDelete}
                  />
                )
              }

              const hasCredentials =
                a.platform || a.application_name || a.login_email || a.login_password || a.app_password || a.t_pin || a.logged_in_notes

              return (
                <div key={a.id} className="card stagger-item p-3 sm:p-3.5">
                  {/* flex-nowrap, not flex-wrap — the previous version
                      allowed the identity block and button group to break
                      onto two lines once the buttons grew wide enough
                      (the touch-target fix below). flex-1 min-w-0 on the
                      identity block below makes IT the one that shrinks/
                      truncates under pressure, so name + cut + every
                      button always share one row regardless of screen
                      width, down to a phone-narrow viewport. */}
                  <div className="flex flex-nowrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
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
                        {/* Just the cut now — PAN moved into the expandable
                            details below. It's the one number worth seeing on
                            every card at a glance; the PAN was both the
                            longest thing on this line and the one that needed
                            a Reveal round trip to be useful at all. */}
                        <div className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                          {a.profit_share_percent}% cut
                        </div>
                      </div>
                    </div>
                    {/* Dialed back from an earlier, wider pass (gap-2.5 +
                        p-2 everywhere) — that fixed Copy/WhatsApp getting
                        mis-tapped together but made the row wide enough to
                        wrap onto its own line below the name on narrower
                        screens. Back to p-1.5 (original size); the actual
                        fix for the mis-tap stays as extra separation
                        specifically at the two group boundaries (mr-1 on
                        Copy, ml-1 on Edit) rather than a bigger gap and
                        bigger buttons everywhere. */}
                    <div className="flex shrink-0 items-center gap-1">
                      <ShareDetailsButton account={a} onGetPan={onGetPan} />
                      {/* ml-1 on top of the row's own gap-1 — a bit more
                          separation between the share pair and the manage
                          pair than between buttons within a pair. */}
                      <button
                        onClick={() => onEdit(a)}
                        disabled={revealing === a.id}
                        aria-label={`Edit ${a.holder_name}`}
                        className="ml-1 rounded-lg p-1.5 transition-colors hover:bg-[var(--hover-surface)] disabled:opacity-50"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        <PencilIcon size={14} />
                      </button>
                      {/* Where Delete used to sit. Delete moved into the edit
                          form — it's destructive and irreversible, so it
                          shouldn't be one stray tap away from Edit on a
                          crowded row. */}
                      <button
                        onClick={() => toggleExpanded(a.id)}
                        aria-label={`${isExpanded ? 'Hide' : 'Show'} details for ${a.holder_name}`}
                        aria-expanded={isExpanded}
                        title={isExpanded ? 'Hide details' : 'Show PAN and login details'}
                        className="rounded-lg p-1.5 transition-colors hover:bg-[var(--hover-surface)]"
                        style={{ color: 'var(--ink-muted)' }}
                      >
                        <span
                          className="inline-flex transition-transform duration-200"
                          style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                        >
                          <ChevronDownIcon size={16} />
                        </span>
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
                  {/* Collapsed by default now, behind the chevron above.
                      Everything sensitive or long-form lives here — PAN
                      (moved off the name line) plus the broker-app
                      credentials, which used to sit open on every card at
                      once. Rendered only while open rather than hidden with
                      CSS, so a collapsed card isn't quietly holding a
                      revealed PAN in the DOM. */}
                  {isExpanded && (
                    <div
                      className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t pt-2 text-xs sm:grid-cols-3"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      {/* PAN keeps its own reveal-then-copy treatment rather
                          than becoming a CredentialField — it's the one
                          value here that isn't already in plaintext on the
                          client (reveal-pan decrypts it server-side and
                          writes an access-log row). */}
                      <div className="col-span-2 sm:col-span-1">
                        <p style={{ color: 'var(--ink-muted)' }}>PAN</p>
                        <div className="flex items-center gap-1" style={{ color: 'var(--ink-secondary)' }}>
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
                        </div>
                      </div>
                      {a.platform ? (
                        <CredentialField label="Platform" value={platformLabel(a.platform)} />
                      ) : (
                        a.application_name && <CredentialField label="App" value={a.application_name} />
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
                      {!hasCredentials && (
                        <p className="col-span-2 sm:col-span-3" style={{ color: 'var(--ink-muted)' }}>
                          No login details saved — add them from Edit.
                        </p>
                      )}
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

// Builds the shareable text for one demat account, and offers it two ways:
// copy to clipboard, or send straight to the account holder's own WhatsApp
// (the same wa.me hand-off the Notifications page uses for its sends, via
// sendCustomWhatsapp — this time with the account's own phone_e164, which
// opens a chat with THEM directly rather than the "share with" contact
// picker an empty phone falls back to).
//
// Contents are deliberately scoped: holder name, PAN, demat (DP client)
// number, and the broker-app login fields — NOT the "Logged in" free-text
// note (already logged in somewhere isn't something worth relaying) or
// profit_share_percent/phone_e164 (the cut is internal accounting that
// means nothing to whoever receives this, and the phone number is usually
// the recipient's own).
//
// PAN is fetched through onGetPan rather than read off the card's revealed
// state, so it's the real value rather than the masked one whether or not
// "Reveal" was pressed first — that call decrypts server-side and writes a
// pan_access_log row, which is the correct audit trail for putting a PAN on
// the clipboard or into a chat.
function ShareDetailsButton({
  account,
  onGetPan,
}: {
  account: DematAccount
  onGetPan: (id: string) => Promise<string | null>
}) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<'copy' | 'whatsapp' | null>(null)

  async function buildText(): Promise<string> {
    const pan = await onGetPan(account.id)
    const lines = [`Name: ${account.holder_name}`]
    // Falls back to the masked value rather than omitting the line entirely
    // if the reveal call fails — an obviously-masked PAN is clearer than a
    // silently missing field.
    lines.push(`PAN: ${pan ?? account.pan_masked}`)
    if (account.dp_client_id) lines.push(`Demat no: ${account.dp_client_id}`)
    if (account.platform) lines.push(`Platform: ${platformLabel(account.platform)}`)
    else if (account.application_name) lines.push(`App: ${account.application_name}`)
    if (account.login_email) lines.push(`Login ID: ${account.login_email}`)
    if (account.login_password) lines.push(`Password: ${account.login_password}`)
    if (account.app_password) lines.push(`App password: ${account.app_password}`)
    if (account.t_pin) lines.push(`T-PIN: ${account.t_pin}`)
    return lines.join('\n')
  }

  async function handleCopy() {
    setBusy('copy')
    const text = await buildText()
    setBusy(null)
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  async function handleWhatsapp() {
    setBusy('whatsapp')
    const text = await buildText()
    setBusy(null)
    // The account holder's own number — opens a chat with THEM directly,
    // not a generic "share with" picker (previously an empty phone,
    // which fell back to WhatsApp's own contact picker). These details are
    // about them, so their own chat is the right default target.
    sendCustomWhatsapp(account.phone_e164, text)
  }

  // Same size as the rest of the row (p-1.5, 14px icons) — mr-1 between
  // Copy and WhatsApp on top of the row's own gap-1 is the actual fix for
  // the mis-tap report; bigger buttons everywhere was the previous
  // (over-corrected) attempt and made the row too wide to stay on one line
  // with the name and cut on narrower screens.
  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        disabled={busy !== null}
        aria-label={`Copy ${account.holder_name}'s details`}
        title={copied ? 'Copied!' : 'Copy the details'}
        className="mr-1 rounded-lg p-1.5 transition-colors hover:bg-[var(--hover-surface)] disabled:opacity-50"
        style={{ color: copied ? 'var(--good)' : 'var(--ink-muted)' }}
      >
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </button>
      <button
        type="button"
        onClick={handleWhatsapp}
        disabled={busy !== null}
        aria-label={`Share ${account.holder_name}'s details on WhatsApp`}
        title="Share on WhatsApp"
        className="rounded-lg p-1.5 transition-colors hover:bg-[var(--hover-surface)] disabled:opacity-50"
        style={{ color: 'var(--ink-muted)' }}
      >
        <CommentDiscussionIcon size={14} />
      </button>
    </>
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
  onDelete,
}: {
  existing?: EditingAccount
  isAdmin?: boolean
  linkableMembers?: Profile[]
  linking?: boolean
  onLinkMember?: (dematId: string, userId: string) => void
  onUnlinkMember?: (dematId: string) => void
  onCancel: () => void
  onDone: () => void
  // Absent when adding — there's nothing to delete yet.
  onDelete?: (id: string, name: string) => void
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
  const [platform, setPlatform] = useState<DematPlatform | ''>(draft?.platform ?? existing?.platform ?? '')
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
      platform,
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
    platform,
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
          platform: platform || null,
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
        <Field label="Platform" hint="which app">
          <Combobox
            options={PLATFORM_OPTIONS}
            value={platform}
            onChange={(v) => setPlatform(v as DematPlatform)}
            placeholder="Select platform…"
            aria-label="Trading platform"
          />
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
        {/* Moved here from the card's own action row, where it sat directly
            beside Edit. Still behind the same confirmDialog it always was —
            this only changes how far you have to go to reach it, not what it
            does. type="button" matters: inside a <form>, an unqualified
            button submits it. */}
        {existing && onDelete && (
          <button
            type="button"
            onClick={() => onDelete(existing.id, existing.holderName)}
            aria-label={`Delete ${existing.holderName}`}
            title={`Delete ${existing.holderName}`}
            className="rounded-lg p-2 transition-colors hover:bg-[var(--critical-tint)]"
            style={{ color: 'var(--critical)' }}
          >
            <TrashIcon size={16} />
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
