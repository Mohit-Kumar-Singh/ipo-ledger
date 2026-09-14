// Deciding whether two IPO records (a freshly-scraped ipoji candidate and
// an already-saved row) represent the same real IPO — the actual root
// cause behind "NSE" and "National Stock Exchange of India" showing up as
// two separate cards. ipoji renamed that IPO's display name (and its own
// detail-page slug) partway through bidding, and company_name comparison
// — the only identity this app ever used — has no way to catch a rename
// like that: the two strings share no normalizable substring, so an exact
// (even whitespace/case-normalized) match was always going to miss it.
//
// The fix is ipoji's own slug (the "/ipo/<slug>" segment of its detail
// page URL), which survives the rename: ipoji 301-redirects the old
// /ipo/national-stock-exchange-of-india-ipo to the new /ipo/nse-ipo
// (confirmed live), so fetching either URL and following the redirect
// (see supabase/functions/_shared/ipoji.ts's fetchHtml) resolves to the
// same slug regardless of which name text was showing when it was scraped.
// Slug match wins whenever both sides have one; company_name stays the
// fallback for legacy rows saved before slug tracking existed and for
// manually-added IPOs with no ipoji link at all.

export interface ExistingIpoRef {
  id: string
  company_name: string
  ipoji_slug: string | null
}

// Trim + collapse internal whitespace + lowercase — the exact normalization
// migration 0043/0044 already established for the DB's own case-insensitive
// unique index (ipos_company_name_ci_key), applied here too so this
// in-memory comparison never disagrees with what the database will accept.
export function normalizeIpoName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

// Pulls "nse-ipo" out of ".../ipo/nse-ipo" (any protocol/subdomain/query
// string), lowercased. Mirrors supabase/functions/_shared/ipoji.ts's
// extractIpojiSlug — duplicated, not imported, since a Deno Edge Function
// and this Vite web app don't share a module boundary; keep both in sync.
export function extractIpojiSlug(url: string | null | undefined): string | null {
  if (!url) return null
  const match = url.match(/\/ipo\/([a-z0-9-]+)/i)
  return match ? match[1].toLowerCase() : null
}

// candidateRefs is deliberately a short, targeted list (typically 0-2 rows
// — whatever a slug-lookup and a name-lookup query each returned), not the
// whole ipos table: callers query by each key separately rather than
// fetching every row to filter in memory here.
export function findExistingIpoMatch(
  candidate: { ipojiSlug: string | null; companyName: string },
  candidateRefs: ExistingIpoRef[],
): ExistingIpoRef | null {
  if (candidate.ipojiSlug) {
    const bySlug = candidateRefs.find((r) => r.ipoji_slug === candidate.ipojiSlug)
    if (bySlug) return bySlug
  }
  const normalizedName = normalizeIpoName(candidate.companyName)
  const byName = candidateRefs.find((r) => normalizeIpoName(r.company_name) === normalizedName)
  return byName ?? null
}
