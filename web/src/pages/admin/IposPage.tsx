import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
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

function deriveStatus(ipo: Ipo): string {
  const today = new Date().toISOString().slice(0, 10)
  if (ipo.listing_date && today >= ipo.listing_date) return 'Listed'
  if (ipo.allotment_date && today >= ipo.allotment_date) return 'Allotment out'
  if (today > ipo.close_date) return 'Closed'
  if (today >= ipo.open_date) return 'Open'
  return 'Upcoming'
}

export function IposPage() {
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('ipos').select('*').order('open_date', { ascending: false })
    setIpos((data ?? []) as Ipo[])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">IPOs</h1>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="rounded bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-800"
        >
          {showForm ? 'Cancel' : '+ Add IPO'}
        </button>
      </div>

      {showForm && (
        <AddIpoForm
          onDone={() => {
            setShowForm(false)
            load()
          }}
        />
      )}

      {loading ? (
        <p className="text-gray-500">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Open</th>
                <th className="px-3 py-2">Close</th>
                <th className="px-3 py-2">Listing</th>
                <th className="px-3 py-2">Registrar</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ipos.map((ipo) => (
                <tr key={ipo.id}>
                  <td className="px-3 py-2 font-medium">{ipo.company_name}</td>
                  <td className="px-3 py-2">{deriveStatus(ipo)}</td>
                  <td className="px-3 py-2">{ipo.open_date}</td>
                  <td className="px-3 py-2">{ipo.close_date}</td>
                  <td className="px-3 py-2">{ipo.listing_date ?? '—'}</td>
                  <td className="px-3 py-2">{ipo.registrar}</td>
                </tr>
              ))}
              {ipos.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-gray-400">
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

function AddIpoForm({ onDone }: { onDone: () => void }) {
  const [companyName, setCompanyName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [priceLow, setPriceLow] = useState('')
  const [priceHigh, setPriceHigh] = useState('')
  const [lotSize, setLotSize] = useState('')
  const [openDate, setOpenDate] = useState('')
  const [closeDate, setCloseDate] = useState('')
  const [allotmentDate, setAllotmentDate] = useState('')
  const [listingDate, setListingDate] = useState('')
  const [registrar, setRegistrar] = useState<Registrar>('OTHER')
  const [registrarUrl, setRegistrarUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await supabase.from('ipos').insert({
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
    })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-3 gap-3 rounded border bg-white p-4">
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

      {error && <p className="col-span-3 text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="col-span-3 rounded bg-purple-700 py-2 text-sm font-medium text-white hover:bg-purple-800 disabled:opacity-50"
      >
        {submitting ? 'Saving…' : 'Save IPO'}
      </button>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm text-gray-700">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}
