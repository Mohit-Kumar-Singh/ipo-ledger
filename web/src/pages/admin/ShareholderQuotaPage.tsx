import { memo, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, PencilIcon, TrashIcon, XIcon } from '@primer/octicons-react'
import { Plus, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useParentCompanies, useDematAccounts, useBankAccounts, useIpos, queryKeys } from '../../lib/queries'
import { firstIpoWord } from '../../lib/ipoDisplayName'
import { formatShortDate } from '../../lib/formatDate'
import { useAuth } from '../../contexts/AuthContext'
import { showToast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirmDialog'
import { Combobox } from '../../components/Combobox'
import { InfoTooltip } from '../../components/HoverCard'
import { rupees } from '../../lib/expectedProfit'
import { sameIdentity } from '../../lib/applicationAttribution'
import { computeHoldingPnl, summarizeCompanyHoldings, type CompanyHoldingsSummary } from '../../lib/parentCompanyPnl'
import { InlineSpinner } from '../../components/PageSpinner'
import type { BankAccount, DematAccount, Ipo, ParentCompany, ParentCompanyHolding } from '../../types/database'

const HOLDINGS_QUERY_KEY = ['parent_company_holdings'] as const

// Module-level, not `?? []` inline — a fresh array literal on every render
// (while a query is still pending) is a different reference each time,
// which defeats useMemo's dependency check below. Same fix ApplicationsPage
// already uses for its own EMPTY_APPLICATIONS fallback.
const EMPTY_DEMAT_ACCOUNTS: DematAccount[] = []
const EMPTY_BANK_ACCOUNTS: BankAccount[] = []
const EMPTY_HOLDINGS: ParentCompanyHolding[] = []
const EMPTY_IPOS: Ipo[] = []

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}

function pnlColor(pnl: number): string {
  if (pnl > 0) return 'var(--good-text)'
  if (pnl < 0) return 'var(--critical-text)'
  return 'var(--ink-muted)'
}

function signedRupees(n: number): string {
  return n > 0 ? `+${rupees(n)}` : rupees(n)
}

function bankOptions(banks: BankAccount[], placeholder: string) {
  return [
    { value: '', label: placeholder },
    ...[...banks]
      .sort((a, b) => (a.account_holder_name ?? '').localeCompare(b.account_holder_name ?? ''))
      .map((b) => ({
        value: b.id,
        label: [b.account_holder_name, b.bank_name, b.upi_id].filter(Boolean).join(' · ') || 'Bank account',
      })),
  ]
}

// Shares of a listed parent/associate company, bought so an account holder
// qualifies for its group's shareholder quota — reusable across every IPO
// with that same parent (see ipos.parent_company_id, migration 0097).
// Distinct from Open positions (post-allotment IPO shares): this page is
// about pre-existing eligibility holdings, not what came out of an IPO.
export function ShareholderQuotaPage() {
  const { profile } = useAuth()
  const queryClient = useQueryClient()
  const companiesQuery = useParentCompanies()
  const dematQuery = useDematAccounts()
  const bankQuery = useBankAccounts()
  const iposQuery = useIpos()
  const companies = useMemo(
    () => [...(companiesQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [companiesQuery.data],
  )
  const dematAccounts = dematQuery.data ?? EMPTY_DEMAT_ACCOUNTS
  const bankAccounts = bankQuery.data ?? EMPTY_BANK_ACCOUNTS
  const ipos = iposQuery.data ?? EMPTY_IPOS

  const holdingsQuery = useQuery({
    queryKey: HOLDINGS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase.from('parent_company_holdings').select('*')
      if (error) throw error
      return (data ?? []) as ParentCompanyHolding[]
    },
  })
  const holdings = holdingsQuery.data ?? EMPTY_HOLDINGS

  // useCallback — passed to every CompanyCard as onChanged; a stable
  // reference is what lets React.memo on CompanyCard/HoldingRow actually
  // skip re-rendering cards nothing changed about. Also invalidates the
  // shared ipos cache (queries.ts) — linking/unlinking an IPO to a parent
  // company writes ipos.parent_company_id, and that cache is shared with
  // Dashboard/Applications/IposPage/Allotment board, so they all need to
  // see the change too, not just this page.
  const reload = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.parentCompanies }),
      queryClient.invalidateQueries({ queryKey: HOLDINGS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: queryKeys.ipos }),
    ])
  }, [queryClient])

  // One batched fetch-stock-price call for every distinct symbol currently in
  // view — same pattern IposPage already uses for parent_company_symbol.
  const [livePrices, setLivePrices] = useState<Record<string, { price: number | null; stale: boolean }>>({})
  useEffect(() => {
    const symbols = Array.from(new Set(companies.map((c) => c.symbol).filter((s): s is string => !!s)))
    if (symbols.length === 0) return
    supabase.functions
      .invoke<{ prices?: Record<string, { price: number | null; stale: boolean }> }>('fetch-stock-price', {
        body: { symbols },
      })
      .then(({ data }) => {
        if (data?.prices) setLivePrices((prev) => ({ ...prev, ...data.prices }))
      })
  }, [companies])

  const dematNameById = useMemo(() => new Map(dematAccounts.map((d) => [d.id, d.holder_name])), [dematAccounts])

  // useCallback, not a plain function — CompanyCard's own summarizeCompanyHoldings
  // useMemo depends on isMeAccount, so a fresh reference on every render of
  // this page (e.g. livePrices updating) would invalidate that memo on
  // every single company card, recomputing all of them for no reason. A
  // stable reference lets each card's memo actually hold.
  const isMeAccount = useCallback(
    (bankId: string | null): boolean => {
      if (!bankId) return false
      const b = bankAccounts.find((x) => x.id === bankId)
      return !!b && sameIdentity(b.account_holder_name, profile?.full_name ?? '')
    },
    [bankAccounts, profile?.full_name],
  )

  const bankLabel = useCallback(
    (bankId: string | null): string => {
      if (!bankId) return 'Self-funded'
      const b = bankAccounts.find((x) => x.id === bankId)
      return b ? [b.account_holder_name, b.bank_name].filter(Boolean).join(' · ') || 'Bank account' : 'Unknown account'
    },
    [bankAccounts],
  )

  const holdingsByCompany = useMemo(() => {
    const map = new Map<string, ParentCompanyHolding[]>()
    for (const h of holdings) {
      if (!map.has(h.parent_company_id)) map.set(h.parent_company_id, [])
      map.get(h.parent_company_id)!.push(h)
    }
    return map
  }, [holdings])

  // Computed once here (not inside each CompanyCard) so the same per-company
  // numbers can feed both that card's own stat row AND the overall totals
  // below, instead of summarizing every company's holdings twice.
  const companySummaries = useMemo(
    () =>
      companies.map((company) => {
        const livePrice = company.symbol ? (livePrices[company.symbol]?.price ?? null) : null
        const companyHoldings = holdingsByCompany.get(company.id) ?? EMPTY_HOLDINGS
        return {
          company,
          livePrice,
          priceStale: company.symbol ? (livePrices[company.symbol]?.stale ?? false) : false,
          holdings: companyHoldings,
          summary: summarizeCompanyHoldings(companyHoldings, livePrice, isMeAccount),
        }
      }),
    [companies, livePrices, holdingsByCompany, isMeAccount],
  )

  // Sum of every company's own summary — "if [an account] bought shares in
  // 2 companies, that counts as 2" means the headline count here is the
  // total number of holding ROWS across every company, not distinct account
  // holders (holdings.length already is that: one row per holder-company
  // purchase lot).
  const overall = useMemo(() => {
    let investedTotal = 0
    let fundedByMeTotal = 0
    let myPnl = 0
    let holderGainsTotal = 0
    let hasUnpriced = false
    for (const { summary } of companySummaries) {
      investedTotal += summary.investedTotal
      fundedByMeTotal += summary.fundedByMeTotal
      myPnl += summary.myPnl
      holderGainsTotal += summary.holderGains.reduce((s, g) => s + g.pnl, 0)
      if (summary.hasUnpriced) hasUnpriced = true
    }
    return { totalHoldings: holdings.length, investedTotal, fundedByMeTotal, myPnl, holderGainsTotal, hasUnpriced }
  }, [companySummaries, holdings.length])

  const [showAddCompany, setShowAddCompany] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSymbol, setNewSymbol] = useState('')
  // Optional — lets the very reason you're adding this company (you just
  // learned of an upcoming IPO) go in at the same time, instead of forcing
  // a second trip through Edit right after creating it. Still just the one
  // field here; adding several, or one later, stays an Edit-form thing.
  const [newIpoName, setNewIpoName] = useState('')
  const [savingCompany, setSavingCompany] = useState(false)

  async function addCompany(e: FormEvent) {
    e.preventDefault()
    setSavingCompany(true)
    const trimmedIpoName = newIpoName.trim()
    const { error } = await supabase.from('parent_companies').insert({
      name: newName.trim(),
      symbol: newSymbol.trim().toUpperCase() || null,
      watched_ipo_names: trimmedIpoName ? [trimmedIpoName] : [],
    })
    setSavingCompany(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    setNewName('')
    setNewSymbol('')
    setNewIpoName('')
    setShowAddCompany(false)
    reload()
  }

  // holdingsQuery is included deliberately — it was missing before, which let
  // company cards render before their holdings arrived (a beat after
  // companies/demat/bank loaded, since it's the one query with no shared
  // warm cache from other pages), flashing "No holdings recorded yet." right
  // before the real list popped in on every fresh visit to this page.
  const loading =
    companiesQuery.isPending || dematQuery.isPending || bankQuery.isPending || holdingsQuery.isPending || iposQuery.isPending

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-1.5 text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
          Shareholder Quota
          <InfoTooltip text="Parent companies your accounts already hold shares in — pick one on an IPO's edit page to unlock its shareholder-quota eligibility." />
        </h1>
        {/* Small icon-only toggle, same size/style as Applications' own
            "New application" button — a full text button here was more
            visual weight than a single add action needs. */}
        <button
          onClick={() => setShowAddCompany((s) => !s)}
          aria-label={showAddCompany ? 'Cancel' : 'Add company'}
          title={showAddCompany ? 'Cancel' : 'Add company'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--hover-surface)]"
          style={{ color: 'var(--ink-secondary)' }}
        >
          {showAddCompany ? <X size={16} /> : <Plus size={16} />}
        </button>
      </div>

      {showAddCompany && (
        <form onSubmit={addCompany} className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
          <Field label="Company name">
            <input required value={newName} onChange={(e) => setNewName(e.target.value)} className="input" placeholder="e.g. Coal India" />
          </Field>
          <Field label="NSE symbol (optional)">
            <input value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} className="input" placeholder="e.g. COALINDIA" />
          </Field>
          <Field label="IPO name (optional)">
            <input value={newIpoName} onChange={(e) => setNewIpoName(e.target.value)} className="input" placeholder="e.g. MCL" />
          </Field>
          <div className="flex items-end">
            <button type="submit" disabled={savingCompany} className="btn-primary w-full">
              {savingCompany ? 'Saving…' : 'Add company'}
            </button>
          </div>
        </form>
      )}

      {loading && <InlineSpinner />}

      {!loading && companies.length === 0 && (
        <div className="card p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
          No parent companies yet — add one above whenever an IPO's shareholder quota is via a company you already hold shares of.
        </div>
      )}

      {!loading && companies.length > 0 && <OverallSummaryCard overall={overall} />}

      {companySummaries.map(({ company, holdings: companyHoldings, livePrice, priceStale, summary }) => (
        <CompanyCard
          key={company.id}
          company={company}
          holdings={companyHoldings}
          summary={summary}
          ipos={ipos}
          livePrice={livePrice}
          priceStale={priceStale}
          dematAccounts={dematAccounts}
          bankAccounts={bankAccounts}
          dematNameById={dematNameById}
          bankLabel={bankLabel}
          isMeAccount={isMeAccount}
          onChanged={reload}
        />
      ))}
    </div>
  )
}

// Sits above the per-company cards — the same 4 numbers each of those cards
// already shows (Invested/Funded by me/My P&L/Holder gains), summed across
// every parent company, plus a headline count of every holding recorded
// (each holder-company purchase lot counts separately, so one holder in 2
// companies counts as 2 — see the `overall` useMemo above).
function OverallSummaryCard({
  overall,
}: {
  overall: {
    totalHoldings: number
    investedTotal: number
    fundedByMeTotal: number
    myPnl: number
    holderGainsTotal: number
    hasUnpriced: boolean
  }
}) {
  return (
    <div className="card p-4">
      <h2 className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
        All companies
      </h2>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        <Stat label="Total holdings" value={String(overall.totalHoldings)} />
        <Stat label="Total invested" value={rupees(overall.investedTotal)} />
        <Stat label="Funded by me" value={rupees(overall.fundedByMeTotal)} />
        <Stat label="My P&L" value={signedRupees(overall.myPnl)} color={pnlColor(overall.myPnl)} />
        <Stat
          label="Holder gains"
          value={overall.holderGainsTotal === 0 ? '—' : signedRupees(overall.holderGainsTotal)}
          color={overall.holderGainsTotal > 0 ? 'var(--good-text)' : undefined}
        />
      </div>
      {overall.hasUnpriced && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
          Some holdings have no live price yet and aren't counted above.
        </p>
      )}
    </div>
  )
}

// memo, not a plain function — every field above it (isMeAccount, bankLabel,
// onChanged, dematNameById) is now a stable reference across renders of the
// parent page, so this actually skips re-rendering a card when nothing
// about that specific company changed (e.g. typing in a sibling card's own
// add-holding form, which only updates that sibling's local state).
const CompanyCard = memo(function CompanyCard({
  company,
  holdings,
  summary,
  ipos,
  livePrice,
  priceStale,
  dematAccounts,
  bankAccounts,
  dematNameById,
  bankLabel,
  isMeAccount,
  onChanged,
}: {
  company: ParentCompany
  holdings: ParentCompanyHolding[]
  summary: CompanyHoldingsSummary
  ipos: Ipo[]
  livePrice: number | null
  priceStale: boolean
  dematAccounts: DematAccount[]
  bankAccounts: BankAccount[]
  dematNameById: Map<string, string>
  bankLabel: (bankId: string | null) => string
  isMeAccount: (bankId: string | null) => boolean
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(company.name)
  const [editSymbol, setEditSymbol] = useState(company.symbol ?? '')
  const [showAddHolding, setShowAddHolding] = useState(false)
  const [saving, setSaving] = useState(false)

  // Real IPOs already wired to this company (ipos.parent_company_id,
  // migration 0097) — every account in this card's holdings is eligible
  // for these. Distinct from watched_ipo_names (a plain label for an IPO
  // that isn't real yet); linking a watched name promotes it into one of
  // these and removes it from the watched list (see IpoLinksEditor).
  const linkedIpos = useMemo(() => ipos.filter((i) => i.parent_company_id === company.id), [ipos, company.id])
  const unlinkedIpoOptions = useMemo(
    () =>
      [...ipos]
        .filter((i) => i.parent_company_id == null)
        .sort((a, b) => a.company_name.localeCompare(b.company_name, undefined, { sensitivity: 'base' }))
        .map((i) => ({ value: i.id, label: i.company_name })),
    [ipos],
  )

  async function saveEdit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    const { error } = await supabase
      .from('parent_companies')
      .update({ name: editName.trim(), symbol: editSymbol.trim().toUpperCase() || null })
      .eq('id', company.id)
    setSaving(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    setEditing(false)
    onChanged()
  }

  async function deleteCompany() {
    // Checked up front rather than just attempting the delete and parsing
    // the resulting FK-violation — ipos.parent_company_id has no ON DELETE
    // clause (migration 0097), so Postgres blocks this outright while any
    // real IPO is still linked, and the raw 23503 error message reads as a
    // cryptic DB internals dump rather than telling the admin what to
    // actually do about it (unlink each one first, here in Edit).
    if (linkedIpos.length > 0) {
      showToast(
        `Can't delete ${company.name} — unlink ${linkedIpos.map((i) => firstIpoWord(i.company_name)).join(', ')} first.`,
        'critical',
      )
      return
    }
    if (
      !(await confirmDialog(
        `Delete ${company.name}? This also deletes ${holdings.length} holding${holdings.length === 1 ? '' : 's'} recorded against it.`,
        { tone: 'critical', confirmLabel: 'Delete' },
      ))
    )
      return
    const { error } = await supabase.from('parent_companies').delete().eq('id', company.id)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    onChanged()
  }

  return (
    <div className="card p-4">
      {editing ? (
        <form onSubmit={saveEdit} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Company name">
              <input required value={editName} onChange={(e) => setEditName(e.target.value)} className="input" />
            </Field>
            <Field label="NSE symbol">
              <input value={editSymbol} onChange={(e) => setEditSymbol(e.target.value)} className="input" />
            </Field>
          </div>

          <IpoLinksEditor company={company} linkedIpos={linkedIpos} unlinkedIpoOptions={unlinkedIpoOptions} onChanged={onChanged} />

          {/* btn-primary + btn-secondary, the same Save/Cancel pairing used
              on every other edit form in the app (e.g. AccountsPage) — a
              plain X icon squeezed into an .input box read as broken/
              unstyled next to a full-width Save button. */}
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="btn-primary flex-1">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="btn-secondary">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div>
          {/* Name and the action icons share this one row — items-start on
              the old wrapping container let this row wrap onto its own
              line below the name whenever the metadata line below took
              enough width, instead of always sitting beside the name the
              way a card header should. truncate + min-w-0 keeps a long
              name from ever pushing the icons out of view. */}
          <div className="flex items-center justify-between gap-2">
            <h2 className="min-w-0 truncate text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
              {company.name}
            </h2>
            {/* Plain icon buttons (no tinted tile background at rest — just
                color, with a hover fill), same pattern Applications already
                uses for its own row-level edit/delete. Add holding sits in
                this same top-right cluster now instead of a text link at
                the bottom of the card, so all three card-level actions
                live in one place. */}
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                onClick={() => setShowAddHolding((s) => !s)}
                aria-label={showAddHolding ? 'Cancel adding holding' : 'Add holding'}
                title={showAddHolding ? 'Cancel' : 'Add holding'}
                className="rounded-lg p-2 transition-colors hover:bg-[var(--hover-surface)] sm:p-1.5"
                style={{ color: 'var(--ink-secondary)' }}
              >
                {showAddHolding ? <X size={15} /> : <Plus size={15} />}
              </button>
              <button
                onClick={() => {
                  setEditName(company.name)
                  setEditSymbol(company.symbol ?? '')
                  setEditing(true)
                  // Its own toggle button lives in this same row and gets
                  // hidden once editing starts — closing it here avoids an
                  // open Add holding form with no way to dismiss it short
                  // of cancelling edit first.
                  setShowAddHolding(false)
                }}
                aria-label="Edit company"
                title="Edit"
                className="rounded-lg p-2 transition-colors hover:bg-[var(--hover-surface)] sm:p-1.5"
                style={{ color: 'var(--ink-muted)' }}
              >
                <PencilIcon size={15} />
              </button>
              <button
                onClick={deleteCompany}
                aria-label="Delete company"
                title="Delete"
                className="rounded-lg p-2 transition-colors hover:bg-[var(--critical-tint)] sm:p-1.5"
                style={{ color: 'var(--critical)' }}
              >
                <TrashIcon size={15} />
              </button>
            </div>
          </div>
          {/* Symbol/price and IPO names share one line below the name row
              — flex-wrap only breaks it onto a second line if it genuinely
              doesn't fit, not by default. A real linked IPO (good tone) is
              told apart from a still-just-watched name (info tone);
              managing them (add/rename/delete/link) moved into Edit below. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="font-mono-ipo text-xs" style={{ color: 'var(--ink-muted)' }}>
              {company.symbol ?? 'No symbol set'}
              {livePrice != null && ` · ₹${livePrice.toLocaleString('en-IN')}`}
              {priceStale && ' (stale)'}
            </span>
            {linkedIpos.map((i) => (
              <span key={i.id} className="badge badge-good">
                {firstIpoWord(i.company_name)}
              </span>
            ))}
            {company.watched_ipo_names.map((name) => (
              <span key={name} className="badge badge-info">
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {showAddHolding && (
        <AddHoldingForm
          companyId={company.id}
          dematAccounts={dematAccounts}
          bankAccounts={bankAccounts}
          isMeAccount={isMeAccount}
          onDone={async () => {
            setShowAddHolding(false)
            await onChanged()
          }}
        />
      )}

      {holdings.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-b py-2.5 text-xs sm:grid-cols-5" style={{ borderColor: 'var(--border)' }}>
          <Stat label="Total holdings" value={String(holdings.length)} />
          <Stat label="Invested" value={rupees(summary.investedTotal)} />
          <Stat label="Funded by me" value={rupees(summary.fundedByMeTotal)} />
          <Stat label="My P&L" value={signedRupees(summary.myPnl)} color={pnlColor(summary.myPnl)} />
          <Stat
            label="Holder gains"
            value={summary.holderGains.length === 0 ? '—' : signedRupees(summary.holderGains.reduce((s, g) => s + g.pnl, 0))}
            color={summary.holderGains.length > 0 ? 'var(--good-text)' : undefined}
          />
        </div>
      )}
      {summary.hasUnpriced && holdings.length > 0 && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
          Some holdings have no live price yet and aren't counted above.
        </p>
      )}

      <div className="mt-3 space-y-1.5">
        {holdings.map((h) => (
          <HoldingRow
            key={h.id}
            holding={h}
            livePrice={livePrice}
            holderName={dematNameById.get(h.demat_id) ?? 'Account holder'}
            bankLabel={bankLabel}
            onChanged={onChanged}
          />
        ))}
        {holdings.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            No holdings recorded yet.
          </p>
        )}
      </div>

    </div>
  )
})

// Small icon-only button (24px), the same compact size introduced for
// HoldingRow's mark-sold/delete actions — used throughout this editor for
// per-row remove/unlink so several rows of tight per-item controls don't
// balloon the card's height.
// Plain icon (no persistent tinted background) — same look CompanyCard's
// own Edit/Delete/Add buttons use and Applications already uses for its
// row-level edit/delete: color only at rest, a hover fill is the only
// affordance. Reused for every small per-row action on this page (holding
// mark-sold/delete, linked/watched IPO unlink/delete).
function SmallIconButton({
  onClick,
  label,
  tone,
  children,
}: {
  onClick: () => void
  label: string
  tone: 'neutral' | 'critical'
  children: ReactNode
}) {
  const style =
    tone === 'critical' ? { color: 'var(--critical)' } : { color: 'var(--ink-secondary)' }
  const hoverBg = tone === 'critical' ? 'hover:bg-[var(--critical-tint)]' : 'hover:bg-[var(--hover-surface)]'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${hoverBg}`}
      style={style}
    >
      {children}
    </button>
  )
}

// Manages a parent company's IPOs, only shown while editing the card:
//   - linkedIpos: real ipos rows already pointed at this company
//     (ipos.parent_company_id) — every holder in this card is eligible for
//     these; can only be unlinked here, not renamed (that's IposPage's job).
//   - watched_ipo_names: plain text placeholders for an IPO that isn't real
//     yet (migration 0098) — rename inline, delete, or "link" one to an
//     actual ipos row once it exists, which promotes it into linkedIpos and
//     removes the placeholder in the same action.
function IpoLinksEditor({
  company,
  linkedIpos,
  unlinkedIpoOptions,
  onChanged,
}: {
  company: ParentCompany
  linkedIpos: Ipo[]
  unlinkedIpoOptions: { value: string; label: string }[]
  onChanged: () => Promise<void>
}) {
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)

  async function saveNames(names: string[]) {
    setSaving(true)
    const { error } = await supabase.from('parent_companies').update({ watched_ipo_names: names }).eq('id', company.id)
    setSaving(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    onChanged()
  }

  async function renameAt(index: number, value: string) {
    const trimmed = value.trim()
    const current = company.watched_ipo_names
    if (trimmed === current[index]) return
    // An emptied field deletes the entry rather than rejecting the edit —
    // clearing the text is the obvious way to remove one while typing.
    const next = trimmed ? current.map((n, i) => (i === index ? trimmed : n)) : current.filter((_, i) => i !== index)
    await saveNames(next)
  }

  async function removeAt(index: number) {
    await saveNames(company.watched_ipo_names.filter((_, i) => i !== index))
  }

  // Not a <form onSubmit> — this editor renders inside CompanyCard's own
  // outer <form> (the Name/Symbol Save/Cancel form), and HTML doesn't allow
  // nested forms. A browser silently flattens the inner one at parse time,
  // which (confirmed via a throwaway harness) let clicking "Add" here
  // trigger the OUTER form's Save/submit instead. A plain button + Enter-
  // key handler avoids the nested-form entirely.
  async function addName() {
    const trimmed = newName.trim()
    if (!trimmed) return
    setNewName('')
    await saveNames([...company.watched_ipo_names, trimmed])
  }

  async function unlinkIpo(ipoId: string) {
    const { error } = await supabase.from('ipos').update({ parent_company_id: null }).eq('id', ipoId)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    onChanged()
  }

  // Two writes — first the real ipos row (the actual eligibility link),
  // then dropping the now-redundant placeholder off watched_ipo_names.
  // Order matters if the second write fails: better to have a linked IPO
  // that's ALSO still listed as watched (a harmless, visible duplicate you
  // can retry clearing) than a placeholder silently deleted with no link
  // actually made.
  async function linkAt(index: number, ipoId: string) {
    setSaving(true)
    const { error: linkError } = await supabase.from('ipos').update({ parent_company_id: company.id }).eq('id', ipoId)
    if (linkError) {
      setSaving(false)
      showToast(linkError.message, 'critical')
      return
    }
    const { error } = await supabase
      .from('parent_companies')
      .update({ watched_ipo_names: company.watched_ipo_names.filter((_, i) => i !== index) })
      .eq('id', company.id)
    setSaving(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    onChanged()
  }

  return (
    <div>
      <p className="text-sm font-medium" style={{ color: 'var(--ink-secondary)' }}>
        IPOs
      </p>
      <div className="mt-1 space-y-1.5">
        {linkedIpos.map((ipo) => (
          <div key={ipo.id} className="flex items-center justify-between gap-2">
            <span className="badge badge-good">{firstIpoWord(ipo.company_name)}</span>
            <SmallIconButton onClick={() => unlinkIpo(ipo.id)} label={`Unlink ${ipo.company_name}`} tone="critical">
              <XIcon size={11} />
            </SmallIconButton>
          </div>
        ))}
        {company.watched_ipo_names.map((name, index) => (
          <div key={`${index}-${name}`} className="flex items-center gap-1.5">
            <input
              defaultValue={name}
              onBlur={(e) => renameAt(index, e.target.value)}
              disabled={saving}
              className="input h-8 flex-1 text-xs"
            />
            <div className="w-24 shrink-0">
              <Combobox
                aria-label={`Link ${name} to an IPO`}
                placeholder="Link…"
                searchPlaceholder="Search IPOs…"
                emptyLabel="No unlinked IPOs"
                value=""
                onChange={(ipoId) => linkAt(index, ipoId)}
                options={unlinkedIpoOptions}
                disabled={saving}
              />
            </div>
            <SmallIconButton onClick={() => removeAt(index)} label={`Delete ${name}`} tone="critical">
              <XIcon size={11} />
            </SmallIconButton>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              addName()
            }}
            placeholder="e.g. MCL or SECL"
            className="input h-8 flex-1 text-xs"
          />
          <button type="button" onClick={addName} disabled={saving || !newName.trim()} className="btn-primary h-8 px-3 text-xs">
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <p style={{ color: 'var(--ink-muted)' }}>{label}</p>
      <p className="font-mono-ipo font-medium" style={{ color: color ?? 'var(--ink-primary)' }}>
        {value}
      </p>
    </div>
  )
}

// memo, same reasoning as CompanyCard above — bankLabel/onChanged are now
// stable, so one row updating (e.g. marking it sold) doesn't force every
// other row in the same card to re-render too.
const HoldingRow = memo(function HoldingRow({
  holding,
  livePrice,
  holderName,
  bankLabel,
  onChanged,
}: {
  holding: ParentCompanyHolding
  livePrice: number | null
  holderName: string
  bankLabel: (bankId: string | null) => string
  onChanged: () => Promise<void>
}) {
  const [selling, setSelling] = useState(false)
  const [sellPrice, setSellPrice] = useState('')
  // Buy price, unlike sell price, isn't a one-way "lock it in" action — it's
  // a correction to a number that might've been mistyped or estimated at
  // add-holding time, so it stays editable regardless of HELD/SOLD status.
  const [editingPrice, setEditingPrice] = useState(false)
  const [editBuyPrice, setEditBuyPrice] = useState(String(holding.buy_price))
  const [submitting, setSubmitting] = useState(false)
  const pnl = computeHoldingPnl(holding, livePrice)

  async function markSold(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    const { error } = await supabase
      .from('parent_company_holdings')
      .update({ status: 'SOLD', sell_price: Number(sellPrice) })
      .eq('id', holding.id)
    setSubmitting(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    setSelling(false)
    onChanged()
  }

  async function saveBuyPrice(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    const { error } = await supabase
      .from('parent_company_holdings')
      .update({ buy_price: Number(editBuyPrice) })
      .eq('id', holding.id)
    setSubmitting(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    setEditingPrice(false)
    onChanged()
  }

  async function deleteHolding() {
    if (!(await confirmDialog(`Delete this holding for ${holderName}?`, { tone: 'critical', confirmLabel: 'Delete' }))) return
    const { error } = await supabase.from('parent_company_holdings').delete().eq('id', holding.id)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    onChanged()
  }

  return (
    <div className="border-t pt-1.5 text-sm" style={{ borderColor: 'var(--border)' }}>
      {/* One line: holder name, then (buy price / profit-loss) in brackets —
          quantity is only shown when it's not the default 1 (shareholder
          quota only ever needs 1 share, so a bare "1 sh ×" prefix on every
          row was just noise). Small icon-only buttons (h-6 w-6, not the
          site-wide 44px .icon-badge) on the right so both fit on the same
          line as the name instead of wrapping. */}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate" style={{ color: 'var(--ink-primary)' }}>
          {holderName}{' '}
          <span className="font-mono-ipo text-xs" style={{ color: pnl.pnl != null ? pnlColor(pnl.pnl) : 'var(--ink-muted)' }}>
            (₹{holding.buy_price.toLocaleString('en-IN')}
            {holding.quantity !== 1 && ` × ${holding.quantity}`}
            {pnl.pnl != null ? ` / ${signedRupees(pnl.pnl)}` : ' / —'})
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {holding.status === 'HELD' && (
            <SmallIconButton
              onClick={() => {
                setSelling((s) => !s)
                setEditingPrice(false)
              }}
              label="Mark sold"
              tone="neutral"
            >
              <CheckIcon size={11} />
            </SmallIconButton>
          )}
          <SmallIconButton
            onClick={() => {
              setEditBuyPrice(String(holding.buy_price))
              setEditingPrice((s) => !s)
              setSelling(false)
            }}
            label="Edit buy price"
            tone="neutral"
          >
            <PencilIcon size={11} />
          </SmallIconButton>
          <SmallIconButton onClick={deleteHolding} label="Delete holding" tone="critical">
            <TrashIcon size={11} />
          </SmallIconButton>
        </span>
      </div>
      <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
        Funded by {bankLabel(holding.funder_id)}
        {!holding.funder_id && holding.loss_bearer_id && ` · loss covered by ${bankLabel(holding.loss_bearer_id)}`}
        {holding.bought_at && ` · bought ${formatShortDate(holding.bought_at)}`}
      </p>
      {selling && (
        <form onSubmit={markSold} className="mt-1.5 flex items-center gap-2">
          <input
            required
            type="number"
            step="0.01"
            min={0}
            value={sellPrice}
            onChange={(e) => setSellPrice(e.target.value)}
            placeholder="Sell price per share"
            className="input h-8 flex-1 text-xs"
          />
          <button type="submit" disabled={submitting} className="btn-primary h-8 px-3 text-xs">
            {submitting ? 'Saving…' : 'Mark sold'}
          </button>
        </form>
      )}
      {editingPrice && (
        <form onSubmit={saveBuyPrice} className="mt-1.5 flex items-center gap-2">
          <input
            required
            type="number"
            step="0.01"
            min={0}
            value={editBuyPrice}
            onChange={(e) => setEditBuyPrice(e.target.value)}
            placeholder="Buy price per share"
            className="input h-8 flex-1 text-xs"
          />
          <button type="submit" disabled={submitting} className="btn-primary h-8 px-3 text-xs">
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
    </div>
  )
})

function AddHoldingForm({
  companyId,
  dematAccounts,
  bankAccounts,
  isMeAccount,
  onDone,
}: {
  companyId: string
  dematAccounts: DematAccount[]
  bankAccounts: BankAccount[]
  isMeAccount: (bankId: string | null) => boolean
  onDone: () => Promise<void>
}) {
  const [dematId, setDematId] = useState('')
  // Defaults to 1, not blank — a shareholder quota only ever requires
  // holding 1 share to qualify, so that's overwhelmingly the common case;
  // still editable for the rare multi-share purchase.
  const [quantity, setQuantity] = useState('1')
  const [buyPrice, setBuyPrice] = useState('')
  const [funderId, setFunderId] = useState('')
  // Defaults to the admin's own bank account, not blank — the common case
  // for a self-funded lot is the holder buying it on the admin's say-so,
  // with the admin still owing them if it drops. Still clearable/changeable
  // for a genuinely fully-self-funded purchase with no such arrangement.
  const [lossBearerId, setLossBearerId] = useState(() => bankAccounts.find((b) => isMeAccount(b.id))?.id ?? '')
  // Optional, unlike an application's applied_at — a holding is often
  // entered well after the actual purchase, and the exact date isn't always
  // known/worth tracking down, so this stays blank rather than forcing
  // today's date on a purchase that may have happened long before.
  const [boughtAt, setBoughtAt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const dematOptions = [...dematAccounts]
    .sort((a, b) => a.holder_name.localeCompare(b.holder_name, undefined, { sensitivity: 'base' }))
    .map((a) => ({ value: a.id, label: a.holder_name }))

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await supabase.from('parent_company_holdings').insert({
      parent_company_id: companyId,
      demat_id: dematId,
      quantity: Number(quantity),
      buy_price: Number(buyPrice),
      funder_id: funderId || null,
      loss_bearer_id: funderId ? null : lossBearerId || null,
      bought_at: boughtAt || null,
    })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    onDone()
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2 lg:grid-cols-3" style={{ borderColor: 'var(--border)' }}>
      <Field label="Account holder">
        <Combobox
          aria-label="Account holder"
          placeholder="Select account"
          searchPlaceholder="Search accounts…"
          value={dematId}
          onChange={setDematId}
          options={dematOptions}
        />
      </Field>
      {/* Grouped into one grid cell with its own 2-column layout so these
          two short numeric fields sit side by side even on a phone, instead
          of each claiming a full stacked row like the wider Combobox
          fields below need to — one less screen's worth of scrolling to
          add a holding on mobile. */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantity (shares)">
          <input required type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} className="input" />
        </Field>
        <Field label="Buy price / share">
          <input required type="number" step="0.01" min={0} value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)} className="input" />
        </Field>
      </div>
      <Field label="Funder">
        <Combobox
          aria-label="Funder"
          placeholder="Self-funded"
          searchPlaceholder="Search bank/UPI accounts…"
          value={funderId}
          onChange={setFunderId}
          options={bankOptions(bankAccounts, 'Self-funded')}
        />
      </Field>
      {!funderId && (
        <Field label="Loss covered by (optional)">
          <Combobox
            aria-label="Loss covered by"
            placeholder="None — holder bears their own loss"
            searchPlaceholder="Search bank/UPI accounts…"
            value={lossBearerId}
            onChange={setLossBearerId}
            options={bankOptions(bankAccounts, 'None — holder bears their own loss')}
          />
        </Field>
      )}
      <Field label="Date bought (optional)">
        <input type="date" value={boughtAt} onChange={(e) => setBoughtAt(e.target.value)} className="input" />
      </Field>
      <div className="flex items-end">
        <button type="submit" disabled={submitting || !dematId} className="btn-primary w-full">
          {submitting ? 'Saving…' : 'Add holding'}
        </button>
      </div>
      {error && <p className="col-span-full text-xs" style={{ color: 'var(--critical-text)' }}>{error}</p>}
    </form>
  )
}
