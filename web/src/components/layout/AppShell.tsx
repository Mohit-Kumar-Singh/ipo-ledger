import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'

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

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className="font-semibold">IPO Ledger</span>
          <nav className="flex gap-4 text-sm">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === '/'}
                className={({ isActive }) =>
                  isActive ? 'font-medium text-purple-700' : 'text-gray-600 hover:text-gray-900'
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-gray-600">
            <span>{profile?.full_name ?? '…'}</span>
            <button onClick={signOut} className="text-purple-700 hover:underline">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
