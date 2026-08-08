// Admin, the member a demat account is linked to, or a member whose linked
// bank/UPI account funded an application on that demat (so they can
// self-check allotment status on the registrar's site, which needs the
// real PAN — a masked one is useless for that). Decrypts a PAN for the
// "Copy PAN" / edit-account action and logs the access.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeadersFor, handlePreflight } from '../_shared/cors.ts'
import { jsonError, jsonResponse, logError, logRequest } from '../_shared/http.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PAN_KEY = Deno.env.get('PAN_KEY')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  logRequest('reveal-pan', req)
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
    const { demat_id } = body
    if (!demat_id) return jsonError('demat_id is required', 400, cors)

    let isOwner = false
    if (!isAdmin) {
      const { data: account } = await admin
        .from('demat_accounts')
        .select('linked_user_id')
        .eq('id', demat_id)
        .single()
      isOwner = account?.linked_user_id === userData.user.id

      if (!isOwner) {
        // Funder check: does the caller's own linked bank/UPI account fund
        // at least one application on this demat account?
        const { data: fundedApp } = await admin
          .from('applications')
          .select('id, bank_accounts!inner(linked_user_id)')
          .eq('demat_id', demat_id)
          .eq('bank_accounts.linked_user_id', userData.user.id)
          .limit(1)
          .maybeSingle()
        if (!fundedApp) {
          return new Response('forbidden', { status: 403, headers: cors })
        }
      }
    }

    const { data: pan, error } = await admin.rpc('decrypt_pan', { p_demat_id: demat_id, p_key: PAN_KEY })
    if (error || !pan) return jsonError(error?.message ?? 'not found', 404, cors)

    // is_self_reveal only when literally revealing your own account's PAN —
    // was previously `!isAdmin`, which was accurate back when a non-admin
    // caller could only ever be the account's own owner; no longer true now
    // that a funder can also reveal someone else's PAN.
    await admin.from('pan_access_log').insert({ demat_id, accessed_by: userData.user.id, is_self_reveal: isOwner })

    return jsonResponse({ pan }, 200, cors)
  } catch (err) {
    logError('reveal-pan', err)
    return jsonError('Internal error', 500, corsHeadersFor(req))
  }
})
