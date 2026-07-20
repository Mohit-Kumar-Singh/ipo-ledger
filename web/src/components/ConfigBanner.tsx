import { supabaseConfigured } from '../lib/supabase'

export function ConfigBanner() {
  if (supabaseConfigured) return null
  return (
    <div
      className="px-4 py-2 text-center text-sm font-medium"
      style={{ background: 'var(--warning-tint)', color: 'var(--warning-text)' }}
    >
      Supabase isn't configured yet — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in
      web/.env.local, then restart the dev server.
    </div>
  )
}
