// Called by Meta. GET = verification handshake. POST = delivery-status updates.
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WA_VERIFY_TOKEN = Deno.env.get('WA_VERIFY_TOKEN')!
const META_APP_SECRET = Deno.env.get('META_APP_SECRET')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

Deno.serve(async (req) => {
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode')
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')
    if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
      return new Response(challenge ?? '', { status: 200 })
    }
    return new Response('forbidden', { status: 403 })
  }

  if (req.method === 'POST') {
    const rawBody = await req.text()
    const signatureHeader = req.headers.get('x-hub-signature-256') ?? ''
    const valid = await verifySignature(rawBody, signatureHeader, META_APP_SECRET)
    if (!valid) return new Response('invalid signature', { status: 401 })

    try {
      const payload = JSON.parse(rawBody)
      // deno-lint-ignore no-explicit-any
      const statuses: any[] =
        payload?.entry?.flatMap(
          // deno-lint-ignore no-explicit-any
          (e: any) => e.changes?.flatMap((c: any) => c.value?.statuses ?? []) ?? [],
        ) ?? []

      for (const s of statuses) {
        await admin
          .from('notifications')
          .update({
            status: String(s.status).toUpperCase(),
            error_detail: s.errors ? JSON.stringify(s.errors) : null,
            updated_at: new Date().toISOString(),
          })
          .eq('wa_message_id', s.id)
      }
    } catch (err) {
      console.error('wa-webhook parse error', err)
    }

    // Always 200 quickly so Meta doesn't retry/backoff.
    return new Response('ok', { status: 200 })
  }

  return new Response('method not allowed', { status: 405 })
})

async function verifySignature(body: string, signatureHeader: string, secret: string): Promise<boolean> {
  const expected = signatureHeader.replace('sha256=', '')
  if (!expected) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const digest = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return digest === expected
}
