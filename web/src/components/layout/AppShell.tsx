import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  ArchiveIcon,
  BellIcon,
  ChecklistIcon,
  FileIcon,
  GearIcon,
  HomeIcon,
  LawIcon,
  GraphIcon,
  PersonIcon,
  PeopleIcon,
  ScreenFullIcon,
  ScreenNormalIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  SignOutIcon,
  ThreeBarsIcon,
} from '@primer/octicons-react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { ToastHost } from '../ToastHost'
import { OnboardingTour } from '../OnboardingTour'

const links = [
  { to: '/', label: 'Dashboard', icon: HomeIcon },
  { to: '/accounts', label: 'Accounts', icon: PeopleIcon },
  { to: '/bank-accounts', label: 'Bank / UPI accounts', icon: LawIcon },
  { to: '/ipos', label: 'IPOs', icon: GraphIcon },
  { to: '/applications', label: 'Applications', icon: FileIcon },
  { to: '/allotment', label: 'Allotment board', icon: ChecklistIcon },
  { to: '/notifications', label: 'Notifications', icon: BellIcon },
  { to: '/archives', label: 'Archives', icon: ArchiveIcon },
  { to: '/settings', label: 'Settings', icon: GearIcon },
  { to: '/profile', label: 'Profile', icon: PersonIcon },
]

export function AppShell() {
  const { profile, signOut } = useAuth()
  const [navOpen, setNavOpen] = useState(false)
  const [tourActive, setTourActive] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  // Desktop-only icon-rail mode — independent of navOpen, which is the
  // mobile off-canvas drawer's open/closed state. Persisted so a reload
  // doesn't snap it back open.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sidebarCollapsed') === '1'
    } catch {
      return false
    }
  })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    try {
      localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0')
    } catch {
      // localStorage can throw in private-browsing/blocked-storage modes —
      // collapse still works for the session, it just won't persist.
    }
  }, [collapsed])

  // Tracks fullscreen state from any source (the button below, browser
  // chrome, or the user hitting Esc) so the icon never gets out of sync
  // with reality.
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(document.fullscreenElement != null)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      document.documentElement.requestFullscreen().catch(() => {
        // Fullscreen can be denied (no user gesture, iframe without the
        // allowfullscreen attribute, etc.) — nothing to recover, the
        // button just stays in its current state.
      })
    }
  }

  // "f" toggles fullscreen (enter, or exit if already in it) — Esc exiting
  // is already native browser behavior once in fullscreen, no code needed
  // for that half. Ignored while modified (avoid stealing Ctrl/Cmd+F find)
  // or while typing in a field.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'f' || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      e.preventDefault()
      toggleFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Pending demat/bank link requests — RLS already scopes this correctly
  // per viewer (admin sees every pending request, a member sees only their
  // own), so the same query works unmodified for both; no client-side role
  // branching needed. Drives both the Dashboard nav badge and the status
  // pill below.
  useEffect(() => {
    async function loadPendingCount() {
      const [demat, bank] = await Promise.all([
        supabase.from('demat_link_requests').select('id', { count: 'exact', head: true }).eq('status', 'PENDING'),
        supabase.from('bank_link_requests').select('id', { count: 'exact', head: true }).eq('status', 'PENDING'),
      ])
      setPendingCount((demat.count ?? 0) + (bank.count ?? 0))
    }
    loadPendingCount()
    const channel = supabase
      .channel('appshell-pending-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'demat_link_requests' }, loadPendingCount)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bank_link_requests' }, loadPendingCount)
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const initials = (profile?.full_name ?? '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  // No background here on purpose — body already paints var(--page)
  // globally (index.css), and a solid bg on this positioned wrapper would
  // paint over the z-index:-1 blobs below (negative z-index only escapes
  // sibling content, not its own containing block's background).
  return (
    <div className="relative min-h-screen md:flex">
      {/* Ambient background blobs (Dashboard.dc.html reference) — fixed to
          the viewport (see .bg-blob), so no overflow-hidden wrapper is
          needed here — that was clipping .bg-blob's overflow when it was
          position:absolute, which also broke the sidebar's position:sticky
          (an overflow:hidden ancestor breaks sticky descendants). No-op
          (transparent) in light mode via --blob-1/2/3. */}
      <div
        aria-hidden
        className="bg-blob"
        style={{ top: -120, left: 220, width: 420, height: 420, background: 'var(--blob-1)' }}
      />
      <div
        aria-hidden
        className="bg-blob"
        style={{ top: 280, right: 60, width: 380, height: 380, background: 'var(--blob-2)', animationDirection: 'reverse' }}
      />
      <div
        aria-hidden
        className="bg-blob"
        style={{ bottom: -100, left: '40%', width: 340, height: 340, background: 'var(--blob-3)' }}
      />

      <ToastHost />
      <OnboardingTour onRequireNavOpen={setNavOpen} onActiveChange={setTourActive} />

      {/* Mobile-only slim top bar — the sidebar below is off-canvas until opened */}
      <div
        className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 md:hidden"
        style={{ background: 'var(--header-bg)', borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--hover-surface)]"
          style={{ color: 'var(--header-fg-muted)' }}
        >
          <ThreeBarsIcon size={16} />
        </button>
      </div>

      {/* Backdrop for mobile drawer */}
      {navOpen && (
        <div
          onClick={() => !tourActive && setNavOpen(false)}
          className="fixed inset-0 z-40 animate-page-in md:hidden"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        />
      )}

      <aside
        className={`glass-header fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 flex-col transition-[transform,width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:sticky md:top-0 md:z-auto md:h-screen md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        } ${collapsed ? 'md:w-16' : 'md:w-64'}`}
        style={{
          borderRight: '1px solid var(--border)',
          // Was var(--shadow-floating-large), a token that was never
          // actually defined anywhere — silently rendered no shadow at all.
          boxShadow: navOpen ? 'var(--shadow-lg)' : undefined,
        }}
      >
        {/* Identity block is now the whole card — a Link to /profile, not
            just an avatar+name display. A dot badge (reusing pendingCount,
            the same demat/bank link-request count the Dashboard nav badge
            already tracks — it's exactly what Profile's own "pending
            review"/"my requests" sections surface) marks that something on
            Profile is worth a look. Collapsed (64px rail) can't lay the
            32px avatar and text out side by side (only ~52px of content
            width after margin/padding) — flex-col there instead. */}
        <Link
          to="/profile"
          onClick={() => setNavOpen(false)}
          className={`mt-4 mb-1.5 flex items-center gap-2.5 rounded-md py-2 transition-colors hover:bg-[var(--accent-tint)] ${
            collapsed ? 'mx-1.5 flex-col gap-1.5 px-1.5' : 'mx-3 px-2'
          }`}
          style={{ background: 'var(--hover-surface)' }}
          title={collapsed ? (profile?.full_name ?? undefined) : undefined}
        >
          <div className="relative shrink-0">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold"
              style={{ background: 'var(--accent)', color: '#ffffff' }}
            >
              {initials}
            </div>
            {pendingCount > 0 && (
              <span
                aria-label={`${pendingCount} pending on Profile`}
                className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full"
                style={{ background: 'var(--critical)', border: '2px solid var(--surface)' }}
              />
            )}
          </div>
          <div className={`sidebar-fade min-w-0 flex-1 ${collapsed ? 'sidebar-fade-collapsed' : ''}`}>
            <p className="truncate text-xs font-semibold" style={{ color: 'var(--header-fg)' }}>
              {profile?.full_name ?? '…'}
            </p>
            <p className="truncate text-[11px] capitalize" style={{ color: 'var(--header-fg-muted)' }}>
              {profile?.role ?? '…'}
            </p>
          </div>
        </Link>

        {/* Collapse + fullscreen toggles, combined into one row below the
            identity card — previously the collapse toggle lived inside that
            card (now a plain Link, with no room for a third interactive
            element) and fullscreen had its own separate row underneath.
            Icon-only pair now, no text labels — self-explanatory via title
            tooltips, and it keeps this row compact in both collapsed and
            expanded widths without any special-casing. */}
        <div
          className={`mb-1.5 flex items-center gap-1 rounded-md py-1.5 transition-[margin,padding] duration-300 ${
            collapsed ? 'mx-1.5 justify-center px-1.5' : 'mx-3 justify-start px-2'
          }`}
        >
          {/* Desktop only — mobile uses the off-canvas drawer instead of a
              collapse rail, so this control has no meaning there. */}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md md:flex"
            style={{ color: 'var(--header-fg-muted)' }}
          >
            {collapsed ? <SidebarExpandIcon size={14} /> : <SidebarCollapseIcon size={14} />}
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
            style={{ color: 'var(--header-fg-muted)' }}
          >
            {isFullscreen ? <ScreenNormalIcon size={14} /> : <ScreenFullIcon size={14} />}
          </button>
        </div>

        {/* Nav — plain NavLink rows, not @primer/react's NavList/ActionList
            (removed app-wide: pulled in the whole primer/react +
            styled-components runtime for components this app already had
            hand-rolled Tailwind equivalents for everywhere else). A side
            effect worth noting: NavList.Item sized to its own content by
            default, which is what forced the w-full hack below it used to
            need (the label collapsing to ~0 width shrank the item's actual
            click target down to just the icon column) — a plain block-level
            NavLink doesn't have that problem to begin with, so that
            workaround is gone too, not just relocated. */}
        <nav className="sidebar-scroll flex-1 overflow-y-auto px-2 pt-1">
          {links.map((l) => {
            const Icon = l.icon
            const isActive = l.to === '/' ? location.pathname === '/' : location.pathname.startsWith(l.to)
            // Only the Dashboard link has a natural home for this count
            // today — pending link requests surface and get approved
            // there, not on a dedicated page of their own.
            const count = l.to === '/' ? pendingCount : 0
            return (
              <NavLink
                key={l.to}
                to={l.to}
                data-tour={l.to}
                onClick={() => setNavOpen(false)}
                aria-current={isActive ? 'page' : undefined}
                title={collapsed ? l.label : undefined}
                className="mb-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--hover-surface)]"
                style={{
                  color: isActive ? 'var(--accent)' : 'var(--header-fg)',
                  // Left corners square, not the uniform 6px the inactive
                  // items use — with a rounded corner AND a 3px left
                  // border together, the border follows the corner's arc
                  // instead of sitting flush, so it read as a short,
                  // detached vertical line/shadow floating next to the
                  // rounded box rather than a clean accent bar flush
                  // against it.
                  borderRadius: isActive ? '0 6px 6px 0' : 6,
                  // Left accent bar + background tint on the active item,
                  // not just a text-color swap (KOVAREX retheme).
                  borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                  background: isActive ? 'var(--accent-tint)' : undefined,
                }}
              >
                <Icon size={16} fill={isActive ? 'var(--accent)' : 'var(--header-fg-muted)'} />
                {/* Always rendered (not conditionally mounted) — fades and
                    narrows via .sidebar-fade in step with the sidebar's
                    own width transition instead of instantly vanishing
                    (md:hidden) while the rail was still visibly wide. */}
                <span
                  className={`sidebar-fade min-w-0 flex-1 truncate ${collapsed ? 'sidebar-fade-collapsed' : ''}`}
                  style={{ color: isActive ? 'var(--accent)' : 'var(--header-fg)' }}
                >
                  {l.label}
                </span>
                {count > 0 && (
                  <span
                    // Two real, caught-via-verification overflow bugs here,
                    // not one: (1) min-width always wins over max-width in
                    // CSS, so sidebar-fade-collapsed's max-width:0 couldn't
                    // shrink this badge past its own min-w-[1.25rem] (20px);
                    // (2) even after removing that, padding never shrinks
                    // below its specified value just because max-width caps
                    // the box smaller — px-1.5 py-0.5 (12px horizontal)
                    // alone still overflowed the collapsed rail on its own.
                    // Both min-width AND padding need to be conditional on
                    // collapsed, not just max-width.
                    className={`sidebar-fade inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${collapsed ? 'sidebar-fade-collapsed px-0 py-0' : 'min-w-[1.25rem] px-1.5 py-0.5'}`}
                    style={{ background: 'var(--warning-tint)', color: 'var(--warning-text)' }}
                  >
                    {count}
                  </span>
                )}
              </NavLink>
            )
          })}
        </nav>

        {/* Logout + version */}
        <div className="px-2 pt-1 pb-3">
          <button
            type="button"
            onClick={signOut}
            title={collapsed ? 'Sign out' : undefined}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--hover-surface)]"
            style={{ color: 'var(--header-fg)' }}
          >
            <SignOutIcon size={16} fill="var(--header-fg-muted)" />
            <span className={`sidebar-fade ${collapsed ? 'sidebar-fade-collapsed' : ''}`} style={{ color: 'var(--header-fg)' }}>
              Sign out
            </span>
          </button>
          <p
            className={`sidebar-fade px-3 pt-2 text-[11px] ${collapsed ? 'sidebar-fade-collapsed' : ''}`}
            style={{ color: 'var(--header-fg-muted)' }}
          >
            v{__APP_VERSION__}
          </p>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-x-hidden">
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 md:px-8 md:py-8">
          <div key={location.pathname} className="animate-page-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
