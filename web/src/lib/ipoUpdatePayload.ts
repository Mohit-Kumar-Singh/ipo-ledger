// Fields that ipoji only SOMETIMES reports for an IPO — the detail page can
// fail to load (a dropped request, a rate limit), or simply not show a date
// yet ("TBA"). Callers build their payload with these set to null / 'OTHER'
// in that case, which is right for a brand-new row (the columns need some
// value) but wrong for an UPDATE: every re-sync (the 4-hourly cron, the
// quick-sync button, the sync panel) would overwrite a listing date,
// allotment date, or registrar this app already knew with a blank. Same
// reasoning allotment_out has always been omitted rather than nulled.
//
// Deliberately not covered: gmp_notes (live data — a stale GMP is worse
// than none), and price/lot/open/close dates (always present, or the
// candidate isn't eligible to sync at all).
const KEEP_EXISTING_WHEN_EMPTY = [
  'allotment_date',
  'listing_date',
  'issue_size',
  'retail_issue_size',
  'retail_subscription_rate',
] as const

export function withoutEmptyEnrichment<T extends Record<string, unknown>>(payload: T): Partial<T> {
  const out: Record<string, unknown> = { ...payload }
  for (const key of KEEP_EXISTING_WHEN_EMPTY) {
    if (out[key] == null || out[key] === '') delete out[key]
  }
  // 'OTHER' is the fallback when the registrar couldn't be identified, not a
  // reading of ipoji's page — never let it replace a known registrar.
  if (out.registrar === 'OTHER') delete out.registrar
  return out as Partial<T>
}
