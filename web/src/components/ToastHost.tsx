import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { AlertIcon, CheckIcon, InfoIcon, XIcon } from '@primer/octicons-react'
import { supabase } from '../lib/supabase'
import { onToast, type ToastTone } from '../lib/toast'
import { useAuth } from '../contexts/AuthContext'
import { renderMessageBody } from '../lib/notificationTemplates'
import type { Notification } from '../types/database'

interface RenderedToast {
  id: string
  tone: ToastTone
  // Small caps line above the heading (what kind of event this is) — only
  // used when there's a separate `title`, e.g. "WhatsApp sent" over "To +91…".
  labelText: string
  title?: string
  message: string
  ttlMs: number
}

const TONE_ICON: Record<ToastTone, typeof CheckIcon> = {
  info: InfoIcon,
  good: CheckIcon,
  warning: AlertIcon,
  critical: XIcon,
}

// Heading for a plain showToast() message — worded for a person, not a log
// (see lib/friendlyError.ts): "Couldn't do that", not "Error".
const TONE_LABEL: Record<ToastTone, string> = {
  info: 'Note',
  warning: 'Heads up',
  good: 'Done',
  critical: "Couldn't do that",
}

// Failures stay a little longer — they carry something to read and act on.
const DEFAULT_TTL_MS = 5000
const CRITICAL_TTL_MS = 7500

function notificationToast(n: Notification): RenderedToast {
  const meta: { label: string; tone: ToastTone } =
    n.status === 'SIMULATED'
      ? { label: 'Simulated WhatsApp (no Meta setup yet)', tone: 'warning' }
      : n.status === 'FAILED'
        ? { label: 'WhatsApp send failed', tone: 'critical' }
        : { label: 'WhatsApp sent', tone: 'good' }
  const params = (n.variables as { params?: string[] } | null)?.params ?? []
  return {
    id: `${n.id}-${n.status}-${Date.now()}`,
    tone: meta.tone,
    labelText: meta.label,
    title: `To ${n.to_phone}`,
    // Was a separately hand-maintained TEMPLATE_PREVIEWS dict duplicating
    // renderMessageBody's copy — it had already drifted twice: missing the
    // 'ipo_applied_bank_holder' (funder) template entirely (fell through to
    // a raw `templateName: params` fallback) and missing the portal-link
    // line added to renderMessageBody. Calling the real function means this
    // preview can't drift from what's actually sent again.
    message: renderMessageBody(n.template_name, params),
    ttlMs: meta.tone === 'critical' ? CRITICAL_TTL_MS : DEFAULT_TTL_MS,
  }
}

// One iOS-style notification banner. Tap it, press Esc/Enter, or swipe it up to
// dismiss; it stays on screen while a finger or the mouse is on it and picks
// its countdown back up afterwards, like a real banner.
function ToastCard({
  toast,
  leaving,
  onDismiss,
}: {
  toast: RenderedToast
  leaving: boolean
  onDismiss: (id: string) => void
}) {
  const Icon = TONE_ICON[toast.tone]
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const startY = useRef<number | null>(null)
  const remainingMs = useRef(toast.ttlMs)
  const paused = dragging || hovered

  useEffect(() => {
    if (paused || leaving) return
    const startedAt = Date.now()
    const timer = setTimeout(() => onDismiss(toast.id), remainingMs.current)
    return () => {
      clearTimeout(timer)
      // Left early (hover/press): keep whatever time was left, but never less
      // than 1.5s so it doesn't vanish the instant the finger lifts.
      remainingMs.current = Math.max(1500, remainingMs.current - (Date.now() - startedAt))
    }
  }, [paused, leaving, onDismiss, toast.id])

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    startY.current = e.clientY
    setDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // capture is a nicety (keeps the drag tracking off-element), not required
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (startY.current == null) return
    const dy = e.clientY - startY.current
    // Free upward, rubber-banded downward — same resistance iOS gives a
    // banner you try to pull the wrong way.
    setDragY(dy < 0 ? dy : dy * 0.12)
  }

  function endDrag(dismissAllowed: boolean) {
    const dy = dragY
    startY.current = null
    setDragging(false)
    // A small movement is a tap; a decent upward flick is a swipe. Both dismiss.
    if (dismissAllowed && (Math.abs(dy) < 6 || dy < -36)) onDismiss(toast.id)
    else setDragY(0)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onDismiss(toast.id)
    }
  }

  return (
    <div
      className={`pointer-events-auto w-full max-w-[26rem] ${leaving ? 'animate-ios-toast-out' : 'animate-ios-toast-in'}`}
    >
      <div
        role={toast.tone === 'critical' ? 'alert' : 'status'}
        tabIndex={0}
        aria-label={`${toast.title ?? toast.labelText}. ${toast.message} Press Enter to dismiss.`}
        data-tone={toast.tone}
        className="ios-toast"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
        onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setHovered(false)}
        onKeyDown={onKeyDown}
        style={{
          transform: `translateY(${dragY}px)`,
          opacity: dragY < 0 ? Math.max(0.35, 1 + dragY / 220) : 1,
          transition: dragging ? 'none' : 'transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.28s ease',
        }}
      >
        <div className="flex items-start gap-3 px-3.5 pt-3 pb-2">
          <span className="ios-toast-icon" aria-hidden="true">
            <Icon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              {toast.title ? (
                <span
                  className="truncate text-[11px] font-semibold tracking-wide uppercase"
                  style={{ color: 'var(--toast-body)' }}
                >
                  {toast.labelText}
                </span>
              ) : (
                <span className="truncate text-[15px] font-semibold" style={{ color: 'var(--toast-title)' }}>
                  {toast.labelText}
                </span>
              )}
              <span className="shrink-0 text-xs" style={{ color: 'var(--toast-body)', opacity: 0.75 }}>
                now
              </span>
            </div>
            {toast.title && (
              <p className="mt-0.5 truncate text-[15px] font-semibold" style={{ color: 'var(--toast-title)' }}>
                {toast.title}
              </p>
            )}
            <p className="mt-0.5 text-[14px] leading-snug whitespace-pre-line" style={{ color: 'var(--toast-body)' }}>
              {toast.message}
            </p>
          </div>
        </div>
        <div className="flex justify-center pb-1.5">
          <span className="ios-toast-grabber" />
        </div>
      </div>
    </div>
  )
}

/** Pops up an iOS-style glass banner for (a) notifications actually dispatched
 *  (SENT, SIMULATED or FAILED — not merely QUEUED, since sending is a separate
 *  explicit action) and (b) any one-off app toast fired via lib/toast's
 *  showToast() (e.g. a low-GMP warning when adding an IPO). RLS scopes which
 *  notification rows each viewer receives here. */
export function ToastHost() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [toasts, setToasts] = useState<RenderedToast[]>([])
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set())

  // Plays the exit animation before actually removing the toast, instead of
  // snapping it out of the list instantly. Stable identity (only setters) so
  // each card's countdown effect doesn't restart on every host render.
  const removeToast = useCallback((id: string) => {
    setLeavingIds((s) => (s.has(id) ? s : new Set(s).add(id)))
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
      setLeavingIds((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }, 240)
  }, [])

  function pushToast(toast: RenderedToast) {
    setToasts((t) => [...t, toast])
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
      const { data, error } = await supabase.rpc('resolve_profile_names', { p_ids: [memberId] })
      if (error) console.error('announceLinkRequest: resolve_profile_names failed', error)
      const name = (data as { id: string; full_name: string }[] | null)?.[0]?.full_name ?? 'Someone'
      pushToast({
        id: `link-request-${kind}-${memberId}-${Date.now()}`,
        tone: 'info',
        labelText: 'New link request',
        message: `${name} requested to link a ${kind === 'demat' ? 'demat' : 'bank/UPI'} account — review on your Profile.`,
        ttlMs: DEFAULT_TTL_MS,
      })
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
      pushToast(notificationToast(notification))
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
      pushToast({
        id: toast.id,
        tone: toast.tone,
        labelText: TONE_LABEL[toast.tone],
        message: toast.message,
        ttlMs: toast.tone === 'critical' ? CRITICAL_TTL_MS : DEFAULT_TTL_MS,
      })
    })

    return () => {
      supabase.removeChannel(channel)
      unsubscribeToasts()
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    // Top-center like iOS. .safe-top adds env(safe-area-inset-top) (mobile:
    // floored at 0.75rem even with no real notch — see its own comment in
    // index.css) so a banner on a phone clears the status bar / Dynamic
    // Island instead of sitting under it. pointer-events-none on the strip
    // so it never blocks taps on the page beside/between banners.
    <div
      className="safe-top pointer-events-none fixed inset-x-0 top-1 z-50 flex flex-col items-center gap-2 px-3"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} leaving={leavingIds.has(t.id)} onDismiss={removeToast} />
      ))}
    </div>
  )
}
