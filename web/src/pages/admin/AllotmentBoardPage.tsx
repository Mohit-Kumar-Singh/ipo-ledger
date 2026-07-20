import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { AllotmentBoardRow, ApplicationStatus, Ipo, RegistrarLink } from '../../types/database'

const statusBadgeClass: Record<ApplicationStatus, string> = {
  APPLIED: 'badge-info',
  ALLOTTED: 'badge-good',
  NOT_ALLOTTED: 'badge-neutral',
  SOLD: 'badge-violet',
}

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
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Allotment board
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Copy PAN, open the registrar, mark results — one row at a time.
        </p>
      </div>

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
          <a href={registrarUrl} target="_blank" rel="noreferrer" className="btn-secondary">
            Open registrar page ↗
          </a>
        )}
        {selected.size > 0 && (
          <button onClick={bulkMarkNotAllotted} className="btn-secondary">
            Mark {selected.size} selected as Not allotted
          </button>
        )}
      </div>

      {loading && <p style={{ color: 'var(--ink-muted)' }}>Loading…</p>}

      {!loading && selectedIpoId && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
              <tr>
                <th className="px-4 py-2.5"></th>
                <th className="px-4 py-2.5 font-medium">Holder</th>
                <th className="px-4 py-2.5 font-medium">PAN</th>
                <th className="px-4 py-2.5 font-medium">Bank</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {rows.map((row) => (
                <tr key={row.application_id} className="hover:bg-[var(--hover-surface)]">
                  <td className="px-4 py-2.5">
                    {row.status === 'APPLIED' && (
                      <input
                        type="checkbox"
                        checked={selected.has(row.application_id)}
                        onChange={() => toggle(row.application_id)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {row.holder_name}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono" style={{ color: 'var(--ink-secondary)' }}>
                      {revealed[row.application_id] ?? row.pan_masked}
                    </span>
                    <button onClick={() => revealPan(row)} className="link-accent ml-2 text-xs font-medium">
                      Reveal
                    </button>
                    <button onClick={() => copyPan(row)} className="link-accent ml-2 text-xs font-medium">
                      Copy
                    </button>
                  </td>
                  <td className="px-4 py-2.5">{row.bank_name ? `${row.bank_name} ••${row.last4}` : '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className={`badge ${statusBadgeClass[row.status]}`}>{row.status.replace('_', ' ')}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    {row.status === 'APPLIED' && (
                      <div className="flex gap-3">
                        <button onClick={() => markStatus(row.application_id, 'ALLOTTED')} className="link-accent text-xs font-medium">
                          Allotted
                        </button>
                        <button
                          onClick={() => markStatus(row.application_id, 'NOT_ALLOTTED')}
                          className="text-xs font-medium hover:underline"
                          style={{ color: 'var(--ink-muted)' }}
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
                  <td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
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
