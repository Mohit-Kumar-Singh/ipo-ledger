import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { dispatchAdminWhatsapp, openWhatsAppForNotification, sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { isLiveIpo } from '../../lib/ipoStatus'
import type { Notification } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'
import { ArchivedSection } from '../../components/ArchivedSection'

interface FunderApplicationDetail {
  holderName: string
  upiId: string | null
  lots: number
}

// One card per (funder name, IPO) — a funder who's currently live across
// several IPOs gets a separate card and a separate WhatsApp message for
// each, rather than one message covering everything they've ever funded.
interface FunderIpoCard {
  key: string
  funderName: string
  phone: string | null
  ipoId: string
  ipoName: string
  applications: FunderApplicationDetail[]
}

type ApplicationForFunderRow = {
  ipo_id: string
  lots: number
  ipos: { company_name: string; open_date: string; close_date: string; listing_date: string | null } | null
  demat_accounts: { holder_name: string } | null
  bank_accounts: { account_holder_name: string | null; phone_e164: string | null; upi_id: string | null } | null
}

// Excludes self-funded applications (no bank_account_id, so no one else to
// message) and anything not currently live — a funder shouldn't get pinged
// about an IPO that already closed and settled months ago. Grouped by name
// rather than bank_account_id, so "Jiggi paid via two different UPI IDs for
// the same IPO" still collapses into one card listing both applications
// (each application line shows its own UPI ID regardless).
function buildFunderIpoCards(rows: ApplicationForFunderRow[]): FunderIpoCard[] {
  const byKey = new Map<string, FunderIpoCard>()
  for (const r of rows) {
    const name = r.bank_accounts?.account_holder_name
    if (!name || !r.ipos || !isLiveIpo(r.ipos)) continue
    const key = `${name}::${r.ipo_id}`
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        funderName: name,
        phone: r.bank_accounts?.phone_e164 ?? null,
        ipoId: r.ipo_id,
        ipoName: r.ipos.company_name,
        applications: [],
      })
    }
    const card = byKey.get(key)!
    if (!card.phone && r.bank_accounts?.phone_e164) card.phone = r.bank_accounts.phone_e164
    card.applications.push({
      holderName: r.demat_accounts?.holder_name ?? 'Unknown',
      upiId: r.bank_accounts?.upi_id ?? null,
      lots: r.lots,
    })
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.funderName.localeCompare(b.funderName) || a.ipoName.localeCompare(b.ipoName),
  )
}

// Full URL, protocol included — a bare domain (tried first, to keep the
// message shorter) doesn't reliably get auto-linked by WhatsApp's mobile
// client, so it just sat there as dead text instead of a tappable link.
const PORTAL_URL = 'https://mohit-kumar-singh-ipo-ledger.vercel.app/'

function buildFunderIpoMessage(card: FunderIpoCard): string {
  // Grouped by UPI ID, not one flat list — a funder who paid through two
  // different UPI IDs for the same IPO needs to see which names went
  // through which one, not a single undifferentiated list. "No UPI ID"
  // entries (bank-only, no UPI recorded) get their own group rather than
  // silently folding into whichever named group happens to sort first.
  const groups = new Map<string, string[]>()
  for (const app of card.applications) {
    const key = app.upiId ?? 'No UPI ID'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(app.holderName)
  }
  const total = card.applications.length
  const body = Array.from(groups.entries())
    // _via_ italic, ```UPI ID``` monospace (reads as a distinct account
    // label, not prose), numbered list (WhatsApp's own "N. " syntax, not a
    // plain bullet) — every symbol here is one of WhatsApp's documented
    // formatting shortcuts, not decoration.
    .map(
      ([upi, names]) =>
        `_via_ \`\`\`${upi}\`\`\` :-\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`,
    )
    .join('\n\n')

  return (
    `Hi ${card.funderName}, here's what you've funded for *${card.ipoName}*:\n\n${body}\n\n` +
    `\`\`\`Total = ${total}\`\`\`\n\n` +
    `> Other updates are posted on ${PORTAL_URL}`
  )
}

export function NotificationsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [funderCards, setFunderCards] = useState<FunderIpoCard[]>([])
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const [notifRes, fundersRes] = await Promise.all([
      supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(200),
      isAdmin
        ? supabase
            .from('applications')
            .select(
              'ipo_id, lots, ipos(company_name, open_date, close_date, listing_date), demat_accounts(holder_name), bank_accounts(account_holder_name, phone_e164, upi_id)',
            )
            .not('bank_account_id', 'is', null)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (notifRes.error) {
      alert(`Couldn't load notifications: ${notifRes.error.message}`)
      setLoading(false)
      return
    }
    setNotifications((notifRes.data ?? []) as Notification[])
    setFunderCards(buildFunderIpoCards((fundersRes.data ?? []) as unknown as ApplicationForFunderRow[]))
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
      await dispatchAdminWhatsapp(n.id)
    } else {
      await openWhatsAppForNotification(n)
    }
    setRetrying(null)
    load()
  }

  const visibleNotifications = notifications.filter((n) => !n.is_archived)
  const archivedNotifications = notifications.filter((n) => n.is_archived)

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

      {isAdmin && !loading && funderCards.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
            Funders
          </h2>
          <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
            One card per funder per currently-live IPO — if someone's funded applications across multiple ongoing
            IPOs, send each one separately.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {funderCards.map((c) => {
              const message = buildFunderIpoMessage(c)
              return (
                <div key={c.key} className="card stagger-item flex flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                        {c.funderName}
                      </p>
                      <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {c.ipoName}
                      </p>
                    </div>
                    <span className="badge badge-neutral shrink-0 text-xs">
                      {c.applications.length} app{c.applications.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  {/* Exact send preview, not just the summarized list above
                      — a WhatsApp-bubble-styled block of buildFunderIpoMessage's
                      own output, so what gets sent is visible before Send is
                      clicked instead of only after, in the chat itself. Capped
                      height + its own scroll, not unbounded — a funder with
                      several UPI groups (each its own numbered list) made this
                      block push the card taller than its neighbors in the
                      grid, and taller than the card's own edit/send controls
                      staying reachable without scrolling the whole page. */}
                  <div
                    className="max-h-40 overflow-y-auto rounded-lg px-3 py-2 text-xs whitespace-pre-wrap"
                    style={{ background: 'var(--hover-surface)', color: 'var(--ink-secondary)' }}
                  >
                    {message}
                  </div>

                  <button
                    type="button"
                    onClick={() => c.phone && sendCustomWhatsapp(c.phone, message)}
                    disabled={!c.phone}
                    title={c.phone ? undefined : 'No phone number on file for this bank/UPI account'}
                    className="btn-secondary mt-1 self-start text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Send on WhatsApp
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {loading ? (
        <InlineSpinner />
      ) : (
        <>
          <NotificationsTable
            notifications={visibleNotifications}
            emptyLabel="No messages sent yet."
            isAdmin={isAdmin}
            retrying={retrying}
            onDispatch={dispatch}
          />

          {/* Notifications for an application whose IPO ended up NOT_ALLOTTED
              (or never got an allotment status at all) more than 3 days past
              the IPO's own allotment_date archive themselves here on their
              own (daily cron sweep, migration 0050) — same "out of the way,
              never deleted" pattern as archived IPOs. */}
          {archivedNotifications.length > 0 && (
            <ArchivedSection>
              <NotificationsTable
                notifications={archivedNotifications}
                emptyLabel="Nothing archived."
                isAdmin={isAdmin}
                retrying={retrying}
                onDispatch={dispatch}
              />
            </ArchivedSection>
          )}
        </>
      )}
    </div>
  )
}

// Extracted so the same table renders both the active list and the
// collapsed archived one, instead of two copies of the same markup.
function NotificationsTable({
  notifications,
  emptyLabel,
  isAdmin,
  retrying,
  onDispatch,
}: {
  notifications: Notification[]
  emptyLabel: string
  isAdmin: boolean
  retrying: string | null
  onDispatch: (n: Notification) => void
}) {
  return (
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
                    onClick={() => onDispatch(n)}
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
                {emptyLabel}
              </td>
            </tr>
          )}
        </tbody>
      </table>
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
