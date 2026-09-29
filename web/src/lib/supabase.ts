import { createClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { friendlyError } from './friendlyError'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabaseConfigured = Boolean(url && anonKey)

export const supabase = createClient<Database>(
  url ?? 'https://placeholder.supabase.co',
  anonKey ?? 'placeholder-anon-key',
)

/**
 * supabase-js's FunctionsHttpError only exposes a generic "non-2xx status
 * code" message by default — the real error is on error.context (a Response).
 * This pulls the { error } body our Edge Functions return so it surfaces in the UI
 * — always as plain language (friendlyError), never the raw text.
 */
export async function describeFunctionError(
  fnError: { message?: string; context?: Response } | null,
  data: { error?: string } | null,
): Promise<string> {
  if (data?.error) return friendlyError(data.error)
  const context = fnError?.context
  if (context instanceof Response) {
    try {
      const body = await context.clone().json()
      if (body?.error) return friendlyError(String(body.error))
    } catch {
      // response wasn't JSON — fall through to the generic message
    }
  }
  return friendlyError(fnError)
}
