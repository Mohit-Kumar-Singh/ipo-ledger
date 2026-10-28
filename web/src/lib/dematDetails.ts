// The shareable "account details" text for one demat account — the Accounts
// page's Copy / WhatsApp buttons and the Allotment board's "Copy holder
// details" menu item both build it here, so the two always copy the same
// lines in the same order.
//
// Deliberately scoped: holder name, PAN, BO ID (DP client id) and the
// broker-app login fields — NOT the "Logged in" note, the profit cut or the
// phone number (internal, or the recipient's own).
import { supabase } from './supabase'
import { platformLabel } from './platforms'
import type { DematAccount } from '../types/database'

export type DematDetailsSource = Pick<
  DematAccount,
  | 'holder_name'
  | 'pan_masked'
  | 'dp_client_id'
  | 'platform'
  | 'application_name'
  | 'login_email'
  | 'login_password'
  | 'app_password'
  | 't_pin'
>

export const DEMAT_DETAILS_COLUMNS =
  'holder_name, pan_masked, dp_client_id, platform, application_name, login_email, login_password, app_password, t_pin'

// `pan` is the decrypted PAN; null falls back to the masked value rather than
// dropping the line — an obviously-masked PAN is clearer than a missing one.
export function dematDetailsText(account: DematDetailsSource, pan: string | null): string {
  const lines = [`Name: ${account.holder_name}`]
  lines.push(`PAN: ${pan ?? account.pan_masked}`)
  if (account.dp_client_id) lines.push(`BO ID: ${account.dp_client_id}`)
  if (account.platform) lines.push(`Platform: ${platformLabel(account.platform)}`)
  else if (account.application_name) lines.push(`App: ${account.application_name}`)
  if (account.login_email) lines.push(`Login ID: ${account.login_email}`)
  if (account.login_password) lines.push(`Password: ${account.login_password}`)
  if (account.app_password) lines.push(`App password: ${account.app_password}`)
  if (account.t_pin) lines.push(`T-PIN: ${account.t_pin}`)
  return lines.join('\n')
}

// Decrypts the PAN server-side (reveal-pan), which also writes the
// pan_access_log row — the right audit trail for putting a PAN on the
// clipboard. Null when the caller isn't allowed or the call fails.
export async function revealPan(dematId: string): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke<{ pan: string }>('reveal-pan', {
    body: { demat_id: dematId },
  })
  if (error || !data) return null
  return data.pan
}

// Copies text that is still loading. Must be called inside the tap: the
// clipboard is handed a pending value synchronously, because iOS Safari
// rejects a writeText that only runs after a network wait. Throws when the
// copy fails.
export async function copyPendingText(build: () => Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const blob = build().then((t) => new Blob([t], { type: 'text/plain' }))
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
  } else {
    await navigator.clipboard.writeText(await build())
  }
}
