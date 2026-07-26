// Any signed-in user. Encrypts the PAN with PAN_KEY (a function secret, never
// exposed to the browser or stored in Postgres config) and inserts or
// updates the demat account — pass demat_id to update an existing row
// instead of creating a new one.
//
// Admins may create/edit any account. Members may only create their own
// (auto-linked to their own user id, ignoring any client-supplied link) or
// edit an account already linked to them.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeadersFor, handlePreflight } from '../_shared/cors.ts'
import { jsonError, jsonResponse, logError, logRequest } from '../_shared/http.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PAN_KEY = Deno.env.get('PAN_KEY')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// Indian mobile number: exactly 10 digits, stored with a +91 prefix.
const PHONE_DIGITS_RE = /^[0-9]{10}$/
// Standard PAN format: 5 letters, 4 digits, 1 letter (e.g. ABCPD1234E).
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  logRequest('add-demat', req)
  const cors = corsHeadersFor(req)

  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
    const { data: userData } = await admin.auth.getUser(jwt)
    if (!userData?.user) return new Response('unauthorized', { status: 401, headers: cors })

    const { data: profile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single()
    const isAdmin = profile?.role === 'admin'

    const body = await req.json().catch(() => ({}))
    const { demat_id, holder_name, phone_e164, phone_digits, pan, dp_client_id } = body
    if (!holder_name || !pan) {
      return jsonError('holder_name and pan are required', 400, cors)
    }

    if (!isAdmin && demat_id) {
      const { data: existing } = await admin
        .from('demat_accounts')
        .select('linked_user_id')
        .eq('id', demat_id)
        .single()
      if (existing?.linked_user_id !== userData.user.id) {
        return new Response('forbidden', { status: 403, headers: cors })
      }
    }

    // Accept either a bare 10-digit number (phone_digits) or a full +91-prefixed
    // value (phone_e164) for compatibility; validate the underlying 10 digits.
    const digits = phone_digits ?? String(phone_e164 ?? '').replace(/^\+91/, '')
    if (!PHONE_DIGITS_RE.test(digits)) {
      return jsonError('Phone number must be exactly 10 digits.', 400, cors)
    }
    const normalizedPhone = `+91${digits}`

    const normalizedPan = String(pan).toUpperCase().trim()
    if (!PAN_RE.test(normalizedPan)) {
      return jsonError('PAN must be in the format ABCPD1234E (5 letters, 4 digits, 1 letter).', 400, cors)
    }

    const rpcName = demat_id ? 'update_demat_encrypted' : 'insert_demat_encrypted'
    const rpcArgs: Record<string, unknown> = {
      p_name: holder_name,
      p_phone: normalizedPhone,
      p_pan: normalizedPan,
      p_key: PAN_KEY,
      p_dp_client_id: dp_client_id ?? null,
    }
    if (demat_id) rpcArgs.p_id = demat_id

    const { data, error } = await admin.rpc(rpcName, rpcArgs)

    if (error) {
      const status = error.code === '23505' ? 409 : 500
      return jsonError(error.message, status, cors)
    }

    const newId = demat_id ?? data
    if (!isAdmin && !demat_id) {
      await admin.from('demat_accounts').update({ linked_user_id: userData.user.id }).eq('id', newId)
    }

    return jsonResponse({ id: newId }, 200, cors)
  } catch (err) {
    logError('add-demat', err)
    return jsonError('Internal error', 500, corsHeadersFor(req))
  }
})
