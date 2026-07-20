import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

export function ProtectedRoute({ requireAdmin = false }: { requireAdmin?: boolean }) {
  const { session, profile, loading } = useAuth()

  if (loading) return <div className="p-8 text-center text-gray-500">Loading…</div>
  if (!session) return <Navigate to="/login" replace />
  if (requireAdmin && profile?.role !== 'admin') return <Navigate to="/" replace />

  return <Outlet />
}
