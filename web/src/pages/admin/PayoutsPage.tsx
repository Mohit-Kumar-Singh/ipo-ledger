// A dedicated, portal-wide view of every payout obligation from a SOLD
// application — the demat holder's cut, and the funder's 50/50 share when
// applicable — across every IPO at once, not just whichever one happens to
// be selected on the Allotment board. That page's "Sold status & payouts"
// section already does the per-IPO version of this; this page is the
// running ledger: what's still owed, to whom, and (once marked) a paid
// history — so nothing has to be reconstructed by memory or by clicking
// through every settled IPO one at a time.
import { useEffect, useState } from 'react'
import { ChevronDownIcon, SearchIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { showToast } from '../../lib/toast'
import { computeProfitSplit } from '../../lib/profitSplit'
import { sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { payoutMessage } from './AllotmentBoardPage'
import type { AllotmentBoardRow } from '../../types/database'
import { InlineSpinner } from '../../components/PageSpinner'

interface PayoutLine {
  applicationId: string
  field: 'demat_cut_paid' | 'funder_share_paid'
  kind: 'cut' | 'share'
  recipient: string
  phone: string | null
  ipoName: string
  amount: number
  paid: boolean
  row: AllotmentBoardRow
  result: ReturnType<typeof computeProfitSplit>
}

// Same per-line split logic AllotmentBoardPage's SoldBreakdown already
// uses, just run across every SOLD row instead of one IPO's worth — kept as
// a plain function here rather than imported, since the source there is a
// component-internal render step, not an exported helper.
function buildPayoutLines(rows: AllotmentBoardRow[], profitPersonName: string): PayoutLine[] {
  const lines: PayoutLine[] = []
  for (const r of rows) {
    if (r.sell_price == null) continue
    const result = computeProfitSplit({
      sellPricePerShare: r.sell_price,
      lotSize: r.lot_size,
      lots: r.lots,
      bidAmount: r.bid_amount ?? 0,
      cutPercent: r.profit_share_percent,
      dematHolderName: r.holder_name,
      funderName: r.bank_account_holder_name,
      profitPersonName,
      splitWithFunder: r.split_profit_with_funder,
    })
    if (!result.isDematHolderSelf && result.dematCutAmount > 0) {
      lines.push({
        applicationId: r.application_id,
        field: 'demat_cut_paid',
        kind: 'cut',
        recipient: r.holder_name,
        phone: r.phone_e164,
        ipoName: r.company_name,
        amount: result.dematCutAmount,
        paid: r.demat_cut_paid,
        row: r,
        result,
      })
    }
    if (result.funderShare > 0) {
      lines.push({
        applicationId: r.application_id,
        field: 'funder_share_paid',
        kind: 'share',
        recipient: r.bank_account_holder_name ?? 'Unknown',
        phone: r.bank_account_phone,
        ipoName: r.company_name,
        amount: result.funderShare,
        paid: r.funder_share_paid,
        row: r,
        result,
      })
    }
  }
  return lines
}

function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

// The two-sided settlement for one SOLD application: what the account
// holder owes back (principal + all profit except their own cut — money
// COMING IN) and what's owed out to whoever funded it (their principal +
// their profit share, if any — money GOING OUT). Distinct from PayoutLine
// above, which only tracks the OUTGOING obligations already being marked
// paid/unpaid; this is a per-application view of the full picture (both
// directions at once), computed fresh each render rather than tracked in
// the DB — there's no "received from holder" flag to check off, only
// "owed to funder"/"owed to holder's cut" already exist as real fields.
interface SettlementCard {
  applicationId: string
  ipoName: string
  lots: number
  lotSize: number
  sellPrice: number
  bidAmount: number
  totalSoldAmount: number
  profitTotal: number
  cutPercent: number
  holderName: string
  isDematHolderSelf: boolean
  dematCutAmount: number
  // Money coming IN — what the account holder sends back once they've sold.
  amountFromHolder: number
  hasFunder: boolean
  isFunderSelf: boolean
  funderName: string | null
  funderPhone: string | null
  funderShare: number
  // Money going OUT — what's owed to the funder (their principal + share).
  amountToFunder: number
  // What's actually left over for the profit person (you) once both sides
  // above have moved — incoming minus outgoing, from computeProfitSplit
  // directly rather than re-derived, so it can never drift from the
  // authoritative split even if the two amounts above are ever adjusted.
  myProfit: number
}

function buildSettlementCards(rows: AllotmentBoardRow[], profitPersonName: string): SettlementCard[] {
  const cards: SettlementCard[] = []
  for (const r of rows) {
    if (r.sell_price == null) continue
    const result = computeProfitSplit({
      sellPricePerShare: r.sell_price,
      lotSize: r.lot_size,
      lots: r.lots,
      bidAmount: r.bid_amount ?? 0,
      cutPercent: r.profit_share_percent,
      dematHolderName: r.holder_name,
      funderName: r.bank_account_holder_name,
      profitPersonName,
      splitWithFunder: r.split_profit_with_funder,
    })
    const bidAmount = r.bid_amount ?? 0
    cards.push({
      applicationId: r.application_id,
      ipoName: r.company_name,
      lots: r.lots,
      lotSize: r.lot_size,
      sellPrice: r.sell_price,
      bidAmount,
      totalSoldAmount: result.totalSoldAmount,
      profitTotal: result.grossProfit,
      cutPercent: r.profit_share_percent,
      holderName: r.holder_name,
      isDematHolderSelf: result.isDematHolderSelf,
      dematCutAmount: result.dematCutAmount,
      amountFromHolder: result.isDematHolderSelf ? 0 : result.totalSoldAmount - result.dematCutAmount,
      hasFunder: result.hasFunder,
      isFunderSelf: result.isFunderSelf,
      funderName: r.bank_account_holder_name,
      funderPhone: r.bank_account_phone,
      funderShare: result.funderShare,
      amountToFunder: result.hasFunder && !result.isFunderSelf ? bidAmount + result.funderShare : 0,
      myProfit: result.profitPersonShare,
    })
  }
  return cards
}

interface RecipientGroup {
  name: string
  phone: string | null
  lines: PayoutLine[]
  total: number
}

function groupByRecipient(lines: PayoutLine[]): RecipientGroup[] {
  const byName = new Map<string, RecipientGroup>()
  for (const l of lines) {
    if (!byName.has(l.recipient)) byName.set(l.recipient, { name: l.recipient, phone: l.phone, lines: [], total: 0 })
    const g = byName.get(l.recipient)!
    if (!g.phone && l.phone) g.phone = l.phone
    g.lines.push(l)
    g.total += l.amount
  }
  return Array.from(byName.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
}

export function PayoutsPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [rows, setRows] = useState<AllotmentBoardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [markingPaid, setMarkingPaid] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  async function load() {
    setLoading(true)
    setLoadError(null)
    // No per-IPO filter — v_allotment_board is already RLS-scoped per
    // viewer, this just doesn't narrow it down to one selected IPO the way
    // AllotmentBoardPage does.
    const { data, error } = await supabase.from('v_allotment_board').select('*').eq('status', 'SOLD')
    if (error) {
      setLoadError(error.message)
      setLoading(false)
      return
    }
    setRows(((data ?? []) as AllotmentBoardRow[]).filter((r) => !r.ipo_is_archived))
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function markPaid(line: PayoutLine) {
    setMarkingPaid(line.applicationId + line.field)
    const { error } = await supabase
      .from('applications')
      .update({ [line.field]: true })
      .eq('id', line.applicationId)
    setMarkingPaid(null)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    load()
  }

  if (!isAdmin) {
    return (
      <div className="card p-8 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
        Payouts is an admin-only page — it covers funding credit and payout obligations across every account, not
        just your own.
      </div>
    )
  }

  const allLines = buildPayoutLines(rows, profile?.full_name ?? '')
  const outstandingLines = allLines.filter((l) => !l.paid)
  const paidLines = allLines.filter((l) => l.paid)
  const searchFilter = (g: RecipientGroup) => !search.trim() || g.name.toLowerCase().includes(search.trim().toLowerCase())
  const outstandingGroups = groupByRecipient(outstandingLines).filter(searchFilter)
  const paidGroups = groupByRecipient(paidLines).filter(searchFilter)
  const outstandingTotal = outstandingLines.reduce((s, l) => s + l.amount, 0)

  const settlementCards = buildSettlementCards(rows, profile?.full_name ?? '')
  const totalIncoming = settlementCards.reduce((s, c) => s + c.amountFromHolder, 0)
  const totalOutgoing = settlementCards.reduce((s, c) => s + c.amountToFunder, 0)
  const totalMyProfit = settlementCards.reduce((s, c) => s + c.myProfit, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Payouts
          </h1>
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Every payout owed out of a sold application, across every IPO — {outstandingLines.length} outstanding
            {outstandingLines.length > 0 && ` (₹${Math.round(outstandingTotal).toLocaleString('en-IN')})`}.
          </p>
        </div>
        {/* Adjacent to the header text, not its own full-width row — the
            overall picture across every sold application at a glance. */}
        {settlementCards.length > 0 && (
          <div className="card flex shrink-0 items-center gap-4 px-4 py-2.5 text-sm">
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                Coming in
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--good)' }}>
                {rupees(totalIncoming)}
              </p>
            </div>
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                Going out
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--critical-text)' }}>
                {rupees(totalOutgoing)}
              </p>
            </div>
            <div>
              <p className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                My profit
              </p>
              <p className="font-mono-ipo font-semibold" style={{ color: 'var(--ink-primary)' }}>
                {rupees(totalMyProfit)}
              </p>
            </div>
          </div>
        )}
      </div>

      {settlementCards.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Settlement — every sold application
          </h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {settlementCards.map((c) => (
              <SettlementCardView key={c.applicationId} c={c} />
            ))}
          </div>
        </section>
      )}

      {rows.length > 0 && (
        <div className="relative">
          <SearchIcon size={15} fill="var(--ink-muted)" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by recipient name…"
            className="input pl-9"
          />
        </div>
      )}

      {loadError && (
        <div className="card p-4 text-sm" style={{ borderColor: 'var(--critical)', color: 'var(--ink-primary)' }}>
          Couldn't load payouts: {loadError}
        </div>
      )}

      {loading ? (
        <InlineSpinner />
      ) : loadError ? null : (
        <>
          <PayoutSection
            title="Outstanding"
            emptyLabel={search ? `No outstanding payouts match "${search}".` : 'Nothing owed right now.'}
            groups={outstandingGroups}
            defaultOpen
            markingPaid={markingPaid}
            onMarkPaid={markPaid}
          />
          <PayoutSection
            title="Paid"
            emptyLabel={search ? `No paid payouts match "${search}".` : 'Nothing marked paid yet.'}
            groups={paidGroups}
            defaultOpen={false}
            markingPaid={markingPaid}
            onMarkPaid={markPaid}
          />
        </>
      )}
    </div>
  )
}

// One card per sold application, showing both directions of money at once:
// what the account holder sends back (green — coming in) and what's owed
// out to whoever funded it (subtle red — going out). Either half can be
// absent (self-funded: no funder row; the holder IS you: no holder row).
function SettlementCardView({ c }: { c: SettlementCard }) {
  const cutRemainder = c.profitTotal - c.dematCutAmount
  return (
    <div className="card stagger-item space-y-3 p-4">
      <p className="font-medium" style={{ color: 'var(--ink-primary)' }}>
        {c.ipoName} — sold {c.lotSize} share{c.lotSize === 1 ? '' : 's'} at {rupees(c.sellPrice)}/share
      </p>

      {!c.isDematHolderSelf && c.amountFromHolder > 0 && (
        <div className="rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--good-tint)', background: 'var(--good-tint)' }}>
          <p className="mb-1.5 font-medium" style={{ color: 'var(--ink-primary)' }}>
            From {c.holderName} (account holder)
          </p>
          <div className="space-y-0.5" style={{ color: 'var(--ink-secondary)' }}>
            <p>Total sold: {rupees(c.totalSoldAmount)}</p>
            <p>Invested: {rupees(c.bidAmount)}</p>
            <p>
              Profit: {rupees(c.totalSoldAmount)} − {rupees(c.bidAmount)} = {rupees(c.profitTotal)}
            </p>
            <p className="pt-1">Their {c.cutPercent}% profit-sharing (incl. TAX) cut:</p>
            <p>
              {rupees(c.profitTotal)} × {c.cutPercent}% = {rupees(c.dematCutAmount)}
            </p>
            <p className="pt-1 font-medium" style={{ color: 'var(--good)' }}>
              Total to receive: {rupees(c.bidAmount)} + {rupees(cutRemainder)} = {rupees(c.amountFromHolder)}
            </p>
          </div>
        </div>
      )}

      {c.hasFunder && !c.isFunderSelf && c.amountToFunder > 0 && (
        <div
          className="rounded-lg border p-3 text-xs"
          style={{ borderColor: 'var(--critical-tint)', background: 'var(--critical-tint)' }}
        >
          <p className="mb-1.5 font-medium" style={{ color: 'var(--ink-primary)' }}>
            To {c.funderName} (funder)
          </p>
          <div className="space-y-0.5" style={{ color: 'var(--ink-secondary)' }}>
            <p>Their principal: {rupees(c.bidAmount)}</p>
            <p>Their profit share: {rupees(c.funderShare)}</p>
            <p className="pt-1 font-medium" style={{ color: 'var(--critical-text)' }}>
              Total to pay: {rupees(c.bidAmount)} + {rupees(c.funderShare)} = {rupees(c.amountToFunder)}
            </p>
          </div>
        </div>
      )}

      <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
        My profit: <span style={{ color: 'var(--ink-primary)', fontWeight: 600 }}>{rupees(c.myProfit)}</span>
      </p>
    </div>
  )
}

function PayoutSection({
  title,
  emptyLabel,
  groups,
  defaultOpen,
  markingPaid,
  onMarkPaid,
}: {
  title: string
  emptyLabel: string
  groups: RecipientGroup[]
  defaultOpen: boolean
  markingPaid: string | null
  onMarkPaid: (line: PayoutLine) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <h2 className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <span className="inline-flex transition-transform duration-200" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
            <ChevronDownIcon size={14} />
          </span>
          {title} <span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>({groups.length})</span>
        </h2>
      </button>
      {open &&
        (groups.length === 0 ? (
          <p className="card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
            {emptyLabel}
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.name} className="card stagger-item p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div
                      className="icon-badge icon-badge-good shrink-0 text-xs font-semibold"
                      style={{ width: '2rem', height: '2rem' }}
                    >
                      {g.name[0]?.toUpperCase()}
                    </div>
                    <span className="font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {g.name}
                    </span>
                  </div>
                  <span style={{ color: 'var(--good)' }}>₹{Math.round(g.total).toLocaleString('en-IN')}</span>
                </div>
                <div className="mt-2 space-y-1.5">
                  {g.lines.map((l) => (
                    <div key={l.applicationId + l.field} className="flex items-center justify-between gap-2 text-xs">
                      <span style={{ color: 'var(--ink-muted)' }}>
                        {l.ipoName} · {l.kind === 'cut' ? 'cut' : 'share'} · ₹{Math.round(l.amount).toLocaleString('en-IN')}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {l.phone && (
                          <button
                            onClick={() => sendCustomWhatsapp(l.phone!, payoutMessage(l.row, l.result, l.kind))}
                            className="link-accent font-medium"
                          >
                            Message
                          </button>
                        )}
                        {l.paid ? (
                          <span className="badge badge-good">Paid</span>
                        ) : (
                          <button
                            onClick={() => onMarkPaid(l)}
                            disabled={markingPaid === l.applicationId + l.field}
                            className="link-accent font-medium disabled:opacity-50"
                          >
                            {markingPaid === l.applicationId + l.field ? 'Marking…' : 'Mark paid'}
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
    </section>
  )
}

