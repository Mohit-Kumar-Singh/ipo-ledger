import { useEffect, useState } from 'react'
import { LinkIcon, PaintbrushIcon, RedoIcon, ShieldCheckIcon } from '@primer/octicons-react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { useTheme } from '../../contexts/ThemeContext'
import { ThemeToggle } from '../../components/ThemeToggle'
import type { RegistrarLink } from '../../types/database'
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
          Registrar links{isAdmin && ' and the PAN-reveal audit trail'}.
        </p>
      </div>
      <AppearanceSection />
      <RegistrarLinksSection editable={isAdmin} />
      {isAdmin && <CancelledMandatesSection />}
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

function RegistrarLinksSection({ editable }: { editable: boolean }) {
  const [links, setLinks] = useState<RegistrarLink[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('registrar_links').select('*').order('registrar')
    if (error) {
      alert(`Couldn't load registrar links: ${error.message}`)
      setLoading(false)
      return
    }
    const rows = (data ?? []) as RegistrarLink[]
    setLinks(rows)
    setDrafts(Object.fromEntries(rows.map((r) => [r.registrar, r.check_url])))
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function save(registrar: string) {
    setSaving(registrar)
    const { error } = await supabase
      .from('registrar_links')
      .update({ check_url: drafts[registrar] })
      .eq('registrar', registrar)
    setSaving(null)
    if (error) {
      alert(error.message)
      return
    }
    load()
  }

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
        <LinkIcon size={15} fill="var(--accent)" />
        Registrar allotment-check links
      </h2>
      <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
        Used by the Allotment board's "Open registrar page" button when an IPO doesn't have its own
        registrar URL set.
      </p>
      {loading ? (
        <InlineSpinner />
      ) : (
        <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
          {links.map((r) => {
            const dirty = drafts[r.registrar] !== r.check_url
            return (
              <div key={r.registrar} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
                <span
                  className="w-36 shrink-0 font-mono text-xs font-medium"
                  style={{ color: 'var(--ink-primary)' }}
                >
                  {r.registrar}
                </span>
                {editable ? (
                  <>
                    <input
                      value={drafts[r.registrar] ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [r.registrar]: e.target.value }))}
                      className="input flex-1"
                    />
                    <button
                      onClick={() => save(r.registrar)}
                      disabled={!dirty || saving === r.registrar}
                      className="btn-secondary shrink-0 disabled:opacity-50"
                    >
                      {saving === r.registrar ? 'Saving…' : 'Save'}
                    </button>
                  </>
                ) : (
                  <span className="flex-1 truncate text-sm" style={{ color: 'var(--ink-muted)' }}>
                    {r.check_url}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

interface CancelledMandateRow {
  id: string
  ipos: { company_name: string } | null
  demat_accounts: { holder_name: string } | null
}

// A CANCELLED mandate means the funder never actually approved the UPI
// block — the application record is still sitting there as APPLIED, but
// no money ever moved. That demat account is effectively free to apply
// again for the same IPO (a fresh application, since this one's mandate
// already failed) — surfaced here so it doesn't just quietly stay wrong
// until someone happens to notice on Applications.
function CancelledMandatesSection() {
  const [rows, setRows] = useState<CancelledMandateRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('applications')
      .select('id, ipos(company_name), demat_accounts(holder_name)')
      .eq('mandate_status', 'CANCELLED')
      .eq('status', 'APPLIED')
      .then(({ data }) => {
        setRows((data ?? []) as unknown as CancelledMandateRow[])
        setLoading(false)
      })
  }, [])

  if (!loading && rows.length === 0) return null

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
        <RedoIcon size={15} fill="var(--warning)" />
        Cancelled mandates — can reapply
      </h2>
      <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
        The funder never approved these — no money moved, so the account is free to apply again for the same IPO.
      </p>
      {loading ? (
        <InlineSpinner />
      ) : (
        <div className="card divide-y" style={{ borderColor: 'var(--border)' }}>
          {rows.map((r) => (
            <div key={r.id} className="stagger-item flex items-center justify-between gap-3 p-3 text-sm">
              <span style={{ color: 'var(--ink-primary)' }}>
                {r.demat_accounts?.holder_name ?? 'Unknown'}
                <span style={{ color: 'var(--ink-muted)' }}> · {r.ipos?.company_name ?? 'Unknown IPO'}</span>
              </span>
              <Link to="/applications" className="link-accent text-xs font-medium">
                Open Applications →
              </Link>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function PanAccessLogSection() {
  const [rows, setRows] = useState<PanAccessLogRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase
      .from('pan_access_log')
      .select('*, demat_accounts(holder_name), profiles(full_name)')
      .order('accessed_at', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        setRows((data ?? []) as unknown as PanAccessLogRow[])
        setLoading(false)
      })
  }, [])

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
        <ShieldCheckIcon size={15} fill="var(--violet)" />
        PAN access log
      </h2>
      <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
        Every time a PAN is decrypted (Accounts/Allotment board "Reveal PAN"), it's logged here — who, whose
        PAN, and when.
      </p>
      {loading ? (
        <InlineSpinner />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">PAN of</th>
                <th className="px-4 py-2.5 font-medium">Accessed by</th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {rows.map((r) => (
                <tr key={r.id} className="stagger-item transition-colors duration-150 hover:bg-[var(--hover-surface)]">
                  <td className="px-4 py-2.5" style={{ color: 'var(--ink-muted)' }}>
                    {new Date(r.accessed_at).toLocaleString()}
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
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
                    No PAN reveals logged yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
