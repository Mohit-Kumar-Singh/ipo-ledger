import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  Bell,
  ClipboardCheck,
  FileText,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  TrendingUp,
  UserCircle,
  Users,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { ThemeToggle } from '../ThemeToggle'
import { ToastHost } from '../ToastHost'

const links = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/accounts', label: 'Accounts', icon: Users },
  { to: '/bank-accounts', label: 'Bank / UPI accounts', icon: Landmark },
  { to: '/ipos', label: 'IPOs', icon: TrendingUp },
  { to: '/applications', label: 'Applications', icon: FileText },
  { to: '/allotment', label: 'Allotment board', icon: ClipboardCheck },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/profile', label: 'Profile', icon: UserCircle },
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
    <div className="min-h-screen md:flex" style={{ background: 'var(--page)' }}>
      <ToastHost />

      {/* Mobile-only slim top bar — the sidebar below is off-canvas until opened */}
      <div
        className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 md:hidden"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <button
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          className="rounded-lg p-1.5"
          style={{ color: 'var(--ink-secondary)' }}
        >
          <Menu size={20} />
        </button>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-lg text-sm font-bold"
          style={{ background: 'linear-gradient(135deg, var(--btn-primary-bg), var(--accent))', color: 'white' }}
        >
          I
        </div>
        <span className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          IPO Ledger
        </span>
      </div>

      {/* Backdrop for mobile drawer */}
      {navOpen && (
        <div
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 animate-page-in md:hidden"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 flex-col transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] md:sticky md:top-0 md:z-auto md:h-screen md:w-64 md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ background: 'var(--header-bg)', boxShadow: navOpen ? 'var(--shadow-lg)' : undefined }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <div
            className="flex h-7 w-7 items-center justify-center rounded-lg text-sm font-bold"
            style={{ background: 'linear-gradient(135deg, var(--btn-primary-bg), var(--accent))', color: 'white' }}
          >
            I
          </div>
          <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--header-fg)' }}>
            IPO Ledger
          </span>
        </div>

        {/* Avatar / identity block */}
        <div className="mx-3 mb-1.5 flex items-center gap-2.5 rounded-lg px-2 py-2" style={{ background: 'var(--header-hover)' }}>
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            style={{ background: 'linear-gradient(135deg, var(--violet), var(--accent))', color: 'white' }}
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
          <ThemeToggle iconOnly className="hover:!bg-[var(--header-hover)]" style={{ color: 'var(--header-fg-muted)' }} />
        </div>

        {/* Nav */}
        <nav className="sidebar-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-1">
          <p className="px-2.5 pb-1 text-[10px] font-semibold tracking-wider uppercase" style={{ color: 'var(--header-fg-muted)' }}>
            Menu
          </p>
          {links.map((l) => {
            const Icon = l.icon
            return (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === '/'}
                onClick={() => setNavOpen(false)}
                className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`}
              >
                <Icon size={16} strokeWidth={2} />
                {l.label}
              </NavLink>
            )
          })}
        </nav>

        {/* Logout + version */}
        <div className="px-3 pt-1 pb-3">
          <button onClick={signOut} className="sidebar-link w-full text-left">
            <LogOut size={16} strokeWidth={2} />
            Sign out
          </button>
          <p className="px-2.5 pt-2 text-[11px]" style={{ color: 'var(--header-fg-muted)' }}>
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
