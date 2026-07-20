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

  async function dispatch(n: Notification) {
    setRetrying(n.id)
    await supabase.functions.invoke('send-whatsapp', {
      body: { notification_id: n.id },
    })
    setRetrying(null)
    load()
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Notifications
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          {notifications.length} messages
        </p>
      </div>

      {loading ? (
        <p style={{ color: 'var(--ink-muted)' }}>Loading…</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
              <tr>
                <th className="px-4 py-2.5 font-medium">Sent</th>
                <th className="px-4 py-2.5 font-medium">To</th>
                <th className="px-4 py-2.5 font-medium">Template</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Error</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {notifications.map((n) => (
                <tr key={n.id} className="hover:bg-[var(--hover-surface)]">
                  <td className="px-4 py-2.5" style={{ color: 'var(--ink-muted)' }}>
                    {new Date(n.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5">{n.to_phone}</td>
                  <td className="px-4 py-2.5">{n.template_name}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={n.status} />
                  </td>
                  <td className="px-4 py-2.5" style={{ color: 'var(--critical)' }}>
                    {n.error_detail ?? ''}
                  </td>
                  <td className="px-4 py-2.5">
                    {(n.status === 'QUEUED' || n.status === 'FAILED') && (
                      <button
                        onClick={() => dispatch(n)}
                        disabled={retrying === n.id}
                        className="link-accent text-xs font-medium disabled:opacity-50"
                      >
                        {retrying === n.id ? 'Sending…' : n.status === 'FAILED' ? 'Retry' : 'Send'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {notifications.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
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
  const classes: Record<Notification['status'], string> = {
    QUEUED: 'badge-neutral',
    SENT: 'badge-info',
    DELIVERED: 'badge-good',
    READ: 'badge-violet',
    FAILED: 'badge-critical',
    SIMULATED: 'badge-warning',
  }
  return <span className={`badge ${classes[status]}`}>{status}</span>
}
