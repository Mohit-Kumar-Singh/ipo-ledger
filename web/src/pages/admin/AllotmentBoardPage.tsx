import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type {
  AllotmentBoardRow,
  ApplicationStatus,
  Ipo,
  Notification,
  RegistrarLink,
} from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

const statusBadgeClass: Record<ApplicationStatus, string> = {
  APPLIED: 'badge-info',
  ALLOTTED: 'badge-good',
  NOT_ALLOTTED: 'badge-neutral',
  SOLD: 'badge-violet',
}

const notifBadgeClass: Record<Notification['status'], string> = {
  QUEUED: 'badge-neutral',
  SENT: 'badge-info',
  DELIVERED: 'badge-good',
  READ: 'badge-violet',
  FAILED: 'badge-critical',
  SIMULATED: 'badge-warning',
}

export function AllotmentBoardPage() {
  const [ipos, setIpos] = useState<Ipo[]>([])
  const [selectedIpoId, setSelectedIpoId] = useState('')
  const [rows, setRows] = useState<AllotmentBoardRow[]>([])
  const [registrarLinks, setRegistrarLinks] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [allottedNotifs, setAllottedNotifs] = useState<Record<string, Pick<Notification, 'id' | 'status'>>>({})
  const [dispatching, setDispatching] = useState<string | null>(null)

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
    const boardRows = (data ?? []) as AllotmentBoardRow[]
    setRows(boardRows)

    const appIds = boardRows.map((r) => r.application_id)
    if (appIds.length > 0) {
      const { data: notifs } = await supabase
        .from('notifications')
        .select('id, application_id, status')
        .eq('type', 'ALLOTTED')
        .in('application_id', appIds)
      const map: Record<string, Pick<Notification, 'id' | 'status'>> = {}
      for (const n of notifs ?? []) map[n.application_id as string] = { id: n.id, status: n.status }
      setAllottedNotifs(map)
    } else {
      setAllottedNotifs({})
    }
    setLoading(false)
  }

  async function dispatchNotification(notificationId: string) {
    setDispatching(notificationId)
    await supabase.functions.invoke('send-whatsapp', { body: { notification_id: notificationId } })
    setDispatching(null)
    loadBoard(selectedIpoId)
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

      <div className="flex flex-wrap items-center gap-3">
        <select value={selectedIpoId} onChange={(e) => loadBoard(e.target.value)} className="input w-full sm:max-w-xs">
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

      {loading && <InlineSpinner />}

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
                <th className="px-4 py-2.5 font-medium">Message</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {rows.map((row) => {
                const notif = allottedNotifs[row.application_id]
                return (
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
                    {notif ? (
                      <div className="flex items-center gap-2">
                        <span className={`badge ${notifBadgeClass[notif.status]}`}>{notif.status}</span>
                        {(notif.status === 'QUEUED' || notif.status === 'FAILED') && (
                          <button
                            onClick={() => dispatchNotification(notif.id)}
                            disabled={dispatching === notif.id}
                            className="link-accent text-xs font-medium disabled:opacity-50"
                          >
                            {dispatching === notif.id ? 'Sending…' : notif.status === 'FAILED' ? 'Retry' : 'Send'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--ink-muted)' }}>—</span>
                    )}
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
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
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
