// Cron-triggered (every 4h, see migration 0009) — not admin-JWT gated since a
// scheduled job has no user session; authenticates via x-cron-secret instead,
// the same pattern send-whatsapp uses for its DB webhook.
// Fetches both current and upcoming ipoji listings and upserts any candidate
// that has open_date, close_date and lot_size — the fields our schema
// requires NOT NULL. Candidates ipoji itself shows as TBA/N/A are skipped;
// they'll pick up automatically once ipoji fills them in on a later run, or
// an admin can add them manually meanwhile.
// Matched against existing rows by ipoji's own detail-page slug first (see
// findExisting/findExistingMatch below), falling back to company name
// (case-insensitive) only when no slug is known yet — slug survives ipoji
// renaming an IPO's display name mid-bidding, which name-matching alone
// cannot (see migration 0099's comment for the real "NSE" vs "National
// Stock Exchange of India" case this fixes).
import { createClient } from 'npm:@supabase/supabase-js@2'
import { fetchDetail, fetchListCandidates, parseGmpPercent, type Candidate } from '../_shared/ipoji.ts'
import { corsHeadersFor, handlePreflight } from '../_shared/cors.ts'

// Same decision as web/src/lib/ipoIdentity.ts's findExistingIpoMatch —
// ported rather than imported, since a Deno Edge Function and the Vite web
// app don't share a module boundary. Keep the two in sync (and see that
// file's test suite for the NSE/National Stock Exchange regression this
// exists to prevent) if this logic changes.
interface ExistingIpoRef {
  id: string
  ipoji_slug: string | null
}

function findExistingMatch(ipojiSlug: string | null, bySlug: ExistingIpoRef[], byName: ExistingIpoRef[]): ExistingIpoRef | null {
  if (ipojiSlug) {
    const slugMatch = bySlug.find((r) => r.ipoji_slug === ipojiSlug)
    if (slugMatch) return slugMatch
  }
  return byName[0] ?? null
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// 7% floor — matches web/src/pages/admin/IposPage.tsx's MIN_SYNC_GMP_PERCENT
// (the manual quick-sync/import-panel path). Missing/unparseable GMP text is
// left eligible; this only excludes a GMP ipoji has actually published as
// low, not one it hasn't reported yet.
const MIN_SYNC_GMP_PERCENT = 7

function isEligible(c: Candidate): boolean {
  if (c.open_date == null || c.close_date == null || c.lot_size == null) return false
  const gmpPercent = parseGmpPercent(c.gmp)
  if (gmpPercent != null && gmpPercent < MIN_SYNC_GMP_PERCENT) return false
  return true
}

// Collapses stray whitespace ipoji's markup can introduce — e.g. a trailing
// space or double space on a later scrape — which would otherwise make the
// exact-match lookup in upsertCandidate miss the existing row and insert a
// duplicate instead of updating it.
function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

// Detail pages are fetched one HTTP round-trip each — running the whole list
// serially risks the Edge Function's wall-clock timeout once there are more
// than a handful of candidates. Bounded concurrency keeps this fast without
// firing dozens of simultaneous requests at ipoji.com.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// Two targeted queries (by slug, by name) rather than fetching every row —
// findExistingMatch above just picks the winner between whatever each one
// returned, same priority order as web/src/lib/ipoIdentity.ts.
async function findExisting(ipojiSlug: string | null, companyName: string): Promise<ExistingIpoRef | null> {
  let bySlug: ExistingIpoRef[] = []
  if (ipojiSlug) {
    const { data } = await admin.from('ipos').select('id, ipoji_slug').eq('ipoji_slug', ipojiSlug).limit(1)
    bySlug = data ?? []
  }
  const { data: byName } = await admin
    .from('ipos')
    .select('id, ipoji_slug')
    .ilike('company_name', companyName)
    .order('created_at', { ascending: true })
    .limit(1)
  return findExistingMatch(ipojiSlug, bySlug, byName ?? [])
}

async function upsertCandidate(c: Candidate): Promise<'saved' | 'failed'> {
  let allotment_date: string | null = null
  let listing_date: string | null = null
  let issue_size: string | null = c.issue_size
  let retail_issue_size: string | null = null
  let retail_subscription_rate: string | null = null
  let registrar = 'OTHER'
  // Only set when the scrape gave a definitive true/false (see
  // allotmentOutFromText) — stays undefined, not null, for "couldn't tell",
  // so it's simply omitted from the payload below rather than overwriting
  // an admin's manual override with "unknown" on the next cron run.
  let allotment_out: boolean | undefined
  // Resolved after following any redirect fetchDetail's request hits — the
  // stable identifier that survives ipoji renaming an IPO's display name
  // mid-bidding (confirmed live: "National Stock Exchange of India" ->
  // "NSE", old slug 301-redirects to the new one). Stays null only if the
  // detail fetch itself failed below, never because no redirect happened.
  let ipoji_slug: string | null = null

  try {
    const detail = await fetchDetail(c.source_url)
    allotment_date = detail.allotment_date
    listing_date = detail.listing_date
    issue_size = detail.issue_size ?? issue_size
    retail_issue_size = detail.retail_issue_size
    retail_subscription_rate = detail.retail_subscription_rate
    ipoji_slug = detail.ipoji_slug
    if (detail.registrar) registrar = detail.registrar
    if (detail.allotment_out != null) allotment_out = detail.allotment_out
  } catch {
    // Detail fetch failing shouldn't block saving the core list-card fields.
  }

  const company_name = normalizeCompanyName(c.company_name)
  const payload = {
    company_name,
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
    ...(ipoji_slug ? { ipoji_slug } : {}),
    ...(allotment_out !== undefined ? { allotment_out } : {}),
  }

  // Root cause of the "NSE" / "National Stock Exchange of India" duplicate:
  // company_name matching alone can never catch ipoji renaming an IPO's
  // display name mid-bidding — the two strings share no normalizable
  // substring. ipoji_slug (when known) is checked first and wins; name
  // stays the fallback for legacy rows saved before slug tracking existed.
  const existing = await findExisting(ipoji_slug, company_name)

  if (existing) {
    const { error } = await admin.from('ipos').update(payload).eq('id', existing.id)
    return error ? 'failed' : 'saved'
  }

  const { error: insertError } = await admin.from('ipos').insert(payload)
  if (!insertError) return 'saved'
  // Concurrent workers in the same mapWithConcurrency batch can race past
  // the lookup above for the same company — the unique index (on
  // ipoji_slug when set, and always on lower(company_name)) turns that
  // into a 23505 instead of a second row; fall back to updating whichever
  // insert won.
  if (insertError.code === '23505') {
    const retryExisting = await findExisting(ipoji_slug, company_name)
    if (retryExisting) {
      const { error } = await admin.from('ipos').update(payload).eq('id', retryExisting.id)
      return error ? 'failed' : 'saved'
    }
  }
  return 'failed'
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
      const eligible = candidates.filter(isEligible)
      skipped += candidates.length - eligible.length
      const results = await mapWithConcurrency(eligible, 4, upsertCandidate)
      for (const result of results) {
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
