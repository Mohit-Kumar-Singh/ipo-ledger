import { useState } from 'react'
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
  const location = useLocation()

  const initials = (profile?.full_name ?? '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="min-h-screen md:flex" style={{ background: 'var(--bgColor-default)' }}>
      <ToastHost />
      <OnboardingTour onRequireNavOpen={setNavOpen} onActiveChange={setTourActive} />

      {/* Mobile-only slim top bar — the sidebar below is off-canvas until opened */}
      <div
        className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 md:hidden"
        style={{ background: 'var(--bgColor-muted)', borderColor: 'var(--borderColor-default)' }}
      >
        <IconButton onClick={() => setNavOpen(true)} aria-label="Open menu" icon={ThreeBarsIcon} variant="invisible" />
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md text-sm font-bold"
          style={{ background: 'var(--bgColor-accent-emphasis)', color: 'var(--fgColor-onEmphasis)' }}
        >
          I
        </div>
        <span className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--fgColor-default)' }}>
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
          background: 'var(--bgColor-muted)',
          borderRight: '1px solid var(--borderColor-default)',
          boxShadow: navOpen ? 'var(--shadow-floating-large)' : undefined,
        }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-md text-sm font-bold"
            style={{ background: 'var(--bgColor-accent-emphasis)', color: 'var(--fgColor-onEmphasis)' }}
          >
            I
          </div>
          <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--fgColor-default)' }}>
            IPO Ledger
          </span>
        </div>

        {/* Identity block */}
        <div
          className="mx-3 mb-1.5 flex items-center gap-2.5 rounded-md px-2 py-2"
          style={{ background: 'var(--bgColor-neutral-muted)' }}
        >
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            style={{ background: 'var(--bgColor-accent-emphasis)', color: 'var(--fgColor-onEmphasis)' }}
          >
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold" style={{ color: 'var(--fgColor-default)' }}>
              {profile?.full_name ?? '…'}
            </p>
            <p className="truncate text-[11px] capitalize" style={{ color: 'var(--fgColor-muted)' }}>
              {profile?.role ?? '…'}
            </p>
          </div>
          <ThemeToggle iconOnly />
        </div>

        {/* Nav */}
        <nav className="sidebar-scroll flex-1 overflow-y-auto px-2 pt-1">
          <NavList>
            {links.map((l) => {
              const Icon = l.icon
              const isActive = l.to === '/' ? location.pathname === '/' : location.pathname.startsWith(l.to)
              return (
                <NavList.Item
                  key={l.to}
                  as={NavLink}
                  to={l.to}
                  data-tour={l.to}
                  onClick={() => setNavOpen(false)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <NavList.LeadingVisual>
                    <Icon size={16} />
                  </NavList.LeadingVisual>
                  {l.label}
                </NavList.Item>
              )
            })}
          </NavList>
        </nav>

        {/* Logout + version */}
        <div className="px-2 pt-1 pb-3">
          <NavList>
            <NavList.Item as="button" onClick={signOut}>
              <NavList.LeadingVisual>
                <SignOutIcon size={16} />
              </NavList.LeadingVisual>
              Sign out
            </NavList.Item>
          </NavList>
          <p className="px-3 pt-2 text-[11px]" style={{ color: 'var(--fgColor-muted)' }}>
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
