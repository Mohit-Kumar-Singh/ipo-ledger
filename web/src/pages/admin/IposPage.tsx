import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { GraphIcon } from '@primer/octicons-react'
import { describeFunctionError, supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { parseGmpPercent } from '../../lib/ipoGmp'
import { showToast } from '../../lib/toast'
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
}

function isEligible(c: ImportCandidate): boolean {
  return c.open_date != null && c.close_date != null && c.lot_size != null
}

function deriveStatus(ipo: Ipo): { label: string; badge: string } {
  const today = new Date().toISOString().slice(0, 10)
  if (ipo.listing_date && today >= ipo.listing_date) return { label: 'Listed', badge: 'badge-violet' }
  if (ipo.allotment_date && today >= ipo.allotment_date) return { label: 'Allotment out', badge: 'badge-warning' }
  if (today > ipo.close_date) return { label: 'Closed', badge: 'badge-neutral' }
  if (today >= ipo.open_date) return { label: 'Open', badge: 'badge-good' }
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
  const { data: existing } = await supabase
    .from('ipos')
    .select('id')
    .ilike('company_name', payload.company_name as string)
    .maybeSingle()

  const { error } = existing
    ? await supabase.from('ipos').update(payload).eq('id', existing.id)
    : await supabase.from('ipos').insert(payload)

  return { error: error?.message ?? null }
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

  const [selectedIpos, setSelectedIpos] = useState<Set<string>>(new Set())

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('ipos').select('*').order('open_date', { ascending: false })
    if (error) {
      alert(`Couldn't load IPOs: ${error.message}`)
      setLoading(false)
      return
    }
    setIpos(sortIpos((data ?? []) as Ipo[]))
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function fetchCandidates(source: 'current' | 'upcoming') {
    setImportSource(source)
    setImportLoading(true)
    setImportError(null)
    setCandidates([])
    setSelected(new Set())
    setBulkResult(null)
    const { data, error } = await supabase.functions.invoke<{ candidates?: ImportCandidate[]; error?: string }>(
      'import-ipos',
      { body: { mode: 'list', source } },
    )
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

  async function saveSelected() {
    const chosen = candidates.filter((c) => selected.has(c.source_url))
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
    if (!window.confirm(`Delete ${selectedIpos.size} IPO(s)? This cannot be undone.`)) return
    const { error } = await supabase.from('ipos').delete().in('id', Array.from(selectedIpos))
    if (error) {
      alert(
        error.code === '23503'
          ? "Can't delete one or more of these — they still have applications on record. Delete those applications first, or delete IPOs one at a time to see which."
          : error.message,
      )
      return
    }
    setSelectedIpos(new Set())
    load()
  }

  async function deleteIpo(ipo: Ipo) {
    if (!window.confirm(`Delete ${ipo.company_name}? This cannot be undone.`)) return
    const { error } = await supabase.from('ipos').delete().eq('id', ipo.id)
    if (error) {
      alert(
        error.code === '23503'
          ? `Can't delete ${ipo.company_name} — it still has applications on record. Delete those applications first.`
          : error.message,
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
      alert(error.message)
      return
    }
    load()
  }

  const existingNames = new Set(ipos.map((i) => i.company_name.toLowerCase()))
  const visibleIpos = ipos.filter((i) => !i.is_archived)
  const archivedIpos = ipos.filter((i) => i.is_archived)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            IPOs
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {visibleIpos.length} tracked
            {archivedIpos.length > 0 ? ` · ${archivedIpos.length} archived` : ''}
          </p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setShowImport((s) => !s)
                setShowAddForm(false)
                setEditingIpo(null)
              }}
              className="btn-secondary"
            >
              {showImport ? 'Cancel' : 'Import from ipoji.com'}
            </button>
            <button
              onClick={() => {
                setShowAddForm((s) => !s)
                setShowImport(false)
                setEditingIpo(null)
              }}
              className="btn-primary"
            >
              {showAddForm ? 'Cancel' : '+ Add IPO'}
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
          {isAdmin && visibleIpos.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
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
            </div>
          )}
          {visibleIpos.length === 0 ? (
            <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
              Everything's archived — see below.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleIpos.map((ipo) => (
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
                />
              ))}
            </div>
          )}

          {archivedIpos.length > 0 && (
            <ArchivedSection>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {archivedIpos.map((ipo) => (
                  <IpoCard
                    key={ipo.id}
                    ipo={ipo}
                    isAdmin={isAdmin}
                    onEdit={() => {
                      setEditingIpo(ipo)
                      setShowAddForm(false)
                      setShowImport(false)
                    }}
                    onDelete={() => deleteIpo(ipo)}
                    onUnarchive={() => setArchived(ipo, false)}
                  />
                ))}
              </div>
            </ArchivedSection>
          )}
        </>
      )}
    </div>
  )
}

// Collapsed by default — archived IPOs are still fully real (applications on
// them keep working exactly as before), just out of the way of the main list.
function ArchivedSection({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium hover:underline"
        style={{ color: 'var(--ink-muted)' }}
      >
        {open ? '▾' : '▸'} Archived
      </button>
      {open && children}
    </section>
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
  onUnarchive,
}: {
  ipo: Ipo
  isAdmin: boolean
  selected?: boolean
  onToggleSelected?: () => void
  onEdit: () => void
  onDelete: () => void
  onArchive?: () => void
  onUnarchive?: () => void
}) {
  const status = deriveStatus(ipo)
  return (
    <div className="card stagger-item flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          {isAdmin && onToggleSelected && (
            <input
              type="checkbox"
              className="mt-1"
              checked={selected ?? false}
              onChange={onToggleSelected}
              aria-label={`Select ${ipo.company_name}`}
            />
          )}
          <div
            className={`icon-badge ${status.badge.replace('badge-', 'icon-badge-')} shrink-0`}
            style={{ width: '2.25rem', height: '2.25rem' }}
          >
            <GraphIcon size={16} />
          </div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            {ipo.company_name}
          </h3>
        </div>
        <span className={`badge shrink-0 ${status.badge}`}>{status.label}</span>
      </div>

      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
        {ipo.registrar}
        {ipo.price_low && ipo.price_high && ` · ₹${ipo.price_low}-${ipo.price_high}`}
        {ipo.lot_size ? ` · lot ${ipo.lot_size}` : ''}
      </p>

      {(ipo.gmp_notes || isAdmin) && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium" style={{ color: 'var(--good)' }}>
            {ipo.gmp_notes}
          </p>
          {isAdmin && (
            <div className="flex shrink-0 gap-3">
              <button onClick={onEdit} className="link-accent text-xs font-medium">
                Edit
              </button>
              {onArchive && (
                <button
                  onClick={onArchive}
                  className="text-xs font-medium hover:underline"
                  style={{ color: 'var(--ink-muted)' }}
                >
                  Archive
                </button>
              )}
              {onUnarchive && (
                <button onClick={onUnarchive} className="link-accent text-xs font-medium">
                  Unarchive
                </button>
              )}
              <button
                onClick={onDelete}
                className="text-xs font-medium hover:underline"
                style={{ color: 'var(--critical)' }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}

      {(ipo.issue_size || ipo.retail_issue_size || ipo.shareholder_issue_size) && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Stat label="Overall issue size" value={ipo.issue_size ?? '—'} />
          <Stat label="Retail issue size" value={ipo.retail_issue_size ?? '—'} />
          {ipo.shareholder_issue_size && <Stat label="Shareholder quota" value={ipo.shareholder_issue_size} />}
        </div>
      )}

      {ipo.retail_subscription_rate && (
        <p className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
          Retail subscription: {ipo.retail_subscription_rate}
        </p>
      )}

      <IpoTimeline
        openDate={ipo.open_date}
        closeDate={ipo.close_date}
        allotmentDate={ipo.allotment_date}
        listingDate={ipo.listing_date}
      />
    </div>
  )
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
      <p style={{ color: 'var(--ink-muted)' }}>{label}</p>
      <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
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
  const [retailSubscriptionRate, setRetailSubscriptionRate] = useState(existing?.retail_subscription_rate ?? '')
  const [registrar, setRegistrar] = useState<Registrar>(existing?.registrar ?? 'OTHER')
  const [registrarUrl, setRegistrarUrl] = useState(existing?.registrar_url ?? '')
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
      retail_subscription_rate: retailSubscriptionRate || null,
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
