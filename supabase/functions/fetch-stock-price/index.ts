// Any signed-in member (not admin-only, unlike import-ipos) — a parent
// company's live share price is shown on their own dashboard, not just the
// admin panel. Batched: { symbols: string[] } in, so a page with several
// IPOs sharing the same parent company only ever needs one call, not one per
// card. Backed by stock_price_cache (15-minute freshness) so this doesn't
// hammer Yahoo Finance on every page load, and so a failed live fetch still
// has a stale-but-present fallback instead of the card showing nothing.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { fetchStockPrice } from '../_shared/stockPrice.ts'
import { corsHeadersFor, handlePreflight } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const FRESH_MS = 15 * 60 * 1000

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight
  const cors = corsHeadersFor(req)

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const { data: userData } = await admin.auth.getUser(jwt)
  if (!userData?.user) return new Response('unauthorized', { status: 401, headers: cors })

  const body = await req.json().catch(() => ({}))
  const symbols: string[] = Array.isArray(body.symbols)
    ? Array.from(new Set(body.symbols.filter((s: unknown) => typeof s === 'string' && s.trim())))
    : []
  if (symbols.length === 0) return jsonResponse({ prices: {} })

  const { data: cached } = await admin
    .from('stock_price_cache')
    .select('symbol, price, fetched_at')
    .in('symbol', symbols)
  const cacheBySymbol = new Map((cached ?? []).map((row) => [row.symbol, row]))

  const prices: Record<string, { price: number | null; stale: boolean }> = {}

  await Promise.all(
    symbols.map(async (symbol) => {
      const cachedRow = cacheBySymbol.get(symbol)
      const isFresh = cachedRow && Date.now() - new Date(cachedRow.fetched_at).getTime() < FRESH_MS
      if (isFresh) {
        prices[symbol] = { price: cachedRow.price, stale: false }
        return
      }
      try {
        const price = await fetchStockPrice(symbol)
        await admin.from('stock_price_cache').upsert({ symbol, price, fetched_at: new Date().toISOString() })
        prices[symbol] = { price, stale: false }
      } catch (err) {
        console.error('fetch-stock-price — live fetch failed for', symbol, err)
        prices[symbol] = cachedRow ? { price: cachedRow.price, stale: true } : { price: null, stale: false }
      }
    }),
  )

  return jsonResponse({ prices })
})
