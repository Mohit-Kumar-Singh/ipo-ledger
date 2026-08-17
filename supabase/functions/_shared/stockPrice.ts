// Yahoo Finance's unauthenticated chart endpoint — no API key, no cookie
// handshake needed, unlike NSE's own quote API which requires a session
// cookie dance and frequently blocks server-side requests outright. This is
// an unofficial endpoint and can change or rate-limit without notice; the
// caller (fetch-stock-price/index.ts) is expected to cache results and fall
// back to a stale cached price rather than treat a failure here as fatal.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export async function fetchStockPrice(symbol: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}.NS`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`yahoo finance returned ${res.status} for ${symbol}`)
  const data = await res.json()
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice
  return typeof price === 'number' ? price : null
}
