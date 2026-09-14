import { memo, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, PencilIcon, TrashIcon, XIcon } from '@primer/octicons-react'
import { supabase } from '../../lib/supabase'
import { useParentCompanies, useDematAccounts, useBankAccounts, queryKeys } from '../../lib/queries'
import { useAuth } from '../../contexts/AuthContext'
import { showToast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirmDialog'
import { Combobox } from '../../components/Combobox'
import { rupees } from '../../lib/expectedProfit'
import { sameIdentity } from '../../lib/applicationAttribution'
import { computeHoldingPnl, summarizeCompanyHoldings } from '../../lib/parentCompanyPnl'
import { InlineSpinner } from '../../components/PageSpinner'
import type { BankAccount, DematAccount, ParentCompany, ParentCompanyHolding } from '../../types/database'

const HOLDINGS_QUERY_KEY = ['parent_company_holdings'] as const

// Module-level, not `?? []` inline — a fresh array literal on every render
// (while a query is still pending) is a different reference each time,
// which defeats useMemo's dependency check below. Same fix ApplicationsPage
// already uses for its own EMPTY_APPLICATIONS fallback.
const EMPTY_DEMAT_ACCOUNTS: DematAccount[] = []
const EMPTY_BANK_ACCOUNTS: BankAccount[] = []
const EMPTY_HOLDINGS: ParentCompanyHolding[] = []

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
  const companies = useMemo(
    () => [...(companiesQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [companiesQuery.data],
  )
  const dematAccounts = dematQuery.data ?? EMPTY_DEMAT_ACCOUNTS
  const bankAccounts = bankQuery.data ?? EMPTY_BANK_ACCOUNTS

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
  // skip re-rendering cards nothing changed about.
  const reload = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.parentCompanies }),
      queryClient.invalidateQueries({ queryKey: HOLDINGS_QUERY_KEY }),
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

  const [showAddCompany, setShowAddCompany] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSymbol, setNewSymbol] = useState('')
  const [savingCompany, setSavingCompany] = useState(false)

  async function addCompany(e: FormEvent) {
    e.preventDefault()
    setSavingCompany(true)
    const { error } = await supabase
      .from('parent_companies')
      .insert({ name: newName.trim(), symbol: newSymbol.trim().toUpperCase() || null })
    setSavingCompany(false)
    if (error) {
      showToast(error.message, 'critical')
      return
    }
    setNewName('')
    setNewSymbol('')
    setShowAddCompany(false)
    reload()
  }

  // holdingsQuery is included deliberately — it was missing before, which let
  // company cards render before their holdings arrived (a beat after
  // companies/demat/bank loaded, since it's the one query with no shared
  // warm cache from other pages), flashing "No holdings recorded yet." right
  // before the real list popped in on every fresh visit to this page.
  const loading = companiesQuery.isPending || dematQuery.isPending || bankQuery.isPending || holdingsQuery.isPending

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--ink-primary)' }}>
            Shareholder Quota
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-muted)' }}>
            Parent companies your accounts already hold shares in — pick one on an IPO's edit page to unlock its shareholder-quota eligibility.
          </p>
        </div>
        <button onClick={() => setShowAddCompany((s) => !s)} className="btn-primary">
          {showAddCompany ? 'Cancel' : '+ Add company'}
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

      {companies.map((company) => (
        <CompanyCard
          key={company.id}
          company={company}
          holdings={holdingsByCompany.get(company.id) ?? EMPTY_HOLDINGS}
          livePrice={company.symbol ? livePrices[company.symbol]?.price ?? null : null}
          priceStale={company.symbol ? (livePrices[company.symbol]?.stale ?? false) : false}
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

// memo, not a plain function — every field above it (isMeAccount, bankLabel,
// onChanged, dematNameById) is now a stable reference across renders of the
// parent page, so this actually skips re-rendering a card when nothing
// about that specific company changed (e.g. typing in a sibling card's own
// add-holding form, which only updates that sibling's local state).
const CompanyCard = memo(function CompanyCard({
  company,
  holdings,
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

  const summary = useMemo(
    () => summarizeCompanyHoldings(holdings, livePrice, isMeAccount),
    [holdings, livePrice, isMeAccount],
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
        <form onSubmit={saveEdit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Company name">
            <input required value={editName} onChange={(e) => setEditName(e.target.value)} className="input" />
          </Field>
          <Field label="NSE symbol">
            <input value={editSymbol} onChange={(e) => setEditSymbol(e.target.value)} className="input" />
          </Field>
          <div className="flex items-end gap-2">
            <button type="submit" disabled={saving} className="btn-primary flex-1">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="input" aria-label="Cancel edit">
              <XIcon size={14} />
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
              {company.name}
            </h2>
            <p className="mt-0.5 font-mono-ipo text-xs" style={{ color: 'var(--ink-muted)' }}>
              {company.symbol ?? 'No symbol set'}
              {livePrice != null && ` · ₹${livePrice.toLocaleString('en-IN')}`}
              {priceStale && ' (stale)'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => {
                setEditName(company.name)
                setEditSymbol(company.symbol ?? '')
                setEditing(true)
              }}
              className="icon-badge icon-badge-neutral"
              aria-label="Edit company"
            >
              <PencilIcon size={13} />
            </button>
            <button onClick={deleteCompany} className="icon-badge icon-badge-critical" aria-label="Delete company">
              <TrashIcon size={13} />
            </button>
          </div>
        </div>
      )}

      <WatchedIposRow company={company} onChanged={onChanged} />

      {holdings.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-b py-2.5 text-xs sm:grid-cols-4" style={{ borderColor: 'var(--border)' }}>
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
      {summary.holderGains.length > 0 && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
          Holder gains:{' '}
          {summary.holderGains
            .map((g) => `${dematNameById.get(g.dematId) ?? 'Account holder'} ${signedRupees(g.pnl)}`)
            .join(', ')}
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

      <button onClick={() => setShowAddHolding((s) => !s)} className="mt-3 text-xs font-medium link-accent">
        {showAddHolding ? 'Cancel' : '+ Add holding'}
      </button>

      {showAddHolding && (
        <AddHoldingForm
          companyId={company.id}
          dematAccounts={dematAccounts}
          bankAccounts={bankAccounts}
          onDone={async () => {
            setShowAddHolding(false)
            await onChanged()
          }}
        />
      )}
    </div>
  )
})

// Upcoming/watched IPO names a parent company's quota could apply to — e.g.
// Coal India shareholders being separately eligible for both an "MCL" and a
// "SECL" IPO, neither of which need exist as a real ipos row yet. Plain
// labels stored on the company itself (parent_companies.watched_ipo_names,
// migration 0098), shown as removable chips with a small add form below.
function WatchedIposRow({ company, onChanged }: { company: ParentCompany; onChanged: () => Promise<void> }) {
  const [adding, setAdding] = useState(false)
  const [newIpoName, setNewIpoName] = useState('')
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

  async function addIpo(e: FormEvent) {
    e.preventDefault()
    const name = newIpoName.trim()
    if (!name) return
    setNewIpoName('')
    setAdding(false)
    await saveNames([...company.watched_ipo_names, name])
  }

  async function removeIpo(name: string) {
    await saveNames(company.watched_ipo_names.filter((n) => n !== name))
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {company.watched_ipo_names.map((name) => (
        <span key={name} className="badge badge-info inline-flex items-center gap-1">
          {name}
          <button onClick={() => removeIpo(name)} disabled={saving} aria-label={`Remove ${name}`} className="disabled:opacity-50">
            <XIcon size={11} />
          </button>
        </span>
      ))}
      {adding ? (
        <form onSubmit={addIpo} className="flex items-center gap-1.5">
          <input
            autoFocus
            value={newIpoName}
            onChange={(e) => setNewIpoName(e.target.value)}
            onBlur={() => {
              if (!newIpoName.trim()) setAdding(false)
            }}
            placeholder="e.g. MCL or SECL"
            className="input h-7 w-36 text-xs"
          />
          <button type="submit" disabled={saving} className="btn-primary h-7 px-2 text-xs">
            Add
          </button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs font-medium link-accent">
          + Add IPO
        </button>
      )}
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span style={{ color: 'var(--ink-primary)' }}>
          {holderName}
          <span className="ml-1.5 font-mono-ipo text-xs" style={{ color: 'var(--ink-muted)' }}>
            {holding.quantity} sh × ₹{holding.buy_price.toLocaleString('en-IN')}
          </span>
        </span>
        <span className="flex items-center gap-2 font-mono-ipo text-xs">
          {pnl.pnl != null ? (
            <span style={{ color: pnlColor(pnl.pnl) }}>
              {holding.status === 'SOLD' ? 'Sold' : 'Unrealized'} {signedRupees(pnl.pnl)}
            </span>
          ) : (
            <span style={{ color: 'var(--ink-muted)' }}>No live price</span>
          )}
          {holding.status === 'HELD' && (
            <button onClick={() => setSelling((s) => !s)} className="icon-badge icon-badge-neutral" aria-label="Mark sold">
              <CheckIcon size={12} />
            </button>
          )}
          <button onClick={deleteHolding} className="icon-badge icon-badge-critical" aria-label="Delete holding">
            <TrashIcon size={12} />
          </button>
        </span>
      </div>
      <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
        Funded by {bankLabel(holding.funder_id)}
        {!holding.funder_id && holding.loss_bearer_id && ` · loss covered by ${bankLabel(holding.loss_bearer_id)}`}
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
    </div>
  )
})

function AddHoldingForm({
  companyId,
  dematAccounts,
  bankAccounts,
  onDone,
}: {
  companyId: string
  dematAccounts: DematAccount[]
  bankAccounts: BankAccount[]
  onDone: () => Promise<void>
}) {
  const [dematId, setDematId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [buyPrice, setBuyPrice] = useState('')
  const [funderId, setFunderId] = useState('')
  const [lossBearerId, setLossBearerId] = useState('')
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
      <div className="flex items-end">
        <button type="submit" disabled={submitting || !dematId} className="btn-primary w-full">
          {submitting ? 'Saving…' : 'Add holding'}
        </button>
      </div>
      {error && <p className="col-span-full text-xs" style={{ color: 'var(--critical-text)' }}>{error}</p>}
    </form>
  )
}
