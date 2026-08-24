import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CreditCardIcon,
  LawIcon,
  ArchiveIcon,
  SignOutIcon,
  DeviceMobileIcon,
  PeopleIcon,
  ShieldCheckIcon,
  PersonIcon,
} from '@primer/octicons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { showToast } from '../lib/toast'
import { confirmDialog } from '../lib/confirmDialog'
import { ThemeToggle } from '../components/ThemeToggle'
import { SharePortalButton } from '../components/SharePortalButton'
import { Logo } from '../components/Logo'
import { InfoTooltip } from '../components/HoverCard'
import { AccountsPage } from './admin/AccountsPage'
import { SellInstructionPdfsSection } from './admin/SellInstructionPdfs'
import { ArchivedApplicationsCard } from './admin/ArchivedApplicationsCard'
import type { BankAccount, DematAccount } from '../types/database'

const PHONE_RE = /^[0-9]{10}$/

export function ProfilePage() {
  const { session, profile, refreshProfile, signOut } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [fullName, setFullName] = useState(profile?.full_name ?? '')
  const [phoneDigits, setPhoneDigits] = useState(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  const [unlinkingDematId, setUnlinkingDematId] = useState<string | null>(null)
  const [unlinkingBankId, setUnlinkingBankId] = useState<string | null>(null)

  // Which "Your details" row (if any) is inline-editable right now — name
  // and phone used to share one always-open form; each field is now its
  // own independent edit/save/cancel.
  const [editingField, setEditingField] = useState<'name' | 'phone' | null>(null)

  useEffect(() => {
    setFullName(profile?.full_name ?? '')
    setPhoneDigits(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  }, [profile?.full_name, profile?.phone_e164])

  // The self-service "search for your account, submit a link request, admin
  // approves" flow (plus the self-attested PAN it depended on) has been
  // removed — an admin now links demat/bank accounts to a person directly
  // from the new Users page (web/src/pages/admin/UsersPage.tsx), no request/
  // approval round-trip. This page keeps only the read-only "Linked
  // accounts" list below (still self-service to UNLINK — that's immediate,
  // no approval needed either way) and, for admins, the PAN access log
  // further down (an unrelated audit feature — admin reveals of the real
  // demat-held PAN, not this self-attestation).
  const queryClient = useQueryClient()

  interface LinkedAccountsData {
    linkedDemat: Pick<DematAccount, 'id' | 'holder_name'>[]
    linkedBank: Pick<BankAccount, 'id' | 'account_holder_name' | 'upi_id'>[]
  }
  const linkedAccountsQueryKey = ['my-linked-accounts', session?.user.id ?? null] as const
  const linkedAccountsQuery = useQuery<LinkedAccountsData>({
    queryKey: linkedAccountsQueryKey,
    queryFn: async () => {
      const [dematRes, bankRes] = await Promise.all([
        supabase.from('demat_accounts').select('id, holder_name').eq('linked_user_id', session!.user.id),
        supabase.from('bank_accounts').select('id, account_holder_name, upi_id').eq('linked_user_id', session!.user.id),
      ])
      return {
        linkedDemat: (dematRes.data ?? []) as Pick<DematAccount, 'id' | 'holder_name'>[],
        linkedBank: (bankRes.data ?? []) as Pick<BankAccount, 'id' | 'account_holder_name' | 'upi_id'>[],
      }
    },
    enabled: !!session,
  })
  const linkedDemat = linkedAccountsQuery.data?.linkedDemat ?? []
  const linkedBank = linkedAccountsQuery.data?.linkedBank ?? []
  function loadLinkedAccounts() {
    queryClient.invalidateQueries({ queryKey: linkedAccountsQueryKey })
  }

  const phoneValid = phoneDigits.length === 0 || PHONE_RE.test(phoneDigits)

  async function unlinkDemat(id: string) {
    if (!(await confirmDialog('Unlink this account? An admin can re-link it later from the Users page.'))) return
    setUnlinkingDematId(id)
    const { error } = await supabase.rpc('unlink_demat_account', { p_demat_id: id })
    setUnlinkingDematId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    loadLinkedAccounts()
  }

  async function unlinkBank(id: string) {
    if (!(await confirmDialog('Unlink this bank/UPI account? An admin can re-link it later from the Users page.'))) return
    setUnlinkingBankId(id)
    const { error } = await supabase.rpc('unlink_bank_account', { p_bank_account_id: id })
    setUnlinkingBankId(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    loadLinkedAccounts()
  }

  // Shared by saveName/savePhone below — same update_own_profile RPC the
  // old combined form used (line ~276 originally), just called from two
  // independent save actions instead of one. Whichever field ISN'T being
  // saved right now is passed through unchanged (fullName/phoneDigits both
  // already mirror the persisted profile value except while their own row
  // is actively being edited — see the sync effect above and
  // cancelFieldEdit below, which resets both on cancel).
  async function updateProfile(nextName: string, nextPhoneDigits: string) {
    setSubmitting(true)
    const { error } = await supabase.rpc('update_own_profile', {
      p_full_name: nextName,
      p_phone_e164: nextPhoneDigits ? `+91${nextPhoneDigits}` : null,
    })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return false
    }
    await refreshProfile()
    return true
  }

  function startEditName() {
    setFullName(profile?.full_name ?? '')
    setError(null)
    setEditingField('name')
  }
  function startEditPhone() {
    setPhoneDigits(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
    setError(null)
    setEditingField('phone')
  }
  function cancelFieldEdit() {
    setFullName(profile?.full_name ?? '')
    setPhoneDigits(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
    setError(null)
    setEditingField(null)
  }
  async function saveName() {
    const trimmed = fullName.trim()
    if (!trimmed) {
      setError('Name cannot be empty.')
      return
    }
    const ok = await updateProfile(trimmed, profile?.phone_e164?.replace(/^\+91/, '') ?? '')
    if (ok) {
      setEditingField(null)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2000)
    }
  }
  async function savePhone() {
    if (!phoneValid) {
      setError('Phone number must be exactly 10 digits, or left blank.')
      return
    }
    const ok = await updateProfile(profile?.full_name ?? fullName, phoneDigits)
    if (ok) {
      setEditingField(null)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2000)
    }
  }

  // Merges demat + bank into one list — same unification pattern the old
  // admin pending-review list used to use.
  const combinedLinked = [
    ...linkedDemat.map((d) => ({
      id: d.id,
      kind: 'demat' as const,
      name: d.holder_name,
      onUnlink: () => unlinkDemat(d.id),
      unlinking: unlinkingDematId === d.id,
    })),
    ...linkedBank.map((b) => ({
      id: b.id,
      kind: 'bank' as const,
      name: b.account_holder_name ?? b.upi_id ?? 'Bank/UPI account',
      onUnlink: () => unlinkBank(b.id),
      unlinking: unlinkingBankId === b.id,
    })),
  ]

  return (
    <div className="mx-auto max-w-md space-y-4 lg:max-w-2xl">
      {/* Page header — the "Profile" title is replaced by the full logo
          (icon+wordmark, sized for phone) since this is the one page that's
          always the first thing tapped from the bottom tab bar; the theme
          toggle sits in this same row instead of its own dedicated card
          further down. items-start (was items-center) now that the left
          side is two lines (logo + version) instead of one, so the right
          side's icon buttons stay pinned to the top rather than centering
          against the taller stack. */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <Logo size={38} />
          {/* Moved here from the identity card below (by request) — right
              under the page's own title reads as "which build of the app,"
              not "part of my account details," which is what it actually
              is. lg:hidden — desktop sessions get this from the browser's
              own dev tools/URL if it's ever needed; the phone/tablet nav
              this page is the entry point for doesn't have that option. */}
          <p className="mt-0.5 text-[10px] lg:hidden" style={{ color: 'var(--ink-muted)' }}>
            v{__APP_VERSION__}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <SharePortalButton />
          <ThemeToggle iconOnly />
        </div>
      </div>

      {/* Identity card — avatar/name/role/email, then two independently
          inline-editable rows (name, phone). The self-attested PAN row that
          used to sit here is gone along with the self-service link-request
          flow it existed for — see the note above this component. */}
      <div className="card animate-page-in p-4">
        <div className="flex items-center gap-3 border-b pb-3" style={{ borderColor: 'var(--border)' }}>
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-semibold"
            style={{ background: 'linear-gradient(135deg, var(--violet), var(--accent))', color: 'white' }}
          >
            {(profile?.full_name || '?')
              .split(' ')
              .map((p) => p[0])
              .slice(0, 2)
              .join('')
              .toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate font-semibold" style={{ color: 'var(--ink-primary)' }}>
                {profile?.full_name || 'Your name'}
              </p>
              <span className="badge badge-info shrink-0" style={{ textTransform: 'capitalize' }}>
                {profile?.role ?? 'member'}
              </span>
            </div>
            <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
              {session?.user.email ?? session?.user.phone ?? '—'}
            </p>
          </div>
        </div>

        {justSaved && (
          <p className="pt-2 text-xs font-medium" style={{ color: 'var(--good)' }}>
            Saved ✓
          </p>
        )}

        {/* Full name row */}
        <div className="border-b" style={{ borderColor: 'var(--border)' }}>
          {editingField === 'name' ? (
            <div className="space-y-2 py-3">
              <label className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--ink-secondary)' }}>
                Full name
                <InfoTooltip text={`Shown in the sidebar, and used to sign messages — e.g. "— ${fullName.trim() || 'your name'}".`} />
              </label>
              <div className="flex items-center gap-2">
                <PersonIcon size={15} fill="var(--ink-muted)" />
                <input autoFocus required value={fullName} onChange={(e) => setFullName(e.target.value)} className="input" />
              </div>
              {error && (
                <p className="text-xs" style={{ color: 'var(--critical)' }}>
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={cancelFieldEdit} className="text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveName}
                  disabled={submitting}
                  className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50"
                >
                  {submitting ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={startEditName} className="flex w-full items-center gap-3 py-2.5 text-left">
              <div className="min-w-0 flex-1">
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Full name
                </p>
                <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {fullName || '—'}
                </p>
              </div>
              <ChevronRightIcon size={16} fill="var(--ink-muted)" />
            </button>
          )}
        </div>

        {/* Phone row */}
        <div className="border-b" style={{ borderColor: 'var(--border)' }}>
          {editingField === 'phone' ? (
            <div className="space-y-2 py-3">
              <label className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--ink-secondary)' }}>
                Phone number
                <InfoTooltip text="Optional, 10 digits." />
              </label>
              <div className="flex items-center gap-2">
                <DeviceMobileIcon size={15} fill="var(--ink-muted)" />
                <span
                  className="rounded-md border px-3 py-2 text-sm"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-muted)' }}
                >
                  +91
                </span>
                <input
                  autoFocus
                  inputMode="numeric"
                  maxLength={10}
                  value={phoneDigits}
                  onChange={(e) => setPhoneDigits(e.target.value.replace(/[^0-9]/g, ''))}
                  className="input"
                  placeholder="9876543210"
                />
              </div>
              {!phoneValid && (
                <p className="text-xs" style={{ color: 'var(--critical)' }}>
                  Must be exactly 10 digits.
                </p>
              )}
              {error && (
                <p className="text-xs" style={{ color: 'var(--critical)' }}>
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-3">
                <button type="button" onClick={cancelFieldEdit} className="text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={savePhone}
                  disabled={submitting}
                  className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50"
                >
                  {submitting ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={startEditPhone} className="flex w-full items-center gap-3 py-2.5 text-left">
              <div className="min-w-0 flex-1">
                <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Phone number
                </p>
                <p className="font-mono-ipo truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {phoneDigits ? `+91 ${phoneDigits}` : 'Not set'}
                </p>
              </div>
              <ChevronRightIcon size={16} fill="var(--ink-muted)" />
            </button>
          )}
        </div>

      </div>

      {/* Quick nav ("Explore") — destinations not on the bottom tab bar.
          IPOs dropped from this list — it's one tap away from the
          Dashboard already, no need to duplicate it here. Hidden at lg,
          where the sidebar already covers all of these. */}
      <div className="card animate-page-in overflow-hidden lg:hidden">
        <p className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
          Explore
        </p>
        <nav className="flex flex-col p-1.5 pt-0.5">
          {[
            { to: '/bank-accounts', label: 'Bank / UPI accounts', desc: 'Manage funding sources', icon: LawIcon, tone: 'good', show: true },
            { to: '/payouts', label: 'Payouts', desc: 'Funding & payout ledger', icon: CreditCardIcon, tone: 'violet', show: isAdmin },
            { to: '/archives', label: 'Archives', desc: 'Closed IPO history', icon: ArchiveIcon, tone: 'neutral', show: true },
          ]
            .filter((l) => l.show)
            .map((l) => {
              const Icon = l.icon
              return (
                <Link
                  key={l.to}
                  to={l.to}
                  className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--hover-surface)]"
                >
                  <span className={`icon-badge icon-badge-${l.tone} shrink-0`} style={{ width: '2.25rem', height: '2.25rem', borderRadius: '0.6rem' }}>
                    <Icon size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {l.label}
                    </span>
                    <span className="block truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {l.desc}
                    </span>
                  </span>
                  <ChevronRightIcon size={16} fill="var(--ink-muted)" />
                </Link>
              )
            })}
        </nav>
      </div>

      {/* Linked accounts */}
      <div className="card animate-page-in overflow-hidden">
        <h2 className="px-4 pt-3 pb-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          Linked accounts
        </h2>
        {combinedLinked.length === 0 ? (
          <p className="px-4 pb-3 text-sm" style={{ color: 'var(--ink-muted)' }}>
            No linked accounts yet.
          </p>
        ) : (
          combinedLinked.map((a) => (
            <div
              key={`${a.kind}-${a.id}`}
              className="flex items-center gap-3 border-t px-4 py-2.5"
              style={{ borderColor: 'var(--border)' }}
            >
              <span
                className={`icon-badge icon-badge-${a.kind === 'demat' ? 'info' : 'good'} shrink-0 text-xs font-bold`}
                style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem' }}
              >
                {a.kind === 'demat' ? 'D' : 'B'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {a.name}
                </p>
                <p className="text-xs capitalize" style={{ color: 'var(--ink-muted)' }}>
                  {a.kind === 'demat' ? 'demat' : 'bank / UPI'}
                </p>
              </div>
              <button
                onClick={a.onUnlink}
                disabled={a.unlinking}
                className="shrink-0 text-xs font-medium hover:underline disabled:opacity-50"
                style={{ color: 'var(--critical)' }}
              >
                {a.unlinking ? 'Unlinking…' : 'Unlink'}
              </button>
            </div>
          ))
        )}
        {isAdmin && (
          <Link
            to="/users"
            className="flex w-full items-center justify-center gap-1.5 border-t py-3 text-sm font-medium transition-colors hover:bg-[var(--hover-surface)]"
            style={{ borderColor: 'var(--border)', color: 'var(--accent)' }}
          >
            Manage on the Users page
          </Link>
        )}
      </div>

      {/* More — groups the secondary/occasional sections under one heading
          instead of four separate top-level cards; each keeps its own
          internal open/close state exactly as before. */}
      <div className="space-y-2">
        <p className="px-1 text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
          More
        </p>
        <div className="space-y-2">
          <AccountsSection />
          {isAdmin && <PanAccessLogSection />}
          {/* Sell-instruction PDFs + archived applications sit last — rarely-
              touched references, collapsed by default. Archived is self-fetching
              and renders nothing when there's no archived history. */}
          {isAdmin && <SellInstructionPdfsSection />}
          <ArchivedApplicationsCard />
        </div>
      </div>

      {/* -mb-1 (lg:mb-0, since AppShell's extra bottom clearance is phone/
          tablet-only — see its own comment on <main>'s paddingBottom) pulls
          this a little closer to the floating tab bar below it than the
          full ~4.5rem AppShell reserves site-wide so that fixed-position
          bar never covers a page's last content — that much clearance read
          as an oversized empty gap under this specific button.
          Previously -mb-4 (1rem), which this comment predicted might crowd
          the bar and turned out to actually do it — confirmed live, the
          button ended up partly under the bar rather than just closer to
          it. -mb-1 keeps some of the intentional pull-in without eating
          into AppShell's own clearance margin. Scoped to this page only,
          not AppShell itself, which every other page also depends on for
          the same protection. */}
      <button
        type="button"
        onClick={signOut}
        className="-mb-1 flex w-full items-center justify-center gap-2 rounded-2xl border py-3 text-sm font-semibold lg:mb-0"
        style={{ borderColor: 'var(--critical-tint)', background: 'var(--critical-tint)', color: 'var(--critical-text)' }}
      >
        <SignOutIcon size={16} fill="var(--critical-text)" />
        Sign out
      </button>
    </div>
  )
}

// Moved here from its own /accounts nav item — same AccountsPage component,
// same functionality (add/edit/link/reveal-PAN etc.), unchanged; just
// reached via a collapsible section at the bottom of Profile now instead of
// a dedicated sidebar entry. Collapsed by default since it's a secondary,
// occasional task from here, not the main reason someone's on this page.
function AccountsSection() {
  const [open, setOpen] = useState(false)
  return (
    <section className="card animate-page-in overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-[var(--hover-surface)]"
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <PeopleIcon size={16} fill="var(--accent)" />
          Accounts
        </span>
        <span
          className="inline-flex transition-transform duration-200"
          style={{ color: 'var(--ink-muted)', transform: open ? 'rotate(180deg)' : undefined }}
        >
          <ChevronDownIcon size={16} />
        </span>
      </button>
      {open && (
        <div className="border-t p-4" style={{ borderColor: 'var(--border)' }}>
          <AccountsPage />
        </div>
      )}
    </section>
  )
}

interface PanAccessLogRow {
  id: string
  demat_id: string
  accessed_by: string
  accessed_at: string
  is_self_reveal: boolean
  demat_accounts: { holder_name: string } | null
  profiles: { full_name: string } | null
}

// Local calendar day, not UTC — a reveal at 11pm IST is "today" to whoever's
// looking, even though its accessed_at timestamp may already have rolled
// into tomorrow in UTC.
function dayKeyFor(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Module-level, not recreated per render — `rows` feeds the hasInitializedOpenDays
// effect and the dayGroups useMemo below, so a fresh `?? []` allocated inline
// on every render (during the query's pending window) was an unstable
// dependency neither could actually memoize/guard against.
const EMPTY_PAN_LOG_ROWS: PanAccessLogRow[] = []

// Moved here from the deleted Settings page, unchanged — admin-only, still
// grouped by day and collapsible (most recent day open by default).
function PanAccessLogSection() {
  // Whole section collapsed by default now too — same card-with-chevron
  // shape as AccountsSection below, instead of always sitting open with
  // just its per-day groups collapsed underneath.
  const [open, setOpen] = useState(false)
  // Was a local useState + fetch-once-on-mount — one useQuery instead, so
  // revisiting Profile within staleTime doesn't refetch 200 audit-log rows
  // it already has. openDays (which day-group starts expanded) still needs
  // to react to the data actually arriving, so it's set from a separate
  // effect on rows rather than inline in the old .then() callback.
  const panAccessLogQuery = useQuery<PanAccessLogRow[]>({
    queryKey: ['pan-access-log'],
    queryFn: async () => {
      const { data } = await supabase
        .from('pan_access_log')
        .select('*, demat_accounts(holder_name), profiles(full_name)')
        .order('accessed_at', { ascending: false })
        .limit(200)
      return (data ?? []) as unknown as PanAccessLogRow[]
    },
  })
  const rows = panAccessLogQuery.data ?? EMPTY_PAN_LOG_ROWS
  const loading = panAccessLogQuery.isPending
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  // Guards against a background refetch (staleTime elapsing on a revisit)
  // silently collapsing whatever days the user had manually opened —
  // without this, a plain `useEffect(..., [rows])` re-derives openDays
  // from the freshest rows on EVERY data update, not just the first one.
  const hasInitializedOpenDays = useRef(false)

  useEffect(() => {
    if (hasInitializedOpenDays.current || rows.length === 0) return
    hasInitializedOpenDays.current = true
    setOpenDays(new Set([dayKeyFor(rows[0].accessed_at)]))
  }, [rows])

  const dayGroups = useMemo(() => {
    const groups = new Map<string, PanAccessLogRow[]>()
    for (const r of rows) {
      const key = dayKeyFor(r.accessed_at)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }
    return Array.from(groups.entries())
  }, [rows])

  function toggleDay(key: string) {
    setOpenDays((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    // overflow-hidden, not visible — the (i) tooltip on the heading below
    // is an absolutely-positioned popup that needs to float OVER this
    // card's own edge; overflow-hidden here clipped it down to an
    // unreadable sliver instead of letting it show. AccountsSection above
    // keeps overflow-hidden since it has no popup content to clip.
    <section className="card animate-page-in overflow-visible">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-[var(--hover-surface)]"
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <ShieldCheckIcon size={16} fill="var(--violet)" />
          PAN access log
          <InfoTooltip text={`Every time a PAN is decrypted (Accounts/Allotment board "Reveal PAN"), it's logged here — who, whose PAN, and when. Grouped by day, most recent first.`} />
        </span>
        <span
          className="inline-flex transition-transform duration-200"
          style={{ color: 'var(--ink-muted)', transform: open ? 'rotate(180deg)' : undefined }}
        >
          <ChevronDownIcon size={16} />
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t p-4" style={{ borderColor: 'var(--border)' }}>
          {loading ? (
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              Loading…
            </p>
          ) : dayGroups.length === 0 ? (
            <p className="p-4 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
              No PAN reveals logged yet.
            </p>
          ) : (
            <div className="space-y-2">
              {dayGroups.map(([day, dayRows]) => {
                const dayOpen = openDays.has(day)
                return (
                  <div key={day} className="rounded-md border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
                    <button
                      type="button"
                      onClick={() => toggleDay(day)}
                      className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium transition-colors hover:bg-[var(--hover-surface)]"
                      style={{ color: 'var(--ink-primary)' }}
                    >
                      <span>
                        {dayOpen ? '▾' : '▸'}{' '}
                        {new Date(dayRows[0].accessed_at).toLocaleDateString(undefined, {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                      <span className="badge badge-neutral shrink-0">{dayRows.length}</span>
                    </button>
                    {dayOpen && (
                      <table className="w-full text-sm">
                        <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
                          <tr>
                            <th className="px-4 py-2 font-medium">When</th>
                            <th className="px-4 py-2 font-medium">PAN of</th>
                            <th className="px-4 py-2 font-medium">Accessed by</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y border-t" style={{ borderColor: 'var(--border)' }}>
                          {dayRows.map((r) => (
                            <tr key={r.id} className="stagger-item transition-colors duration-150 hover:bg-[var(--hover-surface)]">
                              <td className="px-4 py-2" style={{ color: 'var(--ink-muted)' }}>
                                {new Date(r.accessed_at).toLocaleTimeString()}
                              </td>
                              <td className="px-4 py-2" style={{ color: 'var(--ink-primary)' }}>
                                {r.demat_accounts?.holder_name ?? '—'}
                              </td>
                              <td className="px-4 py-2">
                                {r.profiles?.full_name ?? '—'}
                                {r.is_self_reveal && (
                                  <span className="ml-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                    (self)
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
