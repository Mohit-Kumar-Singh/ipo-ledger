import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { PageSpinner } from './PageSpinner'

export function ProtectedRoute() {
  const { session, loading } = useAuth()

  if (loading) return <PageSpinner />
  if (!session) return <Navigate to="/login" replace />

  return <Outlet />
}
