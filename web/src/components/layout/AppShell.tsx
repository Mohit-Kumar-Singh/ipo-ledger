import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { ThemeToggle } from '../ThemeToggle'
import { ToastHost } from '../ToastHost'

const links = [
  { to: '/', label: 'Dashboard' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/bank-accounts', label: 'Bank / UPI accounts' },
  { to: '/ipos', label: 'IPOs' },
  { to: '/applications', label: 'Applications' },
  { to: '/allotment', label: 'Allotment board' },
  { to: '/notifications', label: 'Notifications' },
  { to: '/settings', label: 'Settings' },
  { to: '/profile', label: 'Profile' },
]

export function AppShell() {
  const { profile, signOut } = useAuth()
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()

  const initials = (profile?.full_name ?? '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="min-h-screen" style={{ background: 'var(--page)' }}>
      <ToastHost />

      {/* GitHub-style top header — always dark, in both light and dark theme */}
      <header className="glass-header sticky top-0 z-30 flex h-14 items-center gap-3 px-4 md:px-5">
        <button
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          className="rounded-md p-1.5 md:hidden"
          style={{ color: 'var(--header-fg)' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>

        <div className="flex items-center gap-2">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-md text-sm font-semibold"
            style={{ background: 'var(--header-hover)', color: 'var(--header-fg)' }}
          >
            I
          </div>
          <span className="hidden text-[15px] font-semibold tracking-tight sm:block" style={{ color: 'var(--header-fg)' }}>
            IPO Ledger
          </span>
        </div>

        <div className="flex-1" />

        <ThemeToggle
          className="hover:!bg-[var(--header-hover)]"
          style={{ color: 'var(--header-fg-muted)' }}
        />

        <div className="flex items-center gap-2 pl-1">
          <Link
            to="/profile"
            title="Edit profile"
            className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors"
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--header-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              style={{ background: 'var(--header-hover)', color: 'var(--header-fg)' }}
            >
              {initials}
            </div>
            <span
              className="hidden max-w-[10rem] truncate text-sm font-medium lg:block"
              style={{ color: 'var(--header-fg)' }}
            >
              {profile?.full_name ?? '…'}
            </span>
          </Link>
          <button
            onClick={signOut}
            title="Sign out"
            className="rounded-md px-2 py-1 text-xs font-medium transition-colors"
            style={{ color: 'var(--header-fg-muted)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--header-hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex">
        {/* Backdrop for mobile drawer */}
        {navOpen && (
          <div
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-40 animate-page-in md:hidden"
            style={{ background: 'rgba(0,0,0,0.4)' }}
          />
        )}

        <aside
          className={`fixed inset-y-0 left-0 z-50 mt-14 flex w-64 shrink-0 flex-col border-r transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:sticky md:top-14 md:z-auto md:mt-0 md:h-[calc(100vh-3.5rem)] md:w-60 md:translate-x-0 md:shadow-none ${
            navOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          style={{
            borderColor: 'var(--border)',
            background: 'var(--surface)',
            boxShadow: navOpen ? 'var(--shadow-lg)' : undefined,
          }}
        >
          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === '/'}
                onClick={() => setNavOpen(false)}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 ease-out ${
                    isActive ? '' : 'hover:translate-x-0.5 hover:bg-[var(--hover-surface)]'
                  }`
                }
                style={({ isActive }) =>
                  isActive
                    ? { background: 'var(--accent-tint)', color: 'var(--accent-hover)', boxShadow: 'var(--shadow-sm)' }
                    : { color: 'var(--ink-secondary)' }
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div
            className="border-t px-4 py-2.5 text-xs"
            style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}
          >
            IPO Ledger v{__APP_VERSION__}
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
    </div>
  )
}
