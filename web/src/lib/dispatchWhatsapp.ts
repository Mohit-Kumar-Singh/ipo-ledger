import { supabase } from './supabase'
import { buildWaMeLink, renderMessageBody } from './notificationTemplates'
import { isMobileDevice } from './device'

// Admin dispatch: try the real Cloud API first, same as always. If Meta
// isn't configured yet (the function reports back SIMULATED) and this is a
// phone, fall back to opening the WhatsApp app directly to the recipient's
// chat — same manual-send flow members already use — then mark it sent.
// This stops firing on its own the moment Meta is configured, since a real
// send comes back SENT/FAILED rather than SIMULATED, so there's no flag to
// remember to flip back once Meta setup is done.
//
// window.open() has to happen synchronously inside the click handler or
// mobile Safari/Chrome's popup blocker silently swallows it — by the time
// we know (after awaiting the dispatch call) whether we actually need it,
// the click's "user gesture" window has already closed. So on mobile we
// speculatively open a blank tab right away and either redirect it to wa.me
// or close it once we know the outcome.
export async function dispatchAdminWhatsapp(notificationId: string, signerName: string): Promise<void> {
  const speculativeTab = isMobileDevice() ? window.open('about:blank', '_blank') : null

  await supabase.functions.invoke('send-whatsapp', { body: { notification_id: notificationId } })

  if (!speculativeTab) return

  const { data: fresh } = await supabase
    .from('notifications')
    .select('status, to_phone, template_name, variables')
    .eq('id', notificationId)
    .single()

  if (fresh?.status !== 'SIMULATED') {
    speculativeTab.close()
    return
  }

  const params = (fresh.variables as { params?: string[] } | null)?.params ?? []
  const text = renderMessageBody(fresh.template_name, params, signerName)
  speculativeTab.location.href = buildWaMeLink(fresh.to_phone, text)
  await supabase
    .from('notifications')
    .update({ status: 'SENT', updated_at: new Date().toISOString() })
    .eq('id', notificationId)
}
