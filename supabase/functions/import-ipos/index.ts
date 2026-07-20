// Admin-only. Fetches ipoji.com's current/upcoming IPO listing and parses out
// candidate rows for review in the UI. Nothing is written to the database here —
// this only returns candidates; the admin picks which ones to add via the
// existing Add IPO form, since ipoji's own data is sometimes TBA/N/A while our
// schema requires open_date, close_date and lot_size.
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

interface Candidate {
  company_name: string
  open_date: string | null
  close_date: string | null
  price_low: number | null
  price_high: number | null
  lot_size: number | null
  exchange: string | null
  source_url: string
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
  const source = typeof body.source === 'string' && body.source in SOURCES ? body.source : 'current'
  const url = SOURCES[source]

  let html: string
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IPOLedgerBot/1.0; +personal-use import tool)' },
    })
    if (!res.ok) throw new Error(`upstream returned ${res.status}`)
    html = await res.text()
  } catch (err) {
    return new Response(JSON.stringify({ error: `Could not fetch source: ${String(err)}` }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const doc = new DOMParser().parseFromString(html, 'text/html')
  if (!doc) {
    return new Response(JSON.stringify({ error: 'Could not parse source page' }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

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

    // deno-lint-ignore no-explicit-any
    for (const stat of Array.from(el.querySelectorAll('.ipo-card-body-stat')) as any[]) {
      const label = stat.querySelector('.ipo-card-secondary-label')?.textContent?.trim()
      const value = stat.querySelector('.ipo-card-body-value')?.textContent?.trim()
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
    }

    const onclick = el.getAttribute('onclick') ?? ''
    const link = onclick.match(/'(\/ipo\/[a-z0-9-]+)'/)?.[1]
    const source_url = link ? `https://www.ipoji.com${link}` : url

    candidates.push({ company_name: name, open_date, close_date, price_low, price_high, lot_size, exchange, source_url })
  }

  return new Response(JSON.stringify({ candidates, source, fetched_at: new Date().toISOString() }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
