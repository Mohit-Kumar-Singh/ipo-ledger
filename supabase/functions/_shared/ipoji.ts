// Shared ipoji.com scrape/parse logic used by both import-ipos (admin,
// on-demand, browser-triggered) and auto-import-ipos (cron, every 4h).
// No official ipoji API exists — this parses their public listing/detail
// HTML pages. robots.txt allows /ipo/* ; no scraping restriction found in
// their ToS at the time this was written (verify periodically).
import { DOMParser } from 'https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts'

export const SOURCES: Record<string, string> = {
  current: 'https://www.ipoji.com/ipo/current-ipo',
  upcoming: 'https://www.ipoji.com/ipo/upcoming-ipo',
}
const USER_AGENT = 'Mozilla/5.0 (compatible; IPOLedgerBot/1.0; +personal-use import tool)'
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

// Extracts a percentage like "17%" out of free-text GMP notes (e.g.
// "GMP: ₹95-96 (17%)") — same regex as web/src/lib/ipoGmp.ts's
// parseGmpPercent, duplicated here since Deno Edge Functions and the Vite
// web app don't share a module boundary. Keep both in sync if this changes.
export function parseGmpPercent(gmpNotes: string | null | undefined): number | null {
  if (!gmpNotes) return null
  const match = gmpNotes.match(/(-?\d+(?:\.\d+)?)\s*%/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isNaN(value) ? null : value
}

export interface Candidate {
  company_name: string
  open_date: string | null
  close_date: string | null
  price_low: number | null
  price_high: number | null
  lot_size: number | null
  exchange: string | null
  gmp: string | null
  issue_size: string | null
  source_url: string
}

export type RegistrarCode =
  | 'MUFG_INTIME'
  | 'KFINTECH'
  | 'BIGSHARE'
  | 'CAMEO'
  | 'SKYLINE'
  | 'MAASHITLA'
  | 'OTHER'

export interface Detail {
  allotment_date: string | null
  listing_date: string | null
  exchange: string | null
  issue_size: string | null
  retail_issue_size: string | null
  registrar: RegistrarCode | null
  registrar_name: string | null
  retail_subscription_rate: string | null
  // Whether ipoji itself is reporting allotment as actually finalized
  // ("Allotment Out"), not just that today >= allotment_date — the
  // scheduled date frequently slips (registrar delays), so deriving
  // "Allotment out" purely from the calendar reads as done a day or more
  // before it actually is. null when ipoji shows neither "Allotment Out"
  // nor "Allotment Awaited" (e.g. before the IPO has even closed) — treat
  // that as "unknown", not "not yet", so it doesn't override a manual
  // admin edit either way. See allotmentOutFromText below.
  allotment_out: boolean | null
}

// ipoji shows "Allotment Out" once results are actually published, and
// "Allotment Awaited" while still pending — as plain text next to/inside a
// fact-item, not a distinctly-classed badge (confirmed by inspection, not
// guessed), so this scans full text content rather than chasing a selector
// that isn't there. Whole-page text, not a specific element, since the
// wording's exact container isn't stable enough to pin down from outside a
// real browser session — same "text over classes" tradeoff already made in
// this file for the subscription table below.
export function allotmentOutFromText(pageText: string): boolean | null {
  const t = pageText.toLowerCase()
  if (t.includes('allotment out')) return true
  if (t.includes('allotment awaited')) return false
  return null
}

// ipoji shows the registrar's full name (e.g. "Kfin Technologies Ltd.") —
// map it to our fixed enum by keyword rather than trying to keep an exact
// name list in sync with however they format it.
function mapRegistrar(name: string): RegistrarCode {
  const n = name.toLowerCase()
  if (n.includes('kfin')) return 'KFINTECH'
  if (n.includes('link intime') || n.includes('mufg')) return 'MUFG_INTIME'
  if (n.includes('bigshare')) return 'BIGSHARE'
  if (n.includes('cameo')) return 'CAMEO'
  if (n.includes('skyline')) return 'SKYLINE'
  if (n.includes('maashitla')) return 'MAASHITLA'
  return 'OTHER'
}

// "₹9795.31 Cr" -> { value: 9795.31, unit: "Cr" }
function parseAmountText(text: string): { value: number; unit: string } | null {
  const m = text.match(/₹?\s*([\d,]+\.?\d*)\s*(.*)$/)
  if (!m) return null
  const value = Number(m[1].replace(/,/g, ''))
  if (Number.isNaN(value)) return null
  return { value, unit: m[2].trim() }
}

// "Jul 17, 2026" -> "2026-07-17". Manual parsing avoids Date() timezone shift bugs.
export function parseIpojiDate(text: string): string | null {
  const m = text.trim().match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${month}-${m[2].padStart(2, '0')}`
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`upstream returned ${res.status}`)
  return res.text()
}

export async function fetchListCandidates(source: string): Promise<Candidate[]> {
  const url = SOURCES[source in SOURCES ? source : 'current']
  const html = await fetchHtml(url)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc) throw new Error('Could not parse source page')

  const cards = Array.from(doc.querySelectorAll('.ipo-card'))
  const candidates: Candidate[] = []

  for (const card of cards) {
    // deno-lint-ignore no-explicit-any
    const el = card as any
    const name = el.querySelector('.ipo-card-name')?.textContent?.trim()
    if (!name) continue

    const times = Array.from(el.querySelectorAll('.ipo-card-date time'))
    // deno-lint-ignore no-explicit-any
    const dates = times.map((t: any) => t.getAttribute('datetime'))
    const open_date = dates[0] && dates[0] !== '2050-01-01' ? dates[0] : null
    const close_date = dates[1] && dates[1] !== '2050-01-01' ? dates[1] : null

    const exchange = el.querySelector('.ipo-card-market-badge')?.textContent?.trim() || null

    let price_low: number | null = null
    let price_high: number | null = null
    let lot_size: number | null = null
    let gmp: string | null = null
    let issue_size: string | null = null

    // deno-lint-ignore no-explicit-any
    for (const stat of Array.from(el.querySelectorAll('.ipo-card-body-stat')) as any[]) {
      const label = stat.querySelector('.ipo-card-secondary-label')?.textContent?.trim()
      const value = stat.querySelector('.ipo-card-body-value')?.textContent?.replace(/\s+/g, ' ').trim()
      if (!label || !value || value.includes('N/A')) continue

      if (label === 'Offer Price') {
        const clean = value.replace(/[₹,]/g, '')
        const range = clean.match(/([\d.]+)\s*-\s*([\d.]+)/)
        if (range) {
          price_low = Number(range[1])
          price_high = Number(range[2])
        } else {
          const single = Number(clean)
          if (!Number.isNaN(single)) {
            price_low = single
            price_high = single
          }
        }
      }
      if (label === 'Lot Size') {
        const n = Number(value.replace(/[^\d]/g, ''))
        if (!Number.isNaN(n) && n > 0) lot_size = n
      }
      if (label === 'Exp. Premium') gmp = `GMP: ${value}`
      if (label === 'Issue Size') issue_size = value
    }

    const onclick = el.getAttribute('onclick') ?? ''
    const link = onclick.match(/'(\/ipo\/[a-z0-9-]+)'/)?.[1]
    const source_url = link ? `https://www.ipoji.com${link}` : url

    candidates.push({
      company_name: name,
      open_date,
      close_date,
      price_low,
      price_high,
      lot_size,
      exchange,
      gmp,
      issue_size,
      source_url,
    })
  }

  return candidates
}

export async function fetchDetail(detailUrl: string): Promise<Detail> {
  if (!detailUrl.startsWith('https://www.ipoji.com/ipo/')) {
    throw new Error('detail_url must be an ipoji.com /ipo/ page')
  }
  const html = await fetchHtml(detailUrl)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc) throw new Error('Could not parse detail page')

  const result: Detail = {
    allotment_date: null,
    listing_date: null,
    exchange: null,
    issue_size: null,
    retail_issue_size: null,
    registrar: null,
    registrar_name: null,
    retail_subscription_rate: null,
    allotment_out: allotmentOutFromText(doc.body?.textContent ?? ''),
  }

  // deno-lint-ignore no-explicit-any
  for (const item of Array.from(doc.querySelectorAll('.facts-row .fact-item')) as any[]) {
    const label = item.querySelector('.fact-label')?.textContent?.trim().toLowerCase() ?? ''
    const value = item.querySelector('.fact-value')?.textContent?.trim() ?? ''
    if (!value) continue

    if (label.includes('allotment date')) result.allotment_date = parseIpojiDate(value)
    else if (label === 'listing' || (label.includes('listing') && !label.includes('at'))) {
      const parsed = parseIpojiDate(value)
      if (parsed) result.listing_date = parsed
    } else if (label.includes('listing at')) result.exchange = value
    else if (label.includes('issue size')) result.issue_size = value
  }

  // Registrar: a plain <dt>Registrar</dt><dd>Kfin Technologies Ltd.</dd> row.
  // deno-lint-ignore no-explicit-any
  for (const row of Array.from(doc.querySelectorAll('.detail-list__row')) as any[]) {
    const dt = row.querySelector('dt')?.textContent?.trim().toLowerCase() ?? ''
    const dd = row.querySelector('dd')?.textContent?.trim() ?? ''
    if (dt === 'registrar' && dd) {
      result.registrar_name = dd
      result.registrar = mapRegistrar(dd)
      break
    }
  }

  // Live/final subscription figures ("... IPO Subscription Status" table) —
  // only present once bidding has started, so this stays null for IPOs that
  // haven't opened yet. Matched by header text ("Retail") rather than a
  // class name, since this table doesn't carry a distinctive selector and
  // text-matching is more resilient to markup tweaks than chasing classes.
  // deno-lint-ignore no-explicit-any
  for (const table of Array.from(doc.querySelectorAll('table')) as any[]) {
    const headerRow = table.querySelector('thead tr') ?? table.querySelector('tr')
    if (!headerRow) continue
    const headers = Array.from(headerRow.querySelectorAll('th,td')).map(
      // deno-lint-ignore no-explicit-any
      (c: any) => c.textContent?.trim().toLowerCase() ?? '',
    )
    const retailIdx = headers.indexOf('retail')
    if (retailIdx === -1) continue

    const bodyRows = Array.from(table.querySelectorAll('tbody tr'))
    const dataRows = bodyRows.length > 0 ? bodyRows : Array.from(table.querySelectorAll('tr')).slice(1)
    // deno-lint-ignore no-explicit-any
    const lastRow = dataRows.at(-1) as any
    if (!lastRow) continue
    const cells = Array.from(lastRow.querySelectorAll('td,th'))
    // deno-lint-ignore no-explicit-any
    const value = (cells[retailIdx] as any)?.textContent?.replace(/\s+/g, '').trim()
    if (value) result.retail_subscription_rate = value
    break
  }

  // Category-wise reservation % (retail/QIB/NII/anchor/...) lives in an embedded
  // JSON payload for the reservation chart — this is the real per-IPO split,
  // not a fixed 35%, since it varies by issue (SBI Mutual Fund was 31.66%).
  const chartDataEl = doc.querySelector('#ipo-reservation-chart-data')
  const rawChartData = chartDataEl?.textContent?.trim()
  let retailPct: number | null = null
  if (rawChartData) {
    try {
      const parsed = JSON.parse(rawChartData)
      if (typeof parsed.retail === 'number') retailPct = parsed.retail
    } catch {
      // not JSON or shape changed — retail_issue_size stays null below
    }
  }

  if (retailPct != null && result.issue_size) {
    const amt = parseAmountText(result.issue_size)
    if (amt) {
      const retailValue = amt.value * (retailPct / 100)
      result.retail_issue_size = `₹${retailValue.toFixed(2)} ${amt.unit} (${retailPct}%)`.trim()
    }
  }

  return result
}
