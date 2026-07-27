// Cron-triggered (every 4h, see migration 0009) — not admin-JWT gated since a
// scheduled job has no user session; authenticates via x-cron-secret instead,
// the same pattern send-whatsapp uses for its DB webhook.
// Fetches both current and upcoming ipoji listings and upserts (by company
// name, case-insensitive) any candidate that has open_date, close_date and
// lot_size — the fields our schema requires NOT NULL. Candidates ipoji itself
// shows as TBA/N/A are skipped; they'll pick up automatically once ipoji
// fills them in on a later run, or an admin can add them manually meanwhile.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { fetchDetail, fetchListCandidates, type Candidate } from '../_shared/ipoji.ts'
import { corsHeadersFor, handlePreflight } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function isEligible(c: Candidate): boolean {
  return c.open_date != null && c.close_date != null && c.lot_size != null
}

async function upsertCandidate(c: Candidate): Promise<'saved' | 'failed'> {
  let allotment_date: string | null = null
  let listing_date: string | null = null
  let issue_size: string | null = c.issue_size
  let retail_issue_size: string | null = null
  let retail_subscription_rate: string | null = null
  let registrar = 'OTHER'

  try {
    const detail = await fetchDetail(c.source_url)
    allotment_date = detail.allotment_date
    listing_date = detail.listing_date
    issue_size = detail.issue_size ?? issue_size
    retail_issue_size = detail.retail_issue_size
    retail_subscription_rate = detail.retail_subscription_rate
    if (detail.registrar) registrar = detail.registrar
  } catch {
    // Detail fetch failing shouldn't block saving the core list-card fields.
  }

  const payload = {
    company_name: c.company_name,
    price_low: c.price_low,
    price_high: c.price_high,
    lot_size: c.lot_size,
    open_date: c.open_date,
    close_date: c.close_date,
    allotment_date,
    listing_date,
    registrar,
    gmp_notes: c.gmp,
    issue_size,
    retail_issue_size,
    retail_subscription_rate,
  }

  const { data: existing } = await admin
    .from('ipos')
    .select('id')
    .ilike('company_name', c.company_name)
    .maybeSingle()

  const { error } = existing
    ? await admin.from('ipos').update(payload).eq('id', existing.id)
    : await admin.from('ipos').insert(payload)

  return error ? 'failed' : 'saved'
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  const cors = corsHeadersFor(req)

  const secret = req.headers.get('x-cron-secret')
  if (secret !== CRON_SECRET) {
    return new Response('unauthorized', { status: 401, headers: cors })
  }

  let saved = 0
  let skipped = 0
  let failed = 0

  for (const source of ['current', 'upcoming']) {
    try {
      const candidates = await fetchListCandidates(source)
      for (const c of candidates) {
        if (!isEligible(c)) {
          skipped++
          continue
        }
        const result = await upsertCandidate(c)
        if (result === 'saved') saved++
        else failed++
      }
    } catch (err) {
      console.error(`auto-import-ipos: ${source} fetch failed`, err)
    }
  }

  return new Response(JSON.stringify({ saved, skipped, failed, ran_at: new Date().toISOString() }), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
