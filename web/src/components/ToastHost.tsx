import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { onToast } from '../lib/toast'
import type { Notification } from '../types/database'

interface RenderedToast {
  id: string
  badgeClass: string
  badgeLabel: string
  title?: string
  message: string
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

function notificationToast(n: Notification): RenderedToast {
  const meta =
    n.status === 'SIMULATED'
      ? { label: 'Simulated WhatsApp (no Meta setup yet)', badge: 'badge-warning' }
      : n.status === 'FAILED'
        ? { label: 'WhatsApp send failed', badge: 'badge-critical' }
        : { label: 'WhatsApp sent', badge: 'badge-good' }
  return {
    id: `${n.id}-${n.status}-${Date.now()}`,
    badgeClass: meta.badge,
    badgeLabel: meta.label,
    title: `To ${n.to_phone}`,
    message: renderPreview(n.template_name, n.variables),
  }
}

const toneMeta: Record<string, { badgeClass: string; badgeLabel: string }> = {
  info: { badgeClass: 'badge-info', badgeLabel: 'Note' },
  warning: { badgeClass: 'badge-warning', badgeLabel: 'Heads up' },
  good: { badgeClass: 'badge-good', badgeLabel: 'Done' },
  critical: { badgeClass: 'badge-critical', badgeLabel: 'Error' },
}

/** Pops up a card for (a) notifications actually dispatched (SENT, SIMULATED
 *  or FAILED — not merely QUEUED, since sending is a separate explicit
 *  action) and (b) any one-off app toast fired via lib/toast's showToast()
 *  (e.g. a low-GMP warning when adding an IPO). RLS scopes which
 *  notification rows each viewer receives here. */
export function ToastHost() {
  const [toasts, setToasts] = useState<RenderedToast[]>([])
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set())

  // Plays the exit animation before actually removing the toast, instead of
  // snapping it out of the list instantly.
  function removeToast(id: string) {
    setLeavingIds((s) => new Set(s).add(id))
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
      setLeavingIds((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }, 200)
  }

  useEffect(() => {
    function pushNotification(notification: Notification) {
      if (notification.status === 'QUEUED') return
      const toast = notificationToast(notification)
      setToasts((t) => [...t, toast])
      setTimeout(() => removeToast(toast.id), 15000)
    }

    const channel = supabase
      .channel('notifications-toast')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => pushNotification(payload.new as Notification),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notifications' },
        (payload) => pushNotification(payload.new as Notification),
      )
      .subscribe()

    const unsubscribeToasts = onToast((toast) => {
      const meta = toneMeta[toast.tone] ?? toneMeta.info
      const rendered: RenderedToast = {
        id: toast.id,
        badgeClass: meta.badgeClass,
        badgeLabel: meta.badgeLabel,
        message: toast.message,
      }
      setToasts((t) => [...t, rendered])
      setTimeout(() => removeToast(rendered.id), 8000)
    })

    return () => {
      supabase.removeChannel(channel)
      unsubscribeToasts()
    }
  }, [])

  function dismiss(id: string) {
    removeToast(id)
  }

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`card p-4 ${leavingIds.has(t.id) ? 'animate-toast-out' : 'animate-toast-in'}`}
          style={{ boxShadow: 'var(--shadow-lg)' }}
        >
          <div className="flex items-start justify-between gap-2">
            <span className={`badge ${t.badgeClass}`}>{t.badgeLabel}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="text-sm leading-none"
              style={{ color: 'var(--ink-muted)' }}
            >
              ×
            </button>
          </div>
          {t.title && (
            <p className="mt-2 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              {t.title}
            </p>
          )}
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-primary)' }}>
            {t.message}
          </p>
        </div>
      ))}
    </div>
  )
}
