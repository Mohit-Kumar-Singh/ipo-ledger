// Admin-only. Decrypts a PAN for the "Copy PAN" action and logs the access.
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

  const { demat_id } = await req.json()
  if (!demat_id) {
    return new Response(JSON.stringify({ error: 'demat_id is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { data: pan, error } = await admin.rpc('decrypt_pan', { p_demat_id: demat_id, p_key: PAN_KEY })
  if (error || !pan) {
    return new Response(JSON.stringify({ error: error?.message ?? 'not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  await admin.from('pan_access_log').insert({ demat_id, accessed_by: userData.user.id })

  return new Response(JSON.stringify({ pan }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
