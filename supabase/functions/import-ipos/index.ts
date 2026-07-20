// Admin-only. Two modes, both read-only — nothing is written to the database here:
//  - { mode: "list", source: "current" | "upcoming" }: parses ipoji.com's listing
//    page into candidate rows (company, dates, price band, lot size, GMP, issue size).
//  - { mode: "detail", detail_url: "<an ipoji.com /ipo/... url from a list result>" }:
//    parses that IPO's detail page for allotment date, listing date and exchange,
//    which only appear there, not on the list cards.
// The admin picks which ones to add — see AddIpoForm / the bulk-save flow in
// IposPage, since ipoji's own data is sometimes TBA/N/A while our schema
// requires open_date, close_date and lot_size.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { fetchDetail, fetchListCandidates } from '../_shared/ipoji.ts'
import { corsHeaders, handlePreflight } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

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

  const body = await req.json().catch(() => ({}))

  try {
    if (body.mode === 'detail') {
      if (typeof body.detail_url !== 'string') return jsonResponse({ error: 'detail_url is required' }, 400)
      return jsonResponse(await fetchDetail(body.detail_url))
    }
    const source = typeof body.source === 'string' ? body.source : 'current'
    const candidates = await fetchListCandidates(source)
    return jsonResponse({ candidates, source, fetched_at: new Date().toISOString() })
  } catch (err) {
    return jsonResponse({ error: String(err instanceof Error ? err.message : err) }, 502)
  }
})
