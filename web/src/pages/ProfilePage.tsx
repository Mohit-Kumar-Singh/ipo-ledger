import { useEffect, useState, type ComponentType } from 'react'
import { Link } from 'react-router-dom'
import {
  ChevronRightIcon,
  CreditCardIcon,
  LawIcon,
  LinkIcon,
  ArchiveIcon,
  SignOutIcon,
  DeviceMobileIcon,
  PeopleIcon,
  ShieldCheckIcon,
  PersonIcon,
} from '@primer/octicons-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { ThemeToggle } from '../components/ThemeToggle'
import { SharePortalButton } from '../components/SharePortalButton'
import { Logo } from '../components/Logo'
import { InfoTooltip } from '../components/HoverCard'
import { SellInstructionPdfsSection } from './admin/SellInstructionPdfs'
import { ArchivedApplicationsCard } from './admin/ArchivedApplicationsCard'

const PHONE_RE = /^[0-9]{10}$/

// Linked accounts / Accounts / PAN access log all used to be inline
// sections on this page (a plain list, or a collapsible accordion) — each
// is now its own full page instead, reached by tapping one of these, same
// treatment Payouts/Archives/etc. already get from the sidebar. Better fit
// for phone: no more ever-taller accordion stack, and each destination gets
// its own scroll/back-button instead of fighting for space inside Profile.
function NavCard({
  to,
  icon: Icon,
  iconColor,
  label,
}: {
  to: string
  icon: ComponentType<{ size?: number; fill?: string }>
  iconColor: string
  label: string
}) {
  return (
    <Link
      to={to}
      className="card animate-page-in flex items-center justify-between gap-2 p-4 transition-colors hover:bg-[var(--hover-surface)]"
    >
      <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
        <Icon size={16} fill={iconColor} />
        {label}
      </span>
      <ChevronRightIcon size={16} fill="var(--ink-muted)" />
    </Link>
  )
}

export function ProfilePage() {
  const { session, profile, refreshProfile, signOut } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [fullName, setFullName] = useState(profile?.full_name ?? '')
  const [phoneDigits, setPhoneDigits] = useState(profile?.phone_e164?.replace(/^\+91/, '') ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

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
  // from the Users page (web/src/pages/admin/UsersPage.tsx), no request/
  // approval round-trip. Linked accounts, Accounts, and the PAN access log
  // are now full pages of their own (see NavCard above) rather than inline
  // content on this one, so none of their fetch/mutate logic lives here
  // anymore either.

  const phoneValid = phoneDigits.length === 0 || PHONE_RE.test(phoneDigits)

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

      <NavCard to="/linked-accounts" icon={LinkIcon} iconColor="var(--good)" label="Linked accounts" />

      {/* More — groups the secondary/occasional destinations under one
          heading instead of four separate top-level cards. Accounts and
          PAN access log used to expand inline here; both are full pages
          now (NavCard, defined above) — same reasoning as Linked accounts. */}
      <div className="space-y-2">
        <p className="px-1 text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--ink-muted)' }}>
          More
        </p>
        <div className="space-y-2">
          <NavCard to="/accounts" icon={PeopleIcon} iconColor="var(--accent)" label="Accounts" />
          {isAdmin && <NavCard to="/pan-access-log" icon={ShieldCheckIcon} iconColor="var(--violet)" label="PAN access log" />}
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
