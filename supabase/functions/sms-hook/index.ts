// Supabase's "Send SMS" Auth Hook — called by Supabase Auth itself (not the
// browser) every time phone OTP sign-in needs to deliver a code. Supabase
// still generates and verifies the OTP; this function's only job is
// delivering the exact code it's given via MSG91, since MSG91 isn't one of
// Supabase's natively-supported SMS providers (Twilio/MessageBird/Vonage/
// TextLocal are) but has much smoother DLT registration for Indian numbers.
//
// Wire-up (after enabling the hook in Dashboard -> Authentication -> Hooks):
//   supabase secrets set SEND_SMS_HOOK_SECRET="v1,whsec_..."   (from the hook's "Secret" field)
//   supabase secrets set MSG91_AUTH_KEY="..."                  (Dashboard -> API -> Configure)
//   supabase secrets set MSG91_TEMPLATE_ID="..."                (DLT-approved Flow template with an OTP variable)
// Deploy with: supabase functions deploy sms-hook --no-verify-jwt
import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0'
import { jsonError, jsonResponse, logError, logRequest } from '../_shared/http.ts'

const SEND_SMS_HOOK_SECRET = Deno.env.get('SEND_SMS_HOOK_SECRET') ?? ''
const MSG91_AUTH_KEY = Deno.env.get('MSG91_AUTH_KEY') ?? ''
const MSG91_TEMPLATE_ID = Deno.env.get('MSG91_TEMPLATE_ID') ?? ''

interface HookPayload {
  user: { phone?: string }
  sms: { otp: string }
}

Deno.serve(async (req) => {
  logRequest('sms-hook', req)
  if (req.method !== 'POST') return jsonError('method not allowed', 405)

  // Closed by default: an empty secret (hook not wired up yet) must reject
  // every request rather than skip verification.
  if (!SEND_SMS_HOOK_SECRET) return jsonError('sms hook not configured', 503)

  const rawBody = await req.text()
  let user: HookPayload['user']
  let sms: HookPayload['sms']
  try {
    const base64Secret = SEND_SMS_HOOK_SECRET.replace('v1,whsec_', '')
    const wh = new Webhook(base64Secret)
    ;({ user, sms } = wh.verify(rawBody, Object.fromEntries(req.headers)) as HookPayload)
  } catch (err) {
    logError('sms-hook: signature verification failed', err)
    return jsonError('invalid signature', 401)
  }

  const phone = user?.phone
  if (!phone || !sms?.otp) return jsonError('missing phone or otp', 400)

  if (!MSG91_AUTH_KEY || !MSG91_TEMPLATE_ID) {
    logError('sms-hook', new Error('MSG91_AUTH_KEY/MSG91_TEMPLATE_ID not set'))
    return jsonError('sms provider not configured', 503)
  }

  try {
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authkey: MSG91_AUTH_KEY },
      body: JSON.stringify({
        template_id: MSG91_TEMPLATE_ID,
        short_url: '0',
        recipients: [{ mobiles: phone.replace('+', ''), OTP: sms.otp }],
      }),
    })
    if (!res.ok) {
      logError('sms-hook: MSG91 send failed', new Error(`${res.status} ${await res.text()}`))
      return jsonError('sms provider error', 502)
    }
  } catch (err) {
    logError('sms-hook: MSG91 request threw', err)
    return jsonError('sms provider error', 502)
  }

  // Empty 200 body is what Supabase Auth expects for a successful hook.
  return jsonResponse({})
})
