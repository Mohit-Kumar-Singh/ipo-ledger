// Fills in the demat fields RLS blocks for a funder-only viewer.
//
// Every profit/settlement query in this app fetches demat_accounts(...) as a
// PostgREST embed. For an application a funder FUNDED but whose demat account
// they aren't linked to, RLS blocks that embed wholesale (0034 removed the
// row-level grant on purpose — it used to leak phone_e164/dp_client_id/notes),
// so the embed comes back null and every consumer silently falls back to
// `holder_name ?? 'Unknown'` and `profit_share_percent ?? 25`.
//
// That fallback is what made a funder's own Dashboard disagree with admin's
// on the SAME application (₹2,022 vs ₹1,886 — the real cut was 30%, not the
// assumed 25%). Migration 0088 exposes exactly those fields (and nothing
// else) through the narrow security-definer resolver; this patches them back
// onto the rows so the shared math in expectedProfit.ts computes identically
// for both roles instead of quietly using different inputs.
//
// No-ops entirely for admin — their embed is never null, so there's nothing
// to resolve and no extra round trip.
import { supabase } from './supabase'
import type { ProfitProjectionRow } from './expectedProfit'

interface ResolvedDemat {
  id: string
  holder_name: string
  pan_masked: string | null
  profit_share_percent: number | null
  account_manager_id: string | null
}

export async function hydrateDematAccounts<T extends ProfitProjectionRow>(rows: T[]): Promise<T[]> {
  const unresolved = Array.from(
    new Set(rows.filter((r) => !r.demat_accounts && r.demat_id).map((r) => r.demat_id!)),
  )
  if (unresolved.length === 0) return rows

  const { data, error } = await supabase.rpc('resolve_demat_holder_names', { p_ids: unresolved })
  if (error || !data) return rows

  const byId = new Map<string, ResolvedDemat>()
  for (const d of data as ResolvedDemat[]) byId.set(d.id, d)

  return rows.map((r) => {
    if (r.demat_accounts || !r.demat_id) return r
    const d = byId.get(r.demat_id)
    if (!d) return r
    return {
      ...r,
      demat_accounts: {
        holder_name: d.holder_name,
        // The whole point of this file — `?? 25` here would just reintroduce
        // the bug it exists to fix, so a genuinely null column (never set on
        // the account) stays null and lets the caller's own documented
        // fallback apply, rather than being silently invented here.
        profit_share_percent: d.profit_share_percent as number,
        // Still NOT resolved — deliberately out of scope for a funder, same
        // as 0034/0088 intend. Consumers already treat these as optional.
        phone_e164: null,
        account_manager_id: d.account_manager_id,
      },
    }
  })
}
