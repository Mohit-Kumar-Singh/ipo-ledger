import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import { AuthProvider } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AppShell } from './components/layout/AppShell'
import { ConfigBanner } from './components/ConfigBanner'
import { PageSpinner } from './components/PageSpinner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RealtimeCacheSync } from './components/RealtimeCacheSync'

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
const PayoutsPage = lazy(() => import('./pages/admin/PayoutsPage').then((m) => ({ default: m.PayoutsPage })))
const SharedAccountsPage = lazy(() =>
  import('./pages/admin/SharedAccountsPage').then((m) => ({ default: m.SharedAccountsPage })),
)
const ArchivesPage = lazy(() => import('./pages/admin/ArchivesPage').then((m) => ({ default: m.ArchivesPage })))
const ProfilePage = lazy(() => import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })))

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter>
            <AuthProvider>
              <RealtimeCacheSync />
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
                      <Route path="/payouts" element={<PayoutsPage />} />
                      <Route path="/shared-accounts" element={<SharedAccountsPage />} />
                      <Route path="/notifications" element={<NotificationsPage />} />
                      <Route path="/archives" element={<ArchivesPage />} />
                      <Route path="/profile" element={<ProfilePage />} />
                    </Route>
                  </Route>
                </Routes>
              </Suspense>
            </AuthProvider>
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}

export default App
