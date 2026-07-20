// Triggered by a Supabase Database Webhook on `applications` (INSERT -> ipo_applied,
// UPDATE where status changes to ALLOTTED -> ipo_allotted). Also accepts a client-invoked
// retry: { retry_notification_id } from an authenticated admin, used by the Notifications
// log's "Retry" button.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, handlePreflight } from '../_shared/cors.ts'

// Both empty until Meta/WhatsApp setup (doc 06) is done — sendForApplication()
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

    if (body.retry_notification_id) {
      return await handleRetry(req, body.retry_notification_id)
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

    await sendForApplication(record.id, templateKind)
    return new Response('ok', { status: 200, headers: corsHeaders })
  } catch (err) {
    console.error(err)
    return new Response('error', { status: 500, headers: corsHeaders })
  }
})

async function handleRetry(req: Request, notificationId: string): Promise<Response> {
  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const { data: userData } = await admin.auth.getUser(jwt)
  if (!userData?.user) return new Response('unauthorized', { status: 401, headers: corsHeaders })

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single()
  if (profile?.role !== 'admin') return new Response('forbidden', { status: 403, headers: corsHeaders })

  const { data: notif } = await admin
    .from('notifications')
    .select('*')
    .eq('id', notificationId)
    .single()
  if (!notif?.application_id) return new Response('not found', { status: 404, headers: corsHeaders })

  const templateKind: TemplateKind = notif.type === 'ALLOTTED' ? 'ipo_allotted' : 'ipo_applied'
  await sendForApplication(notif.application_id, templateKind, notificationId)
  return new Response('ok', { status: 200, headers: corsHeaders })
}

async function sendForApplication(
  applicationId: string,
  templateKind: TemplateKind,
  existingNotificationId?: string,
) {
  const notifType = templateKind === 'ipo_applied' ? 'APPLIED' : 'ALLOTTED'

  if (!existingNotificationId) {
    const { data: existing } = await admin
      .from('notifications')
      .select('id')
      .eq('application_id', applicationId)
      .eq('type', notifType)
      .neq('status', 'FAILED')
      .maybeSingle()
    if (existing) return // idempotency: webhook redelivery guard
  }

  const { data: app } = await admin
    .from('applications')
    .select(
      'id, demat_id, lots, bid_amount, ipos(company_name, listing_date), demat_accounts(holder_name, phone_e164), bank_accounts(bank_name, last4)',
    )
    .eq('id', applicationId)
    .single()
  if (!app) return

  const holderName = app.demat_accounts.holder_name as string
  const phone = app.demat_accounts.phone_e164 as string
  const companyName = app.ipos.company_name as string
  const bank = app.bank_accounts
    ? `${app.bank_accounts.bank_name} ••${app.bank_accounts.last4}`
    : 'your linked bank'

  const variables =
    templateKind === 'ipo_applied'
      ? [holderName, companyName, bank, `${app.lots} lot(s) / ₹${app.bid_amount ?? '—'}`]
      : [holderName, companyName, 'ALLOTTED', (app.ipos.listing_date as string | null) ?? 'TBA']

  const testMode = !WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID

  let notifRow: Record<string, unknown>
  if (testMode) {
    notifRow = {
      application_id: applicationId,
      demat_id: app.demat_id,
      type: notifType,
      to_phone: phone,
      template_name: templateKind,
      variables: { params: variables },
      wa_message_id: null,
      status: 'SIMULATED',
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
        to: phone,
        type: 'template',
        template: {
          name: templateKind,
          language: { code: 'en' },
          components: [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: v })) }],
        },
      }),
    })
    const result = await waResponse.json()
    notifRow = {
      application_id: applicationId,
      demat_id: app.demat_id,
      type: notifType,
      to_phone: phone,
      template_name: templateKind,
      variables: { params: variables },
      wa_message_id: result?.messages?.[0]?.id ?? null,
      status: waResponse.ok ? 'SENT' : 'FAILED',
      error_detail: waResponse.ok ? null : JSON.stringify(result?.error ?? result),
      updated_at: new Date().toISOString(),
    }
  }

  if (existingNotificationId) {
    await admin.from('notifications').update(notifRow).eq('id', existingNotificationId)
  } else {
    await admin.from('notifications').insert(notifRow)
  }
}
