// Best-effort NSE symbol lookup by company name, via the same unauthenticated
// Yahoo Finance endpoint stockPrice.ts already relies on (no API key, but
// unofficial and can change without notice). Used by resolve-listing-symbols
// to auto-fill ipos.symbol once an IPO lists, so live-price tracking (see
// fetch-stock-price) can start without an admin having to type the ticker in
// by hand — but ONLY on a confident match. A wrong symbol here would silently
// feed a different company's share price into real profit-split math, which
// is worse than the status quo (no live price, just the frozen GMP estimate)
// — so this deliberately returns null on anything short of an exact match
// rather than guessing off the closest-sounding result.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

interface YahooQuote {
  symbol?: string
  shortname?: string
  longname?: string
  exchange?: string
  quoteType?: string
}

// Strips common corporate suffixes and punctuation so "Dhoot Transmission
// Limited" (Yahoo's longname) and "Dhoot Transmission" (this app's
// company_name, entered by hand off the ipoji listing) compare equal.
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(limited|ltd|enterprises?|industries|corporation|corp|company|co)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()
}

export async function resolveNseSymbol(companyName: string): Promise<string | null> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(companyName)}&quotesCount=10&newsCount=0`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`yahoo finance search returned ${res.status} for "${companyName}"`)
  const data = await res.json()
  const quotes: YahooQuote[] = Array.isArray(data?.quotes) ? data.quotes : []

  const target = normalize(companyName)
  const match = quotes.find(
    (q) =>
      q.exchange === 'NSI' &&
      q.quoteType === 'EQUITY' &&
      !!q.symbol &&
      (normalize(q.longname ?? '') === target || normalize(q.shortname ?? '') === target),
  )
  if (!match?.symbol) return null
  // Yahoo's search returns "TICKER.NS" for NSE listings; this app stores the
  // bare ticker (fetchStockPrice appends ".NS" itself — see stockPrice.ts).
  return match.symbol.replace(/\.NS$/, '')
}
