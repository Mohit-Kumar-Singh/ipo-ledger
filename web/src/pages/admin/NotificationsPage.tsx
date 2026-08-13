import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { dispatchAdminWhatsapp, openWhatsAppForNotification, sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { isLiveIpo } from '../../lib/ipoStatus'
import { sameIdentity } from '../../lib/applicationAttribution'
import { parseGmpPercent } from '../../lib/ipoGmp'
import type { Notification } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'
import { ArchivedSection } from '../../components/ArchivedSection'

// Almost every notification carries application_id, not ipo_id directly —
// send-whatsapp's queueForApplication only ever sets application_id/demat_id
// (see supabase/functions/send-whatsapp/index.ts), so notifications.ipo_id
// stays null except for the handful of gmp-alert rows (migration 0039) that
// set it explicitly. Checking archive status has to go through
// applications.ipo_id instead, or every application-linked notification
// (i.e. almost all of them) would never match its IPO's archived state.
type NotificationRow = Notification & { applications: { ipos: { is_archived: boolean } | null } | null }

interface FunderApplicationDetail {
  holderName: string
  upiId: string | null
  lots: number
  createdAt: string
  mandateStatus: 'PENDING' | 'APPROVED' | 'CANCELLED'
  ipojiStatusText: string | null
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
  applied_at: string
  status: 'APPLIED' | 'ALLOTTED' | 'NOT_ALLOTTED' | 'SOLD'
  mandate_status: 'PENDING' | 'APPROVED' | 'CANCELLED'
  ipoji_status_text: string | null
  ipos: {
    company_name: string
    open_date: string
    close_date: string
    listing_date: string | null
    price_high: number | null
    lot_size: number
    gmp_notes: string | null
  } | null
  demat_accounts: { holder_name: string; profit_share_percent: number } | null
  bank_accounts: { account_holder_name: string | null; phone_e164: string | null; upi_id: string | null } | null
}

// One card per (funder, IPO) covering only their ALLOTTED (or already SOLD —
// still allotted, just further along) applications — separate from the
// funding-summary cards above, which are about what's been *applied for*,
// not the result. A funder shouldn't have to wait for a payout message to
// find out an application under them actually got shares.
interface FunderAllottedCard {
  key: string
  funderName: string
  phone: string | null
  ipoId: string
  ipoName: string
  listingDate: string | null
  priceHigh: number | null
  lotSize: number
  gmpPercent: number | null
  holderNames: string[]
  totalLots: number
  cutPercent: number
}

function buildFunderAllottedCards(rows: ApplicationForFunderRow[]): FunderAllottedCard[] {
  const cardsByIpo = new Map<string, FunderAllottedCard[]>()
  for (const r of rows) {
    const name = r.bank_accounts?.account_holder_name
    if (!name || !r.ipos) continue
    if (r.status !== 'ALLOTTED' && r.status !== 'SOLD') continue
    if (!cardsByIpo.has(r.ipo_id)) cardsByIpo.set(r.ipo_id, [])
    const cardsForIpo = cardsByIpo.get(r.ipo_id)!
    let card = cardsForIpo.find((c) => sameIdentity(c.funderName, name))
    if (!card) {
      card = {
        key: `allotted::${r.ipo_id}::${cardsForIpo.length}`,
        funderName: name,
        phone: r.bank_accounts?.phone_e164 ?? null,
        ipoId: r.ipo_id,
        ipoName: r.ipos.company_name,
        listingDate: r.ipos.listing_date,
        priceHigh: r.ipos.price_high,
        lotSize: r.ipos.lot_size,
        gmpPercent: parseGmpPercent(r.ipos.gmp_notes),
        holderNames: [],
        totalLots: 0,
        cutPercent: r.demat_accounts?.profit_share_percent ?? 25,
      }
      cardsForIpo.push(card)
    } else if (name.length > card.funderName.length) {
      card.funderName = name
    }
    if (!card.phone && r.bank_accounts?.phone_e164) card.phone = r.bank_accounts.phone_e164
    const holder = r.demat_accounts?.holder_name ?? 'Unknown'
    if (!card.holderNames.includes(holder)) card.holderNames.push(holder)
    card.totalLots += r.lots
  }
  return Array.from(cardsByIpo.values())
    .flat()
    .sort((a, b) => a.funderName.localeCompare(b.funderName) || a.ipoName.localeCompare(b.ipoName))
}

// Projected profit, computed the same way the sold-payout messages already
// do (see payoutMessage below) but *before* an actual sale — an estimate
// using the IPO's own price band and its GMP%, so a funder sees roughly
// what to expect the moment allotment lands instead of only after the sale
// is booked. Per LOT, not per share — that's the unit a funder actually
// thinks in (one lot invested, one lot's worth of profit), and matches how
// bid_amount is already shown everywhere else in this app. gmp_notes stores
// a plain percentage (e.g. "17" for 17%), so the expected sold price is the
// per-lot invested amount grossed up by that percentage.
function expectedProfitBreakdown(card: FunderAllottedCard) {
  const lotAmount = (card.priceHigh ?? 0) * card.lotSize
  const gmpPercent = card.gmpPercent ?? 0
  const soldPrice = Math.round(lotAmount * (1 + gmpPercent / 100))
  const profitPerLot = soldPrice - lotAmount
  const netProfitPerLot = Math.round(profitPerLot * (1 - card.cutPercent / 100))
  const yourProfitPerLot = Math.round(netProfitPerLot / 2)
  const netYourProfit = yourProfitPerLot * card.totalLots
  const investedTotal = lotAmount * card.totalLots
  const amountToReturn = investedTotal + netYourProfit
  return { lotAmount, gmpPercent, soldPrice, profitPerLot, netProfitPerLot, yourProfitPerLot, netYourProfit, investedTotal, amountToReturn }
}

function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

function buildFunderAllottedMessage(card: FunderAllottedCard): string {
  const list = card.holderNames.map((n, i) => `${i + 1}. ${n}`).join('\n')
  const listingLine = card.listingDate
    ? `Listing date of ${card.ipoName} IPO is  \`${new Date(card.listingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}\``
    : `Listing date isn't out yet.`

  const intro = `Hi ${card.funderName}, good news  🎉🎉— your application(s) got *allotted* in \`${card.ipoName}\`:\n\n${list}`

  if (!card.priceHigh) {
    // No price band on file — skip the profit math rather than show ₹0s.
    return `${intro}\n\n> Other updates are posted on ${PORTAL_URL}`
  }

  const b = expectedProfitBreakdown(card)
  return (
    `${intro}\n\n` +
    `_Expected profit_\n` +
    `${rupees(b.yourProfitPerLot)}*${card.totalLots} (no. of ipo alloted)=  *${rupees(b.netYourProfit)}*\n` +
    `> ${rupees(b.lotAmount)} +  ${b.gmpPercent}% (GMP)≈ ${rupees(b.soldPrice)} ( sold price)\n` +
    `> ${rupees(b.soldPrice)} − ${rupees(b.lotAmount)} = ${rupees(b.profitPerLot)} profit/lot \n` +
    `> ${rupees(b.profitPerLot)}− ${card.cutPercent}% (accunt holder tax cut) = ${rupees(b.netProfitPerLot)} net profit/lot\n` +
    `> ${rupees(b.netProfitPerLot)} ÷ 2 (your share + my share ) = ${rupees(b.yourProfitPerLot)} your profit/lot\n` +
    `> Amount to return = ${rupees(b.investedTotal)} (invested) + ${rupees(b.netYourProfit)} (profit) =  ${rupees(b.amountToReturn)}\n\n` +
    `${listingLine}\n\n\n` +
    `> Other updates are posted on ${PORTAL_URL}`
  )
}

// Local calendar day, not UTC — an application entered at 11pm IST is
// "today" to whoever's looking at this page, even though its applied_at
// timestamp may already have rolled into tomorrow in UTC.
function isToday(isoTimestamp: string): boolean {
  const d = new Date(isoTimestamp)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  )
}

// Excludes self-funded applications (no bank_account_id, so no one else to
// message) and anything not currently live — a funder shouldn't get pinged
// about an IPO that already closed and settled months ago. Grouped by name
// PER IPO, using the same fuzzy sameIdentity() this app already uses for
// attribution credit — not an exact string match, which used to split one
// real person into several separate cards/messages the moment they funded
// through UPI accounts with differently-spelled holder names ("Avinash" vs
// "Avinash sir"), each producing its own card even for the same IPO. Each
// application line still shows its own UPI ID regardless of which spelling
// merged into the card.
function buildFunderIpoCards(rows: ApplicationForFunderRow[]): FunderIpoCard[] {
  const cardsByIpo = new Map<string, FunderIpoCard[]>()
  for (const r of rows) {
    const name = r.bank_accounts?.account_holder_name
    if (!name || !r.ipos || !isLiveIpo(r.ipos)) continue
    if (!cardsByIpo.has(r.ipo_id)) cardsByIpo.set(r.ipo_id, [])
    const cardsForIpo = cardsByIpo.get(r.ipo_id)!
    let card = cardsForIpo.find((c) => sameIdentity(c.funderName, name))
    if (!card) {
      card = {
        key: `${r.ipo_id}::${cardsForIpo.length}`,
        funderName: name,
        phone: r.bank_accounts?.phone_e164 ?? null,
        ipoId: r.ipo_id,
        ipoName: r.ipos.company_name,
        applications: [],
      }
      cardsForIpo.push(card)
    } else if (name.length > card.funderName.length) {
      // Prefer the fuller spelling as the canonical display name, same
      // "longer wins" rule the attribution credit-merge already uses.
      card.funderName = name
    }
    if (!card.phone && r.bank_accounts?.phone_e164) card.phone = r.bank_accounts.phone_e164
    card.applications.push({
      holderName: r.demat_accounts?.holder_name ?? 'Unknown',
      upiId: r.bank_accounts?.upi_id ?? null,
      lots: r.lots,
      createdAt: r.applied_at,
      mandateStatus: r.mandate_status,
      ipojiStatusText: r.ipoji_status_text,
    })
  }
  return Array.from(cardsByIpo.values())
    .flat()
    .sort((a, b) => a.funderName.localeCompare(b.funderName) || a.ipoName.localeCompare(b.ipoName))
}

// Full URL, protocol included — a bare domain (tried first, to keep the
// message shorter) doesn't reliably get auto-linked by WhatsApp's mobile
// client, so it just sat there as dead text instead of a tappable link.
const PORTAL_URL = 'https://mohit-kumar-singh-ipo-ledger.vercel.app/'

// Plain text glyphs, not color emoji — see the ✓ comment below for why
// (missing glyphs on several WhatsApp fonts render as a blank box).
// CANCELLED means the funder never actually approved the UPI block, ✗
// makes that failure visible instead of the line just looking identical to
// a still-pending one. A still-PENDING mandate whose raw ipoji text
// mentions "bank" is at the sponsor-bank-accepted stage — further along
// than a bare "bid placed" but not yet the investor's own approval — ⟳
// marks that in-between state so it doesn't read as fully done (✓) or
// untouched (nothing).
function mandateSymbol(app: FunderApplicationDetail): string {
  if (app.mandateStatus === 'CANCELLED') return ' ✗'
  if (app.mandateStatus === 'APPROVED') return ' ✓'
  if (app.ipojiStatusText && /bank/i.test(app.ipojiStatusText)) return ' ⟳'
  return ''
}

function buildFunderIpoMessage(card: FunderIpoCard, opts?: { todayOnly?: boolean }): string {
  // Grouped by UPI ID, not one flat list — a funder who paid through two
  // different UPI IDs for the same IPO needs to see which names went
  // through which one, not a single undifferentiated list. "No UPI ID"
  // entries (bank-only, no UPI recorded) get their own group rather than
  // silently folding into whichever named group happens to sort first.
  const groups = new Map<string, FunderApplicationDetail[]>()
  for (const app of card.applications) {
    const key = app.upiId ?? 'No UPI ID'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(app)
  }
  const total = card.applications.length
  const body = Array.from(groups.entries())
    // _via_ italic, `UPI ID` monospace (reads as a distinct account label,
    // not prose — single backtick, WhatsApp's real monospace syntax; triple
    // backtick isn't a WhatsApp thing at all, that's Markdown/Discord's code
    // fence and it doesn't render as monospace here), numbered list
    // (WhatsApp's own "N. " syntax, not a plain bullet). Trailing symbol
    // per mandateSymbol() above.
    .map(
      ([upi, apps]) =>
        `_via_ \`${upi}\` :-\n${apps.map((a, i) => `${i + 1}. ${a.holderName}${mandateSymbol(a)}`).join('\n')}`,
    )
    .join('\n\n')

  const intro = opts?.todayOnly
    ? `Hi ${card.funderName}, here's what you funded *today* for *${card.ipoName}*:`
    : `Hi ${card.funderName}, here's what you've funded for *${card.ipoName}*:`

  return (
    `${intro}\n\n${body}\n\n` +
    `\`Total = ${total}\`\n\n` +
    `> Other updates are posted on ${PORTAL_URL}`
  )
}

export function NotificationsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [notifications, setNotifications] = useState<NotificationRow[]>([])
  const [funderCards, setFunderCards] = useState<FunderIpoCard[]>([])
  const [allottedCards, setAllottedCards] = useState<FunderAllottedCard[]>([])
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState<string | null>(null)
  // Notification rows only ever stored a raw phone number ("To") — useless
  // for recognizing who a message actually went to at a glance. Built once
  // from whatever demat/bank accounts RLS already lets this viewer see (no
  // new grant, same rows the rest of the app already exposes to them), not
  // stored on the notification itself.
  const [phoneNames, setPhoneNames] = useState<Map<string, string>>(new Map())
  // Surfaced instead of silently swallowed — the funders query previously
  // just fell back to an empty array on any error (data ?? []), so a real
  // failure here looked identical to "nobody's funded anything live," no
  // visible sign anything was actually wrong.
  const [fundersError, setFundersError] = useState<string | null>(null)
  // Filters the funder cards below to only the applications entered today —
  // for the common case of "I just added a batch of applications this
  // morning, tell the funder about those specifically" instead of resending
  // the full running total every time.
  const [todayOnly, setTodayOnly] = useState(false)

  async function load() {
    setLoading(true)
    const [notifRes, fundersRes, dematRes, bankRes] = await Promise.all([
      supabase
        .from('notifications')
        .select('*, applications(ipos(is_archived))')
        .order('created_at', { ascending: false })
        .limit(200),
      isAdmin
        ? supabase
            .from('applications')
            .select(
              'ipo_id, lots, applied_at, status, mandate_status, ipoji_status_text, ' +
                'ipos(company_name, open_date, close_date, listing_date, price_high, lot_size, gmp_notes), ' +
                'demat_accounts(holder_name, profit_share_percent), bank_accounts(account_holder_name, phone_e164, upi_id)',
            )
            .not('bank_account_id', 'is', null)
        : Promise.resolve({ data: [], error: null }),
      supabase.from('demat_accounts').select('phone_e164, holder_name'),
      supabase.from('bank_accounts').select('phone_e164, account_holder_name'),
    ])
    if (notifRes.error) {
      alert(`Couldn't load notifications: ${notifRes.error.message}`)
      setLoading(false)
      return
    }
    setNotifications((notifRes.data ?? []) as unknown as NotificationRow[])
    setFundersError(fundersRes.error ? fundersRes.error.message : null)
    const funderRows = (fundersRes.data ?? []) as unknown as ApplicationForFunderRow[]
    setFunderCards(buildFunderIpoCards(funderRows))
    setAllottedCards(buildFunderAllottedCards(funderRows))

    // Bank/UPI names win over demat holder names on a shared phone number —
    // a notification's "To" is almost always the funder who needs to act on
    // it (send a payment, confirm a mandate), not the demat holder it's
    // about.
    const nameMap = new Map<string, string>()
    for (const d of (dematRes.data ?? []) as { phone_e164: string | null; holder_name: string }[]) {
      if (d.phone_e164) nameMap.set(d.phone_e164, d.holder_name)
    }
    for (const b of (bankRes.data ?? []) as { phone_e164: string | null; account_holder_name: string | null }[]) {
      if (b.phone_e164 && b.account_holder_name) nameMap.set(b.phone_e164, b.account_holder_name)
    }
    setPhoneNames(nameMap)
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

  // A notification for an IPO that's since moved to /archives (e.g. every
  // application came back NOT_ALLOTTED) drops out of the main list the same
  // way its IPO did — folded into the same collapsed "Archived" section as
  // notification-level archiving, not a third separate state.
  const visibleNotifications = notifications.filter((n) => !n.is_archived && !n.applications?.ipos?.is_archived)
  const archivedNotifications = notifications.filter((n) => n.is_archived || n.applications?.ipos?.is_archived)

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

      {isAdmin && !loading && fundersError && (
        <p className="badge badge-critical w-fit">Couldn't load funders: {fundersError}</p>
      )}

      {isAdmin && !loading && allottedCards.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
            Allotment updates
          </h2>
          <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
            One card per funder per IPO where at least one of their funded accounts got allotted — with an
            expected-profit projection based on the IPO's price band and GMP.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {allottedCards.map((c) => {
              const message = buildFunderAllottedMessage(c)
              return (
                <div key={c.key} className="aura-card stagger-item flex flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                        {c.funderName}
                      </p>
                      <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {c.ipoName}
                      </p>
                    </div>
                    <span className="badge badge-good shrink-0 text-xs">
                      {c.holderNames.length} allotted
                    </span>
                  </div>
                  <div
                    className="max-h-48 overflow-y-auto rounded-lg px-3 py-2 text-xs whitespace-pre-wrap"
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

      {isAdmin && !loading && funderCards.length > 0 && (
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
              Funders
            </h2>
            {/* Today-only view — same funder cards, but each one's message
                and app count are recomputed from just today's applications,
                and cards where the funder has nothing new today drop out
                entirely rather than showing an empty card. */}
            <label className="flex cursor-pointer items-center gap-1.5 text-xs" style={{ color: 'var(--ink-secondary)' }}>
              <input
                type="checkbox"
                checked={todayOnly}
                onChange={(e) => setTodayOnly(e.target.checked)}
                className="cursor-pointer"
              />
              Today's applications only
            </label>
          </div>
          <p className="mb-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
            {todayOnly
              ? "One card per funder per IPO, showing only applications entered today — for messaging a funder about just what's new."
              : 'One card per funder per currently-live IPO — if someone\'s funded applications across multiple ongoing IPOs, send each one separately.'}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {funderCards
              .map((c) =>
                todayOnly ? { ...c, applications: c.applications.filter((a) => isToday(a.createdAt)) } : c,
              )
              .filter((c) => c.applications.length > 0)
              .map((c) => {
              const message = buildFunderIpoMessage(c, { todayOnly })
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
            phoneNames={phoneNames}
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
                phoneNames={phoneNames}
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
  phoneNames,
}: {
  notifications: Notification[]
  emptyLabel: string
  isAdmin: boolean
  retrying: string | null
  onDispatch: (n: Notification) => void
  phoneNames: Map<string, string>
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
              <td className="px-4 py-2.5">
                {phoneNames.has(n.to_phone) ? (
                  <span title={n.to_phone}>{phoneNames.get(n.to_phone)}</span>
                ) : (
                  n.to_phone
                )}
              </td>
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
