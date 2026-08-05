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
  slices: AttributionSlice[] // sorted desc, capped at top 3 + "Other"
}

const MAX_DIRECT_SLICES = 3

// Per application: if the bank/UPI account used is linked to a portal
// member, the demat holder gets no credit — instead the credit splits 0.5
// to that member and 0.5 to whoever created the application. A bank/UPI
// account can also carry a name with no linked portal login (e.g. a family
// member funding via their own UPI who never signed up) — same 0.5/0.5
// split, just keyed by that raw name instead of a resolved user id, unless
// it's the same person as the demat holder (self-funded, no double-split).
// Otherwise the full credit goes to the demat holder, as before. Summing
// into a name-keyed map is what makes the "same person on both sides" and
// "fully self-service member" cases collapse to a plain 1 with no
// special-casing.
export function computeIpoAttribution(
  rows: ApplicationAttributionRow[],
  nameById: Map<string, string>,
): IpoAttribution[] {
  const nameFor = (id: string) => nameById.get(id) ?? id

  const byIpo = new Map<
    string,
    { companyName: string; openDate: string; credits: Map<string, number>; total: number }
  >()

  for (const r of rows) {
    if (!byIpo.has(r.ipo_id)) {
      byIpo.set(r.ipo_id, { companyName: r.company_name, openDate: r.open_date, credits: new Map(), total: 0 })
    }
    const entry = byIpo.get(r.ipo_id)!
    entry.total += 1
    const add = (name: string, amount: number) => {
      entry.credits.set(name, (entry.credits.get(name) ?? 0) + amount)
    }

    if (r.funder_user_id) {
      add(nameFor(r.funder_user_id), 0.5)
      add(r.created_by ? nameFor(r.created_by) : 'Unknown', 0.5)
    } else if (r.funder_name && r.funder_name !== r.holder_name) {
      add(r.funder_name, 0.5)
      add(r.created_by ? nameFor(r.created_by) : 'Unknown', 0.5)
    } else {
      add(r.holder_name, 1)
    }
  }

  return Array.from(byIpo.entries()).map(([ipoId, entry]) => {
    const sorted = Array.from(entry.credits.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
    const top = sorted.slice(0, MAX_DIRECT_SLICES)
    const restTotal = sorted.slice(MAX_DIRECT_SLICES).reduce((s, x) => s + x.value, 0)
    const slices = restTotal > 0 ? [...top, { name: 'Other', value: restTotal }] : top
    return { ipoId, companyName: entry.companyName, openDate: entry.openDate, totalApplications: entry.total, slices }
  })
}
