import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { dispatchAdminWhatsapp, openWhatsAppForNotification, sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import type { Notification } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

interface FunderSummary {
  name: string
  phone: string | null
  ipoNames: string[]
}

type ApplicationForFunderRow = {
  ipo_id: string
  ipos: { company_name: string } | null
  bank_accounts: { account_holder_name: string | null; phone_e164: string | null } | null
}

// One entry per distinct name on a bank/UPI account actually used to fund an
// application (self-funded applications have no bank_account_id, so they're
// excluded — there's no one else to message). Collapsing by name, not by
// bank_account_id, is what makes "Jiggi funded 4 IPOs across 2 different UPI
// accounts" collapse into one summary instead of two.
function summarizeFunders(rows: ApplicationForFunderRow[]): FunderSummary[] {
  const byName = new Map<string, { phone: string | null; ipoNames: Map<string, string> }>()
  for (const r of rows) {
    const name = r.bank_accounts?.account_holder_name
    if (!name) continue
    if (!byName.has(name)) byName.set(name, { phone: null, ipoNames: new Map() })
    const entry = byName.get(name)!
    if (!entry.phone && r.bank_accounts?.phone_e164) entry.phone = r.bank_accounts.phone_e164
    entry.ipoNames.set(r.ipo_id, r.ipos?.company_name ?? 'Unknown IPO')
  }
  return Array.from(byName.entries())
    .map(([name, { phone, ipoNames }]) => ({ name, phone, ipoNames: Array.from(ipoNames.values()).sort() }))
    .filter((f) => f.ipoNames.length > 0)
    .sort((a, b) => b.ipoNames.length - a.ipoNames.length)
}

function buildFunderMessage(funder: FunderSummary, signerName: string): string {
  const list = funder.ipoNames.map((n) => `• ${n}`).join('\n')
  return `Hi ${funder.name}, you've funded ${funder.ipoNames.length} IPO application${funder.ipoNames.length === 1 ? '' : 's'} so far:\n${list}\n\n— ${signerName}`
}

export function NotificationsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [funders, setFunders] = useState<FunderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const [notifRes, fundersRes] = await Promise.all([
      supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(200),
      isAdmin
        ? supabase
            .from('applications')
            .select('ipo_id, ipos(company_name), bank_accounts(account_holder_name, phone_e164)')
            .not('bank_account_id', 'is', null)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (notifRes.error) {
      alert(`Couldn't load notifications: ${notifRes.error.message}`)
      setLoading(false)
      return
    }
    setNotifications((notifRes.data ?? []) as Notification[])
    setFunders(summarizeFunders((fundersRes.data ?? []) as unknown as ApplicationForFunderRow[]))
    setLoading(false)
  }

  useEffect(() => {
    // isAdmin depends on `profile`, which loads in parallel with (not
    // before) this page mounting — re-running load() when it flips from
    // false to true is what makes the funders query actually fire, instead
    // of permanently reading the isAdmin-false snapshot from first render.
    load()
  }, [isAdmin])

  async function dispatch(n: Notification) {
    setRetrying(n.id)
    if (isAdmin) {
      await dispatchAdminWhatsapp(n.id, profile?.full_name ?? 'there')
    } else {
      await openWhatsAppForNotification(n, profile?.full_name ?? 'there')
    }
    setRetrying(null)
    load()
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Notifications
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
          {notifications.length} messages
        </p>
      </div>

      {isAdmin && !loading && funders.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
            Funders
          </h2>
          <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
            Everyone whose bank/UPI account has funded an application, grouped by name — send them a rundown of what
            they've funded so far.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {funders.map((f) => (
              <div key={f.name} className="card stagger-item flex flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                    {f.name}
                  </p>
                  <span className="badge badge-neutral shrink-0 text-xs">
                    {f.ipoNames.length} IPO{f.ipoNames.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ul className="max-h-28 space-y-0.5 overflow-y-auto text-xs" style={{ color: 'var(--ink-secondary)' }}>
                  {f.ipoNames.map((name) => (
                    <li key={name} className="truncate">
                      {name}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => f.phone && sendCustomWhatsapp(f.phone, buildFunderMessage(f, profile?.full_name ?? 'there'))}
                  disabled={!f.phone}
                  title={f.phone ? undefined : 'No phone number on file for this bank/UPI account'}
                  className="btn-secondary mt-1 self-start text-xs disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Send list on WhatsApp
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {loading ? (
        <InlineSpinner />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--page)', color: 'var(--ink-muted)' }} className="text-left">
              <tr>
                <th className="px-4 py-2.5 font-medium">Sent</th>
                <th className="px-4 py-2.5 font-medium">To</th>
                <th className="px-4 py-2.5 font-medium">Template</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Error</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {notifications.map((n) => (
                <tr key={n.id} className="stagger-item transition-colors duration-150 hover:bg-[var(--hover-surface)]">
                  <td className="px-4 py-2.5" style={{ color: 'var(--ink-muted)' }}>
                    {new Date(n.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5">{n.to_phone}</td>
                  <td className="px-4 py-2.5">{n.template_name}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={n.status} />
                  </td>
                  <td className="px-4 py-2.5" style={{ color: 'var(--critical)' }}>
                    {n.error_detail ?? ''}
                  </td>
                  <td className="px-4 py-2.5">
                    {(n.status === 'QUEUED' || n.status === 'FAILED') && (
                      <button
                        onClick={() => dispatch(n)}
                        disabled={retrying === n.id}
                        className="link-accent text-xs font-medium disabled:opacity-50"
                      >
                        {retrying === n.id
                          ? isAdmin
                            ? 'Sending…'
                            : 'Opening…'
                          : isAdmin
                            ? n.status === 'FAILED'
                              ? 'Retry'
                              : 'Send'
                            : 'Open WhatsApp'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {notifications.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--ink-muted)' }}>
                    No messages sent yet.
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

function StatusBadge({ status }: { status: Notification['status'] }) {
  const classes: Record<Notification['status'], string> = {
    QUEUED: 'badge-neutral',
    SENT: 'badge-info',
    DELIVERED: 'badge-good',
    READ: 'badge-violet',
    FAILED: 'badge-critical',
    SIMULATED: 'badge-warning',
  }
  return <span className={`badge ${classes[status]}`}>{status}</span>
}
