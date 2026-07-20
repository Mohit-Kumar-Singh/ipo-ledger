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

  if (loading) return <p className="text-gray-500">Loading…</p>

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Messages sent to you</h1>
      <div className="divide-y rounded border bg-white">
        {notifications.map((n) => (
          <div key={n.id} className="p-3">
            <div className="flex items-center justify-between">
              <p className="font-medium">{n.template_name}</p>
              <span className="text-xs text-gray-500">{new Date(n.created_at).toLocaleString()}</span>
            </div>
            <p className="text-sm text-gray-500">{n.status}</p>
          </div>
        ))}
        {notifications.length === 0 && (
          <p className="p-3 text-sm text-gray-400">No messages yet.</p>
        )}
      </div>
    </div>
  )
}
