import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { RegistrarLink } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

interface PanAccessLogRow {
  id: string
  demat_id: string
  accessed_by: string
  accessed_at: string
  demat_accounts: { holder_name: string } | null
  profiles: { full_name: string } | null
}

export function SettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Settings
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          Registrar links and the PAN-reveal audit trail.
        </p>
      </div>
      <RegistrarLinksSection />
      <PanAccessLogSection />
    </div>
  )
}

function RegistrarLinksSection() {
  const [links, setLinks] = useState<RegistrarLink[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('registrar_links').select('*').order('registrar')
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
      <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
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
              </div>
            )
          })}
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
      <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
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
                <tr key={r.id}>
                  <td className="px-4 py-2.5" style={{ color: 'var(--ink-muted)' }}>
                    {new Date(r.accessed_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5" style={{ color: 'var(--ink-primary)' }}>
                    {r.demat_accounts?.holder_name ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">{r.profiles?.full_name ?? '—'}</td>
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
