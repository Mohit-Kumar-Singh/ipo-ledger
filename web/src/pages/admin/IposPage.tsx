import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { describeFunctionError, supabase } from '../../lib/supabase'
import type { Ipo, Registrar } from '../../types/database'

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
  source_url: string
}

interface ImportDetail {
  allotment_date: string | null
  listing_date: string | null
  exchange: string | null
}

interface IpoPrefill {
  companyName?: string
  priceLow?: string
  priceHigh?: string
  lotSize?: string
  openDate?: string
  closeDate?: string
  allotmentDate?: string
  listingDate?: string
  gmpNotes?: string
}

function deriveStatus(ipo: Ipo): { label: string; badge: string } {
  const today = new Date().toISOString().slice(0, 10)
  if (ipo.listing_date && today >= ipo.listing_date) return { label: 'Listed', badge: 'badge-violet' }
  if (ipo.allotment_date && today >= ipo.allotment_date) return { label: 'Allotment out', badge: 'badge-warning' }
  if (today > ipo.close_date) return { label: 'Closed', badge: 'badge-neutral' }
  if (today >= ipo.open_date) return { label: 'Open', badge: 'badge-good' }
  return { label: 'Upcoming', badge: 'badge-info' }
}

export function IposPage() {
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [loading, setLoading] = useState(true)
  const [formPrefill, setFormPrefill] = useState<IpoPrefill | null>(null)

  const [showImport, setShowImport] = useState(false)
  const [importSource, setImportSource] = useState<'current' | 'upcoming'>('current')
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [detailLoadingFor, setDetailLoadingFor] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('ipos').select('*').order('open_date', { ascending: false })
    setIpos((data ?? []) as Ipo[])
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

  async function useCandidate(c: ImportCandidate) {
    setDetailLoadingFor(c.source_url)
    const { data, error } = await supabase.functions.invoke<ImportDetail & { error?: string }>('import-ipos', {
      body: { mode: 'detail', detail_url: c.source_url },
    })
    setDetailLoadingFor(null)

    const detail = !error && data && !data.error ? data : null

    setFormPrefill({
      companyName: c.company_name,
      priceLow: c.price_low != null ? String(c.price_low) : '',
      priceHigh: c.price_high != null ? String(c.price_high) : '',
      lotSize: c.lot_size != null ? String(c.lot_size) : '',
      openDate: c.open_date ?? '',
      closeDate: c.close_date ?? '',
      allotmentDate: detail?.allotment_date ?? '',
      listingDate: detail?.listing_date ?? '',
      gmpNotes: c.gmp ?? '',
    })
    setShowImport(false)
  }

  async function deleteIpo(ipo: Ipo) {
    if (
      !window.confirm(
        `Delete ${ipo.company_name}? This also deletes any applications (and their notification history reference) for this IPO. This cannot be undone.`,
      )
    )
      return
    const { error } = await supabase.from('ipos').delete().eq('id', ipo.id)
    if (error) {
      alert(error.message)
      return
    }
    load()
  }

  const existingNames = new Set(ipos.map((i) => i.company_name.toLowerCase()))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            IPOs
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            {ipos.length} tracked
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => {
              setShowImport((s) => !s)
              setFormPrefill(null)
            }}
            className="btn-secondary"
          >
            {showImport ? 'Cancel' : 'Import from ipoji.com'}
          </button>
          <button
            onClick={() => {
              setFormPrefill((p) => (p ? null : {}))
              setShowImport(false)
            }}
            className="btn-primary"
          >
            {formPrefill ? 'Cancel' : '+ Add IPO'}
          </button>
        </div>
      </div>

      {showImport && (
        <div className="card space-y-4 p-5">
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Pulls live data from ipoji.com. Pick a card to open the Add IPO form pre-filled — nothing saves until
            you review and hit Save IPO there.
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
          </div>

          {importLoading && <p style={{ color: 'var(--ink-muted)' }}>Fetching…</p>}
          {importError && <p className="badge badge-critical w-fit">{importError}</p>}

          {!importLoading && candidates.length > 0 && (
            <div className="grid grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2" style={{ maxHeight: '560px' }}>
              {candidates.map((c) => (
                <ImportCard
                  key={c.source_url}
                  candidate={c}
                  alreadyAdded={existingNames.has(c.company_name.toLowerCase())}
                  loading={detailLoadingFor === c.source_url}
                  onUse={() => useCandidate(c)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {formPrefill !== null && (
        <AddIpoForm
          initial={formPrefill}
          onDone={() => {
            setFormPrefill(null)
            load()
          }}
        />
      )}

      {loading ? (
        <p style={{ color: 'var(--ink-muted)' }}>Loading…</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
              <tr>
                <th className="px-4 py-2.5 font-medium">Company</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Open</th>
                <th className="px-4 py-2.5 font-medium">Close</th>
                <th className="px-4 py-2.5 font-medium">Listing</th>
                <th className="px-4 py-2.5 font-medium">Registrar</th>
                <th className="px-4 py-2.5 font-medium">GMP</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {ipos.map((ipo) => {
                const status = deriveStatus(ipo)
                return (
                  <tr key={ipo.id} className="hover:bg-[var(--hover-surface)]">
                    <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {ipo.company_name}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`badge ${status.badge}`}>{status.label}</span>
                    </td>
                    <td className="px-4 py-2.5">{ipo.open_date}</td>
                    <td className="px-4 py-2.5">{ipo.close_date}</td>
                    <td className="px-4 py-2.5">{ipo.listing_date ?? '—'}</td>
                    <td className="px-4 py-2.5">{ipo.registrar}</td>
                    <td className="px-4 py-2.5" style={{ color: 'var(--good)' }}>
                      {ipo.gmp_notes ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => deleteIpo(ipo)}
                        className="text-xs font-medium hover:underline"
                        style={{ color: 'var(--critical)' }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
              {ipos.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
                    No IPOs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ImportCard({
  candidate: c,
  alreadyAdded,
  loading,
  onUse,
}: {
  candidate: ImportCandidate
  alreadyAdded: boolean
  loading: boolean
  onUse: () => void
}) {
  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          {c.company_name}
        </h3>
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

      {c.gmp && (
        <p className="text-xs font-medium" style={{ color: 'var(--good)' }}>
          {c.gmp}
        </p>
      )}

      <button onClick={onUse} disabled={loading} className="btn-secondary mt-1 disabled:opacity-50">
        {loading
          ? 'Fetching allotment/listing dates…'
          : alreadyAdded
            ? 'Use this IPO → (updates existing)'
            : 'Use this IPO →'}
      </button>
    </div>
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

function AddIpoForm({ initial, onDone }: { initial: IpoPrefill; onDone: () => void }) {
  const [companyName, setCompanyName] = useState(initial.companyName ?? '')
  const [symbol, setSymbol] = useState('')
  const [priceLow, setPriceLow] = useState(initial.priceLow ?? '')
  const [priceHigh, setPriceHigh] = useState(initial.priceHigh ?? '')
  const [lotSize, setLotSize] = useState(initial.lotSize ?? '')
  const [openDate, setOpenDate] = useState(initial.openDate ?? '')
  const [closeDate, setCloseDate] = useState(initial.closeDate ?? '')
  const [allotmentDate, setAllotmentDate] = useState(initial.allotmentDate ?? '')
  const [listingDate, setListingDate] = useState(initial.listingDate ?? '')
  const [gmpNotes, setGmpNotes] = useState(initial.gmpNotes ?? '')
  const [registrar, setRegistrar] = useState<Registrar>('OTHER')
  const [registrarUrl, setRegistrarUrl] = useState('')
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
    }

    // Same company (case-insensitive exact match) updates the existing row
    // instead of creating a duplicate — matters for re-importing an IPO
    // whose GMP/allotment/listing info has since changed.
    const { data: existing } = await supabase
      .from('ipos')
      .select('id')
      .ilike('company_name', companyName)
      .maybeSingle()

    const { error } = existing
      ? await supabase.from('ipos').update(payload).eq('id', existing.id)
      : await supabase.from('ipos').insert(payload)

    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
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
        <input type="number" step="0.01" value={priceLow} onChange={(e) => setPriceLow(e.target.value)} className="input" />
      </Field>
      <Field label="Price band high">
        <input type="number" step="0.01" value={priceHigh} onChange={(e) => setPriceHigh(e.target.value)} className="input" />
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

      {error && <p className="badge badge-critical col-span-1 w-fit sm:col-span-2 lg:col-span-3">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="btn-primary col-span-1 py-2.5 sm:col-span-2 lg:col-span-3"
      >
        {submitting ? 'Saving…' : 'Save IPO'}
      </button>
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
