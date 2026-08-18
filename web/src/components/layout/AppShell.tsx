import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArchiveIcon,
  BellIcon,
  ChecklistIcon,
  CreditCardIcon,
  FileIcon,
  HomeIcon,
  LawIcon,
  GraphIcon,
  ScreenFullIcon,
  ScreenNormalIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  SignOutIcon,
  SunIcon,
  MoonIcon,
} from '@primer/octicons-react'
import { useAuth } from '../../contexts/AuthContext'
import { useTheme } from '../../contexts/ThemeContext'
import { supabase } from '../../lib/supabase'
import { ToastHost } from '../ToastHost'
import { ConfirmDialogHost } from '../ConfirmDialogHost'
import { OnboardingTour } from '../OnboardingTour'
import { Logo, LogoMark } from '../Logo'
import { PullToRefresh } from '../PullToRefresh'

// No /profile entry — the identity card above this nav (see below) links
// there directly now, so a second nav item to the same place was redundant.
// No /accounts entry either — that page now lives as a collapsible section
// at the bottom of Profile instead of its own sidebar destination. No
// /settings entry — Settings only ever held Appearance (theme, now also on
// Profile plus the toggle below) and the PAN access log (moved to Profile,
// admin-only) — nothing left to have its own page for.
const links = [
  { to: '/', label: 'Dashboard', icon: HomeIcon },
  { to: '/bank-accounts', label: 'Bank / UPI accounts', icon: LawIcon },
  { to: '/ipos', label: 'IPOs', icon: GraphIcon },
  { to: '/applications', label: 'Applications', icon: FileIcon },
  { to: '/allotment', label: 'Allotment board', icon: ChecklistIcon },
  // Admin-only, filtered out below — Payouts covers funding-credit/payout
  // obligations across every account, the same admin-only scope Dashboard's
  // "Payouts pending" tile already has.
  { to: '/payouts', label: 'Payouts', icon: CreditCardIcon, adminOnly: true },
  { to: '/notifications', label: 'Notifications', icon: BellIcon },
  { to: '/archives', label: 'Archives', icon: ArchiveIcon },
]

// Phone/tablet bottom tab bar (Instagram/iOS style) — the four most-used
// destinations always one thumb-tap away, with a fifth "More" tab opening
// the full sidebar (the rest of the links + Profile, theme, sign-out). Short
// labels so five fit across a 375px screen. Desktop (lg+) keeps the sidebar.
const BOTTOM_TABS = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/allotment', label: 'Allotment', icon: ChecklistIcon },
  { to: '/applications', label: 'Apps', icon: FileIcon },
  { to: '/notifications', label: 'Alerts', icon: BellIcon },
]

export function AppShell() {
  const { profile, signOut } = useAuth()
  const { theme, toggleTheme } = useTheme()
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
    <div className="relative min-h-screen lg:flex">
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
      <ConfirmDialogHost />
      <OnboardingTour onRequireNavOpen={setNavOpen} onActiveChange={setTourActive} />

      {/* Backdrop for the "More" drawer (opened from the bottom tab bar).
          The old mobile top bar (hamburger + page title) is gone: navigation
          now lives in the bottom tab bar, and each page renders its own <h1>,
          so a top-bar title only duplicated it. */}
      {navOpen && (
        <div
          onClick={() => !tourActive && setNavOpen(false)}
          className="fixed inset-0 z-40 animate-page-in lg:hidden"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        />
      )}

      <aside
        className={`glass-header fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 flex-col transition-[transform,width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        } ${collapsed ? 'lg:w-16' : 'lg:w-64'}`}
        style={{
          borderRight: '1px solid var(--border)',
          // Same viewport-fit=cover safe-area handling as the top bar: keep the
          // drawer's own top (identity card) below the status bar and its
          // bottom (sign-out) above the home indicator on iPhone. Insets are 0
          // on desktop, so this is a no-op there.
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          // Was var(--shadow-floating-large), a token that was never
          // actually defined anywhere — silently rendered no shadow at all.
          boxShadow: navOpen ? 'var(--shadow-lg)' : undefined,
        }}
      >
        {/* The three toggle buttons render in two different arrangements
            depending on collapsed state (see below), so they're built once
            here and placed twice rather than duplicating each button's
            markup. Expanded row order is Theme, Fullscreen, Collapse — the
            collapsed stack keeps Collapse on top regardless, since that's
            the one control someone collapsed the rail specifically to
            reach again. */}
        {(() => {
          const collapseButton = (
            // Desktop only — mobile uses the off-canvas drawer instead of a
            // collapse rail, so this control has no meaning there.
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-md lg:flex"
              style={{ color: 'var(--header-fg-muted)' }}
            >
              {collapsed ? <SidebarExpandIcon size={14} /> : <SidebarCollapseIcon size={14} />}
            </button>
          )
          const fullscreenButton = (
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
          )
          const themeButton = (
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
              style={{ color: 'var(--header-fg-muted)' }}
            >
              {theme === 'dark' ? <SunIcon size={14} /> : <MoonIcon size={14} />}
            </button>
          )

          return (
            <>
              {/* Brand mark — the sidebar had no logo at all before this;
                  collapsed rail shows just the icon, expanded shows the
                  full wordmark too. */}
              <Link
                to="/"
                onClick={() => setNavOpen(false)}
                className={`mt-3 flex items-center ${collapsed ? 'mx-1.5 justify-center px-1.5' : 'mx-3 px-2'}`}
              >
                {collapsed ? <LogoMark size={26} /> : <Logo size={26} />}
              </Link>

              {/* Identity block — a Link to /profile wrapping just the
                  avatar+name/role now, not the whole row: when expanded, the
                  three toggle buttons sit in this same row, after the name,
                  so they're outside the <Link> (a <button> nested inside an
                  <a> is invalid HTML and would double-fire on click). A dot
                  badge (reusing pendingCount, the same demat/bank
                  link-request count the Dashboard nav badge already tracks)
                  marks that something on Profile is worth a look. Collapsed
                  (64px rail) can't lay the 32px avatar and text out side by
                  side (only ~52px of content width after margin/padding) —
                  flex-col there instead, and the toggle buttons move to
                  their own stacked group below instead of this row. */}
              <div
                className={`mt-4 mb-1.5 flex items-center gap-2.5 rounded-md py-2 transition-colors hover:bg-[var(--accent-tint)] ${
                  collapsed ? 'mx-1.5 flex-col gap-1.5 px-1.5' : 'mx-3 px-2'
                }`}
                style={{ background: 'var(--hover-surface)' }}
              >
                <Link
                  to="/profile"
                  onClick={() => setNavOpen(false)}
                  className={`flex min-w-0 items-center gap-2.5 ${collapsed ? 'flex-col gap-1.5' : 'flex-1'}`}
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
                  {/* Not rendered at all when collapsed — sidebar-fade only
                      shrinks max-width to 0, it never touches height, so
                      this block's two lines of text kept reserving their
                      normal line-height as blank vertical space below the
                      avatar even fully faded out. Skipping the render
                      entirely (rather than fading an always-mounted block)
                      is what actually collapses that space away, leaving
                      just the circle. */}
                  {!collapsed && (
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold" style={{ color: 'var(--header-fg)' }}>
                        {profile?.full_name ?? '…'}
                      </p>
                      <p className="truncate text-[11px] capitalize" style={{ color: 'var(--header-fg-muted)' }}>
                        {profile?.role ?? '…'}
                      </p>
                    </div>
                  )}
                </Link>
                {!collapsed && (
                  <div className="flex shrink-0 items-center gap-1">
                    {themeButton}
                    {fullscreenButton}
                    {collapseButton}
                  </div>
                )}
              </div>

              {collapsed && (
                <div className="mx-1.5 mb-1.5 flex flex-col items-center justify-center gap-1 rounded-md px-1.5 py-1.5">
                  {collapseButton}
                  {fullscreenButton}
                  {themeButton}
                </div>
              )}
            </>
          )
        })()}

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
          {links.filter((l) => !l.adminOnly || profile?.role === 'admin').map((l) => {
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
                className={`mb-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--hover-surface)] ${
                  collapsed ? 'nav-link-collapsed' : ''
                }`}
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

        {/* Logout + version, one row — version sits inline after Sign out
            instead of its own row underneath, and is dropped entirely (not
            just faded) when the rail is collapsed, since there's no room
            for it next to an icon-only button there. */}
        <div className="px-2 pt-1 pb-3">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={signOut}
              title={collapsed ? 'Sign out' : undefined}
              className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-[var(--hover-surface)] ${
                collapsed ? 'nav-link-collapsed' : ''
              }`}
              style={{ color: 'var(--header-fg)' }}
            >
              <SignOutIcon size={16} fill="var(--header-fg-muted)" />
              <span className={`sidebar-fade ${collapsed ? 'sidebar-fade-collapsed' : ''}`} style={{ color: 'var(--header-fg)' }}>
                Sign out
              </span>
            </button>
            {!collapsed && (
              <span className="shrink-0 pr-2 text-[11px]" style={{ color: 'var(--header-fg-muted)' }}>
                v{__APP_VERSION__}
              </span>
            )}
          </div>
        </div>
      </aside>

      {/* viewport-fit=cover lets content run under the iPhone status bar. This
          top inset keeps the page's own <h1> clear of the clock on first
          paint; scrolling still slides content up under the status bar as iOS
          expects. Zero on desktop (no inset), and on the content wrapper (not
          the sticky sidebar, which handles its own inset).
          env(safe-area-inset-top) alone isn't enough on Android — it only
          ever reports an actual display CUTOUT (a notch), not "there's a
          status bar here." In the browser's own Fullscreen mode (this
          page's own fullscreen toggle, or a phone's "hide address bar on
          scroll" browser chrome) Android hides the status bar without
          creating a cutout, so env() reports 0 and a page title collided
          directly with the clock/battery icons — confirmed via a real
          screenshot. pt-3 (mobile only, sm:pt-0) is a fixed floor under
          that env() value for exactly that gap. */}
      <div className="safe-top min-w-0 flex-1 overflow-x-hidden">
        <main
          className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 md:px-8 md:pt-8 lg:pb-8"
          // Extra bottom padding on phone/tablet so the fixed bottom tab bar
          // (~4rem + home-indicator inset) never covers the last of the page.
          // Removed at lg where the tab bar is hidden (lg:pb-8 above).
          style={{ paddingBottom: 'calc(4.5rem + env(safe-area-inset-bottom))' }}
        >
          {/* Phone/tablet only (PullToRefresh no-ops itself on hover-capable
              devices) — a full reload, not a per-page refetch hook, since
              every route fetches its own data independently. */}
          <PullToRefresh>
            <div key={location.pathname} className="animate-page-in">
              <Outlet />
            </div>
          </PullToRefresh>
        </main>
      </div>

      {/* Floating liquid-glass tab bar — phone + tablet primary navigation
          (hidden at lg, where the sidebar takes over). A centered pill that
          hovers above the content; the page refracts through its blur. The
          outer wrapper is click-through (pointer-events-none) so only the
          pill itself intercepts taps. Profile is the 5th tab (its avatar);
          everything not on the bar lives on the Profile page. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-3 lg:hidden"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.5rem)' }}
      >
        <nav className="glass-tabbar pointer-events-auto flex w-full max-w-md items-stretch rounded-[1.75rem] p-1.5">
          {BOTTOM_TABS.map((t) => {
            const Icon = t.icon
            const isActive = t.to === '/' ? location.pathname === '/' : location.pathname.startsWith(t.to)
            // Dashboard carries the pending-link-request dot, same as the sidebar.
            const count = t.to === '/' ? pendingCount : 0
            return (
              <NavLink
                key={t.to}
                to={t.to}
                onClick={() => setNavOpen(false)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={t.label}
                title={t.label}
                className="relative flex flex-1 items-center justify-center rounded-[1.25rem] py-2"
                style={{ color: isActive ? 'var(--accent)' : 'var(--header-fg-muted)', minHeight: '3rem' }}
              >
                {/* Shared layoutId — Framer Motion morphs this single pill
                    between whichever tab is active instead of each tab
                    independently fading its own background in/out, which is
                    what actually reads as "liquid" (a physical piece of
                    glass sliding under the icon) rather than a cross-fade. */}
                {isActive && (
                  <motion.div
                    layoutId="bottom-tab-indicator"
                    className="glass-tab-active absolute inset-0 rounded-[1.25rem]"
                    transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                  />
                )}
                <motion.div
                  whileTap={{ scale: 0.88 }}
                  transition={{ type: 'spring', stiffness: 600, damping: 20 }}
                  className="relative z-10 flex items-center justify-center"
                >
                  <Icon size={22} fill={isActive ? 'var(--accent)' : 'var(--header-fg-muted)'} />
                  {count > 0 && (
                    <span
                      aria-label={`${count} pending`}
                      className="absolute -top-1 -right-2 h-2 w-2 rounded-full"
                      style={{ background: 'var(--critical)', border: '1.5px solid var(--header-bg)' }}
                    />
                  )}
                </motion.div>
              </NavLink>
            )
          })}
          {/* Profile tab rendered as the user's avatar, Instagram-style. */}
          {(() => {
            const isActive = location.pathname.startsWith('/profile')
            return (
              <NavLink
                to="/profile"
                onClick={() => setNavOpen(false)}
                aria-current={isActive ? 'page' : undefined}
                aria-label="Profile"
                title="Profile"
                className="relative flex flex-1 items-center justify-center rounded-[1.25rem] py-2"
                style={{ color: isActive ? 'var(--accent)' : 'var(--header-fg-muted)', minHeight: '3rem' }}
              >
                {isActive && (
                  <motion.div
                    layoutId="bottom-tab-indicator"
                    className="glass-tab-active absolute inset-0 rounded-[1.25rem]"
                    transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                  />
                )}
                <motion.div
                  whileTap={{ scale: 0.88 }}
                  transition={{ type: 'spring', stiffness: 600, damping: 20 }}
                  className="relative z-10 flex items-center justify-center"
                >
                  <span
                    className="flex items-center justify-center rounded-full text-[10px] font-bold"
                    style={{
                      height: 23,
                      width: 23,
                      background: 'var(--accent)',
                      color: '#ffffff',
                      outline: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                      outlineOffset: 1,
                    }}
                  >
                    {initials}
                  </span>
                  {pendingCount > 0 && (
                    <span
                      aria-label={`${pendingCount} pending`}
                      className="absolute -top-1 -right-2 h-2 w-2 rounded-full"
                      style={{ background: 'var(--critical)', border: '1.5px solid var(--header-bg)' }}
                    />
                  )}
                </motion.div>
              </NavLink>
            )
          })()}
        </nav>
      </div>
    </div>
  )
}
