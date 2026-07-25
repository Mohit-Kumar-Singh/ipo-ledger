import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AppShell } from './components/layout/AppShell'
import { ConfigBanner } from './components/ConfigBanner'
import { PageSpinner } from './components/PageSpinner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useAuth } from './contexts/AuthContext'

// Route-level code splitting: each page's JS only downloads when that route
// is actually visited, instead of one bundle containing every admin screen,
// the IPO-import scraper types, etc. up front for every visitor (including
// members, who never touch most of this).
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
const MyAccountPage = lazy(() => import('./pages/member/MyAccountPage').then((m) => ({ default: m.MyAccountPage })))
const MyApplicationsPage = lazy(() =>
  import('./pages/member/MyApplicationsPage').then((m) => ({ default: m.MyApplicationsPage })),
)
const MyMessagesPage = lazy(() =>
  import('./pages/member/MyMessagesPage').then((m) => ({ default: m.MyMessagesPage })),
)

function HomePage() {
  const { profile } = useAuth()
  return profile?.role === 'admin' ? <DashboardPage /> : <MyAccountPage />
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <ConfigBanner />
            <Suspense fallback={<PageSpinner />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />

                <Route element={<ProtectedRoute />}>
                  <Route element={<AppShell />}>
                    <Route path="/" element={<HomePage />} />
                    <Route path="/my-applications" element={<MyApplicationsPage />} />
                    <Route path="/my-messages" element={<MyMessagesPage />} />

                    <Route element={<ProtectedRoute requireAdmin />}>
                      <Route path="/accounts" element={<AccountsPage />} />
                      <Route path="/bank-accounts" element={<BankAccountsPage />} />
                      <Route path="/ipos" element={<IposPage />} />
                      <Route path="/applications" element={<ApplicationsPage />} />
                      <Route path="/allotment" element={<AllotmentBoardPage />} />
                      <Route path="/notifications" element={<NotificationsPage />} />
                      <Route path="/settings" element={<SettingsPage />} />
                    </Route>
                  </Route>
                </Route>
              </Routes>
            </Suspense>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
