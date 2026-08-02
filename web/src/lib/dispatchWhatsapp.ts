import { supabase } from './supabase'
import { buildWaMeLink, renderMessageBody } from './notificationTemplates'
import { isMobileDevice } from './device'
import type { Notification } from '../types/database'

function openWhatsApp(url: string) {
  if (isMobileDevice()) {
    // A direct top-level navigation is what actually hands off to the
    // native WhatsApp app — opening a new tab and redirecting it (the
    // previous approach) left users looking at a blank/loading browser tab
    // instead, since some mobile browsers don't treat a background tab's
    // programmatic redirect as an app-link the way they do a real navigation.
    window.location.href = url
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

// Builds the message from the notification's own fields, marks it sent, and
// opens WhatsApp. Order matters and differs by device:
//  - Mobile: the update must finish BEFORE navigating, since a same-tab
//    redirect can abort an in-flight request once the page starts unloading.
//  - Desktop: window.open() must happen synchronously (no preceding await)
//    or browsers silently block it as a popup, so the tab opens first and
//    the write happens after — that's safe because the current tab never
//    unloads for a new-tab popup.
export async function openWhatsAppForNotification(
  notification: Pick<Notification, 'id' | 'to_phone' | 'template_name' | 'variables'>,
  signerName: string,
): Promise<void> {
  const params = (notification.variables as { params?: string[] } | null)?.params ?? []
  const text = renderMessageBody(notification.template_name, params, signerName)
  const url = buildWaMeLink(notification.to_phone, text)
  const markSent = () =>
    supabase.from('notifications').update({ status: 'SENT', updated_at: new Date().toISOString() }).eq('id', notification.id)

  if (isMobileDevice()) {
    await markSent()
    openWhatsApp(url)
  } else {
    openWhatsApp(url)
    await markSent()
  }
}

// Ad-hoc sends that aren't tied to a tracked `notifications` row (e.g. a
// one-off payout calculation) — just open WhatsApp with the given text,
// device-aware, no DB write to mark sent.
export function sendCustomWhatsapp(phone: string, text: string): void {
  openWhatsApp(buildWaMeLink(phone, text))
}

// Admin dispatch: try the real Cloud API first, same as always. If Meta
// isn't configured yet (the function reports back SIMULATED) and this is a
// phone, fall back to the same manual-send flow members already use. This
// stops firing on its own the moment Meta is configured, since a real send
// comes back SENT/FAILED rather than SIMULATED, so there's no flag to
// remember to flip back once Meta setup is done. (Desktop never falls back —
// the Cloud API result, real or SIMULATED, is just shown via the toast.)
export async function dispatchAdminWhatsapp(notificationId: string, signerName: string): Promise<void> {
  await supabase.functions.invoke('send-whatsapp', { body: { notification_id: notificationId } })

  if (!isMobileDevice()) return

  const { data: fresh } = await supabase
    .from('notifications')
    .select('id, status, to_phone, template_name, variables')
    .eq('id', notificationId)
    .single()
  if (fresh?.status !== 'SIMULATED') return

  await openWhatsAppForNotification(fresh, signerName)
}
