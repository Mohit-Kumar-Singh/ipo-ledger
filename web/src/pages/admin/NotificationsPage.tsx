import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { Notification } from '../../types/database'

export function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)
    setNotifications((data ?? []) as Notification[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function retry(n: Notification) {
    setRetrying(n.id)
    await supabase.functions.invoke('send-whatsapp', {
      body: { retry_notification_id: n.id },
    })
    setRetrying(null)
    load()
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Notifications</h1>

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-3 py-2">Sent</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2">Template</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Error</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {notifications.map((n) => (
                <tr key={n.id}>
                  <td className="px-3 py-2 text-gray-500">{new Date(n.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{n.to_phone}</td>
                  <td className="px-3 py-2">{n.template_name}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={n.status} />
                  </td>
                  <td className="px-3 py-2 text-red-600">{n.error_detail ?? ''}</td>
                  <td className="px-3 py-2">
                    {n.status === 'FAILED' && (
                      <button
                        onClick={() => retry(n)}
                        disabled={retrying === n.id}
                        className="text-xs text-purple-700 hover:underline disabled:opacity-50"
                      >
                        {retrying === n.id ? 'Retrying…' : 'Retry'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {notifications.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-gray-400">
                    No messages sent yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: Notification['status'] }) {
  const colors: Record<Notification['status'], string> = {
    QUEUED: 'bg-gray-100 text-gray-600',
    SENT: 'bg-blue-100 text-blue-700',
    DELIVERED: 'bg-green-100 text-green-700',
    READ: 'bg-purple-100 text-purple-700',
    FAILED: 'bg-red-100 text-red-700',
  }
  return <span className={`rounded px-2 py-0.5 text-xs ${colors[status]}`}>{status}</span>
}
