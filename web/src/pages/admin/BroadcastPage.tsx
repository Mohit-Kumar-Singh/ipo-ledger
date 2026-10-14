import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertIcon,
  CheckIcon,
  MegaphoneIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
} from '@primer/octicons-react'
import { useAuth } from '../../contexts/AuthContext'
import { describeFunctionError, supabase } from '../../lib/supabase'
import { showToast } from '../../lib/toast'
import { friendlyError } from '../../lib/friendlyError'
import { confirmDialog } from '../../lib/confirmDialog'
import { normalizeIndianPhoneDigits } from '../../lib/phone'
import { sendCustomWhatsapp } from '../../lib/dispatchWhatsapp'
import { useDematAccounts, useIpos, queryKeys } from '../../lib/queries'
import { formatShortDate } from '../../lib/formatDate'
import { isOpenForBidding } from '../../lib/ipoStatus'
import { estimateLotProfit } from '../../lib/lotProfitEstimate'
import type { DematAccount, Ipo } from '../../types/database'

const PHONE_RE = /^[0-9]{10}$/
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

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

  // Open-for-bidding IPOs first, then the rest by most recent open date.
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
  const [manageOpen, setManageOpen] = useState(false)

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

  // "Not applying" ticks, for the selected IPO only.
  const notApplyingKey = ['broadcast-not-applying', ipo?.id ?? null] as const
  const notApplyingQuery = useQuery<Set<string>>({
    queryKey: notApplyingKey,
    enabled: isAdmin && !!ipo,
    queryFn: async () => {
      const { data, error } = await supabase.from('broadcast_not_applying').select('contact_id').eq('ipo_id', ipo!.id)
      if (error) throw error
      return new Set((data ?? []).map((r) => r.contact_id as string))
    },
  })
  const notApplying = notApplyingQuery.data ?? new Set<string>()

  // Demat accounts that already have an application for this IPO — those
  // people have applied, so they never belong in "yet to apply".
  const appliedQuery = useQuery<Set<string>>({
    queryKey: ['broadcast-applied', ipo?.id ?? null],
    enabled: isAdmin && !!ipo,
    queryFn: async () => {
      const { data, error } = await supabase.from('applications').select('demat_id').eq('ipo_id', ipo!.id)
      if (error) throw error
      return new Set((data ?? []).map((r) => r.demat_id as string))
    },
  })
  const appliedDemat = appliedQuery.data ?? new Set<string>()

  const toggleNotApplying = useMutation({
    mutationFn: async ({ contactId, mark }: { contactId: string; mark: boolean }) => {
      if (!ipo) return
      if (mark) {
        const { error } = await supabase.from('broadcast_not_applying').insert({ contact_id: contactId, ipo_id: ipo.id })
        if (error && error.code !== '23505') throw error
      } else {
        const { error } = await supabase
          .from('broadcast_not_applying')
          .delete()
          .eq('contact_id', contactId)
          .eq('ipo_id', ipo.id)
        if (error) throw error
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['broadcast-not-applying'] }),
    onError: (err) => showToast(friendlyError(err, `Couldn't save that tick. Try again.`), 'critical'),
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

  // Not applying + we hold both PAN and BO ID + hasn't applied yet.
  const yetToApply = contacts.filter((c) => {
    if (!notApplying.has(c.id)) return false
    const account = accountByPhone.get(c.phone_e164)
    return !!account?.dp_client_id && !appliedDemat.has(account.id)
  })

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-md p-4 text-sm" style={{ color: 'var(--ink-muted)' }}>
        Only admins can use Broadcast.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Broadcast</h1>
          <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Tell people about an IPO on WhatsApp and see who is ready to apply.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="icon-btn"
            aria-label={nextUnsent ? `Send to next person (${remaining} left)` : 'Everyone has been opened'}
            title={nextUnsent ? `Send to next (${remaining} left)` : 'Everyone opened'}
            onClick={() => nextUnsent && send(nextUnsent)}
            disabled={!nextUnsent || !message.trim()}
            style={!nextUnsent || !message.trim() ? { opacity: 0.5 } : undefined}
          >
            <MegaphoneIcon size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Add, edit or remove people"
            title="Manage people"
            onClick={() => setManageOpen(true)}
          >
            <PencilIcon size={16} />
          </button>
        </div>
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
              rows={8}
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

      {/* Yet to apply (for this IPO) */}
      {ipo && (
        <div className="card space-y-2 p-4">
          <p className="section-label">Yet to apply — {ipo.company_name}</p>
          {yetToApply.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              Nobody yet. People appear here once you tick them as not applying and their PAN and BO ID are in Accounts.
            </p>
          ) : (
            <ul className="divide-y">
              {yetToApply.map((c) => {
                const account = accountByPhone.get(c.phone_e164)
                return (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {c.name}
                    </span>
                    <span className="font-mono-ipo shrink-0 text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {account?.dp_client_id}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {/* People — scrolls inside its own panel */}
      <div className="card p-4">
        <p className="section-label mb-2">People ({contacts.length})</p>
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
            No one yet — tap the pencil at the top to add people.
          </p>
        ) : (
          <ul className="max-h-[55vh] divide-y overflow-y-auto">
            {contacts.map((c) => {
              const account = accountByPhone.get(c.phone_e164)
              const hasBo = !!account?.dp_client_id
              const ready = !!account && hasBo
              const missing = !account ? 'PAN and BO ID' : 'BO ID'
              const isNotApplying = notApplying.has(c.id)
              return (
                <li key={c.id} className="flex items-center gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {c.name}
                      {sent.has(c.id) && <span className="badge badge-info ml-2 align-middle text-[10px]">Opened</span>}
                    </p>
                    <p className="font-mono-ipo truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {c.phone_e164.replace(/^\+91/, '+91 ')}
                    </p>
                  </div>

                  {ready ? (
                    <span title="PAN and BO ID on file" aria-label="PAN and BO ID on file" className="p-1.5">
                      <ShieldCheckIcon size={18} fill="var(--good)" />
                    </span>
                  ) : (
                    <button
                      type="button"
                      title={`${missing} missing — tap to add`}
                      aria-label={`${missing} missing — tap to add`}
                      className="p-1.5"
                      onClick={() => (account ? navigate(`/accounts?edit=${account.id}`) : setManageOpen(true))}
                    >
                      <AlertIcon size={18} fill="var(--warning)" />
                    </button>
                  )}

                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isNotApplying}
                    aria-label={isNotApplying ? `${c.name} is not applying — untick` : `Mark ${c.name} as not applying`}
                    title="Not applying — I'll apply for them"
                    disabled={!ipo || toggleNotApplying.isPending}
                    onClick={() => toggleNotApplying.mutate({ contactId: c.id, mark: !isNotApplying })}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border disabled:opacity-50"
                    style={{
                      borderColor: isNotApplying ? 'var(--accent)' : 'var(--border-strong)',
                      background: isNotApplying ? 'var(--accent)' : 'transparent',
                    }}
                  >
                    {isNotApplying && <CheckIcon size={14} fill="white" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => send(c)}
                    disabled={!message.trim()}
                    className="btn-secondary shrink-0 text-xs disabled:opacity-50"
                  >
                    Send
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {manageOpen && (
        <ManagePeople
          contacts={contacts}
          accountByPhone={accountByPhone}
          onClose={() => setManageOpen(false)}
          onOpenAccount={(id) => navigate(`/accounts?edit=${id}`)}
        />
      )}
    </div>
  )
}

function ManagePeople({
  contacts,
  accountByPhone,
  onClose,
  onOpenAccount,
}: {
  contacts: BroadcastContact[]
  accountByPhone: Map<string, DematAccount>
  onClose: () => void
  onOpenAccount: (dematId: string) => void
}) {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [digits, setDigits] = useState('')
  const [pan, setPan] = useState('')
  const [boId, setBoId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const account = PHONE_RE.test(digits) ? accountByPhone.get(`+91${digits}`) : undefined

  // A number that's already in Accounts: fill the name from there instead
  // of asking for it (and never ask for the PAN again).
  useEffect(() => {
    if (account && !name.trim() && !editingId) setName(account.holder_name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id])

  function reset() {
    setEditingId(null)
    setName('')
    setDigits('')
    setPan('')
    setBoId('')
    setError(null)
  }

  function startEdit(c: BroadcastContact) {
    setEditingId(c.id)
    setName(c.name)
    setDigits(c.phone_e164.replace(/^\+91/, ''))
    setPan('')
    setBoId('')
    setError(null)
  }

  async function save() {
    setError(null)
    const trimmed = name.trim()
    if (!trimmed) return setError('Enter a name.')
    if (!PHONE_RE.test(digits)) return setError('Phone number must be exactly 10 digits.')

    const panUpper = pan.trim().toUpperCase()
    const wantsAccount = !account && (panUpper || boId.trim())
    if (wantsAccount) {
      if (!PAN_RE.test(panUpper)) {
        return setError('To save PAN / BO ID to Accounts, enter a valid PAN (like ABCPD1234E).')
      }
    }

    setSaving(true)
    try {
      if (wantsAccount) {
        const { data, error: fnError } = await supabase.functions.invoke<{ id?: string; error?: string }>('add-demat', {
          body: {
            holder_name: trimmed,
            phone_digits: digits,
            pan: panUpper,
            dp_client_id: boId.trim() || null,
            profit_share_percent: 25,
          },
        })
        if (fnError || !data?.id) {
          setError(await describeFunctionError(fnError, data ?? null))
          return
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.dematAccounts })
      }

      const row = { name: trimmed, phone_e164: `+91${digits}` }
      const { error: dbError } = editingId
        ? await supabase.from('broadcast_contacts').update(row).eq('id', editingId)
        : await supabase.from('broadcast_contacts').insert(row)
      if (dbError) {
        setError(
          dbError.code === '23505'
            ? 'That number is already on your broadcast list.'
            : friendlyError(dbError, `Couldn't save that person.`),
        )
        return
      }
      await queryClient.invalidateQueries({ queryKey: ['broadcast-contacts'] })
      showToast(editingId ? 'Person updated.' : 'Person added.', 'good')
      reset()
    } finally {
      setSaving(false)
    }
  }

  async function remove(c: BroadcastContact) {
    if (!(await confirmDialog(`Remove ${c.name} from the broadcast list? Their account details are not deleted.`, { confirmLabel: 'Remove', tone: 'critical' }))) {
      return
    }
    const { error: dbError } = await supabase.from('broadcast_contacts').delete().eq('id', c.id)
    if (dbError) {
      showToast(friendlyError(dbError, `Couldn't remove that person.`), 'critical')
      return
    }
    if (editingId === c.id) reset()
    await queryClient.invalidateQueries({ queryKey: ['broadcast-contacts'] })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div
        className="card w-full max-w-lg space-y-4 p-5"
        style={{ borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow-lg)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Manage people
          </h2>
          <button type="button" onClick={onClose} className="text-sm hover:underline" style={{ color: 'var(--ink-muted)' }}>
            Close
          </button>
        </div>

        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <p className="section-label">{editingId ? 'Edit person' : 'Add person'}</p>
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

          {account ? (
            <div className="rounded-lg p-3 text-xs" style={{ background: 'var(--hover-surface)', color: 'var(--ink-secondary)' }}>
              <p className="font-medium" style={{ color: 'var(--good)' }}>
                Found in Accounts — {account.holder_name}
              </p>
              <p>
                PAN {account.pan_masked} · BO ID {account.dp_client_id ?? 'not added'}
              </p>
              {!account.dp_client_id && (
                <button type="button" className="link-accent mt-1 font-medium" onClick={() => onOpenAccount(account.id)}>
                  Add BO ID in Accounts
                </button>
              )}
            </div>
          ) : (
            <>
              <input
                value={pan}
                onChange={(e) => setPan(e.target.value.toUpperCase().slice(0, 10))}
                className="input font-mono-ipo"
                placeholder="PAN (optional) — saved to Accounts"
                autoCapitalize="characters"
              />
              <input
                value={boId}
                onChange={(e) => setBoId(e.target.value.trim())}
                className="input font-mono-ipo"
                placeholder="BO ID / demat no (optional) — saved to Accounts"
              />
            </>
          )}

          {error && (
            <p className="text-xs" style={{ color: 'var(--critical)' }}>
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-3">
            {editingId && (
              <button type="button" onClick={reset} className="text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
                Cancel edit
              </button>
            )}
            <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2 text-sm disabled:opacity-50">
              {!editingId && <PlusIcon size={14} />}
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add to list'}
            </button>
          </div>
        </form>

        <div className="border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          <p className="section-label mb-1">On your list ({contacts.length})</p>
          {contacts.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              No one yet.
            </p>
          ) : (
            <ul className="max-h-64 divide-y overflow-y-auto">
              {contacts.map((c) => (
                <li key={c.id} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                      {c.name}
                    </p>
                    <p className="font-mono-ipo truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                      {c.phone_e164.replace(/^\+91/, '+91 ')}
                    </p>
                  </div>
                  <button type="button" aria-label={`Edit ${c.name}`} className="p-1.5" onClick={() => startEdit(c)}>
                    <PencilIcon size={16} fill="var(--ink-muted)" />
                  </button>
                  <button type="button" aria-label={`Remove ${c.name}`} className="p-1.5" onClick={() => void remove(c)}>
                    <TrashIcon size={16} fill="var(--critical-text)" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
