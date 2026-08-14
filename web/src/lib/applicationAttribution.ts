import type { ApplicationAttributionRow } from '../types/database'

export interface AttributionSlice {
  name: string
  value: number
}

export interface IpoAttribution {
  ipoId: string
  companyName: string
  openDate: string
  totalApplications: number
  slices: AttributionSlice[] // sorted desc — every funder, no "Other" cap
}

// A raw bank-account holder_name ("Mohit") and a resolved profile full_name
// ("Mohit Kumar Singh") can both refer to the same real person without ever
// matching exactly — there's no link between an unlinked bank/UPI account
// and a profile beyond the name someone typed in.
//
// Match rule: same first token, AND the shorter name's remaining tokens
// form a SUBSEQUENCE of the longer one's remaining tokens (same order,
// gaps allowed) — not a strict prefix. Real, confirmed bug with the
// prefix-only version: "Mohit Singh" (an account holder_name) vs "Mohit
// Kumar Singh" (the resolved profile full_name) failed to match and split
// into two separate pie-chart slices for the same real person, because
// "Singh" (shorter's 2nd token) isn't at position 1 in the longer name —
// "Kumar" is; a strict prefix check has no way to skip over an omitted
// middle name. Subsequence matching does: after the shared first token,
// "Singh" still has to show up later in the same order, just not
// necessarily immediately next. First-token-ALONE was tried first and is
// also a real, confirmed bug: this app's own real data has two different
// people who share a first name ("Harsh Gandhi" and "Harsh Verma", both
// real funders on record) — matching on first token only would have
// silently merged those two distinct people into one slice. Subsequence
// matching still refuses that: "Gandhi" is not a subsequence of ["Verma"].
export function sameIdentity(a: string, b: string): boolean {
  const ta = a.trim().toLowerCase().split(/\s+/)
  const tb = b.trim().toLowerCase().split(/\s+/)
  if (ta[0] !== tb[0]) return false
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  let i = 0
  for (const tok of longer) {
    if (i < shorter.length && tok === shorter[i]) i++
  }
  return i === shorter.length
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
// Summing into a name-matched list is what makes every one-person-did-
// everything case collapse to a plain 1 with no special-casing. A plain
// array + linear sameIdentity() scan, not a Map keyed by a cheap string —
// there is no O(1) key that captures "same real person, spelled two ways"
// correctly (see sameIdentity's own comment on why first-token-only was
// wrong); this app's per-IPO contributor count is small (a known set of
// family/friends), so the O(n) scan per add is irrelevant in practice.
// Real bug this whole identity-matching path fixes: funderName for an
// unlinked bank/UPI account (funder_user_id null) came straight from that
// ONE bank_account row's own account_holder_name — if the same person had
// two bank/UPI accounts on file with different spellings ("Avinash" on one
// UPI, "Avinash sir" on another), each spelling used to be its own literal
// entry, so credit for the same person split across two separate slices
// instead of summing into one — and if neither spelling's total cleared
// the top-4 cutoff alone, both could silently fall into "Other" even
// though the person, correctly summed, would have been a real named slice.
export function computeIpoAttribution(
  rows: ApplicationAttributionRow[],
  nameById: Map<string, string>,
): IpoAttribution[] {
  const nameFor = (id: string) => nameById.get(id) ?? id

  const byIpo = new Map<
    string,
    { companyName: string; openDate: string; credits: { name: string; value: number }[]; total: number }
  >()

  for (const r of rows) {
    if (!byIpo.has(r.ipo_id)) {
      byIpo.set(r.ipo_id, { companyName: r.company_name, openDate: r.open_date, credits: [], total: 0 })
    }
    const entry = byIpo.get(r.ipo_id)!
    entry.total += 1
    const add = (name: string, amount: number) => {
      const existing = entry.credits.find((c) => sameIdentity(c.name, name))
      if (existing) {
        existing.value += amount
        // Prefer the fuller name as the canonical display — a resolved
        // profile full_name ("Mohit Kumar Singh") over a bare UPI-account
        // label ("Mohit"), so the legend doesn't downgrade to whichever
        // spelling happened to be added to the list first.
        if (name.length > existing.name.length) existing.name = name
      } else {
        entry.credits.push({ name, value: amount })
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
    // Every funder gets a real, named slice — no "Other" bucket to fold
    // anyone into. Tie-break alphabetically, not left to whatever order
    // they happened to land in the array — with 0.5/0.5 funder/creator
    // splits, several contributors easily end up with an equal total (two
    // people funding 2 applications each both sit at 1.0), and sort()
    // isn't guaranteed stable-on-ties across engines.
    const slices = [...entry.credits].sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    return { ipoId, companyName: entry.companyName, openDate: entry.openDate, totalApplications: entry.total, slices }
  })
}
