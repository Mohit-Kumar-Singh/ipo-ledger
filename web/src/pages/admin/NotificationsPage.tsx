import { useEffect, useState } from 'react'
import { InfoTooltip } from '../../components/HoverCard'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { openWhatsAppForNotification, sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { renderMessageBody } from '../../lib/notificationTemplates'
import { isLiveIpo } from '../../lib/ipoStatus'
import { sameIdentity } from '../../lib/applicationAttribution'
import {
  buildFunderAllottedCards,
  expectedProfitBreakdown,
  rupees,
  type FunderAllottedCard,
  type ProfitProjectionRow,
} from '../../lib/expectedProfit'
import { InlineSpinner } from '../../components/PageSpinner'
import type { Notification } from '../../types/database'

interface FunderApplicationDetail {
  holderName: string
  upiId: string | null
  lots: number
  createdAt: string
  mandateStatus: 'PENDING' | 'APPROVED' | 'CANCELLED'
  ipojiStatusText: string | null
  // Funding credit for this one application was manually reassigned to a
  // different bank/UPI account (funder_override_id, migration 0063) —
  // someone transferred money in rather than the applicant's own UPI
  // paying. Flagged in the message alongside the row, same 🏷️ tag
  // ApplicationsPage/the allotment board already show for this.
  isOverride: boolean
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

// This page's admin query fetches exactly the shape lib/expectedProfit.ts's
// ProfitProjectionRow expects — reused as-is (aliased for readability at
// this page's other call sites) rather than redefined.
type ApplicationForFunderRow = ProfitProjectionRow

// Falls back to the demat holder's own identity when there's no bank/UPI
// account on file at all — a genuinely self-funded application (no funder
// distinct from the holder) still needs to show up as a "funder" card, same
// fallback lib/applicationAttribution.ts's pie chart already uses ("no
// bank/UPI account on file to attribute funding to at all" -> the holder).
// Without this, self-funded applications (including an admin's own) never
// generated a Funders/Allotment-updates card at all.
function effectiveFunder(r: ApplicationForFunderRow) {
  return (
    r.funder_override ??
    r.bank_accounts ??
    (r.demat_accounts
      ? { account_holder_name: r.demat_accounts.holder_name, phone_e164: r.demat_accounts.phone_e164, upi_id: null }
      : null)
  )
}

// One card per (demat account holder, IPO) whose application got allotted —
// distinct from FunderAllottedCard above, which is the profit-projection
// message aimed at whoever FUNDED it. This is the plain "you got shares"
// notice aimed at the account HOLDER themselves, sent to their own
// phone_e164 on file — the two are often different people (a family
// member's demat account funded by someone else), and each needs their own
// message: the funder cares about the payout, the holder just needs to know
// their name got allotted.
interface HolderAllottedCard {
  key: string
  holderName: string
  phone: string | null
  ipoId: string
  ipoName: string
  listingDate: string | null
  totalLots: number
  // True if any application in this card had its funding credit manually
  // reassigned to someone else's UPI (funder_override_id) — surfaced in the
  // message so the holder knows who actually paid for it.
  hasOverride: boolean
}

function buildHolderAllottedCards(rows: ApplicationForFunderRow[]): HolderAllottedCard[] {
  const cardsByIpo = new Map<string, HolderAllottedCard[]>()
  for (const r of rows) {
    const holder = r.demat_accounts
    if (!holder?.phone_e164 || !r.ipos) continue
    if (r.status !== 'ALLOTTED' && r.status !== 'SOLD') continue
    if (!cardsByIpo.has(r.ipo_id)) cardsByIpo.set(r.ipo_id, [])
    const cardsForIpo = cardsByIpo.get(r.ipo_id)!
    // Keyed by phone, not name — two different demat accounts can share a
    // holder name; they never share a phone number.
    let card = cardsForIpo.find((c) => c.phone === holder.phone_e164)
    if (!card) {
      card = {
        key: `holder-allotted::${r.ipo_id}::${holder.phone_e164}`,
        holderName: holder.holder_name,
        phone: holder.phone_e164,
        ipoId: r.ipo_id,
        ipoName: r.ipos.company_name,
        listingDate: r.ipos.listing_date,
        totalLots: 0,
        hasOverride: false,
      }
      cardsForIpo.push(card)
    }
    card.totalLots += r.lots
    if (r.funder_override) card.hasOverride = true
  }
  return Array.from(cardsByIpo.values())
    .flat()
    .sort((a, b) => a.holderName.localeCompare(b.holderName) || a.ipoName.localeCompare(b.ipoName))
}

// Deliberately bare — just the allotment fact and the listing date, no
// profit numbers, no portal link. The funder gets the full breakdown in the
// card above; the account holder doesn't need more than "you got shares."
function buildHolderAllottedMessage(card: HolderAllottedCard): string {
  const PARTY = '\u{1F389}'
  const listingLine = card.listingDate
    ? `Listing date is \`${new Date(card.listingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}\``
    : `Listing date isn't out yet.`
  return (
    `Hi ${card.holderName}, Good news ${PARTY} — your *${card.ipoName}* IPO application has been *allotted* to ` +
    `you! (${card.totalLots} lot${card.totalLots === 1 ? '' : 's'})\n\n${listingLine}`
  )
}

function buildFunderAllottedMessage(card: FunderAllottedCard): string {
  const list = card.holderNames.map((h, i) => `${i + 1}. ${h.name}${h.isOverride ? ' \u{1F3F7}\u{FE0F}' : ''}`).join('\n')
  const footnote = card.holderNames.some((h) => h.isOverride)
    ? `\n\n_🏷️ = funded via a transfer to a different UPI, not that your own UPI_`
    : ''
  const listingLine = card.listingDate
    ? `Listing date of ${card.ipoName} IPO is  \`${new Date(card.listingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}\``
    : `Listing date isn't out yet.`

  // Unicode escapes, not literal characters — a literal 🎉 pasted straight
  // into this file got mangled into UTF-8-interpreted-as-Latin1-then-
  // re-encoded mojibake (confirmed via a hex dump of the built output: the
  // party-popper's real UTF-8 bytes F0 9F 8E 89 came out as C3 B0 C5 B8 C5
  // BD E2 80 B0 instead), which is exactly the kind of thing that renders
  // as a blank/broken glyph on WhatsApp. \u{...} escapes are pure source
  // text — nothing about how this file gets saved/read can corrupt them.
  const PARTY = '\u{1F389}'
  const EM_DASH = '—'
  const intro = `Hi ${card.funderName}, good news  ${PARTY}${PARTY}${EM_DASH} your application(s) got *allotted* in \`${card.ipoName}\`:\n\n${list}`

  if (!card.priceHigh) {
    // No price band on file — skip the profit math rather than show ₹0s.
    return `${intro}${footnote}\n\n> Other updates are posted on ${PORTAL_URL}`
  }

  const b = expectedProfitBreakdown(card)
  // Rounds to a whole percent when the weighted average lands on/near one
  // (the common case — one holder, or several holders all sharing the same
  // profit_share_percent), otherwise shows one decimal so a genuine mixed-
  // cut average (e.g. 25%/30% split) isn't silently misrepresented as 28%.
  const cutPercentLabel = `${Math.round(card.cutPercent) === card.cutPercent ? card.cutPercent : card.cutPercent.toFixed(1)}%`
  return (
    `${intro}\n\n` +
    `_Expected profit_\n` +
    `${rupees(b.yourProfitPerLot)}*${card.totalLots} (no. of ipo alloted)=  *${rupees(b.netYourProfit)}*\n` +
    `> ${rupees(b.lotAmount)} +  ${b.gmpPercent}% (GMP)≈ ${rupees(b.soldPrice)} ( sold price)\n` +
    `> ${rupees(b.soldPrice)} − ${rupees(b.lotAmount)} = ${rupees(b.profitPerLot)} profit/lot \n` +
    `> ${rupees(b.profitPerLot)}− ${cutPercentLabel} (accunt holder tax cut) = ${rupees(b.netProfitPerLot)} net profit/lot\n` +
    `> ${rupees(b.netProfitPerLot)} ÷ 2 (your share + my share ) = ${rupees(b.yourProfitPerLot)} your profit/lot\n` +
    `> Amount to return = ${rupees(b.investedTotal)} (invested) + ${rupees(b.netYourProfit)} (profit) =  ${rupees(b.amountToReturn)}\n\n` +
    `${listingLine}${footnote}\n\n` +
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
    const funder = effectiveFunder(r)
    const name = funder?.account_holder_name
    if (!name || !r.ipos || !isLiveIpo(r.ipos)) continue
    if (!cardsByIpo.has(r.ipo_id)) cardsByIpo.set(r.ipo_id, [])
    const cardsForIpo = cardsByIpo.get(r.ipo_id)!
    let card = cardsForIpo.find((c) => sameIdentity(c.funderName, name))
    if (!card) {
      card = {
        key: `${r.ipo_id}::${cardsForIpo.length}`,
        funderName: name,
        phone: funder?.phone_e164 ?? null,
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
    if (!card.phone && funder?.phone_e164) card.phone = funder.phone_e164
    card.applications.push({
      holderName: r.demat_accounts?.holder_name ?? 'Unknown',
      // Still the LITERAL UPI that paid, even under a funder override — the
      // override changes who gets credited/messaged, not what actually
      // happened technically on ipoji.
      upiId: r.bank_accounts?.upi_id ?? null,
      lots: r.lots,
      createdAt: r.applied_at,
      mandateStatus: r.mandate_status,
      ipojiStatusText: r.ipoji_status_text,
      isOverride: !!r.funder_override,
    })
  }
  return Array.from(cardsByIpo.values())
    .flat()
    // IPO first, funder name only to break ties within the same IPO — all
    // of one IPO's funders now sit together, instead of every funder's
    // cards for different IPOs being interleaved alphabetically by name.
    .sort((a, b) => a.ipoName.localeCompare(b.ipoName) || a.funderName.localeCompare(b.funderName))
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
        `_via_ \`${upi}\` :-\n${apps.map((a, i) => `${i + 1}. ${a.holderName}${a.isOverride ? ' \u{1F3F7}\u{FE0F}' : ''}${mandateSymbol(a)}`).join('\n')}`,
    )
    .join('\n\n')

  const intro = opts?.todayOnly
    ? `Hi ${card.funderName}, here's what you funded *today* for *${card.ipoName}*:`
    : `Hi ${card.funderName}, here's what you've funded for *${card.ipoName}*:`

  const footnote = card.applications.some((a) => a.isOverride)
    ? `\n\n_🏷️ = funded via a transfer to a different UPI, not that applicant's own._`
    : ''

  return (
    `${intro}\n\n${body}\n\n` +
    `\`Total = ${total}\`${footnote}\n\n` +
    `> Other updates are posted on ${PORTAL_URL}`
  )
}

export function NotificationsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [funderCards, setFunderCards] = useState<FunderIpoCard[]>([])
  const [allottedCards, setAllottedCards] = useState<FunderAllottedCard[]>([])
  const [holderAllottedCards, setHolderAllottedCards] = useState<HolderAllottedCard[]>([])
  const [loading, setLoading] = useState(true)
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
  // Non-admin only — a funder-only viewer has no funder/holder cards to
  // show at all (those sections are admin-only above), which used to leave
  // them looking at a completely blank page once the old flat 'Messages'
  // table was removed. RLS already scopes this to just their own
  // notifications either way, same as the old table did.
  const [myNotifications, setMyNotifications] = useState<Notification[]>([])
  const [openingId, setOpeningId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const [fundersRes, myNotifsRes] = await Promise.all([
      // Not admin-gated — RLS already scopes this to "every application" for
      // admin and "just what I funded" for a funder-only viewer, which is
      // exactly what the (now non-admin-visible-too) 'Allotment updates'
      // card below needs: a funder's own 'this IPO is allotted, funded by
      // you' card.
      supabase
        .from('applications')
        .select(
          // Explicit FK on both bank_accounts embeds — applications now
          // has two relationships into that table (bank_account_id, the
          // literal paying UPI, and funder_override_id, migration 0063)
          // — and funder cards/messages prefer the override when set
          // (see effectiveFunder()).
          'ipo_id, lots, applied_at, status, mandate_status, ipoji_status_text, ' +
            'ipos(company_name, open_date, close_date, listing_date, price_high, lot_size, gmp_notes), ' +
            'demat_accounts(holder_name, profit_share_percent, phone_e164), ' +
            'bank_accounts!bank_account_id(account_holder_name, phone_e164, upi_id), ' +
            'funder_override:bank_accounts!funder_override_id(account_holder_name, phone_e164, upi_id)',
        )
        // No .or(bank_account_id/funder_override_id not null) filter —
        // that used to drop genuinely self-funded applications (no
        // bank/UPI account tracked at all) from every card below
        // entirely, including "my own" IPOs. effectiveFunder() falls
        // back to the demat holder identity when neither is set, same
        // as the attribution pie chart already does — this just needs
        // the row to actually be fetched for that fallback to run.
        .order('applied_at', { ascending: false }),
      !isAdmin
        ? supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(50)
        : Promise.resolve({ data: [], error: null }),
    ])
    setFundersError(fundersRes.error ? fundersRes.error.message : null)
    const funderRows = (fundersRes.data ?? []) as unknown as ApplicationForFunderRow[]
    setFunderCards(buildFunderIpoCards(funderRows))
    setAllottedCards(buildFunderAllottedCards(funderRows, sameIdentity))
    setHolderAllottedCards(buildHolderAllottedCards(funderRows))
    setMyNotifications((myNotifsRes.data ?? []) as Notification[])
    setLoading(false)
  }

  async function openMyNotification(n: Notification) {
    setOpeningId(n.id)
    await openWhatsAppForNotification(n)
    setOpeningId(null)
    load()
  }

  useEffect(() => {
    // isAdmin depends on `profile`, which loads in parallel with (not
    // before) this page mounting — re-running load() when it flips from
    // false to true is what makes the funders query actually fire, instead
    // of permanently reading the isAdmin-false snapshot from first render.
    load()
  }, [isAdmin])

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Notifications
        </h1>
      </div>

      {!loading && fundersError && (
        <p className="badge badge-critical w-fit">Couldn't load {isAdmin ? 'funders' : 'your allotments'}: {fundersError}</p>
      )}

      {/* Non-admin only — the funder/holder card sections below are
          admin-only, so without this a funder-only viewer had nothing to
          look at here at all once the old flat table was removed. Compact
          on purpose (name + status + one action), not a rebuild of the old
          full table. */}
      {!isAdmin && !loading && (
        <section>
          <h2 className="mb-2 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
            Your messages
          </h2>
          {myNotifications.length === 0 ? (
            <p className="card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
              No messages yet.
            </p>
          ) : (
            <div className="space-y-2">
              {myNotifications.map((n) => (
                <div key={n.id} className="card flex items-center justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate" style={{ color: 'var(--ink-primary)' }}>
                      {renderMessageBody(n.template_name, (n.variables as { params?: string[] } | null)?.params ?? []).split('\n')[0]}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {new Date(n.created_at).toLocaleString()} · {n.status}
                    </p>
                  </div>
                  {(n.status === 'QUEUED' || n.status === 'FAILED') && (
                    <button
                      onClick={() => openMyNotification(n)}
                      disabled={openingId === n.id}
                      className="btn-secondary shrink-0 text-xs disabled:opacity-50"
                    >
                      {openingId === n.id ? 'Opening…' : 'Open WhatsApp'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Non-admin now sees this too, not just admin — a funder's own "this
          IPO is allotted, funded by you" card, same underlying data
          (RLS already scopes it to just their own applications), just no
          Send button (nothing to send to themselves) — the expected-profit
          number is shown directly instead, since that's the actual thing
          they're here to see. */}
      {!loading && allottedCards.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
            {isAdmin ? 'Allotment updates' : 'Allotted — funded by you'}
            <InfoTooltip text="One card per funder per IPO where at least one of their funded accounts got allotted — with an expected-profit projection based on the IPO's price band and GMP." />
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {allottedCards.map((c) => {
              const message = buildFunderAllottedMessage(c)
              const profit = c.priceHigh ? expectedProfitBreakdown(c).netYourProfit : null
              return (
                <div key={c.key} className="aura-card stagger-item flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {isAdmin ? c.funderName : c.ipoName}
                    </p>
                    <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {isAdmin ? `${c.ipoName} · ${c.holderNames.length} allotted` : `${c.holderNames.length} account(s) allotted`}
                    </p>
                  </div>
                  {isAdmin ? (
                    <button
                      type="button"
                      onClick={() => c.phone && sendCustomWhatsapp(c.phone, message)}
                      disabled={!c.phone}
                      title={c.phone ? undefined : 'No phone number on file for this bank/UPI account'}
                      className="btn-secondary shrink-0 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Send
                    </button>
                  ) : (
                    profit != null && (
                      <span className="shrink-0 text-sm font-semibold" style={{ color: 'var(--good)' }}>
                        {rupees(profit)}
                      </span>
                    )
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {isAdmin && !loading && holderAllottedCards.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
            Notify holders — allotted
            <InfoTooltip text={`One card per account holder per IPO where their own application got allotted — a plain "you got shares" notice sent to the account holder themselves, separate from the funder's profit-projection message above.`} />
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {holderAllottedCards.map((c) => {
              const message = buildHolderAllottedMessage(c)
              return (
                <div key={c.key} className="aura-card stagger-item flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {c.holderName}
                      {c.hasOverride && (
                        <span className="ml-1.5" title="Funded via a transfer to a different UPI account">
                          {'\u{1F3F7}\u{FE0F}'}
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {c.ipoName} · {c.totalLots} lot(s)
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => c.phone && sendCustomWhatsapp(c.phone, message)}
                    disabled={!c.phone}
                    title={c.phone ? undefined : 'No phone number on file for this account'}
                    className="btn-secondary shrink-0 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Send
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
            <h2 className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-secondary)' }}>
              Funders
              {/* Today-only view — same funder cards, but each one's message
                  and app count are recomputed from just today's applications,
                  and cards where the funder has nothing new today drop out
                  entirely rather than showing an empty card. */}
              <InfoTooltip
                text={
                  todayOnly
                    ? "One card per funder per IPO, showing only applications entered today — for messaging a funder about just what's new."
                    : "One card per funder per currently-live IPO — if someone's funded applications across multiple ongoing IPOs, send each one separately."
                }
              />
            </h2>
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {funderCards
              .map((c) =>
                todayOnly ? { ...c, applications: c.applications.filter((a) => isToday(a.createdAt)) } : c,
              )
              .filter((c) => c.applications.length > 0)
              .map((c) => {
              const message = buildFunderIpoMessage(c, { todayOnly })
              return (
                <div key={c.key} className="card stagger-item flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {c.funderName}
                    </p>
                    <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {c.ipoName} · {c.applications.length} app{c.applications.length === 1 ? '' : 's'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => c.phone && sendCustomWhatsapp(c.phone, message)}
                    disabled={!c.phone}
                    title={c.phone ? undefined : 'No phone number on file for this bank/UPI account'}
                    className="btn-secondary shrink-0 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {loading && <InlineSpinner />}
    </div>
  )
}
