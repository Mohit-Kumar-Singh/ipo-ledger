import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { ThemeToggle } from '../ThemeToggle'
import { NotificationToastHost } from '../NotificationToastHost'

const adminLinks = [
  { to: '/', label: 'Dashboard' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/ipos', label: 'IPOs' },
  { to: '/applications', label: 'Applications' },
  { to: '/allotment', label: 'Allotment board' },
  { to: '/notifications', label: 'Notifications' },
]

const memberLinks = [
  { to: '/', label: 'My account' },
  { to: '/my-applications', label: 'My applications' },
  { to: '/my-messages', label: 'My messages' },
]

export function AppShell() {
  const { profile, signOut } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const links = isAdmin ? adminLinks : memberLinks
  const [navOpen, setNavOpen] = useState(false)

  const initials = (profile?.full_name ?? '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--page)' }}>
      {isAdmin && <NotificationToastHost />}

      {/* Mobile top bar */}
      <div
        className="fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b px-4 py-3 md:hidden"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <button
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          className="rounded-md p-1.5"
          style={{ color: 'var(--ink-primary)' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          IPO Ledger
        </span>
        <ThemeToggle className="!px-1.5" />
      </div>

      {/* Backdrop for mobile drawer */}
      {navOpen && (
        <div
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 md:hidden"
          style={{ background: 'rgba(0,0,0,0.4)' }}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r transition-transform md:static md:z-auto md:w-60 md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <div className="flex items-center gap-2 px-5 py-5">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-md text-sm font-semibold text-white"
            style={{ background: 'var(--accent)' }}
          >
            I
          </div>
          <span className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            IPO Ledger
          </span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              onClick={() => setNavOpen(false)}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? '' : 'hover:bg-[var(--hover-surface)]'
                }`
              }
              style={({ isActive }) =>
                isActive
                  ? { background: 'var(--accent-tint)', color: 'var(--accent-hover)' }
                  : { color: 'var(--ink-secondary)' }
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t px-3 py-3" style={{ borderColor: 'var(--border)' }}>
          <ThemeToggle className="mb-1 hidden w-full justify-center md:flex" />
          <div className="flex items-center gap-2 rounded-md px-2 py-2">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              style={{ background: 'var(--accent-tint)', color: 'var(--accent-hover)' }}
            >
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                {profile?.full_name ?? '…'}
              </p>
              <p className="text-xs capitalize" style={{ color: 'var(--ink-muted)' }}>
                {profile?.role ?? ''}
              </p>
            </div>
            <button
              onClick={signOut}
              title="Sign out"
              className="rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-[var(--hover-surface)]"
              style={{ color: 'var(--ink-secondary)' }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-x-hidden pt-14 md:pt-0">
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
