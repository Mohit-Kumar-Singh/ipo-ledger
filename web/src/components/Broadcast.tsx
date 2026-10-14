import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MegaphoneIcon, PlusIcon, TrashIcon } from '@primer/octicons-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { showToast } from '../lib/toast'
import { friendlyError } from '../lib/friendlyError'
import { normalizeIndianPhoneDigits } from '../lib/phone'
import { sendCustomWhatsapp } from '../lib/dispatchWhatsapp'

const PHONE_RE = /^[0-9]{10}$/

export interface BroadcastContact {
  id: string
  name: string
  phone_e164: string
}

function useBroadcastContacts() {
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  return useQuery<BroadcastContact[]>({
    queryKey: ['broadcast-contacts', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('broadcast_contacts')
        .select('id, name, phone_e164')
        .order('name', { ascending: true })
      if (error) throw error
      return (data ?? []) as BroadcastContact[]
    },
  })
}

// The list itself: add / remove people. Lives on the Profile page.
export function BroadcastListCard() {
  const queryClient = useQueryClient()
  const { session } = useAuth()
  const query = useBroadcastContacts()
  const [name, setName] = useState('')
  const [digits, setDigits] = useState('')

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['broadcast-contacts'] })

  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('broadcast_contacts')
        .insert({ name: name.trim(), phone_e164: `+91${digits}` })
      if (error) throw error
    },
    onSuccess: () => {
      setName('')
      setDigits('')
      invalidate()
    },
    onError: (err: { code?: string }) => {
      showToast(
        err?.code === '23505'
          ? 'That number is already on your broadcast list.'
          : friendlyError(err, `Couldn't add that person.`),
        'critical',
      )
    },
  })

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('broadcast_contacts').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => showToast(friendlyError(err, `Couldn't remove that person.`), 'critical'),
  })

  const contacts = query.data ?? []
  const canAdd = name.trim().length > 0 && PHONE_RE.test(digits) && !add.isPending && !!session

  return (
    <div className="card animate-page-in space-y-3 p-4">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
          <MegaphoneIcon size={16} fill="var(--accent)" />
          Broadcast list
        </p>
        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          People you message together. Tap the megaphone at the top of this page to send them a WhatsApp message.
        </p>
      </div>

      {query.isLoading ? (
        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          Loading…
        </p>
      ) : query.isError ? (
        <p className="text-xs" style={{ color: 'var(--critical)' }}>
          Couldn't load your broadcast list. Pull down to refresh and try again.
        </p>
      ) : contacts.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          No one yet — add a name and phone number below.
        </p>
      ) : (
        <ul className="divide-y">
          {contacts.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" style={{ color: 'var(--ink-primary)' }}>
                  {c.name}
                </p>
                <p className="font-mono-ipo truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                  {c.phone_e164.replace(/^\+91/, '+91 ')}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Remove ${c.name}`}
                onClick={() => remove.mutate(c.id)}
                disabled={remove.isPending}
                className="p-1.5 disabled:opacity-50"
              >
                <TrashIcon size={16} fill="var(--critical-text)" />
              </button>
            </li>
          ))}
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
        <button type="submit" disabled={!canAdd} className="btn-primary flex w-full items-center justify-center gap-2 text-sm disabled:opacity-50">
          <PlusIcon size={14} />
          {add.isPending ? 'Adding…' : 'Add to list'}
        </button>
      </form>
    </div>
  )
}

// Top-of-page button + composer. WhatsApp can't be bulk-sent from a browser
// (that needs the Meta Cloud API), so the composer opens one chat per person
// with the message pre-filled — same manual-send flow as the sell reminders.
export function BroadcastButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="icon-btn" aria-label="Broadcast a WhatsApp message" onClick={() => setOpen(true)}>
        <MegaphoneIcon size={18} />
      </button>
      {open && <BroadcastComposer onClose={() => setOpen(false)} />}
    </>
  )
}

function BroadcastComposer({ onClose }: { onClose: () => void }) {
  const query = useBroadcastContacts()
  const contacts = query.data ?? []
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState<Set<string>>(new Set())

  const text = message.trim()

  function send(c: BroadcastContact) {
    // "{name}" in the message becomes each person's first name.
    const personal = text.replace(/\{name\}/gi, c.name.trim().split(/\s+/)[0] ?? '')
    setSent((prev) => new Set(prev).add(c.id))
    sendCustomWhatsapp(c.phone_e164, personal)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8" onClick={onClose}>
      <div
        className="card w-full max-w-lg space-y-4 p-5"
        style={{ borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow-lg)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold" style={{ color: 'var(--ink-primary)' }}>
              Broadcast on WhatsApp
            </h2>
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              {contacts.length} {contacts.length === 1 ? 'person' : 'people'} on your list
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-sm hover:underline" style={{ color: 'var(--ink-muted)' }}>
            Close
          </button>
        </div>

        {contacts.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            Your broadcast list is empty. Close this and add people under "Broadcast list" first.
          </p>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-secondary)' }}>
                Message — use {'{name}'} to add each person's first name
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                placeholder="Hi {name}, …"
                className="input w-full resize-none"
              />
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                WhatsApp opens one chat at a time — tap Send next to each person.
              </p>
            </div>

            <ul className="max-h-72 divide-y overflow-y-auto">
              {contacts.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
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
                    disabled={!text}
                    className="btn-secondary shrink-0 text-xs disabled:opacity-50"
                  >
                    Send
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
