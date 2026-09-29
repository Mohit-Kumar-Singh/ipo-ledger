// Yahoo Finance's unauthenticated chart endpoint — no API key, no cookie
// handshake needed, unlike NSE's own quote API which requires a session
// cookie dance and frequently blocks server-side requests outright. This is
// an unofficial endpoint and can change or rate-limit without notice; the
// caller (fetch-stock-price/index.ts) is expected to cache results and fall
// back to a stale cached price rather than treat a failure here as fatal.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// Yahoo exchange suffixes, tried in order. NSE first (the normal case), then
// BSE — a company can list on BSE only, and one always does: NSE Ltd itself
// can't list on its own exchange, so its IPO (listed 2026-09-24) trades only
// as NSE.BO, and a `.NS`-only lookup returned "No data found" for it forever,
// leaving the Dashboard's "Expected profit" stuck on the GMP estimate.
export const EXCHANGE_SUFFIXES = ['.NS', '.BO'] as const

export interface ChartQuote {
  price: number
  exchangeName: string | null
  // Epoch seconds of the stock's first ever trade (Yahoo meta.firstTradeDate)
  // — lets the symbol resolver tell a fresh listing from an old stock that
  // merely shares a ticker guess.
  firstTradeDate: number | null
}

// One chart-endpoint probe for a fully-suffixed Yahoo ticker. null means
// "Yahoo has no quote for this ticker" (404 / chart.error / no price) — a
// legitimate miss, not a failure; anything else unexpected throws so the
// caller can fall back to its stale cache.
export async function fetchChartQuote(yahooTicker: string): Promise<ChartQuote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`yahoo finance returned ${res.status} for ${yahooTicker}`)
  const data = await res.json()
  if (data?.chart?.error) return null
  const meta = data?.chart?.result?.[0]?.meta
  const price = meta?.regularMarketPrice
  if (typeof price !== 'number') return null
  return {
    price,
    exchangeName: typeof meta?.exchangeName === 'string' ? meta.exchangeName : null,
    firstTradeDate: typeof meta?.firstTradeDate === 'number' ? meta.firstTradeDate : null,
  }
}

// `symbol` is the bare ticker stored in ipos.symbol / parent_company_symbol
// (e.g. "SSRETAIL", "NSE") — resolved against NSE first, then BSE.
export async function fetchStockPrice(symbol: string): Promise<number | null> {
  for (const suffix of EXCHANGE_SUFFIXES) {
    const quote = await fetchChartQuote(`${symbol}${suffix}`)
    if (quote) return quote.price
  }
  return null
}
