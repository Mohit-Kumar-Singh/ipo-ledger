import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, MegaphoneIcon, PlusIcon, TrashIcon, XIcon } from '@primer/octicons-react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { showToast } from '../../lib/toast'
import { friendlyError } from '../../lib/friendlyError'
import { normalizeIndianPhoneDigits } from '../../lib/phone'
import { sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { saveDraft } from '../../lib/formDraft'
import { useDematAccounts, useIpos } from '../../lib/queries'
import { formatShortDate } from '../../lib/formatDate'
import { isOpenForBidding } from '../../lib/ipoStatus'
import { estimateLotProfit } from '../../lib/lotProfitEstimate'
import type { DematAccount, Ipo } from '../../types/database'

const PHONE_RE = /^[0-9]{10}$/
const ADD_DEMAT_DRAFT_KEY = 'draft:add-demat'

interface BroadcastContact {
  id: string
  name: string
  phone_e164: string
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

// The message the admin shares for one IPO: name, price, dates, profit
// chances, then the "are you applying?" question. {name} is swapped per
// person at send time.
function buildMessage(ipo: Ipo): string {
  const lines: string[] = [`Hi {name}, 📢 *${ipo.company_name}* IPO — are you applying?`, '']

  if (ipo.price_low != null || ipo.price_high != null) {
    const band =
      ipo.price_low != null && ipo.price_high != null && ipo.price_low !== ipo.price_high
        ? `${inr(ipo.price_low)} – ${inr(ipo.price_high)}`
        : inr((ipo.price_high ?? ipo.price_low) as number)
    lines.push(`💰 Price: ${band} per share`)
    if (ipo.price_high != null && ipo.lot_size > 0) {
      lines.push(`📦 1 lot = ${ipo.lot_size} shares ≈ ${inr(ipo.price_high * ipo.lot_size)}`)
    }
  } else {
    lines.push('💰 Price band: not announced yet')
  }

  lines.push(`📅 Opens ${formatShortDate(ipo.open_date)} · Closes ${formatShortDate(ipo.close_date)}`)
  if (ipo.allotment_date) lines.push(`🧾 Allotment ${formatShortDate(ipo.allotment_date)}`)
  if (ipo.listing_date) lines.push(`📈 Listing ${formatShortDate(ipo.listing_date)}`)

  const est = estimateLotProfit(ipo.price_high, ipo.lot_size, ipo.gmp_notes)
  if (est) {
    const sign = est.grossProfit >= 0 ? '+' : '−'
    lines.push(
      `🔥 Profit chances: GMP ${est.gmpPercent}% → about ${sign}${inr(Math.abs(est.grossProfit))} per lot (estimate, not guaranteed)`,
    )
  } else if (ipo.gmp_notes) {
    lines.push(`🔥 Profit chances: ${ipo.gmp_notes}`)
  } else {
    lines.push('🔥 Profit chances: GMP not available yet')
  }

  lines.push(
    '',
    'Are you applying or not? Please reply YES or NO.',
    "If you're not applying, I can apply from your account — please keep your BO ID and PAN ready.",
  )
  return lines.join('\n')
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`badge ${ok ? 'badge-good' : 'badge-warning'} inline-flex items-center gap-1 text-[10px]`}>
      {ok ? <CheckIcon size={10} /> : <XIcon size={10} />}
      {label}
    </span>
  )
}

export function BroadcastPage() {
  const { session, profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const userId = session?.user.id ?? null

  const contactsQuery = useQuery<BroadcastContact[]>({
    queryKey: ['broadcast-contacts', userId],
    enabled: !!userId && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('broadcast_contacts')
        .select('id, name, phone_e164')
        .order('name', { ascending: true })
      if (error) throw error
      return (data ?? []) as BroadcastContact[]
    },
  })
  const contacts = contactsQuery.data ?? []

  const iposQuery = useIpos(isAdmin)
  const dematQuery = useDematAccounts(isAdmin)

  // Open-for-bidding IPOs first, then the rest by soonest open date.
  const ipos = useMemo(() => {
    const list = (iposQuery.data ?? []).filter((i) => !i.is_archived)
    return [...list].sort((a, b) => {
      const ao = isOpenForBidding(a) ? 0 : 1
      const bo = isOpenForBidding(b) ? 0 : 1
      return ao - bo || b.open_date.localeCompare(a.open_date)
    })
  }, [iposQuery.data])

  const [ipoId, setIpoId] = useState('')
  const ipo = ipos.find((i) => i.id === ipoId) ?? ipos[0] ?? null
  const [message, setMessage] = useState('')
  const [edited, setEdited] = useState(false)
  const [sent, setSent] = useState<Set<string>>(new Set())

  // Re-write the message whenever a different IPO is picked (or its data
  // changes) — unless the admin has started editing the text by hand.
  const generated = useMemo(() => (ipo ? buildMessage(ipo) : ''), [ipo])
  useEffect(() => {
    if (!edited) setMessage(generated)
  }, [generated, edited])

  // Phone -> demat account, preferring one that already has a BO ID.
  const accountByPhone = useMemo(() => {
    const map = new Map<string, DematAccount>()
    for (const a of dematQuery.data ?? []) {
      const prev = map.get(a.phone_e164)
      if (!prev || (!prev.dp_client_id && a.dp_client_id)) map.set(a.phone_e164, a)
    }
    return map
  }, [dematQuery.data])

  const [name, setName] = useState('')
  const [digits, setDigits] = useState('')
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['broadcast-contacts'] })

  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('broadcast_contacts').insert({ name: name.trim(), phone_e164: `+91${digits}` })
      if (error) throw error
    },
    onSuccess: () => {
      setName('')
      setDigits('')
      invalidate()
    },
    onError: (err: { code?: string }) =>
      showToast(
        err?.code === '23505' ? 'That number is already on your broadcast list.' : friendlyError(err, `Couldn't add that person.`),
        'critical',
      ),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('broadcast_contacts').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => showToast(friendlyError(err, `Couldn't remove that person.`), 'critical'),
  })

  function textFor(c: BroadcastContact): string {
    return message.trim().replace(/\{name\}/gi, c.name.trim().split(/\s+/)[0] ?? '')
  }

  function send(c: BroadcastContact) {
    if (!message.trim()) return
    setSent((prev) => new Set(prev).add(c.id))
    sendCustomWhatsapp(c.phone_e164, textFor(c))
  }

  const nextUnsent = contacts.find((c) => !sent.has(c.id))
  const remaining = contacts.filter((c) => !sent.has(c.id)).length

  // No account yet: open the normal Add account form with name + phone
  // already filled in (it restores from this draft on load).
  function addDetails(c: BroadcastContact) {
    saveDraft(ADD_DEMAT_DRAFT_KEY, { holderName: c.name, phoneDigits: c.phone_e164.replace(/^\+91/, '') })
    navigate('/accounts')
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-md p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
        Only admins can use Broadcast.
      </div>
    )
  }

  const canAdd = name.trim().length > 0 && PHONE_RE.test(digits) && !add.isPending

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Broadcast</h1>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Tell people about an IPO on WhatsApp and see who is ready to apply.
          </p>
        </div>
        <button
          type="button"
          onClick={() => nextUnsent && send(nextUnsent)}
          disabled={!nextUnsent || !message.trim()}
          className="btn-primary flex shrink-0 items-center gap-2 text-sm disabled:opacity-50"
        >
          <MegaphoneIcon size={16} />
          {nextUnsent ? `Send to next (${remaining} left)` : 'All opened'}
        </button>
      </div>

      {/* Message */}
      <div className="card space-y-3 p-4">
        <p className="section-label">Message</p>
        {ipos.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            No IPOs yet — add or import one on the IPOs page first.
          </p>
        ) : (
          <>
            <select
              className="input w-full"
              value={ipo?.id ?? ''}
              onChange={(e) => {
                setIpoId(e.target.value)
                setEdited(false)
                setSent(new Set())
              }}
            >
              {ipos.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.company_name}
                  {isOpenForBidding(i) ? ' — open now' : ''}
                </option>
              ))}
            </select>
            <textarea
              value={message}
              onChange={(e) => {
                setMessage(e.target.value)
                setEdited(true)
              }}
              rows={10}
              className="input w-full resize-y text-sm"
            />
            <div className="flex items-center justify-between gap-3 text-xs" style={{ color: 'var(--ink-muted)' }}>
              <span>{'{name}'} becomes each person's first name.</span>
              {edited && (
                <button
                  type="button"
                  className="link-accent font-medium"
                  onClick={() => {
                    setEdited(false)
                    setMessage(generated)
                  }}
                >
                  Reset message
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* People */}
      <div className="card space-y-3 p-4">
        <p className="section-label">People ({contacts.length})</p>

        {contactsQuery.isPending ? (
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Loading…
          </p>
        ) : contactsQuery.isError ? (
          <p className="text-xs" style={{ color: 'var(--critical)' }}>
            Couldn't load your broadcast list. Pull down to refresh and try again.
          </p>
        ) : contacts.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            No one yet — add a name and phone number below.
          </p>
        ) : (
          <ul className="divide-y">
            {contacts.map((c) => {
              const account = accountByPhone.get(c.phone_e164)
              const hasPan = !!account
              const hasBo = !!account?.dp_client_id
              return (
                <li key={c.id} className="space-y-2 py-3">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                        {c.name}
                        {sent.has(c.id) && <span className="badge badge-info ml-2 align-middle text-[10px]">Opened</span>}
                      </p>
                      <p className="font-mono-ipo truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {c.phone_e164.replace(/^\+91/, '+91 ')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => send(c)}
                      disabled={!message.trim()}
                      className="btn-secondary shrink-0 text-xs disabled:opacity-50"
                    >
                      Send
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${c.name}`}
                      onClick={() => remove.mutate(c.id)}
                      disabled={remove.isPending}
                      className="p-1.5 disabled:opacity-50"
                    >
                      <TrashIcon size={16} fill="var(--critical-text)" />
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip ok={hasBo} label="BO ID" />
                    <Chip ok={hasPan} label="PAN" />
                    {hasBo && hasPan ? (
                      <span className="text-xs font-medium" style={{ color: 'var(--good)' }}>
                        Ready to apply
                      </span>
                    ) : !account ? (
                      <button type="button" onClick={() => addDetails(c)} className="link-accent text-xs font-medium">
                        Add details
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => navigate(`/accounts?edit=${account.id}`)}
                        className="link-accent text-xs font-medium"
                      >
                        Add BO ID
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        <form
          className="space-y-2 border-t pt-3"
          style={{ borderColor: 'var(--border)' }}
          onSubmit={(e) => {
            e.preventDefault()
            if (canAdd) add.mutate()
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Name" />
          <div className="flex items-center gap-2">
            <span
              className="rounded-md border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-muted)' }}
            >
              +91
            </span>
            <input
              inputMode="numeric"
              value={digits}
              onChange={(e) => setDigits(normalizeIndianPhoneDigits(e.target.value))}
              className="input"
              placeholder="9876543210"
            />
          </div>
          {digits.length > 0 && !PHONE_RE.test(digits) && (
            <p className="text-xs" style={{ color: 'var(--critical)' }}>
              Must be exactly 10 digits.
            </p>
          )}
          <button
            type="submit"
            disabled={!canAdd}
            className="btn-primary flex w-full items-center justify-center gap-2 text-sm disabled:opacity-50"
          >
            <PlusIcon size={14} />
            {add.isPending ? 'Adding…' : 'Add to list'}
          </button>
        </form>
      </div>
    </div>
  )
}
