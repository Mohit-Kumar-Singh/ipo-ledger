import { useEffect, useState } from 'react'
import { XIcon } from '@primer/octicons-react'
import { supabase } from '../lib/supabase'
import { onToast } from '../lib/toast'
import { useAuth } from '../contexts/AuthContext'
import { renderMessageBody } from '../lib/notificationTemplates'
import { Panel } from './Panel'
import type { Notification } from '../types/database'

// Same tone names Primer's <Label variant> used — kept as the vocabulary
// this file already speaks, mapped onto this app's own .badge-* classes
// instead of importing @primer/react for one small pill.
type LabelVariant = 'accent' | 'attention' | 'success' | 'danger' | 'secondary'
const LABEL_BADGE_CLASS: Record<LabelVariant, string> = {
  accent: 'badge-info',
  attention: 'badge-warning',
  success: 'badge-good',
  danger: 'badge-critical',
  secondary: 'badge-neutral',
}

interface RenderedToast {
  id: string
  labelVariant: LabelVariant
  labelText: string
  title?: string
  message: string
}

function notificationToast(n: Notification): RenderedToast {
  const meta =
    n.status === 'SIMULATED'
      ? ({ label: 'Simulated WhatsApp (no Meta setup yet)', variant: 'attention' } as const)
      : n.status === 'FAILED'
        ? ({ label: 'WhatsApp send failed', variant: 'danger' } as const)
        : ({ label: 'WhatsApp sent', variant: 'success' } as const)
  const params = (n.variables as { params?: string[] } | null)?.params ?? []
  return {
    id: `${n.id}-${n.status}-${Date.now()}`,
    labelVariant: meta.variant,
    labelText: meta.label,
    title: `To ${n.to_phone}`,
    // Was a separately hand-maintained TEMPLATE_PREVIEWS dict duplicating
    // renderMessageBody's copy — it had already drifted twice: missing the
    // 'ipo_applied_bank_holder' (funder) template entirely (fell through to
    // a raw `templateName: params` fallback) and missing the portal-link
    // line added to renderMessageBody. Calling the real function means this
    // preview can't drift from what's actually sent again.
    message: renderMessageBody(n.template_name, params),
  }
}

const toneMeta: Record<string, { variant: LabelVariant; label: string }> = {
  info: { variant: 'accent', label: 'Note' },
  warning: { variant: 'attention', label: 'Heads up' },
  good: { variant: 'success', label: 'Done' },
  critical: { variant: 'danger', label: 'Error' },
}

/** Pops up a card for (a) notifications actually dispatched (SENT, SIMULATED
 *  or FAILED — not merely QUEUED, since sending is a separate explicit
 *  action) and (b) any one-off app toast fired via lib/toast's showToast()
 *  (e.g. a low-GMP warning when adding an IPO). RLS scopes which
 *  notification rows each viewer receives here. */
export function ToastHost() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
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

  function pushToast(toast: RenderedToast, ttlMs: number) {
    setToasts((t) => [...t, toast])
    setTimeout(() => removeToast(toast.id), ttlMs)
  }

  // A new demat/bank link request used to get a permanent "pending link
  // requests" tile + list on the Dashboard — moved to a one-off toast plus
  // review on Profile instead (same lightweight "something needs your
  // attention" signal the high-GMP alert already uses), so it doesn't sit
  // around as a standing dashboard fixture once seen. Admin-only: a member
  // has no review action to take on someone else's link request anyway.
  useEffect(() => {
    if (!isAdmin) return
    async function announceLinkRequest(kind: 'demat' | 'bank', memberId: string) {
      const { data } = await supabase.rpc('resolve_profile_names', { p_ids: [memberId] })
      const name = (data as { id: string; full_name: string }[] | null)?.[0]?.full_name ?? 'Someone'
      pushToast(
        {
          id: `link-request-${kind}-${memberId}-${Date.now()}`,
          labelVariant: 'accent',
          labelText: 'New link request',
          message: `${name} requested to link a ${kind === 'demat' ? 'demat' : 'bank/UPI'} account — review on your Profile.`,
        },
        15000,
      )
    }

    const linkChannel = supabase
      .channel('link-requests-toast')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'demat_link_requests' }, (payload) => {
        announceLinkRequest('demat', (payload.new as { member_id: string }).member_id)
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bank_link_requests' }, (payload) => {
        announceLinkRequest('bank', (payload.new as { member_id: string }).member_id)
      })
      .subscribe()
    return () => {
      supabase.removeChannel(linkChannel)
    }
  }, [isAdmin])

  useEffect(() => {
    function pushNotification(notification: Notification) {
      if (notification.status === 'QUEUED') return
      pushToast(notificationToast(notification), 15000)
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
        (payload) => {
          // Deleting an application nulls out notifications.application_id
          // (ON DELETE SET NULL) — a real UPDATE on this row, but not a
          // dispatch. Only pop the toast when status actually changed, not
          // on every touch to the row (needs replica identity FULL on
          // notifications for old.status to be present here).
          const oldStatus = (payload.old as Partial<Notification> | null)?.status
          const newNotification = payload.new as Notification
          if (oldStatus === newNotification.status) return
          pushNotification(newNotification)
        },
      )
      .subscribe()

    const unsubscribeToasts = onToast((toast) => {
      const meta = toneMeta[toast.tone] ?? toneMeta.info
      const rendered: RenderedToast = {
        id: toast.id,
        labelVariant: meta.variant,
        labelText: meta.label,
        message: toast.message,
      }
      setToasts((t) => [...t, rendered])
      setTimeout(() => removeToast(rendered.id), 10000)
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
        <Panel
          key={t.id}
          className={`p-4 ${leavingIds.has(t.id) ? 'animate-toast-out' : 'animate-toast-in'}`}
          // Was var(--shadow-floating-large) — same never-defined-token bug
          // AppShell's own aside shadow had, silently rendering no shadow at all.
          style={{ boxShadow: 'var(--shadow-lg)' }}
        >
          <div className="flex items-start justify-between gap-2">
            <span className={`badge ${LABEL_BADGE_CLASS[t.labelVariant]}`}>{t.labelText}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--hover-surface)]"
              style={{ color: 'var(--ink-muted)' }}
            >
              <XIcon size={14} />
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
        </Panel>
      ))}
    </div>
  )
}
