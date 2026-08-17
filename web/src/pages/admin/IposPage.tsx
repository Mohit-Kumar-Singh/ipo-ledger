import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckIcon } from '@primer/octicons-react'
import { Archive, Pencil, Plus, Trash2, X } from 'lucide-react'
import { describeFunctionError, supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { parseGmpPercent } from '../../lib/ipoGmp'
import { hasBiddingClosed, isOpenForBidding, nowIst } from '../../lib/ipoStatus'
import { showToast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirmDialog'
import type { Ipo, Registrar } from '../../types/database'
import { IpoTimeline } from '../../components/IpoTimeline'
import { InlineSpinner } from '../../components/PageSpinner'

const LOW_GMP_THRESHOLD = 10

function warnIfLowGmp(companyName: string, gmpNotes: string | null | undefined) {
  const pct = parseGmpPercent(gmpNotes)
  if (pct !== null && pct < LOW_GMP_THRESHOLD) {
    showToast(`${companyName}: GMP is ${pct}% — below the ${LOW_GMP_THRESHOLD}% threshold.`, 'warning')
  }
}

const registrars: Registrar[] = [
  'MUFG_INTIME',
  'KFINTECH',
  'BIGSHARE',
  'CAMEO',
  'SKYLINE',
  'MAASHITLA',
  'OTHER',
]

interface ImportCandidate {
  company_name: string
  open_date: string | null
  close_date: string | null
  price_low: number | null
  price_high: number | null
  lot_size: number | null
  exchange: string | null
  gmp: string | null
  issue_size: string | null
  source_url: string
}

interface ImportDetail {
  allotment_date: string | null
  listing_date: string | null
  exchange: string | null
  issue_size: string | null
  retail_issue_size: string | null
  registrar: Registrar | null
  registrar_name: string | null
  retail_subscription_rate: string | null
  allotment_out: boolean | null
}

function isEligible(c: ImportCandidate): boolean {
  return c.open_date != null && c.close_date != null && c.lot_size != null
}

function deriveStatus(ipo: Ipo): { label: string; badge: string } {
  const today = nowIst().dateStr
  if (ipo.listing_date && today >= ipo.listing_date) return { label: 'Listed', badge: 'badge-violet' }
  // ipoji's own "Allotment Out"/"Allotment Awaited" read, when we have it
  // (allotment_out non-null — either scraped or set by an admin edit), wins
  // over the scheduled allotment_date: the date is when allotment is
  // *supposed* to run, but registrars delay it often enough that deriving
  // "Allotment out" purely from today >= allotment_date reads as done
  // before it actually is.
  if (ipo.allotment_out === true) return { label: 'Allotment out', badge: 'badge-warning' }
  if (ipo.allotment_out === false && ipo.allotment_date && today >= ipo.allotment_date) {
    return { label: 'Allotment awaited', badge: 'badge-info' }
  }
  if (ipo.allotment_out == null && ipo.allotment_date && today >= ipo.allotment_date) {
    return { label: 'Allotment out', badge: 'badge-warning' }
  }
  // Cutoff-aware (4:50pm IST on close_date), not just a calendar-date
  // compare — see hasBiddingClosed/isOpenForBidding in ipoStatus.ts for why
  // pure-date comparison was wrong (stayed "Open" until midnight instead of
  // flipping the moment bidding actually ends that afternoon).
  if (hasBiddingClosed(ipo)) return { label: 'Closed', badge: 'badge-neutral' }
  if (isOpenForBidding(ipo)) return { label: 'Open', badge: 'badge-good' }
  return { label: 'Upcoming', badge: 'badge-info' }
}

// Currently-live IPOs first, then things needing admin attention soon, then
// upcoming (soonest first), with historical ones last (most recent first) —
// rather than a flat date sort, which would bury a currently-open IPO under
// an upcoming one that merely has a later open_date.
const STATUS_PRIORITY: Record<string, number> = {
  Open: 0,
  'Allotment out': 1,
  Upcoming: 2,
  Listed: 3,
  Closed: 4,
}

function sortIpos(ipos: Ipo[]): Ipo[] {
  return [...ipos].sort((a, b) => {
    const sa = deriveStatus(a).label
    const sb = deriveStatus(b).label
    const pa = STATUS_PRIORITY[sa] ?? 5
    const pb = STATUS_PRIORITY[sb] ?? 5
    if (pa !== pb) return pa - pb
    if (sa === 'Upcoming') return a.open_date.localeCompare(b.open_date) // soonest first
    return b.open_date.localeCompare(a.open_date) // most recent first
  })
}

// Collapses stray whitespace ipoji's markup (or a manual typo) can introduce
// — e.g. a trailing space or double space — which would otherwise make the
// exact-match lookup below miss an existing row and insert a duplicate.
function normalizeCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
}

// Upserts by company name (case-insensitive exact match) so re-importing the
// same IPO refreshes it instead of creating a duplicate.
// Each detail fetch is a separate round-trip through the import-ipos Edge
// Function to ipoji.com — running the whole selection serially made a
// several-IPO bulk import take tens of seconds. Bounded concurrency keeps it
// fast without firing every request at once. Safe to parallelize here since
// each candidate in one batch is a distinct company (upsertIpo's lookup is
// per company_name, so parallel workers never touch the same row).
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function upsertIpo(payload: Record<string, unknown>): Promise<{ error: string | null }> {
  const normalized = { ...payload, company_name: normalizeCompanyName(payload.company_name as string) }

  // .limit(1) instead of .maybeSingle(): if a duplicate ever slips past the
  // DB's unique index (ipos_company_name_ci_key, migration 0044) — e.g. two
  // upserts racing — .maybeSingle() errors the moment more than one row
  // matches, which made `existing` read as absent and caused every later
  // call to insert yet another duplicate instead of updating. .limit(1)
  // degrades gracefully to "just pick one" instead of erroring.
  const { data: existingRows } = await supabase
    .from('ipos')
    .select('id')
    .ilike('company_name', normalized.company_name)
    .order('created_at', { ascending: true })
    .limit(1)
  const existing = existingRows?.[0]

  if (existing) {
    const { error } = await supabase.from('ipos').update(normalized).eq('id', existing.id)
    return { error: error?.message ?? null }
  }

  const { error: insertError } = await supabase.from('ipos').insert(normalized)
  if (!insertError) return { error: null }
  // A concurrent upsert (e.g. the cron import running at the same moment)
  // may have inserted the same company between the lookup above and this
  // insert — the unique index turns that into a 23505 instead of a second
  // row. Fall back to updating the row that won the race.
  if (insertError.code === '23505') {
    const { data: retryExisting } = await supabase
      .from('ipos')
      .select('id')
      .ilike('company_name', normalized.company_name)
      .order('created_at', { ascending: true })
      .limit(1)
    if (retryExisting?.[0]) {
      const { error } = await supabase.from('ipos').update(normalized).eq('id', retryExisting[0].id)
      return { error: error?.message ?? null }
    }
  }
  return { error: insertError.message }
}

export function IposPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingIpo, setEditingIpo] = useState<Ipo | null>(null)

  const [showImport, setShowImport] = useState(false)
  const [importSource, setImportSource] = useState<'current' | 'upcoming'>('current')
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 })
  const [bulkResult, setBulkResult] = useState<{ saved: number; skipped: number } | null>(null)
  const [quickSyncing, setQuickSyncing] = useState(false)

  const [selectedIpos, setSelectedIpos] = useState<Set<string>>(new Set())
  const [parentPrices, setParentPrices] = useState<Record<string, { price: number | null; stale: boolean }>>({})

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('ipos').select('*').order('open_date', { ascending: false })
    if (error) {
      showToast(`Couldn't load IPOs: ${error.message}`, 'critical')
      setLoading(false)
      return
    }
    setIpos(sortIpos((data ?? []) as Ipo[]))
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // One batched call for every distinct parent-company symbol currently in
  // view, not one call per card — several IPOs can share the same parent
  // (e.g. multiple Coal India subsidiaries), and this avoids duplicate
  // upstream fetches for that case.
  useEffect(() => {
    const symbols = Array.from(new Set(ipos.map((i) => i.parent_company_symbol).filter((s): s is string => !!s)))
    if (symbols.length === 0) return
    supabase.functions
      .invoke<{ prices?: Record<string, { price: number | null; stale: boolean }> }>('fetch-stock-price', {
        body: { symbols },
      })
      .then(({ data }) => {
        if (data?.prices) setParentPrices((prev) => ({ ...prev, ...data.prices }))
      })
  }, [ipos])

  // Raw fetch only — no component state touched — so quickImportAndSave
  // below can read the result directly instead of racing React's state
  // update timing.
  async function invokeListCandidates(source: 'current' | 'upcoming') {
    return supabase.functions.invoke<{ candidates?: ImportCandidate[]; error?: string }>('import-ipos', {
      body: { mode: 'list', source },
    })
  }

  async function fetchCandidates(source: 'current' | 'upcoming') {
    setImportSource(source)
    setImportLoading(true)
    setImportError(null)
    setCandidates([])
    setSelected(new Set())
    setBulkResult(null)
    const { data, error } = await invokeListCandidates(source)
    setImportLoading(false)
    if (error || !data?.candidates) {
      setImportError(await describeFunctionError(error, data ?? null))
      return
    }
    setCandidates(data.candidates)
  }

  function toggleSelected(url: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  function selectAllEligible() {
    setSelected(new Set(candidates.filter(isEligible).map((c) => c.source_url)))
  }

  // The "i" quick-sync button's whole job in one click: fetch current
  // IPOs, select every eligible one, save them — same three manual steps
  // (Import -> Current IPOs -> Select all eligible -> Save) collapsed into
  // one action. Reuses saveList, which already fetches each candidate's
  // detail (retail_subscription_rate included) and calls load() afterward,
  // so Dashboard/IPOs both pick up fresh data the same as a manual save —
  // no separate refresh step needed for either.
  // Runs entirely in the background — the import panel (with its Current/
  // Upcoming toggle, per-candidate list, progress bar) never opens for
  // this; a toast reports the outcome once it's done, and the IPOs list
  // just updates on its own (saveList already calls load()). The panel
  // stays available for the manual Current/Upcoming/hand-pick flow, it's
  // just not what this button drives anymore.
  async function quickImportAndSave() {
    setQuickSyncing(true)
    const { data, error } = await invokeListCandidates('current')
    if (error || !data?.candidates) {
      showToast(`Couldn't sync from ipoji: ${await describeFunctionError(error, data ?? null)}`, 'critical')
      setQuickSyncing(false)
      return
    }
    const eligible = data.candidates.filter(isEligible)
    const result = await saveList(eligible)
    setQuickSyncing(false)
    if (result) {
      showToast(
        `Synced from ipoji — ${result.saved} saved${result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.`,
        result.skipped > 0 && result.saved === 0 ? 'warning' : 'good',
      )
    }
  }

  async function saveSelected() {
    await saveList(candidates.filter((c) => selected.has(c.source_url)))
  }

  // Split out of saveSelected so the one-click "quick sync" button below
  // can save a freshly-fetched candidate list directly instead of reading
  // `candidates`/`selected` state — those setters wouldn't have committed
  // yet within the same async call, so reading them right after would see
  // stale (likely empty) values instead of what was just fetched.
  async function saveList(chosen: ImportCandidate[]) {
    if (chosen.length === 0) return

    setBulkSaving(true)
    setBulkProgress({ done: 0, total: chosen.length })
    let saved = 0
    let skipped = 0

    async function saveOne(c: ImportCandidate) {
      if (!isEligible(c)) {
        skipped++
        setBulkProgress((p) => ({ ...p, done: p.done + 1 }))
        return
      }

      const { data: detail } = await supabase.functions.invoke<ImportDetail & { error?: string }>('import-ipos', {
        body: { mode: 'detail', detail_url: c.source_url },
      })

      const { error } = await upsertIpo({
        company_name: c.company_name,
        price_low: c.price_low,
        price_high: c.price_high,
        lot_size: c.lot_size,
        open_date: c.open_date,
        close_date: c.close_date,
        allotment_date: detail?.allotment_date ?? null,
        listing_date: detail?.listing_date ?? null,
        registrar: detail?.registrar ?? 'OTHER',
        gmp_notes: c.gmp,
        issue_size: detail?.issue_size ?? c.issue_size,
        retail_issue_size: detail?.retail_issue_size ?? null,
        retail_subscription_rate: detail?.retail_subscription_rate ?? null,
        // Omitted entirely (not set to null) when ipoji shows neither
        // "Allotment Out" nor "Allotment Awaited" yet — a re-import
        // shouldn't stomp a manual admin correction with "unknown".
        ...(detail?.allotment_out != null ? { allotment_out: detail.allotment_out } : {}),
      })

      if (error) {
        skipped++
      } else {
        saved++
        warnIfLowGmp(c.company_name, c.gmp)
      }
      setBulkProgress((p) => ({ ...p, done: p.done + 1 }))
    }

    await mapWithConcurrency(chosen, 4, saveOne)

    setBulkSaving(false)
    setBulkResult({ saved, skipped })
    setSelected(new Set())
    load()
    // Back to the normal IPOs list instead of leaving the import panel
    // open on screen — the newly-saved ones now show "already added" (or
    // just show up) in the Live/Closed/Upcoming sections below, which is
    // confirmation enough; staying on the import screen after a save felt
    // like nothing had happened.
    setShowImport(false)
    setCandidates([])
    return { saved, skipped }
  }

  function toggleIpoSelected(id: string) {
    setSelectedIpos((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllIpos() {
    setSelectedIpos((s) => (s.size === ipos.length ? new Set() : new Set(ipos.map((i) => i.id))))
  }

  async function bulkDeleteIpos() {
    if (selectedIpos.size === 0) return
    if (!(await confirmDialog(`Delete ${selectedIpos.size} IPO(s)? This cannot be undone.`, { tone: 'critical', confirmLabel: 'Delete' })))
      return
    const { error } = await supabase.from('ipos').delete().in('id', Array.from(selectedIpos))
    if (error) {
      showToast(
        error.code === '23503'
          ? "Can't delete one or more of these — they still have applications on record. Delete those applications first, or delete IPOs one at a time to see which."
          : error.message,
        'critical',
      )
      return
    }
    setSelectedIpos(new Set())
    load()
  }

  async function deleteIpo(ipo: Ipo) {
    if (!(await confirmDialog(`Delete ${ipo.company_name}? This cannot be undone.`, { tone: 'critical', confirmLabel: 'Delete' }))) return
    const { error } = await supabase.from('ipos').delete().eq('id', ipo.id)
    if (error) {
      showToast(
        error.code === '23503'
          ? `Can't delete ${ipo.company_name} — it still has applications on record. Delete those applications first.`
          : error.message,
        'critical',
      )
      return
    }
    load()
  }

  // Archiving never deletes the row — applications on it (and everything
  // that joins to it) keep working exactly as before, forever. A cron job
  // (0038) does this automatically 7 days after listing_date; this lets
  // admin do it sooner, or bring one back, without waiting.
  async function setArchived(ipo: Ipo, archived: boolean) {
    const { error } = await supabase.from('ipos').update({ is_archived: archived }).eq('id', ipo.id)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    load()
  }

  const existingNames = new Set(ipos.map((i) => i.company_name.toLowerCase()))
  const visibleIpos = ipos.filter((i) => !i.is_archived)
  const archivedIpos = ipos.filter((i) => i.is_archived)
  // Three explicit sections, top to bottom: Live (currently open for
  // bidding), Closed (bidding over — awaiting allotment, allotted, or
  // listed, all lumped together since none of them can still be applied
  // to), then Upcoming. sortIpos already ordered visibleIpos by status
  // priority, so each bucket below is a stable filter, not a re-sort.
  const liveIpos = visibleIpos.filter((i) => deriveStatus(i).label === 'Open')
  const upcomingIpos = visibleIpos.filter((i) => deriveStatus(i).label === 'Upcoming')
  const closedIpos = visibleIpos.filter((i) => !['Open', 'Upcoming'].includes(deriveStatus(i).label))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            IPOs
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {visibleIpos.length} tracked
            {archivedIpos.length > 0 && (
              <>
                {' · '}
                <Link to="/archives" className="link-accent font-medium">
                  {archivedIpos.length} archived →
                </Link>
              </>
            )}
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-3">
            {/* Select-all/bulk-delete lives here now, next to Import/Add,
                instead of its own separate row below the header. */}
            {visibleIpos.length > 0 && (
              <>
                <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--ink-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={selectedIpos.size > 0 && selectedIpos.size === visibleIpos.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedIpos.size > 0 && selectedIpos.size < visibleIpos.length
                    }}
                    onChange={toggleSelectAllIpos}
                  />
                  Select all
                </label>
                {selectedIpos.size > 0 && (
                  <button
                    onClick={bulkDeleteIpos}
                    className="text-sm font-medium hover:underline"
                    style={{ color: 'var(--critical)' }}
                  >
                    Delete {selectedIpos.size} selected
                  </button>
                )}
              </>
            )}
            {/* One click, entirely in the background: fetch current IPOs
                from ipoji, select every eligible one, save — no panel, no
                visible steps, just a spin while it runs and a toast when
                it's done. */}
            <button
              onClick={quickImportAndSave}
              disabled={quickSyncing}
              aria-label="Sync current IPOs from ipoji.com"
              title="Sync current IPOs from ipoji.com"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover-surface)] disabled:opacity-50"
            >
              <img
                src="/ipoji-logo.png"
                alt="ipoji"
                width={22}
                height={22}
                className={quickSyncing ? 'icon-pulse' : undefined}
              />
            </button>
            <button
              onClick={() => {
                setShowAddForm((s) => !s)
                setShowImport(false)
                setEditingIpo(null)
              }}
              aria-label={showAddForm ? 'Cancel' : 'Add IPO'}
              title={showAddForm ? 'Cancel' : 'Add IPO'}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover-surface)]"
              style={{ color: 'var(--ink-secondary)' }}
            >
              {showAddForm ? <X size={16} /> : <Plus size={16} />}
            </button>
          </div>
        )}
      </div>

      {showImport && (
        <div className="card space-y-4 p-5">
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Pulls live data from ipoji.com. Select the ones you want, then save them all at once. Cards missing a
            date or lot size (ipoji shows them as TBA/N/A) can't be bulk-saved yet — add those manually once ipoji
            has full details.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => fetchCandidates('current')}
              disabled={importLoading}
              className={importSource === 'current' && candidates.length > 0 ? 'btn-primary' : 'btn-secondary'}
            >
              Current IPOs
            </button>
            <button
              onClick={() => fetchCandidates('upcoming')}
              disabled={importLoading}
              className={importSource === 'upcoming' && candidates.length > 0 ? 'btn-primary' : 'btn-secondary'}
            >
              Upcoming IPOs
            </button>
            {candidates.length > 0 && (
              <button onClick={selectAllEligible} className="btn-secondary">
                Select all eligible
              </button>
            )}
          </div>

          {importLoading && <p style={{ color: 'var(--ink-muted)' }}>Fetching…</p>}
          {importError && <p className="badge badge-critical w-fit">{importError}</p>}
          {bulkResult && (
            <p className="badge badge-good w-fit">
              Saved {bulkResult.saved}
              {bulkResult.skipped > 0 ? `, skipped ${bulkResult.skipped}` : ''}
            </p>
          )}

          {!importLoading && candidates.length > 0 && (
            <>
              <button
                onClick={saveSelected}
                disabled={selected.size === 0 || bulkSaving}
                className="btn-primary disabled:opacity-50"
              >
                {bulkSaving
                  ? `Saving ${bulkProgress.done}/${bulkProgress.total}…`
                  : `Save ${selected.size} selected`}
              </button>
              <div className="grid grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2" style={{ maxHeight: '480px' }}>
                {candidates.map((c) => (
                  <ImportCard
                    key={c.source_url}
                    candidate={c}
                    alreadyAdded={existingNames.has(c.company_name.toLowerCase())}
                    eligible={isEligible(c)}
                    checked={selected.has(c.source_url)}
                    onToggle={() => toggleSelected(c.source_url)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {showAddForm && (
        <AddIpoForm
          onDone={() => {
            setShowAddForm(false)
            load()
          }}
        />
      )}

      {editingIpo && (
        <AddIpoForm
          existing={editingIpo}
          onCancel={() => setEditingIpo(null)}
          onDone={() => {
            setEditingIpo(null)
            load()
          }}
        />
      )}

      {loading ? (
        <InlineSpinner />
      ) : ipos.length === 0 ? (
        <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No IPOs yet.
        </p>
      ) : (
        <>
          {visibleIpos.length === 0 ? (
            <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
              Everything's archived —{' '}
              <Link to="/archives" className="link-accent font-medium">
                see Archives
              </Link>
              .
            </p>
          ) : (
            <>
              {/* Three explicit sections, top to bottom — live first (what
                  you'd actually act on today), then closed (bidding's over,
                  nothing left to do but wait/record), then upcoming
                  (nothing to do yet). Every section past the first gets the
                  same divider-with-label treatment; the label itself
                  (unlike the old single "Closed" divider) is now always
                  shown so it's never ambiguous which section is which. */}
              {([
                ['Live', liveIpos, false],
                ['Closed', closedIpos, true],
                ['Upcoming', upcomingIpos, true],
              ] as const).map(
                ([label, list, withDivider]) =>
                  list.length > 0 && (
                    <div key={label} className="space-y-4">
                      {withDivider ? (
                        <div className="flex items-center gap-3 py-1" aria-hidden>
                          <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
                          <span
                            className="text-xs font-medium tracking-wide uppercase"
                            style={{ color: 'var(--ink-muted)' }}
                          >
                            {label}
                          </span>
                          <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
                        </div>
                      ) : (
                        <span
                          className="block text-xs font-medium tracking-wide uppercase"
                          style={{ color: 'var(--ink-muted)' }}
                        >
                          {label}
                        </span>
                      )}
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {list.map((ipo) => (
                          <IpoCard
                            key={ipo.id}
                            ipo={ipo}
                            isAdmin={isAdmin}
                            selected={selectedIpos.has(ipo.id)}
                            onToggleSelected={() => toggleIpoSelected(ipo.id)}
                            onEdit={() => {
                              setEditingIpo(ipo)
                              setShowAddForm(false)
                              setShowImport(false)
                            }}
                            onDelete={() => deleteIpo(ipo)}
                            onArchive={() => setArchived(ipo, true)}
                            parentPrice={ipo.parent_company_symbol ? parentPrices[ipo.parent_company_symbol] : undefined}
                          />
                        ))}
                      </div>
                    </div>
                  ),
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function IpoCard({
  ipo,
  isAdmin,
  selected,
  onToggleSelected,
  onEdit,
  onDelete,
  onArchive,
  parentPrice,
}: {
  ipo: Ipo
  isAdmin: boolean
  selected?: boolean
  onToggleSelected?: () => void
  onEdit: () => void
  onDelete: () => void
  onArchive?: () => void
  // Looked up (by ipo.parent_company_symbol) and passed down by the page —
  // fetched once per page load for every distinct symbol in view, not once
  // per card. See the fetch-stock-price effect in IposPage.
  parentPrice?: { price: number | null; stale: boolean }
}) {
  const status = deriveStatus(ipo)
  // Hot-GMP hype ring — a rotating conic-gradient glow around the card,
  // amber into red (var(--warning)/var(--critical), same tokens the app
  // already uses for "needs attention" elsewhere), not a fixed brand color,
  // so it stays on-theme in both light and dark without its own overrides.
  const gmpPercent = parseGmpPercent(ipo.gmp_notes)
  const isHotGmp = gmpPercent != null && gmpPercent > 45
  const card = (
    <div className="card stagger-item flex flex-col gap-2 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {isAdmin && onToggleSelected && (
            <input
              type="checkbox"
              className="mt-1 shrink-0"
              checked={selected ?? false}
              onChange={onToggleSelected}
              aria-label={`Select ${ipo.company_name}`}
            />
          )}
          {/* Fixed green checkmark tile (IPO Tracker.dc.html reference) —
              always this color/icon regardless of status; status itself is
              the separate pill on the right, not this badge. */}
          <div
            className="icon-badge icon-badge-good shrink-0"
            style={{ width: '2rem', height: '2rem', borderRadius: '0.5rem' }}
          >
            <CheckIcon size={15} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
              {ipo.company_name}
            </h3>
            <p className="font-mono-ipo truncate text-[13px]" style={{ color: 'var(--ink-muted)' }}>
              {ipo.registrar}
              {ipo.price_low && ipo.price_high && ` · ₹${ipo.price_low}-${ipo.price_high}`}
              {ipo.lot_size ? ` · lot ${ipo.lot_size}` : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {ipo.shareholder_issue_size && <span className="badge badge-info shrink-0">Shareholder quota</span>}
          <span className={`badge shrink-0 ${status.badge}`}>{status.label}</span>
        </div>
      </div>

      {(ipo.gmp_notes || isAdmin) && (
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono-ipo truncate text-sm font-semibold" style={{ color: 'var(--good)' }}>
            {ipo.gmp_notes}
          </p>
          {isAdmin && (
            <div className="flex shrink-0 items-center gap-2.5">
              <button
                onClick={onEdit}
                aria-label={`Edit ${ipo.company_name}`}
                title="Edit"
                className="flex items-center rounded-md p-1 transition-colors hover:bg-[var(--hover-surface)]"
                style={{ color: 'var(--ink-muted)' }}
              >
                <Pencil size={15} />
              </button>
              {onArchive && (
                <button
                  onClick={onArchive}
                  aria-label={`Archive ${ipo.company_name}`}
                  title="Archive"
                  className="flex items-center rounded-md p-1 transition-colors hover:bg-[var(--hover-surface)]"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  <Archive size={15} />
                </button>
              )}
              <button
                onClick={onDelete}
                aria-label={`Delete ${ipo.company_name}`}
                title="Delete"
                className="flex items-center rounded-md p-1 transition-colors hover:bg-[var(--critical-tint)]"
                style={{ color: 'var(--critical)' }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          )}
        </div>
      )}

      {(ipo.issue_size || ipo.retail_issue_size || ipo.shareholder_issue_size) && (
        <div
          className="grid grid-cols-2 gap-2 border-t border-b py-2.5 text-xs"
          style={{ borderColor: 'var(--border)' }}
        >
          <Stat label="Overall issue size" value={ipo.issue_size ?? '—'} />
          <Stat label="Retail issue size" value={ipo.retail_issue_size ?? '—'} />
          {ipo.shareholder_issue_size && <Stat label="Shareholder quota" value={ipo.shareholder_issue_size} />}
        </div>
      )}

      {ipo.parent_company_name && (
        <p className="font-mono-ipo text-xs" style={{ color: 'var(--ink-muted)' }}>
          Parent: {ipo.parent_company_name}
          {parentPrice?.price != null && ` · ₹${parentPrice.price}`}
          {parentPrice?.stale && ' (stale)'}
        </p>
      )}

      {ipo.retail_subscription_rate && (
        <p className="font-mono-ipo text-xs font-medium" style={{ color: 'var(--accent)' }}>
          Retail subscription: {ipo.retail_subscription_rate}
        </p>
      )}

      <IpoTimeline
        milestones={[
          { date: ipo.open_date, label: 'Open' },
          { date: ipo.close_date, label: 'Close' },
          { date: ipo.allotment_date, label: 'Allotment', estimated: true },
          { date: ipo.listing_date, label: 'Listing', estimated: true },
        ]}
      />
    </div>
  )

  if (!isHotGmp) return card
  return <div className="aura">{card}</div>
}

function ImportCard({
  candidate: c,
  alreadyAdded,
  eligible,
  checked,
  onToggle,
}: {
  candidate: ImportCandidate
  alreadyAdded: boolean
  eligible: boolean
  checked: boolean
  onToggle: () => void
}) {
  return (
    <label
      className="card flex cursor-pointer flex-col gap-3 p-4 transition-shadow"
      style={{
        opacity: eligible ? 1 : 0.6,
        borderColor: checked ? 'var(--accent)' : undefined,
        background: checked ? 'var(--accent-tint)' : undefined,
        boxShadow: checked ? '0 0 0 1px var(--accent), 0 4px 12px rgba(9, 105, 218, 0.2)' : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={checked}
            disabled={!eligible}
            onChange={onToggle}
            className="mt-1"
          />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            {c.company_name}
          </h3>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {c.exchange && <span className="badge badge-info">{c.exchange}</span>}
          {alreadyAdded && <span className="badge badge-neutral">already added</span>}
        </div>
      </div>

      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
        {c.open_date && c.close_date ? `${c.open_date} → ${c.close_date}` : 'Dates TBA'}
      </p>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat label="Offer price" value={c.price_low && c.price_high ? `₹${c.price_low}-${c.price_high}` : 'N/A'} />
        <Stat label="Lot size" value={c.lot_size ? String(c.lot_size) : 'N/A'} />
      </div>

      {(c.gmp || c.issue_size) && (
        <p className="text-xs">
          {c.gmp && (
            <span className="font-medium" style={{ color: 'var(--good)' }}>
              {c.gmp}
            </span>
          )}
          {c.gmp && c.issue_size && ' · '}
          {c.issue_size && <span style={{ color: 'var(--ink-muted)' }}>Overall issue size {c.issue_size}</span>}
        </p>
      )}

      {!eligible && (
        <p className="text-xs" style={{ color: 'var(--warning-text)' }}>
          Missing date or lot size — can't bulk-save.
        </p>
      )}
    </label>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </p>
      <p className="font-mono-ipo font-semibold" style={{ color: 'var(--ink-primary)' }}>
        {value}
      </p>
    </div>
  )
}

function AddIpoForm({ existing, onCancel, onDone }: { existing?: Ipo; onCancel?: () => void; onDone: () => void }) {
  const [companyName, setCompanyName] = useState(existing?.company_name ?? '')
  const [symbol, setSymbol] = useState(existing?.symbol ?? '')
  const [priceLow, setPriceLow] = useState(existing?.price_low != null ? String(existing.price_low) : '')
  const [priceHigh, setPriceHigh] = useState(existing?.price_high != null ? String(existing.price_high) : '')
  const [lotSize, setLotSize] = useState(existing ? String(existing.lot_size) : '')
  const [openDate, setOpenDate] = useState(existing?.open_date ?? '')
  const [closeDate, setCloseDate] = useState(existing?.close_date ?? '')
  const [allotmentDate, setAllotmentDate] = useState(existing?.allotment_date ?? '')
  const [listingDate, setListingDate] = useState(existing?.listing_date ?? '')
  const [gmpNotes, setGmpNotes] = useState(existing?.gmp_notes ?? '')
  const [issueSize, setIssueSize] = useState(existing?.issue_size ?? '')
  const [retailIssueSize, setRetailIssueSize] = useState(existing?.retail_issue_size ?? '')
  const [shareholderIssueSize, setShareholderIssueSize] = useState(existing?.shareholder_issue_size ?? '')
  const [parentCompanyName, setParentCompanyName] = useState(existing?.parent_company_name ?? '')
  const [parentCompanySymbol, setParentCompanySymbol] = useState(existing?.parent_company_symbol ?? '')
  const [retailSubscriptionRate, setRetailSubscriptionRate] = useState(existing?.retail_subscription_rate ?? '')
  const [registrar, setRegistrar] = useState<Registrar>(existing?.registrar ?? 'OTHER')
  const [registrarUrl, setRegistrarUrl] = useState(existing?.registrar_url ?? '')
  // 'unknown' means "don't touch it" (submitted as null) — not the same as
  // explicitly saying awaited/not-out. Manual override for when ipoji's own
  // scrape hasn't caught a delayed/early allotment yet (see deriveStatus).
  const [allotmentOut, setAllotmentOut] = useState<'unknown' | 'awaited' | 'out'>(
    existing?.allotment_out === true ? 'out' : existing?.allotment_out === false ? 'awaited' : 'unknown',
  )
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const payload = {
      company_name: companyName,
      symbol: symbol || null,
      price_low: priceLow ? Number(priceLow) : null,
      price_high: priceHigh ? Number(priceHigh) : null,
      lot_size: Number(lotSize),
      open_date: openDate,
      close_date: closeDate,
      allotment_date: allotmentDate || null,
      listing_date: listingDate || null,
      registrar,
      registrar_url: registrarUrl || null,
      gmp_notes: gmpNotes || null,
      issue_size: issueSize || null,
      retail_issue_size: retailIssueSize || null,
      shareholder_issue_size: shareholderIssueSize || null,
      parent_company_name: parentCompanyName || null,
      parent_company_symbol: parentCompanySymbol || null,
      retail_subscription_rate: retailSubscriptionRate || null,
      allotment_out: allotmentOut === 'unknown' ? null : allotmentOut === 'out',
    }

    // Editing a known row updates it directly by id; otherwise fall back to
    // the name-based upsert (used by manual "Add" and the import flow).
    const { error } = existing
      ? { error: (await supabase.from('ipos').update(payload).eq('id', existing.id)).error?.message ?? null }
      : await upsertIpo(payload)

    setSubmitting(false)
    if (error) {
      setError(error)
      return
    }
    warnIfLowGmp(companyName, gmpNotes)
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="card grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Company name">
        <input required value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="input" />
      </Field>
      <Field label="Symbol">
        <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className="input" />
      </Field>
      <Field label="Lot size">
        <input required type="number" min={1} value={lotSize} onChange={(e) => setLotSize(e.target.value)} className="input" />
      </Field>
      <Field label="Price band low">
        <input type="number" step="1" value={priceLow} onChange={(e) => setPriceLow(e.target.value)} className="input" />
      </Field>
      <Field label="Price band high">
        <input type="number" step="1" value={priceHigh} onChange={(e) => setPriceHigh(e.target.value)} className="input" />
      </Field>
      <Field label="Registrar">
        <select value={registrar} onChange={(e) => setRegistrar(e.target.value as Registrar)} className="input">
          {registrars.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Open date">
        <input required type="date" value={openDate} onChange={(e) => setOpenDate(e.target.value)} className="input" />
      </Field>
      <Field label="Close date">
        <input required type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} className="input" />
      </Field>
      <Field label="Allotment date">
        <input type="date" value={allotmentDate} onChange={(e) => setAllotmentDate(e.target.value)} className="input" />
      </Field>
      <Field label="Allotment status">
        <select
          value={allotmentOut}
          onChange={(e) => setAllotmentOut(e.target.value as 'unknown' | 'awaited' | 'out')}
          className="input"
        >
          <option value="unknown">Auto (from date / next import)</option>
          <option value="awaited">Awaited (delayed past date)</option>
          <option value="out">Out — override, mark done now</option>
        </select>
      </Field>
      <Field label="Listing date">
        <input type="date" value={listingDate} onChange={(e) => setListingDate(e.target.value)} className="input" />
      </Field>
      <Field label="Registrar allotment-check URL">
        <input value={registrarUrl} onChange={(e) => setRegistrarUrl(e.target.value)} className="input" />
      </Field>
      <Field label="GMP notes">
        <input
          value={gmpNotes}
          onChange={(e) => setGmpNotes(e.target.value)}
          placeholder="e.g. GMP: ₹95-96 (17%)"
          className="input"
        />
      </Field>
      <Field label="Overall issue size">
        <input
          value={issueSize}
          onChange={(e) => setIssueSize(e.target.value)}
          placeholder="e.g. ₹9795.31 Cr"
          className="input"
        />
      </Field>
      <Field label="Retail issue size">
        <input
          value={retailIssueSize}
          onChange={(e) => setRetailIssueSize(e.target.value)}
          placeholder="e.g. ₹3100.87 Cr (31.66%)"
          className="input"
        />
      </Field>
      <Field label="Shareholder quota (optional, only if applicable)">
        <input
          value={shareholderIssueSize}
          onChange={(e) => setShareholderIssueSize(e.target.value)}
          placeholder="e.g. ₹50 Cr"
          className="input"
        />
      </Field>
      <Field label="Parent company name (optional, for shareholder quota)">
        <input
          value={parentCompanyName}
          onChange={(e) => setParentCompanyName(e.target.value)}
          placeholder="e.g. Coal India"
          className="input"
        />
      </Field>
      <Field label="Parent company NSE symbol">
        <input
          value={parentCompanySymbol}
          onChange={(e) => setParentCompanySymbol(e.target.value.toUpperCase())}
          placeholder="e.g. COALINDIA"
          className="input"
        />
      </Field>
      <Field label="Retail subscription rate">
        <input
          value={retailSubscriptionRate}
          onChange={(e) => setRetailSubscriptionRate(e.target.value)}
          placeholder="e.g. 2.77x (once bidding is live/closed)"
          className="input"
        />
      </Field>

      {error && <p className="badge badge-critical col-span-1 w-fit sm:col-span-2 lg:col-span-3">{error}</p>}

      <div className="col-span-1 flex gap-2 sm:col-span-2 lg:col-span-3">
        <button type="submit" disabled={submitting} className="btn-primary flex-1 py-2.5">
          {submitting ? 'Saving…' : existing ? 'Save changes' : 'Save IPO'}
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}
