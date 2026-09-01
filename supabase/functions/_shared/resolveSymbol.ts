// Best-effort NSE symbol lookup by company name, via the same unauthenticated
// Yahoo Finance endpoints stockPrice.ts already relies on (no API key, but
// unofficial and can change without notice). Used by resolve-listing-symbols
// to auto-fill ipos.symbol once an IPO lists, so live-price tracking (see
// fetch-stock-price) can start without an admin having to type the ticker in
// by hand — but ONLY on a confident match. A wrong symbol here would silently
// feed a different company's share price into real profit-split math, which
// is worse than the status quo (no live price, just the frozen GMP estimate)
// — so both strategies below deliberately return null rather than guess off
// a plausible-but-unverified result.
//
// Two strategies, tried in order:
//  1. Yahoo's fuzzy search, matched on an exact (suffix-normalized) company
//     name — fully name-verified, but confirmed (live, on the two IPOs that
//     prompted this file) NOT to have indexed a same-day small-cap listing
//     yet — /v1/finance/search returned zero results for either.
//  2. Direct ticker guesses (first word, or the run-together first two
//     words, of the company name) probed straight against the CHART
//     endpoint — confirmed live to already have same-day data for both of
//     those same two IPOs, even though search didn't. This can't verify the
//     company name back (the chart endpoint's meta has no longName/shortname
//     for a brand-new listing), so it only accepts a hit that's (a) actually
//     on the NSE and (b) trading within a plausible multiple of the IPO's
//     own issue price — real listing-day moves are large but not
//     10x-in-a-day large, so this catches "guessed the wrong company's
//     ticker" (a random unrelated stock price) without needing name
//     verification it can't get.
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
function stripSuffixes(name: string): string {
  return name.replace(/\b(limited|ltd|enterprises?|industries|corporation|corp|company|co)\b\.?/gi, '').trim()
}

function normalize(name: string): string {
  return stripSuffixes(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

async function searchByName(companyName: string): Promise<string | null> {
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
  return match?.symbol?.replace(/\.NS$/, '') ?? null
}

// Real listing-day pops/drops on a decent-GMP small-cap commonly run
//30–80%; nothing legitimate moves 5x on day one. Wide enough to never
// reject a genuine match, tight enough to reject "guessed a ticker that
// belongs to some unrelated stock trading at a wildly different price."
const MIN_PLAUSIBLE_RATIO = 0.3
const MAX_PLAUSIBLE_RATIO = 3

async function tryTicker(ticker: string, priceHigh: number | null): Promise<string | null> {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.NS`, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!res.ok) return null
  const data = await res.json()
  if (data?.chart?.error) return null
  const meta = data?.chart?.result?.[0]?.meta
  const price = meta?.regularMarketPrice
  if (typeof price !== 'number' || meta?.exchangeName !== 'NSI') return null
  if (priceHigh != null && priceHigh > 0) {
    const ratio = price / priceHigh
    if (ratio < MIN_PLAUSIBLE_RATIO || ratio > MAX_PLAUSIBLE_RATIO) return null
  }
  return ticker
}

function tickerCandidates(companyName: string): string[] {
  const words = stripSuffixes(companyName)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  if (words.length === 0) return []
  const candidates = [words[0]]
  if (words.length > 1) candidates.push(words.slice(0, 2).join(''))
  return Array.from(new Set(candidates)).filter((c) => c.length >= 3)
}

export async function resolveNseSymbol(companyName: string, priceHigh: number | null): Promise<string | null> {
  const byName = await searchByName(companyName)
  if (byName) return byName

  for (const candidate of tickerCandidates(companyName)) {
    const hit = await tryTicker(candidate, priceHigh)
    if (hit) return hit
  }
  return null
}
