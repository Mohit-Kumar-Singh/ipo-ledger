import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { AllotmentBoardRow, Ipo, RegistrarLink } from '../../types/database'

export function AllotmentBoardPage() {
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [selectedIpoId, setSelectedIpoId] = useState('')
  const [rows, setRows] = useState<AllotmentBoardRow[]>([])
  const [registrarLinks, setRegistrarLinks] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase
      .from('ipos')
      .select('*')
      .order('open_date', { ascending: false })
      .then(({ data }) => setIpos((data ?? []) as Ipo[]))
    supabase
      .from('registrar_links')
      .select('*')
      .then(({ data }) => {
        const map: Record<string, string> = {}
        for (const l of (data ?? []) as RegistrarLink[]) map[l.registrar] = l.check_url
        setRegistrarLinks(map)
      })
  }, [])

  async function loadBoard(ipoId: string) {
    setSelectedIpoId(ipoId)
    setSelected(new Set())
    if (!ipoId) {
      setRows([])
      return
    }
    setLoading(true)
    const { data } = await supabase.from('v_allotment_board').select('*').eq('ipo_id', ipoId)
    setRows((data ?? []) as AllotmentBoardRow[])
    setLoading(false)
  }

  const selectedIpo = ipos.find((i) => i.id === selectedIpoId)
  const registrarUrl = selectedIpo?.registrar_url || registrarLinks[selectedIpo?.registrar ?? '']

  async function markStatus(applicationId: string, status: 'ALLOTTED' | 'NOT_ALLOTTED') {
    await supabase.from('applications').update({ status }).eq('id', applicationId)
    loadBoard(selectedIpoId)
  }

  async function bulkMarkNotAllotted() {
    if (selected.size === 0) return
    await supabase.from('applications').update({ status: 'NOT_ALLOTTED' }).in('id', Array.from(selected))
    loadBoard(selectedIpoId)
  }

  async function revealPan(row: AllotmentBoardRow) {
    const { data, error } = await supabase.functions.invoke<{ pan: string }>('reveal-pan', {
      body: { demat_id: row.demat_id },
    })
    if (!error && data) setRevealed((r) => ({ ...r, [row.application_id]: data.pan }))
  }

  function copyPan(row: AllotmentBoardRow) {
    const pan = revealed[row.application_id] ?? row.pan_masked
    navigator.clipboard.writeText(pan)
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Allotment board</h1>

      <div className="flex items-center gap-3">
        <select value={selectedIpoId} onChange={(e) => loadBoard(e.target.value)} className="input max-w-xs">
          <option value="">Select an IPO</option>
          {ipos.map((i) => (
            <option key={i.id} value={i.id}>
              {i.company_name}
            </option>
          ))}
        </select>
        {registrarUrl && (
          <a
            href={registrarUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded border px-3 py-2 text-sm hover:bg-gray-50"
          >
            Open registrar page ↗
          </a>
        )}
        {selected.size > 0 && (
          <button
            onClick={bulkMarkNotAllotted}
            className="rounded border px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Mark {selected.size} selected as Not allotted
          </button>
        )}
      </div>

      {loading && <p className="text-gray-500">Loading…</p>}

      {!loading && selectedIpoId && (
        <div className="overflow-x-auto rounded border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-3 py-2"></th>
                <th className="px-3 py-2">Holder</th>
                <th className="px-3 py-2">PAN</th>
                <th className="px-3 py-2">Bank</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.application_id}>
                  <td className="px-3 py-2">
                    {row.status === 'APPLIED' && (
                      <input
                        type="checkbox"
                        checked={selected.has(row.application_id)}
                        onChange={() => toggle(row.application_id)}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2 font-medium">{row.holder_name}</td>
                  <td className="px-3 py-2">
                    <span className="font-mono">{revealed[row.application_id] ?? row.pan_masked}</span>
                    <button onClick={() => revealPan(row)} className="ml-2 text-xs text-purple-700 hover:underline">
                      Reveal
                    </button>
                    <button onClick={() => copyPan(row)} className="ml-2 text-xs text-purple-700 hover:underline">
                      Copy
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    {row.bank_name ? `${row.bank_name} ••${row.last4}` : '—'}
                  </td>
                  <td className="px-3 py-2">{row.status}</td>
                  <td className="px-3 py-2">
                    {row.status === 'APPLIED' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => markStatus(row.application_id, 'ALLOTTED')}
                          className="text-xs text-green-700 hover:underline"
                        >
                          Allotted
                        </button>
                        <button
                          onClick={() => markStatus(row.application_id, 'NOT_ALLOTTED')}
                          className="text-xs text-gray-500 hover:underline"
                        >
                          Not allotted
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-gray-400">
                    No applications for this IPO.
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
