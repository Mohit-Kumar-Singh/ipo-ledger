import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { showToast } from '../../lib/toast'
import { openWhatsAppForNotification } from '../../lib/dispatchWhatsapp'
import { platformLabel, type DematPlatform } from '../../lib/platforms'
import type { AllotmentBoardRow, Notification } from '../../types/database'

const BUCKET = 'sell-instructions'

// One recipient = one demat holder (deduped by phone), covering every
// ALLOTTED application they hold for this IPO.
type Recipient = {
  phone: string
  holderName: string
  dematId: string
  platform: DematPlatform | null
  totalLots: number
  applicationId: string
}

type SentNotif = Pick<Notification, 'id' | 'status' | 'to_phone' | 'template_name' | 'variables'>

function formatListing(iso: string | null): string {
  if (!iso) return 'its listing day'
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

// Same body for everyone, personalised by name + lot count. The admin's
// editable note (price band, cutoff time, etc.) is appended verbatim.
function buildBody(r: Recipient, ipoName: string, listingLabel: string, note: string): string {
  const base =
    `Hi ${r.holderName}, \u{23F0} reminder — the *${ipoName}* IPO lists on *${listingLabel}*. ` +
    `We'll be selling your allotted shares (${r.totalLots} lot${r.totalLots === 1 ? '' : 's'}) around *10 AM*, right when the market opens.`
  return note.trim() ? `${base}\n\n${note.trim()}` : base
}

export function SellReminderComposer({
  ipo,
  allottedRows,
  onClose,
}: {
  ipo: { id: string; company_name: string; listing_date: string | null }
  allottedRows: AllotmentBoardRow[]
  onClose: () => void
}) {
  const listingLabel = formatListing(ipo.listing_date)
  const [note, setNote] = useState('')
  const [pdfByPlatform, setPdfByPlatform] = useState<Record<string, string>>({})
  const [notifByPhone, setNotifByPhone] = useState<Record<string, SentNotif>>({})
  const [preparing, setPreparing] = useState(false)
  const [prepared, setPrepared] = useState(false)
  const [busyPhone, setBusyPhone] = useState<string | null>(null)

  // Dedupe ALLOTTED rows to one recipient per holder phone, summing lots.
  const recipients = useMemo<Recipient[]>(() => {
    const byPhone = new Map<string, Recipient>()
    for (const r of allottedRows) {
      if (r.status !== 'ALLOTTED' || !r.phone_e164) continue
      const existing = byPhone.get(r.phone_e164)
      if (existing) {
        existing.totalLots += r.lots
      } else {
        byPhone.set(r.phone_e164, {
          phone: r.phone_e164,
          holderName: r.holder_name,
          dematId: r.demat_id,
          platform: r.platform,
          totalLots: r.lots,
          applicationId: r.application_id,
        })
      }
    }
    return Array.from(byPhone.values()).sort((a, b) => a.holderName.localeCompare(b.holderName))
  }, [allottedRows])

  // Load the PDF library + any sell reminders already queued for this IPO, so
  // reopening the composer shows their sent status instead of offering to
  // create duplicates.
  useEffect(() => {
    supabase
      .from('sell_instruction_pdfs')
      .select('platform, storage_path')
      .then(({ data }) => {
        const map: Record<string, string> = {}
        for (const row of (data ?? []) as { platform: string; storage_path: string }[]) map[row.platform] = row.storage_path
        setPdfByPlatform(map)
      })
    supabase
      .from('notifications')
      .select('id, status, to_phone, template_name, variables')
      .eq('type', 'SELL_REMINDER')
      .eq('ipo_id', ipo.id)
      .then(({ data }) => {
        const map: Record<string, SentNotif> = {}
        for (const n of (data ?? []) as SentNotif[]) map[n.to_phone] = n
        setNotifByPhone(map)
        if ((data ?? []).length > 0) setPrepared(true)
      })
  }, [ipo.id])

  async function prepare() {
    setPreparing(true)
    const toInsert = recipients
      .filter((r) => !notifByPhone[r.phone])
      .map((r) => ({
        application_id: r.applicationId,
        demat_id: r.dematId,
        ipo_id: ipo.id,
        type: 'SELL_REMINDER' as const,
        to_phone: r.phone,
        template_name: 'sell_reminder',
        // Body pre-composed; platform + storage_path carried so "Attach PDF"
        // can mint a fresh signed URL on demand (resolved on open, not baked
        // in — a stored signed URL would expire).
        variables: {
          params: [buildBody(r, ipo.company_name, listingLabel, note)],
          platform: r.platform,
          pdf_path: r.platform ? pdfByPlatform[r.platform] ?? null : null,
        },
        status: 'QUEUED' as const,
      }))

    if (toInsert.length > 0) {
      const { data, error } = await supabase
        .from('notifications')
        .insert(toInsert)
        .select('id, status, to_phone, template_name, variables')
      if (error) {
        showToast(`Couldn't queue reminders: ${error.message}`, 'critical')
        setPreparing(false)
        return
      }
      setNotifByPhone((prev) => {
        const next = { ...prev }
        for (const n of (data ?? []) as SentNotif[]) next[n.to_phone] = n
        return next
      })
    }
    setPrepared(true)
    setPreparing(false)
    showToast('Sell reminders queued — send each on WhatsApp below.', 'good')
  }

  async function sendOne(r: Recipient) {
    const notif = notifByPhone[r.phone]
    if (!notif) return
    setBusyPhone(r.phone)
    await openWhatsAppForNotification(notif)
    // openWhatsAppForNotification marks it SENT; reflect that locally.
    setNotifByPhone((prev) => ({ ...prev, [r.phone]: { ...notif, status: 'SENT' } }))
    setBusyPhone(null)
  }

  async function openPdf(r: Recipient) {
    const path = r.platform ? pdfByPlatform[r.platform] : null
    if (!path) return
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300)
    if (error || !data?.signedUrl) {
      showToast(`Couldn't open PDF: ${error?.message ?? 'no signed URL'}`, 'critical')
      return
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
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
              Send sell reminder
            </h2>
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              {ipo.company_name} · lists {listingLabel} · {recipients.length} allotment holder
              {recipients.length === 1 ? '' : 's'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-sm hover:underline" style={{ color: 'var(--ink-muted)' }}>
            Close
          </button>
        </div>

        {recipients.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--ink-muted)' }}>
            No allotment holders for this IPO yet — mark applications as allotted first.
          </p>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-secondary)' }}>
                Note (optional) — appended to every message
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={prepared}
                rows={3}
                placeholder="e.g. Sell above ₹X. Do it before 3:15 PM."
                className="input w-full resize-none disabled:opacity-60"
              />
              {prepared && (
                <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                  Reminders are queued — reopen after changing the note isn't needed; send each below.
                </p>
              )}
            </div>

            <div className="max-h-72 divide-y overflow-y-auto" style={{ borderColor: 'var(--border)' }}>
              {recipients.map((r) => {
                const notif = notifByPhone[r.phone]
                const hasPdf = !!(r.platform && pdfByPlatform[r.platform])
                return (
                  <div key={r.phone} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate font-medium" style={{ color: 'var(--ink-primary)' }}>
                        {r.holderName}
                        {notif?.status && notif.status !== 'QUEUED' && (
                          <span className="badge badge-info ml-2 align-middle text-[10px]">{notif.status}</span>
                        )}
                      </p>
                      <p className="truncate text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {r.totalLots} lot(s) · {platformLabel(r.platform)} · {hasPdf ? 'PDF ready' : 'no PDF'}
                      </p>
                    </div>
                    {prepared && (
                      <div className="flex shrink-0 items-center gap-3">
                        {hasPdf && (
                          <button type="button" onClick={() => openPdf(r)} className="link-accent text-xs font-medium">
                            PDF
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => sendOne(r)}
                          disabled={busyPhone === r.phone}
                          className="btn-secondary text-xs disabled:opacity-50"
                        >
                          Send
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {!prepared && (
              <button type="button" onClick={prepare} disabled={preparing} className="btn-primary w-full disabled:opacity-50">
                {preparing ? 'Queuing…' : `Queue ${recipients.length} reminder${recipients.length === 1 ? '' : 's'}`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
