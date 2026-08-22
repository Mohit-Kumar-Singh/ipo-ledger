// Shared TanStack Query hooks for the tables/views that were being fetched
// independently, in full, by multiple pages — confirmed by grep across
// pages/admin/*.tsx before this existed:
//
//   ipos               — Dashboard (x2 in one load!), Applications, IposPage,
//                         Archives (filtered), Allotment board (filtered)
//   demat_accounts     — Accounts, Applications, SharedAccounts, Dashboard
//                         (narrow columns), BankAccounts (narrow columns)
//   bank_accounts      — Applications, BankAccounts
//   v_allotment_board  — Dashboard, Archives (filtered), Payouts (filtered),
//                         Allotment board (filtered by one ipo_id)
//
// Each of those fired its own network round trip on every mount — meaning
// every route navigation refetched data another currently-cached page
// already had. These hooks fetch each table ONCE per staleTime window (see
// queryClient.ts) and every page reads the same cache entry; pages that
// need a filtered subset (e.g. Archives' is_archived=true ipos, or one IPO's
// slice of the allotment board) filter the shared result client-side with
// useMemo instead of issuing a second network query for a subset of rows
// they already have.
//
// Deliberately NOT centralized here: settlement_payments, notifications,
// account_managers, profiles-for-linking, and anything selected with
// per-row/detail-only columns (e.g. AllotmentBoardPage's single-account
// credential lookup on "Notify holder" click) — none of those are fetched
// by more than one page today, so sharing them would add indirection with
// no request-count benefit. See the migration notes in the PR description
// for the full list of what's still page-local.
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { Ipo, DematAccount, BankAccount, AllotmentBoardRow } from '../types/database'

export const queryKeys = {
  ipos: ['ipos'] as const,
  dematAccounts: ['demat_accounts'] as const,
  bankAccounts: ['bank_accounts'] as const,
  allotmentBoard: ['v_allotment_board'] as const,
}

// Plain async fetchers, exported separately from the useX hooks below —
// DashboardPage isn't built around individual useQuery calls (it's one big
// Promise.all-driven load() covering several OTHER tables too, which stay
// page-local), so it reads these same tables via
// queryClient.fetchQuery({ queryKey, queryFn }) instead of the hooks. Same
// queryKey, same underlying cache entry, either way — a fetchQuery call
// resolves from cache instantly if still fresh, or fetches and populates the
// cache if not, exactly like a useQuery mount would.
export async function fetchIpos(): Promise<Ipo[]> {
  const { data, error } = await supabase.from('ipos').select('*')
  if (error) throw error
  return (data ?? []) as Ipo[]
}

export async function fetchDematAccounts(): Promise<DematAccount[]> {
  const { data, error } = await supabase.from('demat_accounts').select('*')
  if (error) throw error
  return (data ?? []) as DematAccount[]
}

export async function fetchBankAccounts(): Promise<BankAccount[]> {
  const { data, error } = await supabase.from('bank_accounts').select('*')
  if (error) throw error
  return (data ?? []) as BankAccount[]
}

export async function fetchAllotmentBoardAll(): Promise<AllotmentBoardRow[]> {
  const { data, error } = await supabase.from('v_allotment_board').select('*')
  if (error) throw error
  return (data ?? []) as AllotmentBoardRow[]
}

// Every IPO, unfiltered — the shared source every page's own filtered view
// (closing today, archived, allotment-out-and-not-archived, ...) derives
// from client-side. Small table (a personal/family IPO tracker's full
// history, not an enterprise dataset), so shipping the whole thing once and
// filtering in JS is cheaper than a second round trip per filter shape.
// `enabled` defaults to true for every existing caller (page-level lists
// that always need the data); ApplicationsPage passes false until its own
// add/edit form is actually open — this table's already-deferred-fetch
// pattern (see loadFormData's own comment there) predates this cache and is
// preserved here via the same primitive, not overridden by it.
export function useIpos(enabled = true): UseQueryResult<Ipo[]> {
  return useQuery({ queryKey: queryKeys.ipos, queryFn: fetchIpos, enabled })
}

export function useDematAccounts(enabled = true): UseQueryResult<DematAccount[]> {
  return useQuery({ queryKey: queryKeys.dematAccounts, queryFn: fetchDematAccounts, enabled })
}

export function useBankAccounts(enabled = true): UseQueryResult<BankAccount[]> {
  return useQuery({ queryKey: queryKeys.bankAccounts, queryFn: fetchBankAccounts, enabled })
}

// Backed by `applications` (via the view), which IS in the realtime
// publication (CLAUDE.md) — kept at a shorter staleTime than the app default
// since this is the table that actually changes during a session (marking
// allotted/sold/paid), and paired with a realtime invalidate in
// components/RealtimeCacheSync.tsx so a change from any page refreshes this
// for every page currently reading it, not just the one that made the change.
export function useAllotmentBoardAll(): UseQueryResult<AllotmentBoardRow[]> {
  return useQuery({ queryKey: queryKeys.allotmentBoard, queryFn: fetchAllotmentBoardAll, staleTime: 15_000 })
}
