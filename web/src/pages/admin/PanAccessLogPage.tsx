import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { InfoTooltip } from '../../components/HoverCard'

interface PanAccessLogRow {
  id: string
  demat_id: string
  accessed_by: string
  accessed_at: string
  is_self_reveal: boolean
  demat_accounts: { holder_name: string } | null
  profiles: { full_name: string } | null
}

// Local calendar day, not UTC — a reveal at 11pm IST is "today" to whoever's
// looking, even though its accessed_at timestamp may already have rolled
// into tomorrow in UTC.
function dayKeyFor(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Module-level, not recreated per render — `rows` feeds the hasInitializedOpenDays
// effect and the dayGroups useMemo below, so a fresh `?? []` allocated inline
// on every render (during the query's pending window) was an unstable
// dependency neither could actually memoize/guard against.
const EMPTY_PAN_LOG_ROWS: PanAccessLogRow[] = []

// Moved off Profile's own collapsible "PAN access log" card onto its own
// page — content/logic unchanged from that section (still grouped by day,
// most recent day open by default), just reached by tapping a nav card now
// instead of expanding inline.
export function PanAccessLogPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const panAccessLogQuery = useQuery<PanAccessLogRow[]>({
    queryKey: ['pan-access-log'],
    queryFn: async () => {
      const { data } = await supabase
        .from('pan_access_log')
        .select('*, demat_accounts(holder_name), profiles(full_name)')
        .order('accessed_at', { ascending: false })
        .limit(200)
      return (data ?? []) as unknown as PanAccessLogRow[]
    },
    enabled: isAdmin,
  })
  const rows = panAccessLogQuery.data ?? EMPTY_PAN_LOG_ROWS
  const loading = panAccessLogQuery.isPending
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  // Guards against a background refetch (staleTime elapsing on a revisit)
  // silently collapsing whatever days the user had manually opened —
  // without this, a plain `useEffect(..., [rows])` re-derives openDays
  // from the freshest rows on EVERY data update, not just the first one.
  const hasInitializedOpenDays = useRef(false)

  useEffect(() => {
    if (hasInitializedOpenDays.current || rows.length === 0) return
    hasInitializedOpenDays.current = true
    setOpenDays(new Set([dayKeyFor(rows[0].accessed_at)]))
  }, [rows])

  const dayGroups = useMemo(() => {
    const groups = new Map<string, PanAccessLogRow[]>()
    for (const r of rows) {
      const key = dayKeyFor(r.accessed_at)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(r)
    }
    return Array.from(groups.entries())
  }, [rows])

  function toggleDay(key: string) {
    setOpenDays((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (!isAdmin) {
    return (
      <p className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
        This page is for admins only.
      </p>
    )
  }

  return (
    <div className="mx-auto max-w-md space-y-4 lg:max-w-2xl">
      <div>
        <h1 className="flex items-center gap-1.5 text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          PAN access log
          <InfoTooltip text={`Every time a PAN is decrypted (Accounts/Allotment board "Reveal PAN"), it's logged here — who, whose PAN, and when. Grouped by day, most recent first.`} />
        </h1>
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Loading…
        </p>
      ) : dayGroups.length === 0 ? (
        <p className="card p-4 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No PAN reveals logged yet.
        </p>
      ) : (
        <div className="space-y-2">
          {dayGroups.map(([day, dayRows]) => {
            const dayOpen = openDays.has(day)
            return (
              <div key={day} className="card overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleDay(day)}
                  className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium transition-colors hover:bg-[var(--hover-surface)]"
                  style={{ color: 'var(--ink-primary)' }}
                >
                  <span>
                    {dayOpen ? '▾' : '▸'}{' '}
                    {new Date(dayRows[0].accessed_at).toLocaleDateString(undefined, {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                  <span className="badge badge-neutral shrink-0">{dayRows.length}</span>
                </button>
                {dayOpen && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
                        <tr>
                          <th className="px-4 py-2 font-medium">When</th>
                          <th className="px-4 py-2 font-medium">PAN of</th>
                          <th className="px-4 py-2 font-medium">Accessed by</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y border-t" style={{ borderColor: 'var(--border)' }}>
                        {dayRows.map((r) => (
                          <tr key={r.id} className="stagger-item transition-colors duration-150 hover:bg-[var(--hover-surface)]">
                            <td className="px-4 py-2" style={{ color: 'var(--ink-muted)' }}>
                              {new Date(r.accessed_at).toLocaleTimeString()}
                            </td>
                            <td className="px-4 py-2" style={{ color: 'var(--ink-primary)' }}>
                              {r.demat_accounts?.holder_name ?? '—'}
                            </td>
                            <td className="px-4 py-2">
                              {r.profiles?.full_name ?? '—'}
                              {r.is_self_reveal && (
                                <span className="ml-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
                                  (self)
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
