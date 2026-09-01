// Cron-triggered, daily at 10:00am IST (see the matching migration) — same
// x-cron-secret auth pattern as gmp-alert-notify/ipo-close-rollup-notify,
// since a scheduled job has no user session.
//
// For every IPO that has listed (listing_date <= today) but still has no
// `symbol` on file, tries to auto-resolve its NSE ticker by company name
// (see _shared/resolveSymbol.ts) and, on a confident match, saves it — the
// instant that happens, fetch-stock-price/Dashboard's "Expected profit"
// starts tracking the real market price instead of the frozen pre-listing
// GMP estimate, with zero admin action needed.
//
// Deliberately generic over EVERY IPO in this state, not just whichever one
// happened to be listing the day this was written — a freshly-listed
// small-cap is often not indexed by Yahoo's search yet (confirmed: it
// returned nothing for a same-day SME listing), so this keeps retrying once
// a day, for as long as the IPO stays un-archived, until it resolves or the
// IPO settles. When it can't resolve, it does nothing further here — the
// Dashboard's own needsSymbolForLivePrice toast (DashboardPage.tsx) is what
// tells an admin to add it by hand; this function's job is only to make that
// manual step unnecessary whenever it safely can be.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeadersFor, handlePreflight } from '../_shared/cors.ts'
import { jsonResponse, logError, logRequest } from '../_shared/http.ts'
import { resolveNseSymbol } from '../_shared/resolveSymbol.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  logRequest('resolve-listing-symbols', req)
  const cors = corsHeadersFor(req)

  const secret = req.headers.get('x-cron-secret')
  if (secret !== CRON_SECRET) {
    return new Response('unauthorized', { status: 401, headers: cors })
  }

  try {
    const today = new Date().toISOString().slice(0, 10)
    const { data: ipos, error } = await admin
      .from('ipos')
      .select('id, company_name')
      .is('symbol', null)
      .eq('is_archived', false)
      .lte('listing_date', today)
    if (error) throw error

    let resolved = 0
    let unresolved = 0
    for (const ipo of ipos ?? []) {
      try {
        const symbol = await resolveNseSymbol(ipo.company_name)
        if (!symbol) {
          unresolved++
          continue
        }
        const { error: updateError } = await admin.from('ipos').update({ symbol }).eq('id', ipo.id)
        if (updateError) throw updateError
        resolved++
      } catch (err) {
        // One IPO's lookup failing (rate limit, transient network error)
        // shouldn't abort the rest of the batch — it just tries again
        // tomorrow, same as an unresolved match.
        logError('resolve-listing-symbols', err)
        unresolved++
      }
    }

    return jsonResponse({ checked: (ipos ?? []).length, resolved, unresolved, ran_at: new Date().toISOString() })
  } catch (err) {
    logError('resolve-listing-symbols', err)
    return jsonResponse({ error: 'internal error' }, 500)
  }
})
