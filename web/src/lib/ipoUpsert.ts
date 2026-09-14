// Shared upsert-an-ipoji-IPO logic — previously duplicated almost verbatim
// across IposPage's bulk-import save and IpojiSyncPanel's fetch-and-create-
// missing-IPO flow (a third copy lives in supabase/functions/auto-import-
// ipos, which can't import this across the Edge Function boundary and
// ports the same algorithm inline instead). Two near-identical copies
// drifting apart is exactly how the underlying bug went unfixed in one
// place after being fixed in the other; this is now the one place browser
// code decides "is this candidate an IPO we already have."
import { supabase } from './supabase'
import { findExistingIpoMatch, type ExistingIpoRef } from './ipoIdentity'
import type { Ipo } from '../types/database'

export interface IpoUpsertPayload extends Record<string, unknown> {
  company_name: string
}

const EXISTING_COLUMNS = 'id, company_name, ipoji_slug'

async function findExisting(ipojiSlug: string | null, companyName: string): Promise<ExistingIpoRef | null> {
  const candidateRefs: ExistingIpoRef[] = []
  if (ipojiSlug) {
    const { data } = await supabase.from('ipos').select(EXISTING_COLUMNS).eq('ipoji_slug', ipojiSlug).limit(1)
    if (data) candidateRefs.push(...(data as ExistingIpoRef[]))
  }
  const { data: byName } = await supabase
    .from('ipos')
    .select(EXISTING_COLUMNS)
    .ilike('company_name', companyName)
    .order('created_at', { ascending: true })
    .limit(1)
  if (byName) candidateRefs.push(...(byName as ExistingIpoRef[]))
  return findExistingIpoMatch({ ipojiSlug, companyName }, candidateRefs)
}

// ipojiSlug must be the slug ipoji's detail page actually resolved to
// AFTER following any redirect — i.e. Detail.ipoji_slug from an import-ipos
// "detail" call, never re-derived client-side from the list-card's own
// source_url. That distinction is the entire point: ipoji's list card can
// still show an old/renamed slug in its onclick href, but fetching that
// URL and following the redirect (done server-side, in
// supabase/functions/_shared/ipoji.ts's fetchHtml) resolves to the
// CURRENT one, which is what stays stable across a rename. Omit it
// entirely for a purely manual "Add IPO" entry with no ipoji link, which
// falls back to company_name matching alone, same as before this existed.
export async function upsertIpoByIdentity(
  payload: IpoUpsertPayload,
  ipojiSlug?: string | null,
): Promise<{ error: string | null; ipo: Ipo | null }> {
  const company_name = payload.company_name.trim().replace(/\s+/g, ' ')
  const slug = ipojiSlug ?? null
  const normalizedPayload = { ...payload, company_name, ...(slug ? { ipoji_slug: slug } : {}) }

  const existing = await findExisting(slug, company_name)
  if (existing) {
    const { data, error } = await supabase.from('ipos').update(normalizedPayload).eq('id', existing.id).select('*').single()
    return { error: error?.message ?? null, ipo: (data as Ipo) ?? null }
  }

  const { data: inserted, error: insertError } = await supabase.from('ipos').insert(normalizedPayload).select('*').single()
  if (!insertError) return { error: null, ipo: inserted as Ipo }

  // A concurrent upsert (the cron import running at the same moment, or a
  // second sync run) may have inserted the same IPO between the lookup
  // above and this insert — the unique index (on ipoji_slug when set, and
  // always on lower(company_name)) turns that into a 23505 instead of a
  // second row. Fall back to updating whichever insert won the race.
  if (insertError.code === '23505') {
    const retryExisting = await findExisting(slug, company_name)
    if (retryExisting) {
      const { data, error } = await supabase
        .from('ipos')
        .update(normalizedPayload)
        .eq('id', retryExisting.id)
        .select('*')
        .single()
      return { error: error?.message ?? null, ipo: (data as Ipo) ?? null }
    }
  }
  return { error: insertError.message, ipo: null }
}
