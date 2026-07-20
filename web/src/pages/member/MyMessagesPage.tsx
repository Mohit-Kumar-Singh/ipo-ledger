import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { Notification } from '../../types/database'

export function MyMessagesPage() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setNotifications((data ?? []) as Notification[])
        setLoading(false)
      })
  }, [])

  if (loading) return <p style={{ color: 'var(--ink-muted)' }}>Loading…</p>

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
        Messages sent to you
      </h1>
      <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
        {notifications.map((n) => (
          <div key={n.id} className="p-4">
            <div className="flex items-center justify-between">
              <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                {n.template_name}
              </p>
              <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                {new Date(n.created_at).toLocaleString()}
              </span>
            </div>
            <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
              {n.status}
            </p>
          </div>
        ))}
        {notifications.length === 0 && (
          <p className="p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            No messages yet.
          </p>
        )}
      </div>
    </div>
  )
}
