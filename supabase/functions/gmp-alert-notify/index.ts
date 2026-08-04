// Cron-triggered, daily at 4am (see migration 0040) — same x-cron-secret
// auth pattern as auto-import-ipos, since a scheduled job has no user
// session.
//
// For every saved IPO opening in exactly 2 days or exactly 1 day, if its
// GMP is above 15%, sends a heads-up WhatsApp message to every active
// demat holder. Idempotent per (ipo, holder, day-offset): notifications.ipo_id
// + demat_id + template_name is checked before sending, so a job that's
// retried (or fires twice due to a scheduler quirk) never double-sends —
// same guard shape as send-whatsapp's application-status idempotency check.
//
// Unlike applied/allotted notifications (queued, then an admin explicitly
// sends), this dispatches immediately — there's no admin present at 4am to
// click Send, and the whole point is the message going out ahead of the
// IPO's open date. Still respects the existing WA_ACCESS_TOKEN/
// WA_PHONE_NUMBER_ID simulate-fallback, so nothing real goes out until
// Meta setup is done.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeadersFor, handlePreflight } from '../_shared/cors.ts'
import { jsonResponse, logError, logRequest } from '../_shared/http.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET')!
const WA_ACCESS_TOKEN = Deno.env.get('WA_ACCESS_TOKEN') ?? ''
const WA_PHONE_NUMBER_ID = Deno.env.get('WA_PHONE_NUMBER_ID') ?? ''

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const GMP_THRESHOLD_PERCENT = 15

interface IpoRow {
  id: string
  company_name: string
  open_date: string
  close_date: string
  lot_size: number
  price_low: number | null
  price_high: number | null
  issue_size: string | null
  retail_issue_size: string | null
  shareholder_issue_size: string | null
  registrar: string
  gmp_notes: string | null
}

// Same extraction as web/src/lib/ipoGmp.ts's parseGmpPercent — duplicated
// rather than shared across the web/Deno boundary, it's a one-line regex.
function parseGmpPercent(gmpNotes: string | null): number | null {
  if (!gmpNotes) return null
  const match = gmpNotes.match(/(-?\d+(?:\.\d+)?)\s*%/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isNaN(value) ? null : value
}

function addDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function buildMessage(
  holderName: string,
  ipo: IpoRow,
  gmpPercent: number,
  dayLabel: '2 days' | '1 day',
): { text: string; params: string[] } {
  const lotAmount = ipo.price_high != null ? Math.round(ipo.lot_size * ipo.price_high) : null
  const sizeParts = [
    ipo.issue_size ? `Total size ${ipo.issue_size}` : null,
    ipo.retail_issue_size ? `Retail ${ipo.retail_issue_size}` : null,
    ipo.shareholder_issue_size ? `Shareholder quota ${ipo.shareholder_issue_size}` : null,
  ].filter(Boolean)

  const params = [
    holderName,
    ipo.company_name,
    dayLabel,
    `${ipo.open_date} to ${ipo.close_date}`,
    `${gmpPercent}%`,
    lotAmount != null ? `₹${lotAmount.toLocaleString('en-IN')}` : 'N/A',
    sizeParts.join(', ') || 'N/A',
    ipo.registrar,
  ]

  const text =
    `Hi ${holderName}, heads up — ${ipo.company_name} IPO opens in ${dayLabel} ` +
    `(${ipo.open_date} to ${ipo.close_date}) and GMP is running high at ${gmpPercent}%. ` +
    `Lot: ${ipo.lot_size} shares = ${lotAmount != null ? `₹${lotAmount.toLocaleString('en-IN')}` : 'N/A'}. ` +
    `${sizeParts.length > 0 ? sizeParts.join(', ') + '. ' : ''}` +
    `Registrar: ${ipo.registrar}. Worth a look if you're interested.`

  return { text, params }
}

async function sendOne(demat: { id: string; holder_name: string; phone_e164: string }, ipo: IpoRow, gmpPercent: number, offset: 2 | 1) {
  const templateName = offset === 2 ? 'gmp_alert_2d' : 'gmp_alert_1d'

  const { data: existing } = await admin
    .from('notifications')
    .select('id')
    .eq('ipo_id', ipo.id)
    .eq('demat_id', demat.id)
    .eq('template_name', templateName)
    .maybeSingle()
  if (existing) return 'skipped' as const

  const dayLabel = offset === 2 ? ('2 days' as const) : ('1 day' as const)
  const { params } = buildMessage(demat.holder_name, ipo, gmpPercent, dayLabel)
  const testMode = !WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID

  let status: string
  let wa_message_id: string | null = null
  let error_detail: string | null = null

  if (testMode) {
    status = 'SIMULATED'
  } else {
    const waResponse = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: demat.phone_e164,
        type: 'template',
        template: { name: templateName, language: { code: 'en' }, components: [{ type: 'body', parameters: params.map((v) => ({ type: 'text', text: v })) }] },
      }),
    })
    const result = await waResponse.json()
    wa_message_id = result?.messages?.[0]?.id ?? null
    status = waResponse.ok ? 'SENT' : 'FAILED'
    error_detail = waResponse.ok ? null : JSON.stringify(result?.error ?? result)
  }

  await admin.from('notifications').insert({
    ipo_id: ipo.id,
    demat_id: demat.id,
    type: 'GMP_ALERT',
    to_phone: demat.phone_e164,
    template_name: templateName,
    variables: { params },
    status,
    wa_message_id,
    error_detail,
  })

  return status === 'FAILED' ? ('failed' as const) : ('sent' as const)
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  logRequest('gmp-alert-notify', req)
  const cors = corsHeadersFor(req)

  const secret = req.headers.get('x-cron-secret')
  if (secret !== CRON_SECRET) {
    return new Response('unauthorized', { status: 401, headers: cors })
  }

  try {
    const today = new Date().toISOString().slice(0, 10)
    const in2Days = addDays(today, 2)
    const in1Day = addDays(today, 1)

    const { data: ipos } = await admin
      .from('ipos')
      .select(
        'id, company_name, open_date, close_date, lot_size, price_low, price_high, issue_size, retail_issue_size, shareholder_issue_size, registrar, gmp_notes',
      )
      .in('open_date', [in2Days, in1Day])

    const { data: holders } = await admin
      .from('demat_accounts')
      .select('id, holder_name, phone_e164')
      .eq('is_active', true)

    let sent = 0
    let skipped = 0
    let failed = 0

    for (const ipo of (ipos ?? []) as IpoRow[]) {
      const gmpPercent = parseGmpPercent(ipo.gmp_notes)
      if (gmpPercent === null || gmpPercent <= GMP_THRESHOLD_PERCENT) continue

      const offset: 2 | 1 = ipo.open_date === in2Days ? 2 : 1
      for (const demat of (holders ?? []) as { id: string; holder_name: string; phone_e164: string }[]) {
        const result = await sendOne(demat, ipo, gmpPercent, offset)
        if (result === 'sent') sent++
        else if (result === 'skipped') skipped++
        else failed++
      }
    }

    return jsonResponse({ sent, skipped, failed, ran_at: new Date().toISOString() })
  } catch (err) {
    logError('gmp-alert-notify', err)
    return jsonResponse({ error: 'internal error' }, 500)
  }
})
