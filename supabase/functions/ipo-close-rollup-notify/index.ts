// Cron-triggered, daily — same x-cron-secret auth pattern as
// auto-import-ipos/gmp-alert-notify, since a scheduled job has no user
// session.
//
// For every IPO whose close_date is today, groups all of its applications
// by funder (whoever's bank/UPI account paid — same resolveFunder rule
// send-whatsapp uses, so a funder here is exactly who'd otherwise get an
// individual "applied" message) and queues ONE rollup message per funder
// listing every demat account they applied through for that IPO, grouped
// by the date each application was actually created ("Applied today: X, Y"
// vs "Applied on 7th Aug: Z") rather than one flat undated list.
//
// Idempotent per (ipo, funder phone): checks for an existing ROLLUP
// notification with that ipo_id + to_phone before inserting, so a retried
// or twice-fired cron run never double-queues the same funder's rollup.
//
// QUEUED, not auto-sent — same "admin explicitly dispatches" model as
// ipo_applied/ipo_allotted, unlike gmp-alert-notify's immediate send.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeadersFor, handlePreflight } from '../_shared/cors.ts'
import { jsonResponse, logError, logRequest } from '../_shared/http.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET')!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

interface BankRow {
  account_holder_name?: string | null
  phone_e164?: string | null
}

interface AppRow {
  id: string
  demat_id: string
  created_at: string
  ipo_id: string
  ipos: { company_name: string }
  demat_accounts: { holder_name: string; phone_e164: string }
  bank_accounts: BankRow | null
  // Manual funder-credit override (funder_override_id, migration 0063) —
  // wins over bank_accounts when set, same rule every other funder-facing
  // consumer in the app follows.
  funder_override: BankRow | null
}

// Same rule as send-whatsapp's resolveFunder: no bank account, or one
// whose holder name matches the demat holder, means there's no funder
// distinct from the holder — they fund/hold under one identity.
function resolveFunder(holderName: string, holderPhone: string, b: BankRow | null) {
  const bankName = b?.account_holder_name || null
  const bankPhone = b?.phone_e164 || null
  const sameAsHolder = !bankName || bankName === holderName
  if (sameAsHolder || !bankPhone) return { phone: holderPhone, name: holderName }
  return { phone: bankPhone, name: bankName }
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

function formatDateLabel(iso: string, todayIso: string): string {
  if (iso === todayIso) return 'today'
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `on ${ordinal(d)} ${month}`
}

function buildRollupBody(companyName: string, todayIso: string, holdersByDate: Map<string, string[]>): string {
  const lines = Array.from(holdersByDate.entries())
    // Most recent application date first — the close-date rollup itself
    // isn't chasing a specific reading order beyond "today's applications
    // are the ones most worth seeing first."
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, names]) => `Applied ${formatDateLabel(date, todayIso)}: ${names.join(', ')}`)
    .join('\n')
  return `Here's a summary of every account you funded for *${companyName}*, now that bidding has closed:\n\n${lines}`
}

Deno.serve(async (req) => {
  logRequest('ipo-close-rollup-notify', req)
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  const cors = corsHeadersFor(req)

  const secret = req.headers.get('x-cron-secret')
  if (secret !== CRON_SECRET) return jsonResponse({ error: 'unauthorized' }, 401, cors)

  try {
    const todayIso = new Date().toISOString().slice(0, 10)

    const { data: closingIpos } = await admin.from('ipos').select('id, company_name').eq('close_date', todayIso)
    let queued = 0

    for (const ipo of closingIpos ?? []) {
      // bank_accounts embedded twice (bank_account_id + funder_override_id,
      // migration 0063) — needs the FK named explicitly on both or
      // PostgREST can't tell which relationship a bare bank_accounts(...)
      // means and errors instead of returning rows. Same fix as
      // send-whatsapp's queueForApplication; this function had the same gap.
      const { data: rows, error: rowsError } = await admin
        .from('applications')
        .select(
          'id, demat_id, created_at, ipo_id, ipos(company_name), demat_accounts(holder_name, phone_e164), ' +
            'bank_accounts!bank_account_id(account_holder_name, phone_e164), ' +
            'funder_override:bank_accounts!funder_override_id(account_holder_name, phone_e164)',
        )
        .eq('ipo_id', ipo.id)
      if (rowsError) {
        console.error('ipo-close-rollup-notify — failed to load applications for', ipo.company_name, rowsError)
        continue
      }
      if (!rows || rows.length === 0) continue

      // Group applications by funder identity (phone), each funder's own
      // holdersByDate map keyed by the application's created_at date.
      const byFunderPhone = new Map<string, { name: string; holdersByDate: Map<string, string[]> }>()
      for (const r of rows as unknown as AppRow[]) {
        const holderName = r.demat_accounts.holder_name
        const holderPhone = r.demat_accounts.phone_e164
        const funder = resolveFunder(holderName, holderPhone, r.funder_override ?? r.bank_accounts)
        if (!funder.phone) continue
        if (!byFunderPhone.has(funder.phone)) {
          byFunderPhone.set(funder.phone, { name: funder.name, holdersByDate: new Map() })
        }
        const entry = byFunderPhone.get(funder.phone)!
        const dateKey = r.created_at.slice(0, 10)
        if (!entry.holdersByDate.has(dateKey)) entry.holdersByDate.set(dateKey, [])
        entry.holdersByDate.get(dateKey)!.push(holderName)
      }

      for (const [phone, entry] of byFunderPhone) {
        const { data: existing } = await admin
          .from('notifications')
          .select('id')
          .eq('ipo_id', ipo.id)
          .eq('to_phone', phone)
          .eq('type', 'ROLLUP')
          .maybeSingle()
        if (existing) continue

        const body = buildRollupBody(ipo.company_name, todayIso, entry.holdersByDate)
        await admin.from('notifications').insert({
          application_id: null,
          demat_id: null,
          ipo_id: ipo.id,
          type: 'ROLLUP',
          to_phone: phone,
          template_name: 'ipo_close_rollup',
          variables: { params: [body] },
          status: 'QUEUED',
        })
        queued++
      }
    }

    return jsonResponse({ ok: true, ipos: (closingIpos ?? []).length, queued })
  } catch (err) {
    logError('ipo-close-rollup-notify', err)
    return jsonResponse({ error: 'internal error' }, 500, cors)
  }
})
