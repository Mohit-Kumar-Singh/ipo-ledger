import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { IconButton, NavList } from '@primer/react'
import {
  BellIcon,
  ChecklistIcon,
  FileIcon,
  GearIcon,
  HomeIcon,
  LawIcon,
  GraphIcon,
  PersonIcon,
  PeopleIcon,
  SignOutIcon,
  ThreeBarsIcon,
} from '@primer/octicons-react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { ThemeToggle } from '../ThemeToggle'
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
  { to: '/settings', label: 'Settings', icon: GearIcon },
  { to: '/profile', label: 'Profile', icon: PersonIcon },
]

export function AppShell() {
  const { profile, signOut } = useAuth()
  const [navOpen, setNavOpen] = useState(false)
  const [tourActive, setTourActive] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const location = useLocation()

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

  return (
    <div className="min-h-screen md:flex" style={{ background: 'var(--surface)' }}>
      <ToastHost />
      <OnboardingTour onRequireNavOpen={setNavOpen} onActiveChange={setTourActive} />

      {/* Mobile-only slim top bar — the sidebar below is off-canvas until opened */}
      <div
        className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 md:hidden"
        style={{ background: 'var(--header-bg)', borderColor: 'var(--border)' }}
      >
        <IconButton onClick={() => setNavOpen(true)} aria-label="Open menu" icon={ThreeBarsIcon} variant="invisible" />
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md text-sm font-bold"
          style={{ background: 'var(--accent)', color: '#ffffff' }}
        >
          I
        </div>
        <span className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--header-fg)' }}>
          IPO Ledger
        </span>
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
        className={`fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 flex-col transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:sticky md:top-0 md:z-auto md:h-screen md:w-64 md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{
          background: 'var(--header-bg)',
          borderRight: '1px solid var(--border)',
          boxShadow: navOpen ? 'var(--shadow-floating-large)' : undefined,
        }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-md text-sm font-bold"
            style={{ background: 'var(--accent)', color: '#ffffff' }}
          >
            I
          </div>
          <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--header-fg)' }}>
            IPO Ledger
          </span>
        </div>

        {/* Identity block */}
        <div
          className="mx-3 mb-1.5 flex items-center gap-2.5 rounded-md px-2 py-2"
          style={{ background: 'var(--hover-surface)' }}
        >
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            style={{ background: 'var(--accent)', color: '#ffffff' }}
          >
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold" style={{ color: 'var(--header-fg)' }}>
              {profile?.full_name ?? '…'}
            </p>
            <p className="truncate text-[11px] capitalize" style={{ color: 'var(--header-fg-muted)' }}>
              {profile?.role ?? '…'}
            </p>
          </div>
          <ThemeToggle iconOnly />
        </div>

        {/* Status pill — colored dot + short status text, same pending-count
            data as the Dashboard nav badge below. */}
        <div className="mx-3 mb-2.5 flex items-center gap-1.5 px-2">
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: pendingCount > 0 ? 'var(--warning)' : 'var(--good)' }}
          />
          <span
            className="text-[10px] font-semibold tracking-wider uppercase"
            style={{ color: pendingCount > 0 ? 'var(--warning-text)' : 'var(--good-text)' }}
          >
            {pendingCount > 0 ? `${pendingCount} pending request${pendingCount === 1 ? '' : 's'}` : 'all clear'}
          </span>
        </div>

        {/* Nav */}
        <nav className="sidebar-scroll flex-1 overflow-y-auto px-2 pt-1">
          <NavList>
            {links.map((l) => {
              const Icon = l.icon
              const isActive = l.to === '/' ? location.pathname === '/' : location.pathname.startsWith(l.to)
              // Only the Dashboard link has a natural home for this count
              // today — pending link requests surface and get approved
              // there, not on a dedicated page of their own.
              const count = l.to === '/' ? pendingCount : 0
              return (
                <NavList.Item
                  key={l.to}
                  as={NavLink}
                  to={l.to}
                  data-tour={l.to}
                  onClick={() => setNavOpen(false)}
                  aria-current={isActive ? 'page' : undefined}
                  style={{
                    color: isActive ? 'var(--accent)' : 'var(--header-fg)',
                    marginBottom: 4,
                    borderRadius: 6,
                    // Left accent bar + background tint on the active item,
                    // not just a text-color swap (KOVAREX retheme).
                    borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                    background: isActive ? 'var(--accent-tint)' : undefined,
                  }}
                >
                  <NavList.LeadingVisual>
                    <Icon size={16} fill={isActive ? 'var(--accent)' : 'var(--header-fg-muted)'} />
                  </NavList.LeadingVisual>
                  <span style={{ color: isActive ? 'var(--accent)' : 'var(--header-fg)' }}>{l.label}</span>
                  {count > 0 && (
                    <NavList.TrailingVisual>
                      <span
                        className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                        style={{ background: 'var(--warning-tint)', color: 'var(--warning-text)' }}
                      >
                        {count}
                      </span>
                    </NavList.TrailingVisual>
                  )}
                </NavList.Item>
              )
            })}
          </NavList>
        </nav>

        {/* Logout + version */}
        <div className="px-2 pt-1 pb-3">
          <NavList>
            <NavList.Item as="button" onClick={signOut} style={{ color: 'var(--header-fg)' }}>
              <NavList.LeadingVisual>
                <SignOutIcon size={16} fill="var(--header-fg-muted)" />
              </NavList.LeadingVisual>
              <span style={{ color: 'var(--header-fg)' }}>Sign out</span>
            </NavList.Item>
          </NavList>
          <p className="px-3 pt-2 text-[11px]" style={{ color: 'var(--header-fg-muted)' }}>
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
