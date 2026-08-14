import { useEffect, useMemo, useState } from 'react'
import { PaintbrushIcon, ShieldCheckIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { useTheme } from '../../contexts/ThemeContext'
import { ThemeToggle } from '../../components/ThemeToggle'
import { InlineSpinner } from '../../components/PageSpinner'

interface PanAccessLogRow {
  id: string
  demat_id: string
  accessed_by: string
  accessed_at: string
  is_self_reveal: boolean
  demat_accounts: { holder_name: string } | null
  profiles: { full_name: string } | null
}

export function SettingsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Settings
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Appearance{isAdmin && ' and the PAN-reveal audit trail'}.
        </p>
      </div>
      <AppearanceSection />
      {isAdmin && <PanAccessLogSection />}
    </div>
  )
}

// Moved here from the sidebar identity block — a per-page settings toggle
// reads more like "settings" than a control living permanently in the nav
// chrome, and it's one less thing competing for space in the collapsed
// icon-rail sidebar.
function AppearanceSection() {
  const { theme } = useTheme()
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
        <PaintbrushIcon size={15} fill="var(--accent)" />
        Appearance
      </h2>
      <div className="card flex items-center justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
            Theme
          </p>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Currently {theme === 'dark' ? 'dark' : 'light'}.
          </p>
        </div>
        <ThemeToggle />
      </div>
    </section>
  )
}

// Local calendar day, not UTC — a reveal at 11pm IST is "today" to whoever's
// looking, even though its accessed_at timestamp may already have rolled
// into tomorrow in UTC.
function dayKeyFor(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function PanAccessLogSection() {
  const [rows, setRows] = useState<PanAccessLogRow[]>([])
  const [loading, setLoading] = useState(true)
  // Collapsed by default, one exception — the most recent day's group
  // starts open, since that's almost always the one worth actually
  // reading; older days are there to scroll back into, not to greet you
  // with 200 flat rows every visit.
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())

  useEffect(() => {
    supabase
      .from('pan_access_log')
      .select('*, demat_accounts(holder_name), profiles(full_name)')
      .order('accessed_at', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        const loaded = (data ?? []) as unknown as PanAccessLogRow[]
        setRows(loaded)
        if (loaded.length > 0) setOpenDays(new Set([dayKeyFor(loaded[0].accessed_at)]))
        setLoading(false)
      })
  }, [])

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

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
        <ShieldCheckIcon size={15} fill="var(--violet)" />
        PAN access log
      </h2>
      <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
        Every time a PAN is decrypted (Accounts/Allotment board "Reveal PAN"), it's logged here — who, whose
        PAN, and when. Grouped by day, most recent first.
      </p>
      {loading ? (
        <InlineSpinner />
      ) : dayGroups.length === 0 ? (
        <p className="card p-4 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
          No PAN reveals logged yet.
        </p>
      ) : (
        <div className="space-y-2">
          {dayGroups.map(([day, dayRows]) => {
            const open = openDays.has(day)
            return (
              <div key={day} className="card overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleDay(day)}
                  className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium transition-colors hover:bg-[var(--hover-surface)]"
                  style={{ color: 'var(--ink-primary)' }}
                >
                  <span>
                    {open ? '▾' : '▸'}{' '}
                    {new Date(dayRows[0].accessed_at).toLocaleDateString(undefined, {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                  <span className="badge badge-neutral shrink-0">{dayRows.length}</span>
                </button>
                {open && (
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
                          <td className="px-4 py-2.5" style={{ color: 'var(--ink-muted)' }}>
                            {new Date(r.accessed_at).toLocaleTimeString()}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--ink-primary)' }}>
                            {r.demat_accounts?.holder_name ?? '—'}
                          </td>
                          <td className="px-4 py-2.5">
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
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
