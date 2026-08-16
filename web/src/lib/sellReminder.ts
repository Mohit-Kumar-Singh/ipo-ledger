import { supabase } from './supabase'
import { platformLabel, type DematPlatform } from './platforms'

const BUCKET = 'sell-instructions'
// Long-lived on purpose: this URL is pasted straight into a WhatsApp message
// the holder may not open until listing morning — a short TTL would 404 by
// the time they tap it. 7 days covers "sent the day before" comfortably.
const PDF_URL_TTL_SECONDS = 60 * 60 * 24 * 7

// The stored broker-app login details (all plaintext, all optional) that a
// sell reminder can hand back to the account holder so they can log in and
// sell — same fields the Accounts page "Share details" button already sends.
export type SellAccountDetails = {
  platform?: DematPlatform | string | null
  dp_client_id?: string | null
  application_name?: string | null
  login_email?: string | null
  login_password?: string | null
  app_password?: string | null
  t_pin?: string | null
  logged_in_notes?: string | null
}

// Resolves a platform's how-to-sell PDF to a fresh signed URL (or null if
// that platform has no PDF on file). Admin-only under RLS/storage policy —
// only ever called from admin send actions.
export async function resolveSellPdfUrl(platform: string | null | undefined): Promise<string | null> {
  if (!platform) return null
  const { data: row } = await supabase
    .from('sell_instruction_pdfs')
    .select('storage_path')
    .eq('platform', platform)
    .maybeSingle()
  if (!row?.storage_path) return null
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(row.storage_path, PDF_URL_TTL_SECONDS)
  return data?.signedUrl ?? null
}

// Builds the full sell-reminder body: the "we're selling at 10 AM" reminder,
// the holder's own login details (only the fields that are actually set), and
// the how-to-sell PDF link when one exists. listingPhrase is the caller's
// wording — "lists today" / "lists tomorrow" (Notifications) or "lists on
// 20 Aug" (allotment board).
export function buildSellReminderText(opts: {
  holderName: string
  ipoName: string
  lots: number
  listingPhrase: string
  details?: SellAccountDetails | null
  pdfUrl?: string | null
  note?: string
}): string {
  const { holderName, ipoName, lots, listingPhrase, details, pdfUrl, note } = opts
  let msg =
    `Hi ${holderName}, reminder \u{23F0} — *${ipoName}* ${listingPhrase}. ` +
    `We'll be selling your allotted shares (${lots} lot${lots === 1 ? '' : 's'}) around *10 AM*, right when the market opens.`

  const lines: string[] = []
  if (details?.platform) lines.push(`Platform: ${platformLabel(details.platform)}`)
  else if (details?.application_name) lines.push(`App: ${details.application_name}`)
  if (details?.login_email) lines.push(`Login ID: ${details.login_email}`)
  if (details?.login_password) lines.push(`Password: ${details.login_password}`)
  if (details?.app_password) lines.push(`App password: ${details.app_password}`)
  if (details?.t_pin) lines.push(`T-PIN: ${details.t_pin}`)
  if (details?.dp_client_id) lines.push(`Demat/DP ID: ${details.dp_client_id}`)
  if (details?.logged_in_notes) lines.push(`Note: ${details.logged_in_notes}`)
  if (lines.length) msg += `\n\n*Your login details:*\n${lines.join('\n')}`

  if (pdfUrl) msg += `\n\n*How to verify (T-PIN) & sell:*\n${pdfUrl}`
  if (note?.trim()) msg += `\n\n${note.trim()}`
  return msg
}
