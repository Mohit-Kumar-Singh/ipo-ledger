// Admin-only. Encrypts the PAN with PAN_KEY (a function secret, never exposed
// to the browser or stored in Postgres config) and inserts the demat account.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, handlePreflight } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PAN_KEY = Deno.env.get('PAN_KEY')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const { data: userData } = await admin.auth.getUser(jwt)
  if (!userData?.user) return new Response('unauthorized', { status: 401, headers: corsHeaders })

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single()
  if (profile?.role !== 'admin') return new Response('forbidden', { status: 403, headers: corsHeaders })

  const { holder_name, phone_e164, pan, broker, dp_client_id } = await req.json()
  if (!holder_name || !phone_e164 || !pan) {
    return new Response(JSON.stringify({ error: 'holder_name, phone_e164 and pan are required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { data: id, error } = await admin.rpc('insert_demat_encrypted', {
    p_name: holder_name,
    p_phone: phone_e164,
    p_pan: String(pan).toUpperCase(),
    p_key: PAN_KEY,
    p_broker: broker ?? null,
    p_dp_client_id: dp_client_id ?? null,
  })

  if (error) {
    const status = error.code === '23505' ? 409 : 500
    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ id }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
