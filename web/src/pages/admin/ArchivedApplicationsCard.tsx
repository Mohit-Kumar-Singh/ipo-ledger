import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArchiveIcon, ChevronDownIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { InfoTooltip } from '../../components/HoverCard'
import type { ApplicationStatus } from '../../types/database'

type ArchivedRow = {
  id: string
  status: ApplicationStatus
  demat_accounts: { holder_name: string } | null
  ipos: { company_name: string } | null
}

const statusBadgeClass: Record<ApplicationStatus, string> = {
  APPLIED: 'badge-info',
  ALLOTTED: 'badge-good',
  NOT_ALLOTTED: 'badge-neutral',
  SOLD: 'badge-violet',
}

// Module-level, not recreated per render — `rows` feeds the byIpo useMemo
// below, so a fresh `?? []` allocated inline on every render (during the
// query's pending window) was an unstable dependency that useMemo could
// never actually memoize against.
const EMPTY_ROWS: ArchivedRow[] = []

// Self-contained, collapsed-by-default card (same shape as the PAN access-log
// and sell-instruction-PDF cards) listing applications whose IPO has been
// archived/settled. Fetches its own scoped data (RLS limits it to what the
// viewer may see), and renders nothing at all when there's none — so it only
// appears at the bottom of Profile once there's actually history to show.
export function ArchivedApplicationsCard() {
  // Was a local useState + fetch-once-on-mount — the collapsed-by-default
  // card visibly flashed away and back (the `if (loading ...) return null`
  // below) on every single visit to Profile, even seconds after it had
  // already shown the same rows. One useQuery instead, same fix as every
  // other page this pass.
  const [open, setOpen] = useState(false)
  const archivedQuery = useQuery<ArchivedRow[]>({
    queryKey: ['archived-applications'],
    queryFn: async () => {
      const { data } = await supabase
        .from('applications')
        .select('id, status, demat_accounts(holder_name), ipos!inner(company_name, is_archived)')
        .eq('ipos.is_archived', true)
      return (data ?? []) as unknown as ArchivedRow[]
    },
  })
  const rows = archivedQuery.data ?? EMPTY_ROWS
  const loading = archivedQuery.isPending

  const byIpo = useMemo(() => {
    const map = new Map<string, ArchivedRow[]>()
    for (const a of rows) {
      const name = a.ipos?.company_name ?? 'Unknown IPO'
      if (!map.has(name)) map.set(name, [])
      map.get(name)!.push(a)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rows])

  // Nothing to show (and don't flash an empty card while loading either).
  if (loading || rows.length === 0) return null

  return (
    <section className="card animate-page-in overflow-visible">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-[var(--hover-surface)]"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <ArchiveIcon size={16} fill="var(--violet)" />
          Archived applications
          <InfoTooltip text="Applications whose IPO has been archived (fully settled). Read-only reference, grouped by IPO." />
          <span className="badge badge-neutral">{rows.length}</span>
        </span>
        <span
          className="inline-flex transition-transform duration-200"
          style={{ color: 'var(--ink-muted)', transform: open ? 'rotate(180deg)' : undefined }}
        >
          <ChevronDownIcon size={16} />
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t p-4" style={{ borderColor: 'var(--border)' }}>
          {byIpo.map(([ipoName, items]) => (
            <div key={ipoName}>
              <p className="mb-1 text-xs font-semibold" style={{ color: 'var(--ink-secondary)' }}>
                {ipoName} <span style={{ color: 'var(--ink-muted)' }}>({items.length})</span>
              </p>
              <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
                {items.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="truncate" style={{ color: 'var(--ink-primary)' }}>
                      {a.demat_accounts?.holder_name ?? 'Unknown'}
                    </span>
                    <span className={`badge ${statusBadgeClass[a.status]}`}>{a.status.replace('_', ' ')}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
