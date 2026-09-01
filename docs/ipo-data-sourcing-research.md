# IPO data sourcing — research notes (2026-09-01)

Captured from a live investigation into (a) why the live-share-price feature
was dormant, and (b) whether ipoji.com could be replaced/supplemented for
IPO calendar + GMP data. Nothing here was deployed as a result — informational
only, for whoever picks this up next.

## Current pipeline (as-is)

- `supabase/functions/_shared/ipoji.ts` scrapes ipoji.com's public HTML
  (`/ipo/current-ipo`, `/ipo/upcoming-ipo`, plus each IPO's detail page) —
  no official API. Used by `import-ipos` (admin, on-demand) and
  `auto-import-ipos` (cron, every 4h). Fields: company name, open/close date,
  price band, lot size, exchange, GMP text, issue size, allotment date,
  listing date, registrar, subscription rate, allotment-out status.
- `supabase/functions/_shared/stockPrice.ts` + `fetch-stock-price` get a
  *live share price* (post-listing) from Yahoo Finance's unofficial chart
  endpoint — `stock_price_cache` table, 15-min freshness.
- `supabase/functions/_shared/resolveSymbol.ts` (added 2026-09-01,
  v1.209.0/1.209.1) auto-fills `ipos.symbol` for a newly-listed IPO so the
  above can find it without manual entry — see that file's own comments for
  the two-strategy approach (Yahoo search by name, then direct ticker-guess
  against the chart endpoint).

## Where each field actually originates, and whether we can fetch it ourselves

| Field | True source | Directly fetchable server-side? |
|---|---|---|
| Open/close date, price band, lot size, issue size, registrar | NSE/BSE's own official "Public Issues" pages, or the RHP filed with SEBI | **No, not from NSE.** Confirmed live: `nseindia.com/api/search/autocomplete` and `nseindia.com/market-data/...` both hung and timed out on a plain server-side fetch — Cloudflare/Akamai-style bot protection, not a missing endpoint. This is the same reason `fetch-stock-price` already goes through Yahoo instead of NSE for live prices. |
| Same fields, alternate free aggregators | Chittorgarh.com, InvestorGain.com | **Chittorgarh: no** — `chittorgarh.com/report/latest-ipo-gmp-grey-market-premium/89/` and `/ipo/ipo_dashboard.asp` both returned **403 Forbidden** on a plain fetch (tested live). Never tested InvestorGain. |
| Same fields, BSE | `bseindia.com/publicissue/publicissuecurr.aspx` | **Unclear, likely no** — the page loads (200) but a plain fetch only returns the header/nav shell; the actual issuer table is either client-rendered or loaded via a separate AJAX/postback call our fetch didn't trigger. Not a simple static-HTML scrape like ipoji.ts's approach. Untested with real browser automation (headless Chrome) — might work that way, at real infra cost. |
| GMP (grey market premium) | **Never official** — no exchange publishes this. It's collected by trackers (ipoji, Chittorgarh, InvestorGain) from dealer/broker networks. | No true source exists to go to instead of one of those trackers. |
| Live post-listing share price | NSE's real-time feed | Not directly (see NSE row above) — Yahoo Finance's unofficial endpoints are the workaround already in use, and were re-confirmed live and working on 2026-09-01. |

### Two different Yahoo endpoints — worth knowing apart

- `/v1/finance/search?q=<name>` — fuzzy name search. Good for verified
  name-matching, but **does not index a same-day new listing yet** (confirmed:
  returned zero results for two IPOs that listed that same morning).
- `/v8/finance/chart/<TICKER>.NS` — the actual live-quote endpoint (already
  used by `fetchStockPrice()`). **Already has same-day data** once a stock
  starts trading, even before the search index catches up — this is why
  `resolveSymbol.ts`'s second strategy (guess the ticker, probe this endpoint
  directly) succeeds where the search-based approach alone doesn't.

## Paid API pricing, if the free-scrape approach ever needs replacing

None of these solve the IPO-calendar/GMP problem (still nowhere but ipoji/
Chittorgarh/InvestorGain, since GMP is never official) — they're for live/
historical *share price* only, i.e. a hypothetical replacement for the Yahoo
workaround.

| Provider | Price | Notes |
|---|---|---|
| **Zerodha Kite Connect** | ₹500/month per API key | Real-time WebSocket + historical candles, NSE+BSE. Requires an actual Zerodha trading account behind the key — not just a signup. [zerodha.com/products/api](https://zerodha.com/products/api/) |
| **Upstox API** | Advertised free | Live WebSocket + orders; fine print on account/balance requirements wasn't confirmed. [upstox.com/developer](https://upstox.com/developer/api-documentation/open-api/) |
| **TrueData** | ₹1,440–₹2,800/month (Lite→Ultima tiers) + add-ons (extra symbols ₹99–₹2,000/mo, extra historical tick data ₹300–₹1,000/mo) | Pure data vendor, no trading account needed. NSE+BSE+MCX. [truedata.in/price](https://www.truedata.in/price) |
| **NSE direct** | Not published — "contact NSE sales" | Official leased-line/multicast feed; enterprise-grade infra, not a casual API. [nseindia.com/static/market-data/real-time-data-subscription](https://www.nseindia.com/static/market-data/real-time-data-subscription) |

**Take for this app**: since only one live price per symbol is needed (not
tick-by-tick), Kite Connect at ₹500/month is the cheapest realistic upgrade
path if Yahoo's unofficial endpoint ever breaks — but it needs a funded
Zerodha account wired to the API key, which is a real setup step. Not worth
doing pre-emptively; Yahoo is free and was reconfirmed working today.
