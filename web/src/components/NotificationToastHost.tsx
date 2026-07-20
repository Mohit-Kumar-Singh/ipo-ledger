import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Notification } from '../types/database'

interface ToastItem {
  id: string
  notification: Notification
}

// Mirrors the approved template copy in doc 04 §4, filled in with this
// notification's variables, so the popup previews what would actually be sent.
const TEMPLATE_PREVIEWS: Record<string, (p: string[]) => string> = {
  ipo_applied: (p) =>
    `Hi ${p[0] ?? ''}, I've applied for the ${p[1] ?? ''} IPO from your account using ${p[2] ?? ''} — ${p[3] ?? ''}. You may get a UPI/ASBA mandate request from your bank; please approve it today so the application goes through.`,
  ipo_allotted: (p) =>
    `Hi ${p[0] ?? ''}, good news! The ${p[1] ?? ''} IPO applied from your account has been ${p[2] ?? 'ALLOTTED'} 🎉. Listing date: ${p[3] ?? 'TBA'}. Plan: sell on listing day.`,
}

function renderPreview(templateName: string, variables: unknown): string {
  const params = (variables as { params?: string[] } | null)?.params ?? []
  const render = TEMPLATE_PREVIEWS[templateName]
  return render ? render(params) : `${templateName}: ${params.join(' · ')}`
}

function statusMeta(status: Notification['status']) {
  if (status === 'SIMULATED') return { label: 'Simulated WhatsApp (no Meta setup yet)', badge: 'badge-warning' }
  if (status === 'FAILED') return { label: 'WhatsApp send failed', badge: 'badge-critical' }
  return { label: 'WhatsApp sent', badge: 'badge-good' }
}

/** Admin-only. Pops up a card the moment a notification is actually dispatched
 *  (SENT, SIMULATED or FAILED) — not when it's merely QUEUED, since queuing no
 *  longer sends anything; the admin triggers that explicitly via the Send button. */
export function NotificationToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    function handleChange(notification: Notification) {
      if (notification.status === 'QUEUED') return
      const id = `${notification.id}-${notification.status}-${Date.now()}`
      setToasts((t) => [...t, { id, notification }])
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id))
      }, 15000)
    }

    const channel = supabase
      .channel('notifications-toast')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => handleChange(payload.new as Notification),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notifications' },
        (payload) => handleChange(payload.new as Notification),
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  function dismiss(id: string) {
    setToasts((t) => t.filter((x) => x.id !== id))
  }

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
      {toasts.map(({ id, notification: n }) => {
        const meta = statusMeta(n.status)
        return (
          <div key={id} className="card p-4" style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
            <div className="flex items-start justify-between gap-2">
              <span className={`badge ${meta.badge}`}>{meta.label}</span>
              <button
                onClick={() => dismiss(id)}
                aria-label="Dismiss"
                className="text-sm leading-none"
                style={{ color: 'var(--ink-muted)' }}
              >
                ×
              </button>
            </div>
            <p className="mt-2 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              To {n.to_phone}
            </p>
            <p className="mt-1 text-sm" style={{ color: 'var(--ink-primary)' }}>
              {renderPreview(n.template_name, n.variables)}
            </p>
          </div>
        )
      })}
    </div>
  )
}
