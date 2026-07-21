// CORS is defense-in-depth here, not the primary security boundary — every
// function still requires a valid admin JWT or a shared secret regardless of
// Origin. But there's no reason to let arbitrary websites read responses via
// a victim's browser, so this is scoped to: the production domain, any
// Vercel preview deployment (unpredictable per-PR subdomain, hence the
// pattern match rather than an exact list), and local dev.
const ALLOWED_ORIGINS = [
  'https://mohit-kumar-singh-ipo-ledger.vercel.app',
  'http://localhost:5173',
]
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/

function resolveOrigin(req: Request): string {
  const origin = req.headers.get('origin') ?? ''
  if (ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin)) return origin
  return ALLOWED_ORIGINS[0]
}

export function corsHeadersFor(req: Request) {
  return {
    'Access-Control-Allow-Origin': resolveOrigin(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
    Vary: 'Origin',
  }
}

// Back-compat static export for anything not yet passing `req` through —
// prefer corsHeadersFor(req) in new/updated code.
export const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://mohit-kumar-singh-ipo-ledger.vercel.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
}

export function handlePreflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(req) })
  return null
}
