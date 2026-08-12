import { supabase } from './supabase'
import type { ApplicationAttributionRow } from '../types/database'

// Picks the N most-recently-opened IPOs (by open_date desc) present in the
// given attribution rows, and returns just the rows belonging to those IPOs
// — used by both Dashboard (N=8) and Profile (N=4) so "which IPOs show up"
// stays one consistent rule instead of two separate ones.
export function topRecentIpoAttributionRows(
  rows: ApplicationAttributionRow[],
  limit: number,
): ApplicationAttributionRow[] {
  const openDateByIpo = new Map<string, string>()
  for (const r of rows) openDateByIpo.set(r.ipo_id, r.open_date)
  const topIpoIds = new Set(
    Array.from(openDateByIpo.entries())
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, limit)
      .map(([id]) => id),
  )
  return rows.filter((r) => topIpoIds.has(r.ipo_id))
}

// Shared by Dashboard/Profile: given rows already scoped to the IPOs to
// show, resolve the funder/creator names via the resolve_profile_names RPC
// and return the id->name map computeIpoAttribution needs.
export async function resolveAttributionNames(rows: ApplicationAttributionRow[]): Promise<Map<string, string>> {
  const ids = new Set<string>()
  for (const r of rows) {
    if (r.funder_user_id) ids.add(r.funder_user_id)
    if (r.created_by) ids.add(r.created_by)
  }
  if (ids.size === 0) return new Map()
  const { data, error } = await supabase.rpc('resolve_profile_names', { p_ids: Array.from(ids) })
  // Degrades gracefully either way (charts fall back to raw ids/"Other"
  // rather than breaking), so this doesn't need UI-level error state like
  // the main attribution query above — but a silent failure here was
  // otherwise indistinguishable from "nobody to resolve," worth at least
  // logging so a real RPC failure doesn't look like normal data.
  if (error) console.error('resolveAttributionNames: resolve_profile_names failed', error)
  const rows2 = (data ?? []) as { id: string; full_name: string }[]
  return new Map(rows2.map((r) => [r.id, r.full_name]))
}
