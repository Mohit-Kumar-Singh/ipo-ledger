// Admin-only. Invites a friend by email and links the new user id to their demat account.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders, handlePreflight } from '../_shared/cors.ts'
import { jsonError, jsonResponse, logError, logRequest } from '../_shared/http.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  logRequest('invite-member', req)

  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
    const { data: userData } = await admin.auth.getUser(jwt)
    if (!userData?.user) return new Response('unauthorized', { status: 401, headers: corsHeaders })

    const { data: profile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single()
    if (profile?.role !== 'admin') return new Response('forbidden', { status: 403, headers: corsHeaders })

    const body = await req.json().catch(() => ({}))
    const { email, demat_id } = body
    if (!email || !demat_id) {
      return jsonError('email and demat_id are required', 400)
    }

    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email)
    if (inviteError || !invited?.user) {
      return jsonError(inviteError?.message ?? 'invite failed', 500)
    }

    const newUserId = invited.user.id

    // A DB trigger (handle_new_user) already creates the profiles row on signup;
    // this upsert just guarantees it's a member row even if that trigger changes later.
    await admin.from('profiles').upsert({ id: newUserId, full_name: email, role: 'member' }, { onConflict: 'id' })

    const { error: linkError } = await admin
      .from('demat_accounts')
      .update({ linked_user_id: newUserId })
      .eq('id', demat_id)

    if (linkError) return jsonError(linkError.message, 500)

    return jsonResponse({ status: 'invited', user_id: newUserId })
  } catch (err) {
    logError('invite-member', err)
    return jsonError('Internal error', 500)
  }
})
