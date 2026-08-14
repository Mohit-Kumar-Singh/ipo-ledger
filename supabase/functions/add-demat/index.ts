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
    const {
      demat_id,
      holder_name,
      phone_e164,
      phone_digits,
      pan,
      dp_client_id,
      profit_share_percent,
      is_active,
      application_name,
      login_email,
      login_password,
      app_password,
      t_pin,
      logged_in_notes,
    } = body

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

    // Fast path: just flipping the active flag on an existing account — no
    // PAN reveal/re-entry needed, so this is a plain column update, not a
    // trip through the encryption RPCs.
    if (demat_id && holder_name === undefined && pan === undefined && typeof is_active === 'boolean') {
      const { error } = await admin.from('demat_accounts').update({ is_active }).eq('id', demat_id)
      if (error) return jsonError(error.message, 500, cors)
      return jsonResponse({ id: demat_id }, 200, cors)
    }

    if (!holder_name || !pan) {
      return jsonError('holder_name and pan are required', 400, cors)
    }

    const profitShare = profit_share_percent === undefined || profit_share_percent === null || profit_share_percent === ''
      ? 25
      : Number(profit_share_percent)
    if (Number.isNaN(profitShare) || profitShare < 0 || profitShare > 100) {
      return jsonError('Profit sharing cut must be a number between 0 and 100.', 400, cors)
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

    // Neither RPC touches linked_user_id/profit_share_percent/is_active/the
    // broker-app credential fields — all are set (or re-set) here as a plain
    // follow-up update under the service role. The credential fields are
    // deliberately plaintext (no encryption RPC, unlike PAN) — undefined
    // means "field wasn't in the request" (leave alone on an update), an
    // explicit empty string/null clears it.
    const followUp: Record<string, unknown> = {
      profit_share_percent: profitShare,
      is_active: typeof is_active === 'boolean' ? is_active : true,
    }
    if (application_name !== undefined) followUp.application_name = application_name || null
    if (login_email !== undefined) followUp.login_email = login_email || null
    if (login_password !== undefined) followUp.login_password = login_password || null
    if (app_password !== undefined) followUp.app_password = app_password || null
    if (t_pin !== undefined) followUp.t_pin = t_pin || null
    if (logged_in_notes !== undefined) followUp.logged_in_notes = logged_in_notes || null
    if (!isAdmin && !demat_id) followUp.linked_user_id = userData.user.id
    await admin.from('demat_accounts').update(followUp).eq('id', newId)

    return jsonResponse({ id: newId }, 200, cors)
  } catch (err) {
    logError('add-demat', err)
    return jsonError('Internal error', 500, corsHeadersFor(req))
  }
})
