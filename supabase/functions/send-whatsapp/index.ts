// Triggered by a Supabase Database Webhook on `applications` (INSERT -> ipo_applied,
// UPDATE where status changes to ALLOTTED -> ipo_allotted). This only QUEUES a
// notification row — it does not send anything. Sending is a separate, explicit
// admin action: { notification_id } from an authenticated admin, used by the
// "Send" button (on a QUEUED row) and "Retry" button (on a FAILED row) in the UI.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, handlePreflight } from '../_shared/cors.ts'

// Both empty until Meta/WhatsApp setup (doc 06) is done — dispatchNotification()
// simulates instead of calling the real Graph API while either is unset, so this
// flips over to real sending automatically the moment the secrets are set.
const WA_ACCESS_TOKEN = Deno.env.get('WA_ACCESS_TOKEN') ?? ''
const WA_PHONE_NUMBER_ID = Deno.env.get('WA_PHONE_NUMBER_ID') ?? ''
const DB_WEBHOOK_SECRET = Deno.env.get('DB_WEBHOOK_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

type TemplateKind = 'ipo_applied' | 'ipo_allotted'

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  try {
    const body = await req.json()

    if (body.notification_id) {
      return await handleDispatch(req, body.notification_id)
    }

    const secret = req.headers.get('x-webhook-secret')
    if (secret !== DB_WEBHOOK_SECRET) {
      return new Response('unauthorized', { status: 401, headers: corsHeaders })
    }

    const { type, table, record, old_record } = body
    if (table !== 'applications') return new Response('ignored', { status: 200, headers: corsHeaders })

    let templateKind: TemplateKind | null = null
    if (type === 'INSERT') templateKind = 'ipo_applied'
    if (type === 'UPDATE' && old_record?.status !== record.status && record.status === 'ALLOTTED') {
      templateKind = 'ipo_allotted'
    }
    if (!templateKind) return new Response('ignored', { status: 200, headers: corsHeaders })

    await queueForApplication(record.id, templateKind)
    return new Response('ok', { status: 200, headers: corsHeaders })
  } catch (err) {
    console.error(err)
    return new Response('error', { status: 500, headers: corsHeaders })
  }
})

async function handleDispatch(req: Request, notificationId: string): Promise<Response> {
  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const { data: userData } = await admin.auth.getUser(jwt)
  if (!userData?.user) return new Response('unauthorized', { status: 401, headers: corsHeaders })

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single()
  if (profile?.role !== 'admin') return new Response('forbidden', { status: 403, headers: corsHeaders })

  await dispatchNotification(notificationId)
  return new Response('ok', { status: 200, headers: corsHeaders })
}

// Builds the message content and inserts it as QUEUED. No network call — the
// admin sends it explicitly afterward via dispatchNotification().
async function queueForApplication(applicationId: string, templateKind: TemplateKind) {
  const notifType = templateKind === 'ipo_applied' ? 'APPLIED' : 'ALLOTTED'

  const { data: existing } = await admin
    .from('notifications')
    .select('id')
    .eq('application_id', applicationId)
    .eq('type', notifType)
    .maybeSingle()
  if (existing) return // idempotency: webhook redelivery guard

  const { data: app } = await admin
    .from('applications')
    .select(
      'id, demat_id, lots, bid_amount, ipos(company_name, listing_date), demat_accounts(holder_name, phone_e164), bank_accounts(account_holder_name, bank_name, last4, upi_id)',
    )
    .eq('id', applicationId)
    .single()
  if (!app) return

  const holderName = app.demat_accounts.holder_name as string
  const phone = app.demat_accounts.phone_e164 as string
  const companyName = app.ipos.company_name as string
  const b = app.bank_accounts as { bank_name?: string; last4?: string; upi_id?: string } | null
  const bank = b
    ? [b.bank_name && b.last4 ? `${b.bank_name} ••${b.last4}` : b.bank_name, b.upi_id].filter(Boolean).join(' / ') ||
      'your linked bank'
    : 'your linked bank'

  const variables =
    templateKind === 'ipo_applied'
      ? [holderName, companyName, bank, `${app.lots} lot(s) / ₹${app.bid_amount ?? '—'}`]
      : [holderName, companyName, 'ALLOTTED', (app.ipos.listing_date as string | null) ?? 'TBA']

  await admin.from('notifications').insert({
    application_id: applicationId,
    demat_id: app.demat_id,
    type: notifType,
    to_phone: phone,
    template_name: templateKind,
    variables: { params: variables },
    status: 'QUEUED',
  })
}

// Actually sends (or simulates) a QUEUED/FAILED notification and updates its status.
// A no-op if the row has already gone out, so double-clicks / redelivery are safe.
async function dispatchNotification(notificationId: string) {
  const { data: notif } = await admin.from('notifications').select('*').eq('id', notificationId).single()
  if (!notif) return
  if (notif.status !== 'QUEUED' && notif.status !== 'FAILED') return

  const params = (notif.variables as { params?: string[] } | null)?.params ?? []
  const testMode = !WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID

  let update: Record<string, unknown>
  if (testMode) {
    update = {
      status: 'SIMULATED',
      wa_message_id: null,
      error_detail: null,
      updated_at: new Date().toISOString(),
    }
  } else {
    const waResponse = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: notif.to_phone,
        type: 'template',
        template: {
          name: notif.template_name,
          language: { code: 'en' },
          components: [{ type: 'body', parameters: params.map((v) => ({ type: 'text', text: v })) }],
        },
      }),
    })
    const result = await waResponse.json()
    update = {
      wa_message_id: result?.messages?.[0]?.id ?? null,
      status: waResponse.ok ? 'SENT' : 'FAILED',
      error_detail: waResponse.ok ? null : JSON.stringify(result?.error ?? result),
      updated_at: new Date().toISOString(),
    }
  }

  await admin.from('notifications').update(update).eq('id', notificationId)
}
