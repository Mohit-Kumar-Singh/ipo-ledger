// The Applications page's list — every application the viewer can see,
// plus the narrow name lookups RLS-withheld embeds need. Lives here (not in
// the page) so the app can also load it in the background right after the
// Dashboard (components/BackgroundPrefetch), under the same cache key, and
// opening Applications then shows the list straight away.
import { supabase } from './supabase'
import { fetchAllRows } from './fetchAllRows'
import type { Application, BankAccount, DematAccount, Ipo } from '../types/database'

export type ApplicationRow = Application & {
  ipos: Pick<Ipo, 'company_name' | 'allotment_date' | 'is_archived' | 'open_date' | 'close_date'>
  // null when RLS withholds the full row — that only happens for a
  // funder-only viewer (their linked bank/UPI paid for someone else's
  // demat), and those rows are filtered out of this list before render (see
  // loadApplications), so demat_accounts is non-null for everything shown.
  demat_accounts: Pick<DematAccount, 'holder_name' | 'linked_user_id'> | null
  bank_accounts: Pick<BankAccount, 'account_holder_name' | 'upi_id' | 'linked_user_id'> | null
  // The manually-set funder credit override (see funder_override_id on
  // Application) — null on almost every row. Wherever "who funded this"
  // is shown or counted, this wins over bank_accounts when present.
  funder_override: Pick<BankAccount, 'account_holder_name' | 'upi_id' | 'linked_user_id'> | null
}

export interface ApplicationsData {
  rows: ApplicationRow[]
  resolvedDematInfo: Map<string, { holder_name: string; pan_masked: string | null }>
  resolvedBankInfo: Map<string, string>
  mandateMarkerNames: Map<string, string>
}

export const applicationsListKey = ['applications-list'] as const

export async function fetchApplicationsList(): Promise<ApplicationsData> {
  // Paged past PostgREST's 1000-row cap (see fetchAllRows) — every
  // application ever is well past it, and the oldest were silently
  // missing from this list. `id` breaks applied_at ties so pages are stable.
  const { data, error } = await fetchAllRows((from, to) =>
    supabase
      .from('applications')
      .select(
        // bank_accounts is now embedded twice (bank_account_id — the literal
        // paying UPI — and funder_override_id, an independent manual credit
        // override, migration 0063) — PostgREST needs the FK named
        // explicitly on both or it can't tell which relationship a bare
        // `bank_accounts(...)` means anymore.
        '*, ipos(company_name, allotment_date, is_archived, open_date, close_date), demat_accounts(holder_name, linked_user_id), ' +
          'bank_accounts!bank_account_id(account_holder_name, upi_id, linked_user_id), ' +
          'funder_override:bank_accounts!funder_override_id(account_holder_name, upi_id, linked_user_id)',
      )
      .order('applied_at', { ascending: false })
      .order('id')
      .range(from, to),
  )
  if (error) throw error
  // supabase-js's compile-time select-string parser can't resolve the
  // `!fk_column` disambiguation + alias syntax above (needed now that
  // applications has two FKs into bank_accounts) into a real row type —
  // it falls back to an error placeholder type, hence the extra
  // `unknown` hop TS itself suggests. Runtime behavior is unaffected;
  // this is purely a limitation of that string-literal type inference.
  const rows = (data ?? []) as unknown as ApplicationRow[]

  // Previously these funder-only rows (their linked bank/UPI paid for
  // someone else's demat) were dropped here entirely — a funder could
  // fund 16 applications and see zero of them on their own page. Now
  // resolved and shown instead, read-only (isOwner below already
  // requires demat_accounts.linked_user_id === self, which funder-only
  // rows never satisfy).
  const unresolvedIds = Array.from(
    new Set(rows.filter((r) => r.demat_accounts == null).map((r) => r.demat_id)),
  )
  const unresolvedBankIds = Array.from(
    new Set([
      ...rows.filter((r) => r.bank_accounts == null && r.bank_account_id != null).map((r) => r.bank_account_id as string),
      // Same RLS gap can withhold the override's own bank_accounts embed
      // just as easily as the literal-payer one — resolve both through
      // the same narrow RPC/map rather than adding a second one.
      ...rows.filter((r) => r.funder_override == null && r.funder_override_id != null).map((r) => r.funder_override_id as string),
    ]),
  )
  const markerIds = Array.from(new Set(rows.map((r) => r.mandate_marked_by).filter((id): id is string => id != null)))

  // These three RPCs are independent of each other (each only depends on
  // `rows`) — batching them removes 2 sequential round trips per load.
  const [dematResult, bankResult, markerResult] = await Promise.all([
    unresolvedIds.length > 0
      ? supabase.rpc('resolve_demat_holder_names', { p_ids: unresolvedIds })
      : Promise.resolve({ data: null }),
    unresolvedBankIds.length > 0
      ? supabase.rpc('resolve_bank_holder_names', { p_ids: unresolvedBankIds })
      : Promise.resolve({ data: null }),
    markerIds.length > 0
      ? supabase.rpc('resolve_profile_names', { p_ids: markerIds })
      : Promise.resolve({ data: null }),
  ])

  const resolvedDematInfo = new Map<string, { holder_name: string; pan_masked: string | null }>()
  if (unresolvedIds.length > 0) {
    for (const r of (dematResult.data ?? []) as { id: string; holder_name: string; pan_masked: string | null }[]) {
      resolvedDematInfo.set(r.id, { holder_name: r.holder_name, pan_masked: r.pan_masked })
    }
  }

  const resolvedBankInfo = new Map<string, string>()
  if (unresolvedBankIds.length > 0) {
    for (const r of (bankResult.data ?? []) as { id: string; account_holder_name: string | null }[]) {
      if (r.account_holder_name) resolvedBankInfo.set(r.id, r.account_holder_name)
    }
  }

  const mandateMarkerNames = new Map<string, string>()
  if (markerIds.length > 0) {
    for (const n of (markerResult.data ?? []) as { id: string; full_name: string }[]) mandateMarkerNames.set(n.id, n.full_name)
  }

  return { rows, resolvedDematInfo, resolvedBankInfo, mandateMarkerNames }
}
