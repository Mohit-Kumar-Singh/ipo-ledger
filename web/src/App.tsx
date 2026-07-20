import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'
import { ProtectedRoute } from './components/ProtectedRoute'
import { AppShell } from './components/layout/AppShell'
import { ConfigBanner } from './components/ConfigBanner'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/admin/DashboardPage'
import { AccountsPage } from './pages/admin/AccountsPage'
import { IposPage } from './pages/admin/IposPage'
import { ApplicationsPage } from './pages/admin/ApplicationsPage'
import { AllotmentBoardPage } from './pages/admin/AllotmentBoardPage'
import { NotificationsPage } from './pages/admin/NotificationsPage'
import { MyAccountPage } from './pages/member/MyAccountPage'
import { MyApplicationsPage } from './pages/member/MyApplicationsPage'
import { MyMessagesPage } from './pages/member/MyMessagesPage'
import { useAuth } from './contexts/AuthContext'

function HomePage() {
  const { profile } = useAuth()
  return profile?.role === 'admin' ? <DashboardPage /> : <MyAccountPage />
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ConfigBanner />
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route element={<ProtectedRoute />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/my-applications" element={<MyApplicationsPage />} />
              <Route path="/my-messages" element={<MyMessagesPage />} />

              <Route element={<ProtectedRoute requireAdmin />}>
                <Route path="/accounts" element={<AccountsPage />} />
                <Route path="/ipos" element={<IposPage />} />
                <Route path="/applications" element={<ApplicationsPage />} />
                <Route path="/allotment" element={<AllotmentBoardPage />} />
                <Route path="/notifications" element={<NotificationsPage />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
