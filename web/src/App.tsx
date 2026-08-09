import { Suspense, lazy, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider as PrimerThemeProvider, BaseStyles } from '@primer/react'
import { AuthProvider } from './contexts/AuthContext'
import { ThemeProvider, useTheme } from './contexts/ThemeContext'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AppShell } from './components/layout/AppShell'
import { ConfigBanner } from './components/ConfigBanner'
import { PageSpinner } from './components/PageSpinner'
import { ErrorBoundary } from './components/ErrorBoundary'

// Route-level code splitting: each page's JS only downloads when that route
// is actually visited.
const LoginPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })))
const DashboardPage = lazy(() => import('./pages/admin/DashboardPage').then((m) => ({ default: m.DashboardPage })))
const AccountsPage = lazy(() => import('./pages/admin/AccountsPage').then((m) => ({ default: m.AccountsPage })))
const BankAccountsPage = lazy(() =>
  import('./pages/admin/BankAccountsPage').then((m) => ({ default: m.BankAccountsPage })),
)
const IposPage = lazy(() => import('./pages/admin/IposPage').then((m) => ({ default: m.IposPage })))
const ApplicationsPage = lazy(() =>
  import('./pages/admin/ApplicationsPage').then((m) => ({ default: m.ApplicationsPage })),
)
const AllotmentBoardPage = lazy(() =>
  import('./pages/admin/AllotmentBoardPage').then((m) => ({ default: m.AllotmentBoardPage })),
)
const NotificationsPage = lazy(() =>
  import('./pages/admin/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
)
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const ProfilePage = lazy(() => import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })))

// Bridges this app's own light/dark toggle (ThemeContext, drives `data-theme`
// on <html> for the existing custom CSS) into Primer's own color mode, so
// there's one source of truth for theme instead of two independent toggles.
function PrimerThemeBridge({ children }: { children: ReactNode }) {
  const { theme } = useTheme()
  return (
    // key={theme} forces a full remount on toggle — Primer's ThemeProvider
    // doesn't reliably recompute its injected styles from a changed
    // colorMode prop alone (components like TextInput stayed light-styled
    // after toggling), so this sidesteps whatever internal memoization is
    // at play rather than fighting it.
    <PrimerThemeProvider key={theme} colorMode={theme === 'dark' ? 'night' : 'day'}>
      {/* BaseStyles ships its own fontFamily (Primer's default stack) on the
          wrapper div, which silently overrides body's Inter for every Primer
          component (NavList, Button, etc.) — the sidebar/nav rendered in a
          different font than the hand-styled Dashboard/IPO cards even though
          both "used Inter". Force it here so the whole app (Primer pieces
          included) matches the IPO Tracker.dc.html reference's `font-family:
          'Inter', sans-serif` consistently. */}
      <BaseStyles style={{ fontFamily: "'Inter Variable', -apple-system, 'Segoe UI', sans-serif" }}>
        {children}
      </BaseStyles>
    </PrimerThemeProvider>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <PrimerThemeBridge>
          <BrowserRouter>
            <AuthProvider>
              <ConfigBanner />
              <Suspense fallback={<PageSpinner />}>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />

                  <Route element={<ProtectedRoute />}>
                    <Route element={<AppShell />}>
                      <Route path="/" element={<DashboardPage />} />
                      <Route path="/accounts" element={<AccountsPage />} />
                      <Route path="/bank-accounts" element={<BankAccountsPage />} />
                      <Route path="/ipos" element={<IposPage />} />
                      <Route path="/applications" element={<ApplicationsPage />} />
                      <Route path="/allotment" element={<AllotmentBoardPage />} />
                      <Route path="/notifications" element={<NotificationsPage />} />
                      <Route path="/settings" element={<SettingsPage />} />
                      <Route path="/profile" element={<ProfilePage />} />
                    </Route>
                  </Route>
                </Routes>
              </Suspense>
            </AuthProvider>
          </BrowserRouter>
        </PrimerThemeBridge>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
