import { Fragment, Suspense, lazy, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import * as Popover from '@radix-ui/react-popover'
import { Command } from 'cmdk'
import { AlertIcon, CheckIcon, HistoryIcon, PencilIcon, PersonIcon, SearchIcon, SyncIcon, TrashIcon, UnfoldIcon } from '@primer/octicons-react'
import { InfoTooltip } from '../../components/HoverCard'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { isOpenForBidding, nowIst } from '../../lib/ipoStatus'
import { maybeAutoArchiveIpo } from '../../lib/autoArchive'
import { SaleAmountField, sellPricePerShareFromEntry, type SaleEntryMode } from '../../components/SaleAmountField'
import { Combobox } from '../../components/Combobox'
import { CopyButton } from '../../components/CopyButton'
// Lazy — most visits to this page never open the sync panel (627 lines,
// its own review-table UI), no reason to make every Applications page load
// pay for parsing it eagerly.
const IpojiSyncPanel = lazy(() => import('../../components/IpojiSyncPanel').then((m) => ({ default: m.IpojiSyncPanel })))
import type {
  Application,
  ApplicationCategory,
  BankAccount,
  DematAccount,
  Ipo,
} from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

const categories: ApplicationCategory[] = ['RETAIL', 'SHNI', 'BHNI', 'SHAREHOLDER', 'EMPLOYEE']

// Whoever's bank/UPI account actually funded the application — falls back to
// the demat holder when no bank/UPI account was recorded (self-funded, the
// common case), same fallback logic as the attribution split's "no funder
// row" branch. `resolvedBankNames` covers the case RLS withheld the embed
// (see resolvedBankInfo above) — narrower than the embed (name only), but
// enough to keep this label working.
function funderNameFor(a: ApplicationRow, resolvedBankNames: Map<string, string>): string {
  const effectiveId = a.funder_override_id ?? a.bank_account_id
  const resolvedName = effectiveId ? resolvedBankNames.get(effectiveId) : undefined
  return effectiveFunderAccount(a)?.account_holder_name ?? resolvedName ?? a.demat_accounts?.holder_name ?? 'Unknown'
}

// The UPI ID itself, distinct from funderNameFor — one funder name can span
// several UPI/bank accounts, so this is the finer-grained "which specific
// account paid" view. Bank accounts without a UPI ID (bank-only entries)
// group under a shared placeholder rather than splintering by holder name.
// Unlike funderNameFor, this has no resolved-fallback — a demat owner who
// isn't the funder legitimately shouldn't see the raw UPI ID anymore
// (migration 0057), only who funded them. Falls to 'No UPI ID' the same as
// a genuinely bank-only entry; the two cases read the same on purpose,
// since distinguishing "withheld" from "absent" here isn't worth exposing.
function upiIdFor(a: ApplicationRow): string {
  return effectiveFunderAccount(a)?.upi_id ?? 'No UPI ID'
}

// Clusters cancelled-mandate applications together within each IPO instead
// of leaving them scattered wherever recency/funder/UPI sort happened to
// Shared by the grouping useMemo and the render below — one place that
// knows how each SortMode maps to a group key, so the two can't drift.
function sortGroupKeyFor(mode: SortMode, a: ApplicationRow, resolvedBankNames: Map<string, string>): string {
  if (mode === 'upi') return upiIdFor(a)
  return funderNameFor(a, resolvedBankNames)
}

type SortMode = 'recent' | 'funder' | 'upi' | 'cancelled' | 'not_on_ipoji' | 'duplicates'

// Same eligibility rule the existing single-row "Not allotted" button
// already used (owner + still APPLIED + allotment_date actually passed) —
// extracted so the bulk "select all eligible in this IPO" checkbox can
// compute the same set the per-row checkboxes are individually gated by,
// without the two ever silently disagreeing.
function isEligibleForNotAllotted(
  a: ApplicationRow,
  isAdmin: boolean,
  profileId: string | undefined,
  todayStr: string,
): boolean {
  const isOwner = isAdmin || a.demat_accounts?.linked_user_id === profileId
  return isOwner && a.status === 'APPLIED' && !!a.ipos.allotment_date && a.ipos.allotment_date <= todayStr
}

type ApplicationRow = Application & {
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

// The account that actually gets funding credit — the manual override when
// set, otherwise whichever UPI/bank account literally paid ipoji. Every
// funder-facing read (name, UPI, sort grouping) goes through this instead
// of reading `bank_accounts` directly, so setting an override changes
// credit everywhere at once instead of needing each call site updated.
function effectiveFunderAccount(
  a: ApplicationRow,
): Pick<BankAccount, 'account_holder_name' | 'upi_id' | 'linked_user_id'> | null {
  return a.funder_override ?? a.bank_accounts
}

export function ApplicationsPage() {
  const { profile } = useAuth()
  const location = useLocation()
  const isAdmin = profile?.role === 'admin'
  const [applications, setApplications] = useState<ApplicationRow[]>([])
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [accounts, setAccounts] = useState<DematAccount[]>([])
  const [banks, setBanks] = useState<BankAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formDataLoading, setFormDataLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingApplication, setEditingApplication] = useState<ApplicationRow | null>(null)
  const [ipojiSyncOpen, setIpojiSyncOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [searchQuery, setSearchQuery] = useState('')
  const todayStr = nowIst().dateStr
  // Funder-only rows (RLS grants SELECT on the application itself, but not
  // the full demat_accounts row) come back with demat_accounts = null — this
  // resolves just holder_name + pan_masked for those via a narrow RPC
  // (resolve_demat_holder_names, migration 0045), never phone/DP client id,
  // so a funder can see who/what they funded and self-check allotment via
  // PAN without seeing anything else about that demat account.
  const [resolvedDematInfo, setResolvedDematInfo] = useState<Map<string, { holder_name: string; pan_masked: string | null }>>(
    new Map(),
  )
  // Same shape, other direction: a demat owner viewing their own application
  // no longer gets the full bank_accounts row for a funder who isn't them
  // (migration 0057 narrowed that RLS grant — it used to leak the funder's
  // raw UPI ID/phone/bank name, not just who they are) — resolves just
  // account_holder_name via resolve_bank_holder_names so the "Funded by X"
  // label still works without that.
  const [resolvedBankInfo, setResolvedBankInfo] = useState<Map<string, string>>(new Map())
  // A masked PAN is useless for actually checking allotment on the
  // registrar's site — reveal-pan now also authorizes a funder (not just
  // admin/owner) to decrypt the real PAN for a demat account their linked
  // bank/UPI funded an application on.
  const [revealedPans, setRevealedPans] = useState<Record<string, string>>({})
  const [revealingPan, setRevealingPan] = useState<string | null>(null)
  const [mandateSaving, setMandateSaving] = useState<string | null>(null)
  // full_name for whoever last marked a mandate (mandate_marked_by is just a
  // uuid) — resolved the same narrow way as the funder-only demat rows
  // above (resolve_profile_names, already granted broadly since a display
  // name isn't sensitive), not a join, since applications' own RLS grant
  // doesn't extend to reading arbitrary profiles rows.
  const [mandateMarkerNames, setMandateMarkerNames] = useState<Map<string, string>>(new Map())
  // Bulk "mark not allotted" — select several accounts (within one IPO's
  // group, via its own "select all eligible" checkbox, or mixed across
  // groups) and mark them all NOT_ALLOTTED in one action instead of
  // clicking "Not allotted" on every row individually.
  const [selectedForNotAllotted, setSelectedForNotAllotted] = useState<Set<string>>(new Set())
  const [bulkMarking, setBulkMarking] = useState(false)
  // Per-IPO group collapse — a portal with several IPOs' worth of
  // applications made this page a long scroll of every group always fully
  // expanded. Keyed by ipo_id, COLLAPSED by default (empty set = nothing
  // expanded) — someone opening this page wants the list of IPOs, not every
  // application under every one of them dumped open at once.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  function toggleGroupCollapsed(ipoId: string) {
    setExpandedGroups((s) => {
      const next = new Set(s)
      if (next.has(ipoId)) next.delete(ipoId)
      else next.add(ipoId)
      return next
    })
  }

  async function revealPan(dematId: string) {
    setRevealingPan(dematId)
    const { data, error } = await supabase.functions.invoke<{ pan: string }>('reveal-pan', {
      body: { demat_id: dematId },
    })
    setRevealingPan(null)
    if (error || !data) {
      alert("Couldn't reveal PAN.")
      return
    }
    setRevealedPans((r) => ({ ...r, [dematId]: data.pan }))
  }

  async function loadApplications() {
    setLoading(true)
    const { data, error } = await supabase
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
    if (error) {
      setLoadError(error.message)
      setLoading(false)
      return
    }
    setLoadError(null)
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

    if (unresolvedIds.length > 0) {
      const map = new Map<string, { holder_name: string; pan_masked: string | null }>()
      for (const r of (dematResult.data ?? []) as { id: string; holder_name: string; pan_masked: string | null }[]) {
        map.set(r.id, { holder_name: r.holder_name, pan_masked: r.pan_masked })
      }
      setResolvedDematInfo(map)
    } else {
      setResolvedDematInfo(new Map())
    }

    if (unresolvedBankIds.length > 0) {
      const bankMap = new Map<string, string>()
      for (const r of (bankResult.data ?? []) as { id: string; account_holder_name: string | null }[]) {
        if (r.account_holder_name) bankMap.set(r.id, r.account_holder_name)
      }
      setResolvedBankInfo(bankMap)
    } else {
      setResolvedBankInfo(new Map())
    }

    if (markerIds.length > 0) {
      const map = new Map<string, string>()
      for (const n of (markerResult.data ?? []) as { id: string; full_name: string }[]) map.set(n.id, n.full_name)
      setMandateMarkerNames(map)
    } else {
      setMandateMarkerNames(new Map())
    }

    setApplications(rows)
    setLoading(false)
  }

  // IPOs + demat accounts + bank/UPI accounts are only needed to populate the
  // "New application" form's dropdowns — no point fetching them on every page
  // load when most visits are just reviewing the table. Re-fetched every time
  // the form opens (not cached after the first load) so newly added IPOs/
  // accounts/bank-UPI entries show up immediately instead of needing a page
  // refresh. Demat accounts and bank/UPI accounts are independent lists now —
  // any combination of the two can be picked per application.
  async function loadFormData() {
    setFormDataLoading(true)
    const [iposRes, accountsRes, banksRes] = await Promise.all([
      supabase.from('ipos').select('*').order('company_name'),
      supabase.from('demat_accounts').select('*').order('holder_name'),
      supabase.from('bank_accounts').select('*').order('is_default', { ascending: false }),
    ])
    setIpos((iposRes.data ?? []) as Ipo[])
    setAccounts((accountsRes.data ?? []) as DematAccount[])
    setBanks((banksRes.data ?? []) as BankAccount[])
    setFormDataLoading(false)
  }

  useEffect(() => {
    loadApplications()

    // Live-refresh on any application change — covers e.g. an admin
    // creating/editing an application funded by a member's linked bank/UPI
    // account, so that member's list updates without a manual refresh.
    const channel = supabase
      .channel('applications-page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'applications' }, () => loadApplications())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  // Arriving from the Dashboard's "awaiting mandate approval" list links to
  // /applications#mandate-<id> — the target row doesn't exist in the DOM
  // until loadApplications finishes, so a plain in-page anchor (which only
  // resolves once, at initial render) would silently do nothing. Re-run
  // whenever loading flips false so it also works on the first load, not
  // just client-side navigations.
  useEffect(() => {
    if (loading || !location.hash) return
    const el = document.querySelector(location.hash)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [loading, location.hash])

  function openForm() {
    setShowForm(true)
    setEditingApplication(null)
    loadFormData()
  }

  function openEdit(a: ApplicationRow) {
    setEditingApplication(a)
    setShowForm(false)
    loadFormData()
  }

  async function markStatus(id: string, status: Application['status']) {
    const ipoId = applications.find((a) => a.id === id)?.ipo_id
    await supabase.from('applications').update({ status }).eq('id', id)
    if (status === 'NOT_ALLOTTED' && ipoId) await maybeAutoArchiveIpo(ipoId)
    loadApplications()
  }

  function toggleSelectedForNotAllotted(id: string) {
    setSelectedForNotAllotted((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // One update per selected id rather than a single `.in('id', [...])`
  // call — applications' own RLS write policy (p_apps_member_write) scopes
  // by demat ownership per row, which a batched `.in()` update still
  // respects, but a per-row result means one denied/failed row doesn't
  // silently swallow the rest of a mixed-eligibility selection.
  async function bulkMarkNotAllotted() {
    if (selectedForNotAllotted.size === 0) return
    setBulkMarking(true)
    const ids = Array.from(selectedForNotAllotted)
    // Captured before the update lands — once every application on one of
    // these IPOs is resolved (this batch might be the last one), that IPO
    // archives itself immediately instead of waiting for the nightly sweep.
    const affectedIpoIds = Array.from(new Set(applications.filter((a) => ids.includes(a.id)).map((a) => a.ipo_id)))
    const results = await Promise.all(
      ids.map((id) => supabase.from('applications').update({ status: 'NOT_ALLOTTED' }).eq('id', id))
    )
    setBulkMarking(false)
    const failed = results.filter((r) => r.error).length
    if (failed > 0) alert(`${failed} of ${ids.length} couldn't be updated.`)
    setSelectedForNotAllotted(new Set())
    await Promise.all(affectedIpoIds.map((id) => maybeAutoArchiveIpo(id)))
    loadApplications()
  }

  // Goes through the set_mandate_status RPC (migration 0047), not a direct
  // table update — a funder only has SELECT on applications, and granting
  // funders a raw UPDATE just for the 3 mandate_* columns isn't possible
  // with RLS alone (row-level, not column-level: they'd get every other
  // column too). The RPC checks admin-or-funder internally and only ever
  // touches mandate_status/mandate_marked_by/mandate_marked_at.
  async function setMandateStatus(id: string, status: Application['mandate_status']) {
    setMandateSaving(id)
    const { error } = await supabase.rpc('set_mandate_status', { p_application_id: id, p_status: status })
    setMandateSaving(null)
    if (error) {
      alert(error.message)
      return
    }
    loadApplications()
  }

  async function deleteApplication(id: string) {
    if (!window.confirm('Delete this application? This cannot be undone.')) return
    const { error } = await supabase.from('applications').delete().eq('id', id)
    if (error) {
      alert(error.message)
      return
    }
    loadApplications()
  }

  // applications is already fetched newest-applied-first, so grouping into a
  // Map (which preserves insertion order) naturally puts each IPO's group at
  // the position of its own most recent application — i.e. latest IPO on top
  // — without needing a second sort pass. When sorting by funder or UPI ID,
  // each IPO's items are further clustered by that key (alphabetical), so
  // e.g. all of Jiggi's applications for an IPO — or all applications paid
  // via one specific UPI ID — sit together under one sub-header.
  // Once an IPO's archived (settled — see /archives), its applications drop
  // off this page entirely rather than sitting in an ever-growing list of
  // groups nobody needs to look at anymore; they're still fully visible on
  // the Archives page.
  const visibleApplications = useMemo(() => applications.filter((a) => !a.ipos?.is_archived), [applications])
  const notOnIpojiCount = useMemo(
    () => visibleApplications.filter((a) => !a.imported_from_ipoji).length,
    [visibleApplications],
  )
  const cancelledCount = useMemo(
    () => visibleApplications.filter((a) => a.mandate_status === 'CANCELLED').length,
    [visibleApplications],
  )
  // More than one active (non-cancelled) application for the same
  // (ipo_id, demat_id) — legitimate as of migration 0070 (each funded via a
  // different bank/UPI account, e.g. two different people funded the same
  // demat holder's bid on the same IPO separately), but still worth
  // surfacing explicitly rather than letting it blend into the list, since
  // it used to be structurally impossible and is still an edge case worth a
  // second look.
  const duplicateAppIds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of visibleApplications) {
      if (a.mandate_status === 'CANCELLED') continue
      const key = `${a.ipo_id}_${a.demat_id}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const ids = new Set<string>()
    for (const a of visibleApplications) {
      if (a.mandate_status === 'CANCELLED') continue
      if ((counts.get(`${a.ipo_id}_${a.demat_id}`) ?? 0) > 1) ids.add(a.id)
    }
    return ids
  }, [visibleApplications])
  const duplicatesCount = duplicateAppIds.size

  const groupedApplications = useMemo(() => {
    // "Not on ipoji" and "Cancelled mandate" are FILTERS, not just sorts —
    // each restricts to only the rows that matter for that specific review
    // task, instead of showing everything with the relevant ones merely
    // clustered together. "Not on ipoji": rows never confirmed against
    // ipoji at all (imported_from_ipoji false) — either a legitimate
    // manual/backdated entry, or a mistaken duplicate/typo that never
    // actually existed and should just be deleted. Anything a sync has ever
    // matched (even once) drops out of this view — see toSyncExisting in
    // IpojiSyncPanel, which flips imported_from_ipoji to true the moment a
    // match is found, even for an existing manually-made row. "Cancelled
    // mandate": only rows whose mandate actually got cancelled — the
    // account is free to reapply (Settings' own cancelled-mandates section
    // covers the same list from a different angle).
    const source =
      sortMode === 'not_on_ipoji'
        ? visibleApplications.filter((a) => !a.imported_from_ipoji)
        : sortMode === 'cancelled'
          ? visibleApplications.filter((a) => a.mandate_status === 'CANCELLED')
          : sortMode === 'duplicates'
            ? visibleApplications.filter((a) => duplicateAppIds.has(a.id))
            : visibleApplications
    // Free-text search — matches holder name, IPO name, or funder name.
    // Applied after the sort-mode filter above, so e.g. searching within
    // "Not on ipoji" still only searches that already-narrowed set.
    const q = searchQuery.trim().toLowerCase()
    const searched = q
      ? source.filter((a) => {
          const holder = (a.demat_accounts?.holder_name ?? resolvedDematInfo.get(a.demat_id)?.holder_name ?? '').toLowerCase()
          const ipoName = (a.ipos?.company_name ?? '').toLowerCase()
          const funder = funderNameFor(a, resolvedBankInfo).toLowerCase()
          return holder.includes(q) || ipoName.includes(q) || funder.includes(q)
        })
      : source
    // Groups are built from `searched`, which is already ordered by
    // applied_at desc (the query's own order) — a Map's insertion order is
    // preserved, so the first application seen for each IPO is its most
    // recent one, meaning the group order below is already "IPO with the
    // most recent activity first" for free. Don't re-sort it.
    const groups = new Map<string, { ipoName: string; items: ApplicationRow[] }>()
    for (const a of searched) {
      const key = a.ipo_id
      if (!groups.has(key)) groups.set(key, { ipoName: a.ipos?.company_name ?? 'Unknown IPO', items: [] })
      groups.get(key)!.items.push(a)
    }
    const result = Array.from(groups.values())
    if (sortMode === 'funder' || sortMode === 'upi') {
      const groupKeyFor = (a: ApplicationRow) => sortGroupKeyFor(sortMode, a, resolvedBankInfo)
      for (const g of result) {
        g.items.sort((a, b) => {
          const byKey = groupKeyFor(a).localeCompare(groupKeyFor(b))
          return byKey !== 0 ? byKey : b.applied_at.localeCompare(a.applied_at)
        })
      }
    } else {
      // "Recent" (and the two filter modes, which fall through here too)
      // — within each IPO's group, accounts sort alphabetically by holder
      // name instead of just staying in applied_at order, so a long list
      // under one IPO is actually easy to scan for a specific person.
      const holderNameFor = (a: ApplicationRow) =>
        a.demat_accounts?.holder_name ?? resolvedDematInfo.get(a.demat_id)?.holder_name ?? ''
      for (const g of result) {
        g.items.sort((a, b) => holderNameFor(a).localeCompare(holderNameFor(b)))
      }
    }
    return result
  }, [visibleApplications, sortMode, resolvedBankInfo, resolvedDematInfo, searchQuery, duplicateAppIds])

  // Two lookup maps, checked in priority order by the sync panel (see
  // existingByAppNumber's own comment for why one alone isn't enough):
  //
  // 1. (ipo_id, demat_id, ipoji_app_number) — ipoji's own application number
  //    is the actual stable identity of a bid; this MUST win when present.
  //    Real bug this fixes: a re-sync sometimes resolves the same bid to a
  //    slightly different bank_accounts row than the first sync did (e.g.
  //    ipoji's UPI text case changed, "MKS...@OKICICI" vs "mks...@okicici",
  //    or a new bank_accounts row got added since — matchBank() isn't
  //    guaranteed stable run to run). Keying existence purely on
  //    (ipo_id, demat_id, bank_account_id) treated that as a brand new
  //    application every time it happened, silently creating a real
  //    duplicate row for the exact same ipoji bid — confirmed live: 10 such
  //    pairs, same ipoji_app_number, different bank_account_id, one row per
  //    sync run days apart.
  // 2. (ipo_id, demat_id, bank_account_id) — the fallback for rows with no
  //    ipoji_app_number at all (manual/backdated entries), and still what
  //    correctly tells apart two genuinely different bids on the same
  //    account+IPO through two different funders (migration 0070) when
  //    ipoji happens to report different app numbers for each, as it does
  //    for a real distinct bid.
  const existingByAppNumber = useMemo(
    () =>
      new Map(
        applications
          .filter((a) => a.ipoji_app_number)
          .map((a) => [
            `${a.ipo_id}_${a.demat_id}_${a.ipoji_app_number}`,
            {
              id: a.id,
              mandate_status: a.mandate_status,
              ipoji_app_number: a.ipoji_app_number,
              imported_from_ipoji: a.imported_from_ipoji,
            },
          ]),
      ),
    [applications],
  )
  const existingByKey = useMemo(
    () =>
      new Map(
        applications.map((a) => [
          `${a.ipo_id}_${a.demat_id}_${a.bank_account_id ?? 'self'}`,
          {
            id: a.id,
            mandate_status: a.mandate_status,
            ipoji_app_number: a.ipoji_app_number,
            imported_from_ipoji: a.imported_from_ipoji,
          },
        ]),
      ),
    [applications],
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Applications
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {visibleApplications.length} total
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showForm ? (
            <button onClick={() => setShowForm(false)} className="btn-secondary">
              Cancel
            </button>
          ) : (
            <>
              {/* Admin-only — this bulk-imports from ipoji against every
                  account in the portal, not just whatever a funder-only
                  viewer is allowed to see; showing it to them would just be
                  a button that does nothing useful. */}
              {isAdmin && (
                <button
                  onClick={() => {
                    setIpojiSyncOpen((v) => !v)
                    if (!ipojiSyncOpen) loadFormData()
                  }}
                  className="btn-secondary"
                >
                  {ipojiSyncOpen ? 'Close' : 'from ipoji'}
                </button>
              )}
              {/* One entry point now — the form auto-detects a backdated
                  application from the selected IPO's date and badges it, so
                  the separate "+ Backdated application" button is gone. */}
              <button onClick={() => openForm()} className="btn-secondary">
                + New application
              </button>
              {/* Search collapsed to a single icon at the end of the title
                  row; tapping it reveals the search field below. */}
              {visibleApplications.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSearchOpen((v) => !v)}
                  aria-label="Search applications"
                  aria-expanded={searchOpen}
                  title="Search"
                  className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover-surface)]"
                  style={{ color: searchOpen ? 'var(--accent)' : 'var(--ink-muted)' }}
                >
                  <SearchIcon size={16} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {isAdmin && !showForm && ipojiSyncOpen && (
        <Suspense fallback={<InlineSpinner label="Loading sync panel…" />}>
          <IpojiSyncPanel
            open={ipojiSyncOpen}
            ipos={ipos}
            accounts={accounts}
            banks={banks}
            existingByKey={existingByKey}
            existingByAppNumber={existingByAppNumber}
            onImported={loadApplications}
            onIposCreated={loadFormData}
            lookupsLoading={formDataLoading}
          />
        </Suspense>
      )}

      {!showForm && searchOpen && visibleApplications.length > 0 && (
        <div className="relative max-w-sm">
          <SearchIcon size={15} fill="var(--ink-muted)" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by holder, IPO, or funder…"
            className="input pl-9"
          />
        </div>
      )}

      {/* Admin-only — every one of these is either meaningless or actively
          confusing to a funder-only viewer: "Who funded it"/UPI ID sorting
          group by funder identity, but a funder only ever sees applications
          THEY funded (RLS already scopes the list down to that), so there's
          nothing to sort by. The other three are admin housekeeping filters
          (cancelled-mandate review, ipoji-audit, duplicate detection) a
          funder has no reason to act on. */}
      {isAdmin && !showForm && visibleApplications.length > 0 && (
        // Phone-only fix: this used to be one flex-wrap row that, once the
        // 6 pills couldn't fit the phone's width, either got clipped by
        // .segmented's own overflow-hidden (cutting pill text off mid-word,
        // "Duplicat"/"applicati") or wrapped the pills into a ragged
        // multi-row block. Stacked (label above, pills below) and the pill
        // row scrolls horizontally on its own instead of wrapping or
        // clipping — sm: reverts to the original single-row layout
        // unchanged for tablet/desktop.
        <div className="flex flex-col items-start gap-2 text-sm sm:flex-row sm:items-center" style={{ color: 'var(--ink-muted)' }}>
          <span className="shrink-0">Sort within each IPO by</span>
          <div className="segmented scrollbar-none max-w-full overflow-x-auto">
            {(
              [
                ['recent', 'Recent'],
                ['funder', 'Who funded it'],
                ['upi', 'UPI ID'],
                ['cancelled', `Cancelled mandate (${cancelledCount})`],
                // A FILTER, not a sort — see groupedApplications — restricted
                // to rows never confirmed against ipoji at all, for spotting
                // ones created by mistake and cleaning them up.
                ['not_on_ipoji', `Not on ipoji (${notOnIpojiCount})`],
                // Another filter — more than one active application for the
                // same account+IPO (now allowed when each is funded via a
                // different bank/UPI account, migration 0070).
                ['duplicates', `Duplicate applications (${duplicatesCount})`],
              ] as [SortMode, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSortMode(mode)}
                className={`segmented-item shrink-0 whitespace-nowrap ${sortMode === mode ? 'segmented-item-active' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sticky, not inline in the flow — with several IPO groups on the
          page, a selection made low down would otherwise scroll the action
          bar out of view along with the rows it applies to. */}
      {selectedForNotAllotted.size > 0 && (
        <div
          className="card sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          <span style={{ color: 'var(--ink-primary)' }}>
            {selectedForNotAllotted.size} account{selectedForNotAllotted.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSelectedForNotAllotted(new Set())}
              className="text-xs font-medium hover:underline"
              style={{ color: 'var(--ink-muted)' }}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={bulkMarkNotAllotted}
              disabled={bulkMarking}
              className="btn-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bulkMarking ? 'Marking…' : `Mark ${selectedForNotAllotted.size} not allotted`}
            </button>
          </div>
        </div>
      )}

      {showForm && formDataLoading && <InlineSpinner label="Loading form…" />}

      {showForm && !formDataLoading && (
        <NewApplicationForm
          ipos={ipos}
          accounts={accounts}
          banks={banks}
          onDone={() => {
            setShowForm(false)
            loadApplications()
          }}
        />
      )}

      {loadError && (
        <div className="card flex items-start gap-3 p-4" style={{ borderColor: 'var(--critical)' }}>
          <AlertIcon size={18} className="mt-0.5 shrink-0" fill="var(--critical)" />
          <p className="text-sm" style={{ color: 'var(--ink-primary)' }}>
            Couldn't load applications: {loadError}
          </p>
        </div>
      )}

      {loading ? (
        <InlineSpinner />
      ) : loadError ? null : visibleApplications.length === 0 ? (
        <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No applications yet.
        </p>
      ) : (
        <div className="space-y-6">
          {groupedApplications.map(({ ipoName, items }) => {
            const eligibleIdsInGroup = items
              .filter((a) => isEligibleForNotAllotted(a, isAdmin, profile?.id, todayStr))
              .map((a) => a.id)
            const allEligibleSelected =
              eligibleIdsInGroup.length > 0 && eligibleIdsInGroup.every((id) => selectedForNotAllotted.has(id))

            const ipoId = items[0].ipo_id
            const isCollapsed = !expandedGroups.has(ipoId)

            return (
            <div key={ipoId}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => toggleGroupCollapsed(ipoId)}
                  aria-expanded={!isCollapsed}
                  className="flex min-w-0 items-center gap-1.5 text-sm font-semibold hover:underline"
                  style={{ color: 'var(--ink-secondary)' }}
                >
                  <span className="shrink-0">{isCollapsed ? '▸' : '▾'}</span>
                  <span className="truncate">{ipoName}</span>
                  <span className="shrink-0 font-normal" style={{ color: 'var(--ink-muted)' }}>
                    ({items.length})
                  </span>
                </button>
                {/* Only shows once at least one application in this IPO's
                    group is actually eligible for the bulk action, AND only
                    while the group is expanded — a "select all" over a
                    collapsed (hidden) list is just a confusing lever with no
                    visible rows to act on. */}
                {eligibleIdsInGroup.length > 0 && !isCollapsed && (
                  <label className="flex shrink-0 items-center gap-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                    <input
                      type="checkbox"
                      checked={allEligibleSelected}
                      onChange={() =>
                        setSelectedForNotAllotted((s) => {
                          const next = new Set(s)
                          if (allEligibleSelected) {
                            for (const id of eligibleIdsInGroup) next.delete(id)
                          } else {
                            for (const id of eligibleIdsInGroup) next.add(id)
                          }
                          return next
                        })
                      }
                    />
                    Select all not-allotted-eligible
                  </label>
                )}
              </div>
              {isCollapsed ? null : (
              <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
                {items.map((a, i) => {
                  const groupKeyFor = (x: ApplicationRow) => sortGroupKeyFor(sortMode, x, resolvedBankInfo)
                  const showFunderHeader =
                    (sortMode === 'funder' || sortMode === 'upi') &&
                    (i === 0 || groupKeyFor(items[i - 1]) !== groupKeyFor(a))
                  // Items are already sorted by group key within this IPO's
                  // list, so the run sharing `a`'s key is contiguous — count
                  // it directly instead of a second full-list filter.
                  const groupCount = showFunderHeader
                    ? items.filter((x) => groupKeyFor(x) === groupKeyFor(a)).length
                    : 0
                  const funderHeader = showFunderHeader && (
                    <div
                      key={`${a.id}-funder-header`}
                      className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide uppercase"
                      style={{ color: 'var(--ink-muted)', background: 'var(--hover-surface)' }}
                    >
                      {sortMode === 'upi' && `Paid via ${upiIdFor(a)}`}
                      {sortMode === 'funder' && `Funded by ${funderNameFor(a, resolvedBankInfo)}`}
                      {' · '}
                      {groupCount} application{groupCount === 1 ? '' : 's'}
                    </div>
                  )

                  if (editingApplication?.id === a.id) {
                    return (
                      <Fragment key={a.id}>
                        {funderHeader}
                        {formDataLoading ? (
                          <div className="p-4">
                            <InlineSpinner label="Loading form…" />
                          </div>
                        ) : (
                          <div className="p-4">
                            <NewApplicationForm
                              ipos={ipos}
                              accounts={accounts}
                              banks={banks}
                              existing={editingApplication}
                              onCancel={() => setEditingApplication(null)}
                              onDone={() => {
                                setEditingApplication(null)
                                loadApplications()
                              }}
                            />
                          </div>
                        )}
                      </Fragment>
                    )
                  }

                  const tone = { APPLIED: 'info', ALLOTTED: 'good', NOT_ALLOTTED: 'neutral', SOLD: 'violet' }[a.status]
                  // Owner = admin, or the member whose linked demat this application is on.
                  const isOwner = isAdmin || a.demat_accounts?.linked_user_id === profile?.id
                  // demat_accounts is null for a funder-only row (RLS withholds the full
                  // row) — fall back to the narrow holder_name/pan_masked resolved above.
                  const resolvedDemat = a.demat_accounts ? null : resolvedDematInfo.get(a.demat_id)
                  const holderName = a.demat_accounts?.holder_name ?? resolvedDemat?.holder_name

                  const funderName = funderNameFor(a, resolvedBankInfo)
                  const funderDiffersFromHolder = funderName !== holderName
                  // "Me and the funder can mark it" — admin, or whoever's
                  // linked bank/UPI account actually funded this application
                  // (mirrors set_mandate_status's own server-side check).
                  const canMarkMandate = isAdmin || a.bank_accounts?.linked_user_id === profile?.id
                  // "ipoji" when the mandate was set from the sync's guess
                  // at ipoji's own status text (not a reviewed human
                  // decision) — showing the admin who happened to run the
                  // sync would misrepresent it as one.
                  const mandateMarkerName = a.mandate_marked_by_ipoji
                    ? 'ipoji'
                    : a.mandate_marked_by
                      ? mandateMarkerNames.get(a.mandate_marked_by)
                      : undefined
                  const eligibleForNotAllotted = isEligibleForNotAllotted(a, isAdmin, profile?.id, todayStr)

                  return (
                    <Fragment key={a.id}>
                      {funderHeader}
                      <div className="stagger-item flex flex-wrap items-center gap-3 p-4">
                      {eligibleForNotAllotted && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${holderName} for bulk not-allotted`}
                          checked={selectedForNotAllotted.has(a.id)}
                          onChange={() => toggleSelectedForNotAllotted(a.id)}
                          className="shrink-0"
                        />
                      )}
                      <div
                        className={`icon-badge icon-badge-${tone} shrink-0 text-xs font-semibold`}
                        style={{ width: '2.25rem', height: '2.25rem' }}
                      >
                        {holderName?.[0]?.toUpperCase()}
                      </div>

                      <div className="min-w-[9rem] flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                            {holderName}
                          </p>
                          {/* is_backdated is now only ever set true by the
                              explicit "+ Backdated application" flow —
                              ipoji-synced rows never set it (migration 0064
                              corrected every row the old buggy sync logic
                              had wrongly flagged), since anything ipoji
                              shows at all was, by construction, placed while
                              bidding was genuinely open. No runtime gate
                              needed anymore; the stored flag is trustworthy. */}
                          {a.is_backdated && (
                            <span
                              className="shrink-0"
                              title="This application was created in backdated format."
                            >
                              <HistoryIcon size={13} fill="var(--warning)" aria-label="Backdated" />
                            </span>
                          )}
                          {a.imported_from_ipoji ? (
                            <span className="shrink-0" title="Imported from ipoji via the sync panel.">
                              <SyncIcon size={13} fill="var(--accent)" aria-label="Synced from ipoji" />
                            </span>
                          ) : (
                            <span className="shrink-0" title="Added manually, not synced from ipoji.">
                              <PersonIcon size={13} fill="var(--ink-muted)" aria-label="Added manually" />
                            </span>
                          )}
                          {a.funder_override_id && (
                            <span
                              className="shrink-0"
                              title={`Funder manually set to ${funderName} — overrides the account actually used to pay, for pie chart/profit credit.`}
                            >
                              {'\u{1F3F7}\u{FE0F}'}
                            </span>
                          )}
                          {/* More than one active (non-cancelled) application
                              for this same account+IPO — legitimate now
                              (migration 0070 allows it when each is funded
                              via a different bank/UPI account, e.g. someone
                              bid twice through two different funders), but
                              still worth flagging so it's never mistaken for
                              an accidental double-entry. */}
                          {duplicateAppIds.has(a.id) && (
                            <span className="badge badge-warning shrink-0 text-[10px]" title="More than one active application for this account on this IPO — see the 'Duplicate applications' sort.">
                              duplicate
                            </span>
                          )}
                        </div>
                        {funderDiffersFromHolder && (
                          <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                            via {funderName}
                          </p>
                        )}
                        {/* Funder-only rows show something to self-check allotment
                            status on the registrar's site, not the full demat/phone
                            details. Now that ipoji sync brings in the real
                            application number, that's what a funder actually needs
                            (it's literally what the registrar's own lookup asks
                            for) — PAN is only shown as a fallback for rows that
                            don't have one (manual/backdated entries, or ones from
                            before ipoji_app_number was tracked). Masked by default
                            when it does fall back to PAN (same reveal-then-copy
                            pattern as AccountsPage); a masked PAN can't actually be
                            used to check allotment, so "Reveal" calls reveal-pan
                            (funder-authorized). */}
                        {resolvedDemat &&
                          (a.ipoji_app_number ? (
                            <p className="flex items-center gap-1 truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                              <span className="font-mono">App #: {a.ipoji_app_number}</span>
                              <CopyButton value={a.ipoji_app_number} label="application number" />
                            </p>
                          ) : (
                            resolvedDemat.pan_masked && (
                              <p className="flex items-center gap-1 truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                                <span className="font-mono">PAN: {revealedPans[a.demat_id] ?? resolvedDemat.pan_masked}</span>
                                {revealedPans[a.demat_id] ? (
                                  <CopyButton value={revealedPans[a.demat_id]} label="PAN" />
                                ) : (
                                  <button
                                    onClick={() => revealPan(a.demat_id)}
                                    disabled={revealingPan === a.demat_id}
                                    className="link-accent font-medium disabled:opacity-50"
                                  >
                                    {revealingPan === a.demat_id ? 'Revealing…' : 'Reveal'}
                                  </button>
                                )}
                              </p>
                            )
                          ))}
                      </div>

                      {/* App # (ipoji's own application number, when synced from there)
                          replaces the old lots/amount display — those are now assumed
                          defaults on ipoji-imported rows (see IpojiSyncPanel), not real
                          scraped values, so showing them here read as more precise than
                          they actually are. This is a directly checkable identifier
                          against ipoji instead. Blank for manually-entered applications,
                          which never have one. */}
                      <div className="w-32 shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {a.ipoji_app_number && (
                          <>
                            {/* First word only ("Dhoot" not "Dhoot Transmission") —
                                grouped-by-IPO headers above already give the full
                                name; this is just enough to place the App # at a
                                glance while scanning, not a second full label. */}
                            <p className="truncate font-medium">{a.ipos?.company_name?.split(' ')[0]}</p>
                            <p className="font-mono-ipo">App #{a.ipoji_app_number}</p>
                          </>
                        )}
                      </div>

                      {a.sell_price != null && (
                        <div className="w-24 shrink-0 text-xs" style={{ color: 'var(--good)' }}>
                          Sold ₹{a.sell_price.toLocaleString('en-IN')}
                        </div>
                      )}

                      {/* APPLIED is the default/starting state of literally every
                          row here — showing it as a badge on every single
                          application was just noise, not information. Only the
                          states that actually mean something (allotted/not
                          allotted/sold) get a badge now. */}
                      {a.status !== 'APPLIED' && <StatusBadge status={a.status} />}

                      <div className="w-36 shrink-0 text-xs" id={`mandate-${a.id}`}>
                        {a.mandate_status === 'PENDING' ? (
                          canMarkMandate ? (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => setMandateStatus(a.id, 'APPROVED')}
                                disabled={mandateSaving === a.id}
                                className="link-accent font-medium disabled:opacity-50"
                              >
                                Mandate approved
                              </button>
                              <button
                                onClick={() => setMandateStatus(a.id, 'CANCELLED')}
                                disabled={mandateSaving === a.id}
                                className="font-medium hover:underline disabled:opacity-50"
                                style={{ color: 'var(--ink-muted)' }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--warning)' }}>Awaiting mandate approval</span>
                          )
                        ) : (
                          <div>
                            <span style={{ color: a.mandate_status === 'APPROVED' ? 'var(--good)' : 'var(--critical)' }}>
                              Mandate {a.mandate_status === 'APPROVED' ? 'approved' : 'cancelled'}
                            </span>
                            {mandateMarkerName && (
                              <p style={{ color: 'var(--ink-muted)' }}>by {mandateMarkerName}</p>
                            )}
                          </div>
                        )}
                        {/* ipoji's own words, not just our 3-state PENDING/
                            APPROVED/CANCELLED simplification — "Request
                            Accepted By Sponsor Bank" and "Bid placed
                            successfully" both collapse to the same PENDING
                            bucket, but they're not the same thing and the
                            portal previously had no way to show that
                            distinction at all. */}
                        {a.ipoji_status_text && (
                          <p className="mt-0.5 truncate" style={{ color: 'var(--ink-muted)' }} title={a.ipoji_status_text}>
                            ipoji: {a.ipoji_status_text}
                          </p>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {isOwner && a.status === 'APPLIED' && (
                          <>
                            {/* Can't know allotment status before the registrar has actually
                                run allotment — gate both actions on the IPO's own
                                allotment_date having passed, same rule as the Allotment
                                board (which only lists already-past-allotment-date IPOs to
                                pick from in the first place). */}
                            {a.ipos.allotment_date && a.ipos.allotment_date <= todayStr ? (
                              <>
                                <button onClick={() => markStatus(a.id, 'ALLOTTED')} className="link-accent text-xs font-medium">
                                  Allotted
                                </button>
                                <button
                                  onClick={() => markStatus(a.id, 'NOT_ALLOTTED')}
                                  className="text-xs font-medium hover:underline"
                                  style={{ color: 'var(--ink-muted)' }}
                                >
                                  Not allotted
                                </button>
                              </>
                            ) : (
                              <span className="text-xs" style={{ color: 'var(--ink-muted)' }} title="Allotment date hasn't passed yet">
                                Awaiting allotment
                              </span>
                            )}
                          </>
                        )}
                        {isOwner && a.status === 'ALLOTTED' && (
                          <>
                            <button onClick={() => markStatus(a.id, 'SOLD')} className="link-accent text-xs font-medium">
                              Mark sold
                            </button>
                            <button
                              onClick={() => markStatus(a.id, 'APPLIED')}
                              className="text-xs font-medium hover:underline"
                              style={{ color: 'var(--ink-muted)' }}
                              title="Revert back to Applied"
                            >
                              Undo
                            </button>
                          </>
                        )}
                        {/* A mis-click here (or on the Allotment board) used to
                            have no way back short of editing the DB row
                            directly. */}
                        {isOwner && a.status === 'NOT_ALLOTTED' && (
                          <button
                            onClick={() => markStatus(a.id, 'APPLIED')}
                            className="text-xs font-medium hover:underline"
                            style={{ color: 'var(--ink-muted)' }}
                            title="Revert back to Applied"
                          >
                            Undo
                          </button>
                        )}
                        {isOwner && (
                        <button
                          onClick={() => openEdit(a)}
                          aria-label={`Edit application for ${a.demat_accounts?.holder_name}`}
                          className="rounded-lg p-1.5 transition-colors hover:bg-[var(--hover-surface)]"
                          style={{ color: 'var(--ink-muted)' }}
                        >
                          <PencilIcon size={15} />
                        </button>
                        )}
                        {isOwner && (
                        <button
                          onClick={() => deleteApplication(a.id)}
                          aria-label={`Delete application for ${a.demat_accounts?.holder_name}`}
                          className="rounded-lg p-1.5 transition-colors hover:bg-[var(--critical-tint)]"
                          style={{ color: 'var(--critical)' }}
                        >
                          <TrashIcon size={15} />
                        </button>
                        )}
                      </div>
                      </div>
                    </Fragment>
                  )
                })}
              </div>
              )}
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: Application['status'] }) {
  const classes: Record<Application['status'], string> = {
    APPLIED: 'badge-info',
    ALLOTTED: 'badge-good',
    NOT_ALLOTTED: 'badge-neutral',
    SOLD: 'badge-violet',
  }
  return <span className={`badge ${classes[status]}`}>{status.replace('_', ' ')}</span>
}

function NewApplicationForm({
  ipos,
  accounts,
  banks,
  existing,
  onCancel,
  onDone,
}: {
  ipos: Ipo[]
  accounts: DematAccount[]
  banks: BankAccount[]
  existing?: ApplicationRow
  onCancel?: () => void
  onDone: () => void
}) {
  const existingIpo = existing ? ipos.find((i) => i.id === existing.ipo_id) : undefined
  const [ipoId, setIpoId] = useState(existing?.ipo_id ?? '')
  const dematId = existing?.demat_id ?? ''
  // Only used for new applications — selecting more than one account creates
  // one application per selected holder in a single submit, all sharing the
  // same IPO/bank/category/lots. Editing an existing application is always
  // a single record, so this stays irrelevant there.
  const [dematIds, setDematIds] = useState<string[]>([])
  // Demat ids that already have an application on the selected IPO — the
  // (ipo_id, demat_id) unique constraint means picking one of these and
  // submitting fails outright, previously with no warning until the save
  // itself errored. Still shown (not filtered out of the list — an admin
  // may genuinely need to see/confirm who's already in), just flagged.
  const [alreadyAppliedDematIds, setAlreadyAppliedDematIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!ipoId || existing) {
      setAlreadyAppliedDematIds(new Set())
      return
    }
    let cancelled = false
    supabase
      .from('applications')
      .select('demat_id, mandate_status')
      .eq('ipo_id', ipoId)
      .then(({ data }) => {
        if (cancelled) return
        // A CANCELLED mandate means the funder never actually approved the
        // UPI block — no money moved, so that account hasn't really applied
        // and should be free to pick again, same reasoning as the "accounts
        // left"/"cancelled mandates" fixes on Dashboard and Settings. Not
        // excluding it here left it wrongly flagged "already applied" (and
        // silently unselectable) in this exact dropdown.
        setAlreadyAppliedDematIds(
          new Set((data ?? []).filter((r) => r.mandate_status !== 'CANCELLED').map((r) => r.demat_id)),
        )
      })
    return () => {
      cancelled = true
    }
  }, [ipoId, existing])
  const [bankAccountId, setBankAccountId] = useState(existing?.bank_account_id ?? '')
  // Independent of bankAccountId (which is "whichever UPI literally paid
  // ipoji," used for mandate tracking) — this is a manual override for
  // "who actually gets funding credit," for the case where the real funder
  // handed money over off-app and someone else's own UPI placed the bid.
  // Never touched by the ipoji sync; only ever set here, by hand.
  const [funderOverrideId, setFunderOverrideId] = useState(existing?.funder_override_id ?? '')
  // An override only means anything if it's actually a DIFFERENT account
  // from the one that paid — picking a funder whose UPI happens to match
  // the bank account already selected isn't really an override at all, so
  // this snaps back to "same as bank account used" the moment that happens,
  // instead of silently storing a no-op override.
  useEffect(() => {
    if (!funderOverrideId || !bankAccountId || funderOverrideId === bankAccountId) return
    const bankUpi = banks.find((b) => b.id === bankAccountId)?.upi_id?.trim().toLowerCase()
    const funderUpi = banks.find((b) => b.id === funderOverrideId)?.upi_id?.trim().toLowerCase()
    if (bankUpi && funderUpi && bankUpi === funderUpi) setFunderOverrideId('')
  }, [bankAccountId, funderOverrideId, banks])
  const [lots, setLots] = useState(existing ? String(existing.lots) : '1')
  const [category, setCategory] = useState<ApplicationCategory>(existing?.category ?? 'RETAIL')
  const [saleMode, setSaleMode] = useState<SaleEntryMode>('total')
  const [sellPrice, setSellPrice] = useState(existing?.sell_price != null ? String(existing.sell_price) : '')
  const [totalPayout, setTotalPayout] = useState(
    existing?.sell_price != null && existingIpo
      ? String(Math.round(existing.sell_price * existingIpo.lot_size * existing.lots))
      : '',
  )
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Only IPOs currently open for bidding make sense to apply for — closed,
  // upcoming, or already past bidding (awaiting allotment/listed) would
  // just be a mistake waiting to happen. Backdated mode (and the ipoji sync
  // panel, which matches against the full unfiltered ipos list) is the
  // deliberate escape hatch for catching up a record after the fact, so
  // both list every IPO instead.
  // One merged entry point: every IPO is selectable. Whether the result is a
  // "backdated" record is derived from the chosen IPO — if it's no longer
  // open for bidding, it's a catch-up/backdated entry and gets badged as
  // such. Live IPOs sort to the top so the common case stays first.
  const selectableIpos = [...ipos].sort(
    (a, b) => Number(isOpenForBidding(b)) - Number(isOpenForBidding(a)),
  )
  const selectedIpo = ipos.find((i) => i.id === ipoId)
  const autoBackdated = selectedIpo ? !isOpenForBidding(selectedIpo) : false
  const selectedAccount = accounts.find((a) => a.id === dematId)
  const cutoffPrice = selectedIpo?.price_high ?? 0
  const bidAmount = selectedIpo ? Number(lots || 0) * selectedIpo.lot_size * cutoffPrice : 0
  const soldShares = selectedIpo ? selectedIpo.lot_size * Number(lots || 0) : 0
  const finalSellPrice = sellPricePerShareFromEntry(saleMode, sellPrice, totalPayout, soldShares)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    if (existing) {
      // IPO/demat account are fixed once created — changing either is really
      // a different application (and demat_id is part of the WhatsApp
      // message trail), so only category/lots/bank account are editable.
      const { error } = await supabase
        .from('applications')
        .update({
          bank_account_id: bankAccountId || null,
          funder_override_id: funderOverrideId || null,
          category,
          lots: Number(lots),
          bid_amount: bidAmount || null,
          // Optional here — marking an application Sold (the "Mark sold"
          // button) no longer requires a price. The payment amount is
          // normally filled in afterward on the Allotment board instead;
          // this just lets it be recorded here too if it's already known.
          sell_price: finalSellPrice ? Math.round(finalSellPrice * 100) / 100 : null,
          status: existing.status,
        })
        .eq('id', existing.id)
      setSubmitting(false)
      if (error) {
        setError(error.message)
        return
      }
      onDone()
      return
    }

    const results = await Promise.all(
      dematIds.map(async (id) => {
        const { error } = await supabase.from('applications').insert({
          ipo_id: ipoId,
          demat_id: id,
          bank_account_id: bankAccountId || null,
          funder_override_id: funderOverrideId || null,
          category,
          lots: Number(lots),
          bid_amount: bidAmount || null,
          is_backdated: autoBackdated,
        })
        return { id, error }
      }),
    )
    setSubmitting(false)

    const failed = results.filter((r) => r.error)
    if (failed.length > 0) {
      const names = failed
        .map((f) => {
          const name = accounts.find((a) => a.id === f.id)?.holder_name ?? f.id
          return f.error?.code === '23505' ? `${name} (already applied)` : `${name} (${f.error?.message})`
        })
        .join(', ')
      const succeeded = results.length - failed.length
      setError(
        succeeded > 0
          ? `Created ${succeeded} of ${results.length} application(s). Failed for: ${names}.`
          : `Couldn't create any applications. Failed for: ${names}.`,
      )
      if (succeeded > 0) onDone()
      return
    }
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card animate-page-in grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
      {!existing && autoBackdated && (
        <p className="col-span-full inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
          style={{ background: 'var(--warning-tint)', color: 'var(--warning-text)' }}
        >
          <HistoryIcon size={13} fill="var(--warning-text)" />
          Backdated — this IPO is past its bidding window; it'll be flagged as backdated once saved.
        </p>
      )}
      <Field label="IPO">
        {existing ? (
          <p className="input" style={{ background: 'var(--page)' }}>
            {selectedIpo?.company_name ?? existing.ipos?.company_name}
          </p>
        ) : (
          <>
            <select required value={ipoId} onChange={(e) => setIpoId(e.target.value)} className="input">
              <option value="">
                {selectableIpos.length === 0 ? 'No IPOs yet' : 'Select IPO'}
              </option>
              {selectableIpos.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.company_name}
                  {!isOpenForBidding(i) ? ' (past)' : ''}
                </option>
              ))}
            </select>
          </>
        )}
      </Field>
      <Field label={existing ? 'Demat account' : `Demat account(s)${dematIds.length > 1 ? ` — ${dematIds.length} selected` : ''}`}>
        {existing ? (
          <p className="input" style={{ background: 'var(--page)' }}>
            {selectedAccount?.holder_name ?? existing.demat_accounts?.holder_name}
          </p>
        ) : (
          <MultiDematSelect
            accounts={accounts}
            selected={dematIds}
            onChange={setDematIds}
            alreadyAppliedIds={alreadyAppliedDematIds}
          />
        )}
      </Field>
      <Field label="Bank account used">
        <Combobox
          aria-label="Bank account used"
          placeholder="Select bank/UPI"
          searchPlaceholder="Search bank/UPI accounts…"
          value={bankAccountId}
          onChange={setBankAccountId}
          options={[
            { value: '', label: 'None' },
            ...[...banks]
              .sort((a, b) => (a.account_holder_name ?? '').localeCompare(b.account_holder_name ?? ''))
              .map((b) => ({
                value: b.id,
                label: [b.account_holder_name, b.bank_name, b.upi_id].filter(Boolean).join(' · ') || 'Bank account',
              })),
          ]}
        />
      </Field>
      <Field
        label={
          <span className="inline-flex items-center gap-1.5">
            Funder
            <InfoTooltip text="Only needed when the real funder handed money over some other way and someone else's UPI actually paid — e.g. they gave you cash/a transfer and you applied using your own account. This overrides who gets funding credit (pie chart, profit-split messages) everywhere; it never affects mandate tracking, and the ipoji sync never sets or changes it." />
          </span>
        }
      >
        <Combobox
          aria-label="Funder override"
          placeholder="Same as bank account used"
          searchPlaceholder="Search bank/UPI accounts…"
          value={funderOverrideId}
          onChange={setFunderOverrideId}
          options={[
            { value: '', label: 'Same as bank account used' },
            ...[...banks]
              .sort((a, b) => (a.account_holder_name ?? '').localeCompare(b.account_holder_name ?? ''))
              .map((b) => ({
                value: b.id,
                label: [b.account_holder_name, b.bank_name, b.upi_id].filter(Boolean).join(' · ') || 'Bank account',
              })),
          ]}
        />
      </Field>
      <Field label="Category">
        <select value={category} onChange={(e) => setCategory(e.target.value as ApplicationCategory)} className="input">
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Lots">
        <input required type="number" min={1} value={lots} onChange={(e) => setLots(e.target.value)} className="input" />
      </Field>
      <Field label="Bid amount (auto)">
        <input
          readOnly
          value={bidAmount ? `₹${bidAmount.toLocaleString('en-IN')}` : ''}
          className="input"
          style={{ background: 'var(--page)' }}
        />
      </Field>
      {existing && (existing.status === 'ALLOTTED' || existing.status === 'SOLD') && (
        <div className="col-span-1 sm:col-span-2 lg:col-span-3">
          <SaleAmountField
            mode={saleMode}
            onModeChange={setSaleMode}
            sellPrice={sellPrice}
            onSellPriceChange={setSellPrice}
            totalPayout={totalPayout}
            onTotalPayoutChange={setTotalPayout}
            shares={soldShares}
            invested={Math.round(bidAmount)}
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
            Optional — use "Mark sold" to flip status without this; the payment amount is normally filled in on the
            Allotment board afterward.
          </p>
        </div>
      )}

      {error && (
        <p className="badge badge-critical col-span-1 w-fit sm:col-span-2 lg:col-span-3">{error}</p>
      )}

      <div className="col-span-1 flex gap-2 sm:col-span-2 lg:col-span-3">
        <button
          type="submit"
          disabled={submitting || !ipoId || (existing ? !dematId : dematIds.length === 0)}
          className="btn-primary flex-1 py-2.5"
        >
          {submitting
            ? 'Saving…'
            : existing
              ? 'Save changes'
              : dematIds.length > 1
                ? `Save ${dematIds.length} applications`
                : 'Save application'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

// Click-to-open popover (same Radix Popover + cmdk shell as Combobox, the
// "Bank account used" field) rather than an always-expanded checklist, so
// the form doesn't balloon in height. Multi-select semantics: checkboxes,
// doesn't auto-close on select — selecting several accounts here drives
// handleSubmit's per-account insert loop, so one application gets created
// per holder from a single "Save" click.
function MultiDematSelect({
  accounts,
  selected,
  onChange,
  alreadyAppliedIds,
}: {
  accounts: DematAccount[]
  selected: string[]
  onChange: (ids: string[]) => void
  // Still selectable, not filtered out of the list — picking one and
  // submitting will fail (unique(ipo_id, demat_id)), but hiding the name
  // entirely made it look like the account had vanished rather than
  // "already applied." Flagging it up front means that's visible before
  // submitting, not just as a save-time error.
  alreadyAppliedIds?: Set<string>
}) {
  const [open, setOpen] = useState(false)
  // Not-yet-applied accounts first within each group — the whole point of
  // picking from this list for a new application is finding who still
  // needs to apply, so they shouldn't be mixed in alphabetically behind
  // names that are already done. .sort is stable (holder_name order was
  // already applied server-side), so ties keep their original ordering.
  const notYetApplied = (a: DematAccount) => !(alreadyAppliedIds?.has(a.id) ?? false)
  const active = accounts.filter((a) => a.is_active).sort((a, b) => Number(notYetApplied(b)) - Number(notYetApplied(a)))
  const inactive = accounts.filter((a) => !a.is_active).sort((a, b) => Number(notYetApplied(b)) - Number(notYetApplied(a)))

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  const triggerLabel =
    selected.length === 0
      ? 'Select accounts…'
      : selected.length === 1
        ? (accounts.find((a) => a.id === selected[0])?.holder_name ?? '1 selected')
        : `${selected.length} accounts selected`

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="input flex items-center justify-between gap-2 text-left"
        >
          <span className="truncate" style={{ color: selected.length ? 'var(--ink-primary)' : 'var(--ink-muted)' }}>
            {triggerLabel}
          </span>
          <UnfoldIcon size={14} className="shrink-0" fill="var(--ink-muted)" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="card z-50 w-72 overflow-hidden p-0"
          style={{ borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow-lg)' }}
        >
          <Command loop>
            <div className="flex items-center border-b px-3" style={{ borderColor: 'var(--border)' }}>
              <Command.Input
                autoFocus
                placeholder="Search accounts…"
                aria-label="Search demat accounts"
                className="h-9 w-full bg-transparent text-sm outline-none"
                style={{ color: 'var(--ink-primary)' }}
              />
            </div>
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-4 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
                No matches.
              </Command.Empty>
              {(
                [
                  ['Active accounts', active],
                  ['Inactive accounts', inactive],
                ] as const
              ).map(
                ([label, list]) =>
                  list.length > 0 && (
                    <Command.Group key={label}>
                      <div className="px-2 py-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                        {label}
                      </div>
                      {list.map((a) => {
                        const alreadyApplied = alreadyAppliedIds?.has(a.id) ?? false
                        return (
                          <Command.Item
                            key={a.id}
                            value={`${a.holder_name}::${a.id}`}
                            onSelect={() => toggle(a.id)}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-[var(--hover-surface)]"
                            style={{ color: 'var(--ink-primary)' }}
                          >
                            <input type="checkbox" readOnly checked={selected.includes(a.id)} className="pointer-events-none" />
                            <span className="min-w-0 flex-1 truncate">{a.holder_name}</span>
                            {alreadyApplied && (
                              <span className="shrink-0" title="Already has an application on this IPO">
                                <CheckIcon size={14} fill="var(--good)" />
                              </span>
                            )}
                          </Command.Item>
                        )
                      })}
                    </Command.Group>
                  ),
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Field({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
      <span className="flex items-baseline justify-between gap-2">
        {label}
        {hint && (
          <span className="text-xs font-normal" style={{ color: 'var(--ink-muted)' }}>
            {hint}
          </span>
        )}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  )
}
