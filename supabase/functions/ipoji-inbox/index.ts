// Receives a finished ipoji scrape from the phone bookmarklet (running on
// ipoji.com) and parks it in ipoji_inbox for the admin to review in the app.
// Auth is the per-admin import key in the body (see migration 0103) — no JWT,
// because the bookmarklet runs on ipoji's page, not ours. The key is
// write-only: it can add rows to that admin's inbox and do nothing else, and
// nothing in the inbox is imported without the admin's own Review step.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { jsonError, jsonResponse, logError, logRequest } from '../_shared/http.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const MAX_BODY_CHARS = 3_000_000
const MAX_ROWS = 1000
const KEEP_INBOX_ROWS = 5

// Called cross-origin from ipoji.com, so the portal-only allowlist in
// _shared/cors.ts doesn't apply. Safe to open: no cookies/credentials are
// involved, and the secret key in the body is the only authorization.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return jsonError('method not allowed', 405, CORS)
  logRequest('ipoji-inbox', req)

  try {
    const text = await req.text()
    if (text.length > MAX_BODY_CHARS) return jsonError('too large', 413, CORS)
    let body: { key?: unknown; rows?: unknown }
    try {
      body = JSON.parse(text)
    } catch {
      return jsonError('bad request', 400, CORS)
    }
    const key = typeof body.key === 'string' ? body.key : ''
    if (!/^[0-9a-f]{64}$/.test(key)) return jsonError('unauthorized', 401, CORS)
    if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > MAX_ROWS) {
      return jsonError('bad request', 400, CORS)
    }
    const rows = body.rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r))
    if (rows.length === 0) return jsonError('bad request', 400, CORS)

    const { data: keyRow } = await admin.from('ipoji_import_keys').select('user_id').eq('key', key).maybeSingle()
    if (!keyRow) return jsonError('unauthorized', 401, CORS)

    const { error } = await admin
      .from('ipoji_inbox')
      .insert({ user_id: keyRow.user_id, rows, row_count: rows.length })
    if (error) throw error

    // Keep only the newest few so the inbox can't grow without bound.
    const { data: old } = await admin
      .from('ipoji_inbox')
      .select('id')
      .eq('user_id', keyRow.user_id)
      .order('created_at', { ascending: false })
      .range(KEEP_INBOX_ROWS, KEEP_INBOX_ROWS + 100)
    if (old && old.length > 0) await admin.from('ipoji_inbox').delete().in('id', old.map((o) => o.id))

    return jsonResponse({ ok: true, count: rows.length }, 200, CORS)
  } catch (err) {
    logError('ipoji-inbox', err)
    return jsonError('server error', 500, CORS)
  }
})
