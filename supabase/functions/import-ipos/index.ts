// Admin-only. Two modes, both read-only — nothing is written to the database here:
//  - { mode: "list", source: "current" | "upcoming" }: parses ipoji.com's listing
//    page into candidate rows (company, dates, price band, lot size).
//  - { mode: "detail", detail_url: "<an ipoji.com /ipo/... url from a list result>" }:
//    parses that IPO's detail page for allotment date, listing date and exchange,
//    which only appear there, not on the list cards.
// The admin picks which ones to add via the existing Add IPO form, since ipoji's
// own data is sometimes TBA/N/A while our schema requires open_date, close_date
// and lot_size.
import { createClient } from 'npm:@supabase/supabase-js@2'
// deno-dom: HTML parsing for the scrape (no official ipoji API exists).
import { DOMParser } from 'https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts'
import { corsHeaders, handlePreflight } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const SOURCES: Record<string, string> = {
  current: 'https://www.ipoji.com/ipo/current-ipo',
  upcoming: 'https://www.ipoji.com/ipo/upcoming-ipo',
}
const USER_AGENT = 'Mozilla/5.0 (compatible; IPOLedgerBot/1.0; +personal-use import tool)'
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

interface Candidate {
  company_name: string
  open_date: string | null
  close_date: string | null
  price_low: number | null
  price_high: number | null
  lot_size: number | null
  exchange: string | null
  gmp: string | null
  source_url: string
}

interface Detail {
  allotment_date: string | null
  listing_date: string | null
  exchange: string | null
}

// "Jul 17, 2026" -> "2026-07-17". Manual parsing avoids Date() timezone shift bugs.
function parseIpojiDate(text: string): string | null {
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function handleList(source: string) {
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
      if (label === 'Exp. Premium') {
        gmp = `GMP: ${value}`
      }
    }

    const onclick = el.getAttribute('onclick') ?? ''
    const link = onclick.match(/'(\/ipo\/[a-z0-9-]+)'/)?.[1]
    const source_url = link ? `https://www.ipoji.com${link}` : url

    candidates.push({ company_name: name, open_date, close_date, price_low, price_high, lot_size, exchange, gmp, source_url })
  }

  return { candidates, source, fetched_at: new Date().toISOString() }
}

async function handleDetail(detailUrl: string) {
  if (!detailUrl.startsWith('https://www.ipoji.com/ipo/')) {
    throw new Error('detail_url must be an ipoji.com /ipo/ page')
  }
  const html = await fetchHtml(detailUrl)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc) throw new Error('Could not parse detail page')

  const result: Detail = { allotment_date: null, listing_date: null, exchange: null }

  // deno-lint-ignore no-explicit-any
  for (const item of Array.from(doc.querySelectorAll('.facts-row .fact-item')) as any[]) {
    const label = item.querySelector('.fact-label')?.textContent?.trim().toLowerCase() ?? ''
    const value = item.querySelector('.fact-value')?.textContent?.trim() ?? ''
    if (!value) continue

    if (label.includes('allotment date')) result.allotment_date = parseIpojiDate(value)
    else if (label === 'listing' || label.includes('listing') && !label.includes('at')) {
      const parsed = parseIpojiDate(value)
      if (parsed) result.listing_date = parsed
    } else if (label.includes('listing at')) result.exchange = value
  }

  return result
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req)
  if (preflight) return preflight

  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
  const { data: userData } = await admin.auth.getUser(jwt)
  if (!userData?.user) return new Response('unauthorized', { status: 401, headers: corsHeaders })

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single()
  if (profile?.role !== 'admin') return new Response('forbidden', { status: 403, headers: corsHeaders })

  const body = await req.json().catch(() => ({}))

  try {
    if (body.mode === 'detail') {
      if (typeof body.detail_url !== 'string') return jsonResponse({ error: 'detail_url is required' }, 400)
      return jsonResponse(await handleDetail(body.detail_url))
    }
    const source = typeof body.source === 'string' ? body.source : 'current'
    return jsonResponse(await handleList(source))
  } catch (err) {
    return jsonResponse({ error: String(err instanceof Error ? err.message : err) }, 502)
  }
})
