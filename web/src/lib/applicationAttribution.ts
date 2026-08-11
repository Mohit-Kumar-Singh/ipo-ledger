import type { ApplicationAttributionRow } from '../types/database'

export interface AttributionSlice {
  name: string
  value: number
  // Only set on the synthetic "Other" slice — each individual folded into
  // it, WITH their own count (not just their name), so the legend can list
  // "Jigyansh — 1" etc. as real, readable text lines rather than only a
  // hover tooltip someone could easily miss (and can't reach at all on
  // touch) — restructured after exactly that complaint: a real
  // contributor's count was invisible once they fell outside the top N.
  members?: { name: string; value: number }[]
}

export interface IpoAttribution {
  ipoId: string
  companyName: string
  openDate: string
  totalApplications: number
  slices: AttributionSlice[] // sorted desc, capped at top N + "Other"
}

// 4, not the reference palette's full categorical set — validated via the
// dataviz skill against this app's --series-* tokens on the adjacent-pair
// gate (the relevant one for a legend-labeled donut, not the stricter
// all-pairs gate that only applies to scatter/choropleth-style charts).
const MAX_DIRECT_SLICES = 4

// A raw bank-account holder_name ("Mohit") and a resolved profile full_name
// ("Mohit Kumar Singh") can both refer to the same real person without ever
// matching exactly — there's no link between an unlinked bank/UPI account
// and a profile beyond the name someone typed in. First-token comparison is
// the same "close enough" identity heuristic already used to display these
// names (see AttributionChart's firstName truncation) — good enough at this
// app's scale (a small, known set of family/friends) to stop e.g. "Mohit"
// (a personal UPI's raw label) and "Mohit Kumar Singh" (the resolved
// creator) from reading as two different people and splitting credit with
// himself.
function sameIdentity(a: string, b: string): boolean {
  const firstToken = (s: string) => s.trim().toLowerCase().split(/\s+/)[0]
  return firstToken(a) === firstToken(b)
}

// Per application: credit splits 0.5 to whoever funded it (the bank/UPI
// account's linked member, or its raw account-holder name if that account
// was never linked to a login) and 0.5 to whoever created the application
// record — UNLESS those are the same identity, in which case a split would
// just be crediting one person against themselves, so they get the full 1
// instead. The comparison is against the CREATOR, not the demat holder —
// funding your own demat account with your own money is exactly as much
// "work" as funding someone else's, so an admin who sets up and files an
// application on a member's behalf, using that member's own UPI, still did
// something the member didn't: the funder/creator split applies whenever
// they're different people, whether or not the funder also happens to be
// the demat holder. Falls back to full credit for the demat holder only
// when there's no bank/UPI account on file to attribute funding to at all.
// Summing into a name-keyed map is what makes every one-person-did-
// everything case collapse to a plain 1 with no special-casing.
// Grouping key for the credits map — first-token identity, same rule
// sameIdentity() already used for the funder-vs-creator comparison below,
// but applied here too so it also collapses two DIFFERENT unlinked bank
// accounts that both belong to the same real person. Real bug this fixes:
// funderName for an unlinked bank/UPI account (funder_user_id null) came
// straight from that ONE bank_account row's own account_holder_name — if
// the same person had two bank/UPI accounts on file with different
// spellings ("Avinash" on one UPI, "Avinash sir" on another), each spelling
// was previously used as its own literal map key, so credit for the same
// person split across two separate slices instead of summing into one —
// and if neither spelling's total cleared the top-4 cutoff on its own,
// both silently fell into "Other" even though the person, correctly
// counted, would have been a real named slice.
function identityKey(name: string): string {
  return name.trim().toLowerCase().split(/\s+/)[0] ?? name
}

export function computeIpoAttribution(
  rows: ApplicationAttributionRow[],
  nameById: Map<string, string>,
): IpoAttribution[] {
  const nameFor = (id: string) => nameById.get(id) ?? id

  const byIpo = new Map<
    string,
    { companyName: string; openDate: string; credits: Map<string, { name: string; value: number }>; total: number }
  >()

  for (const r of rows) {
    if (!byIpo.has(r.ipo_id)) {
      byIpo.set(r.ipo_id, { companyName: r.company_name, openDate: r.open_date, credits: new Map(), total: 0 })
    }
    const entry = byIpo.get(r.ipo_id)!
    entry.total += 1
    const add = (name: string, amount: number) => {
      const key = identityKey(name)
      const existing = entry.credits.get(key)
      if (existing) {
        existing.value += amount
        // Prefer the fuller name as the canonical display — a resolved
        // profile full_name ("Mohit Kumar Singh") over a bare UPI-account
        // label ("Mohit"), so the legend doesn't downgrade to whichever
        // spelling happened to be added to the map first.
        if (name.length > existing.name.length) existing.name = name
      } else {
        entry.credits.set(key, { name, value: amount })
      }
    }

    const funderName = r.funder_user_id ? nameFor(r.funder_user_id) : r.funder_name
    const creatorName = r.created_by ? nameFor(r.created_by) : 'Unknown'

    if (funderName && !sameIdentity(funderName, creatorName)) {
      add(funderName, 0.5)
      add(creatorName, 0.5)
    } else if (funderName) {
      // Same person funded it and created it (however their name was
      // spelled in each place) — credit the resolved/canonical name.
      add(sameIdentity(funderName, creatorName) ? creatorName : funderName, 1)
    } else {
      add(r.holder_name, 1) // no bank/UPI account on file to attribute funding to
    }
  }

  return Array.from(byIpo.entries()).map(([ipoId, entry]) => {
    const sorted = Array.from(entry.credits.values()).sort((a, b) => b.value - a.value)
    const top = sorted.slice(0, MAX_DIRECT_SLICES)
    const rest = sorted.slice(MAX_DIRECT_SLICES)
    const restTotal = rest.reduce((s, x) => s + x.value, 0)
    const slices = restTotal > 0 ? [...top, { name: 'Other', value: restTotal, members: rest }] : top
    return { ipoId, companyName: entry.companyName, openDate: entry.openDate, totalApplications: entry.total, slices }
  })
}
