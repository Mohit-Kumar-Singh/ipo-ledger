// Admin-only. Decrypts a PAN for the "Copy PAN" action and logs the access.
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
    if (profile?.role !== 'admin') return new Response('forbidden', { status: 403, headers: cors })

    const body = await req.json().catch(() => ({}))
    const { demat_id } = body
    if (!demat_id) return jsonError('demat_id is required', 400, cors)

    const { data: pan, error } = await admin.rpc('decrypt_pan', { p_demat_id: demat_id, p_key: PAN_KEY })
    if (error || !pan) return jsonError(error?.message ?? 'not found', 404, cors)

    await admin.from('pan_access_log').insert({ demat_id, accessed_by: userData.user.id })

    return jsonResponse({ pan }, 200, cors)
  } catch (err) {
    logError('reveal-pan', err)
    return jsonError('Internal error', 500, corsHeadersFor(req))
  }
})
