// Pure parsing / matching helpers for the ipoji sync: turning scraped rows
// into portal IPOs, accounts, funders, lots and mandate states. Kept out of the
// sync panel component so they can be unit tested (ipojiMatching.test.ts).
import type { BankAccount, DematAccount, Ipo, MandateStatus } from '../types/database'

export interface ScrapedRow {
  ipo: string
  applicant: string
  appNumber: string
  status: string
  // Straight off ipoji's own card ("Qty"/"Amount" fields) — used to derive
  // the real lot count (qty ÷ the matched IPO's lot size) instead of always
  // assuming 1 lot, see computeLotsAndAmount.
  qty?: string
  amount?: string
  upiId?: string
  panNumber?: string
  // 'SHAREHOLDER' when ipoji marks the bid as a shareholder-quota one,
  // otherwise 'RETAIL'. Older pastes (before the script captured it) have
  // neither field and are treated as RETAIL, exactly as before.
  category?: 'SHAREHOLDER' | 'RETAIL'
  // The exact ipoji text that made this a shareholder bid, and the card's raw
  // lines — diagnostics only, never written to the database.
  categoryText?: string
  _card?: string
  _sheet?: string
  // Diagnostic only, set by the scrape script when it couldn't open/read the
  // UPI/PAN detail sheet for a row — surfaces what actually happened on a
  // phone (no DevTools console there) so it round-trips into this app
  // instead of being invisible. Never written back to the database.
  _debug?: string
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ipoji's own shorthand comes in two different styles, not just one — a
// truncated/caps prefix of the name ("DHOOTTRANS" for "Dhoot Transmission"),
// which the prefix/substring check below covers, OR a first-letter acronym
// of each word ("BLEL" for "Behari Lal Engineering Limited" — none of
// DHOOTTRANS's rules matched that one at all, since "blel" isn't a prefix,
// suffix, or substring of "beharilalengineeringlimited"). Both are real,
// observed ipoji abbreviation styles, so both get checked.
export function acronym(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toLowerCase()
}

export function nameMatches(ipojiName: string, companyName: string): boolean {
  const n = normalize(ipojiName)
  if (!n) return false
  const full = normalize(companyName)
  if (full.startsWith(n) || n.startsWith(full) || full.includes(n)) return true
  const acr = acronym(companyName)
  return acr.length > 0 && (acr === n || acr.startsWith(n) || n.startsWith(acr))
}

// Every IPO the ipoji name could plausibly mean — by company name, or by
// its NSE/BSE ticker when ipoji's shorthand is the ticker itself
// ("ADROITIND").
export function matchIpoCandidates(ipojiName: string, ipos: Ipo[]): Ipo[] {
  const n = normalize(ipojiName)
  if (!n) return []
  return ipos.filter((i) => nameMatches(ipojiName, i.company_name) || (!!i.symbol && normalize(i.symbol) === n))
}

export function matchIpo(ipojiName: string, ipos: Ipo[]): Ipo | null {
  // A generic/short shorthand can substring-match more than one IPO's
  // company_name (nameMatches' `full.includes(n)` rule) — silently taking
  // the first (array-order, not intent) risked filing a bid under the wrong
  // IPO entirely. Two narrow, deterministic tie-breaks are allowed before
  // giving up: an exact name/ticker match beats a prefix/substring one, and
  // a single still-active IPO beats archived (settled) ones. Anything still
  // ambiguous after that is "not found" — surfaced in the preview's
  // "map to existing IPO" picker rather than guessed at.
  const matches = matchIpoCandidates(ipojiName, ipos)
  if (matches.length <= 1) return matches[0] ?? null
  const n = normalize(ipojiName)
  const exact = matches.filter((i) => normalize(i.company_name) === n || (!!i.symbol && normalize(i.symbol) === n))
  if (exact.length === 1) return exact[0]
  const active = (exact.length > 1 ? exact : matches).filter((i) => !i.is_archived)
  return active.length === 1 ? active[0] : null
}

export function upiKey(upiId: string | undefined): string {
  return upiId?.trim().toLowerCase() ?? ''
}

// A remembered mapping only counts while its target still exists — an IPO
// or bank account deleted since then silently falls back to auto-matching.
export function aliasedIpo(aliases: Record<string, string>, ipojiName: string, pool: Ipo[]): Ipo | null {
  const id = aliases[normalize(ipojiName)]
  return id ? (pool.find((i) => i.id === id) ?? null) : null
}

export function aliasedBank(aliases: Record<string, string>, upiId: string | undefined, banks: BankAccount[]): BankAccount | null {
  const id = aliases[upiKey(upiId)]
  return id ? (banks.find((b) => b.id === id) ?? null) : null
}

export function matchDematByName(applicantName: string, accounts: DematAccount[]): DematAccount | null {
  const n = normalize(applicantName)
  if (!n) return null
  const exact = accounts.filter((a) => normalize(a.holder_name) === n)
  if (exact.length > 0) return exact.length === 1 ? exact[0] : null
  // First-token match ("Manya Singh" vs a holder_name that starts "Manya…")
  // catches the common case of a nickname/short form without over-matching
  // on a bare surname shared by multiple accounts — but two linked accounts
  // sharing a first name ("Manya Singh" and "Manya Gupta") used to silently
  // resolve to whichever came first alphabetically, misattributing a bid to
  // the wrong person. Ambiguous now returns null ("not found", reviewed by
  // hand) instead of guessing.
  const firstToken = applicantName.trim().split(/\s+/)[0]
  const nt = normalize(firstToken)
  const byFirstToken = accounts.filter((a) => normalize(a.holder_name.split(/\s+/)[0]) === nt)
  return byFirstToken.length === 1 ? byFirstToken[0] : null
}

// PAN is never stored in plaintext (see reveal-pan / PAN_KEY in
// CLAUDE.md) — but demat_accounts.pan_hash is sha256(upper(pan)), computed
// the same way at insert time (0006_update_demat_encrypted.sql). Hashing
// the scraped PAN client-side with the same algorithm and comparing hashes
// gives an exact, unique match without ever decrypting anything — strictly
// better than the name-based fallback below, which can collide (two
// "Arpit"s) or miss on a nickname.
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function matchDemat(
  applicantName: string,
  panNumber: string | undefined,
  accounts: DematAccount[],
): Promise<{ account: DematAccount | null; byPan: boolean }> {
  if (panNumber?.trim()) {
    const hash = await sha256Hex(panNumber.trim().toUpperCase())
    const byPan = accounts.find((a) => a.pan_hash === hash)
    if (byPan) return { account: byPan, byPan: true }
  }
  return { account: matchDematByName(applicantName, accounts), byPan: false }
}

// UPI IDs are exact identifiers, not names — no fuzz here. This is what
// actually lets the sync attribute an application to the right funder
// (bank_account_id) instead of leaving it unset, which is the whole point
// of pulling UPI ID off ipoji at all.
export function matchBank(upiId: string | undefined, banks: BankAccount[]): BankAccount | null {
  if (!upiId?.trim()) return null
  const n = upiId.trim().toLowerCase()
  return banks.find((b) => b.upi_id?.trim().toLowerCase() === n) ?? null
}

// A single malformed row (observed: a truncated/garbled UPI ID producing
// invalid JSON for just that one object — cause unconfirmed, but it's
// scoped to one row, not the whole payload) used to fail the ENTIRE paste
// with one generic error, discarding otherwise-good rows. Parse the array
// as a whole first (the common, fully-valid case); only if that fails, fall
// back to splitting on top-level object boundaries and parsing each row
// independently, so one bad row is skipped and reported instead of blocking
// everything else.
// Best-effort identification for a row whose JSON is too broken to parse —
// pulls whatever plain-text fragments still look like "applicant":"...",
// "panNumber":"...", "ipo":"..." out of the raw (invalid) substring via
// regex, so a skipped row can be reported as "Parnita (PAN CHJPP2137B,
// DHOOTTRANS)" instead of just "1 row skipped" with no way to know which
// application needs adding by hand.
export function identifyBrokenRow(raw: string): string {
  const field = (name: string) => raw.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`))?.[1]
  const parts = [field('applicant'), field('panNumber') && `PAN ${field('panNumber')}`, field('ipo')].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : 'unidentified row'
}

export function parseScrapedRows(text: string): { rows: ScrapedRow[]; skippedLabels: string[] } {
  try {
    const whole = JSON.parse(text)
    if (Array.isArray(whole)) return { rows: whole, skippedLabels: [] }
  } catch {
    // fall through to per-row recovery below
  }
  const inner = text.trim().replace(/^\[/, '').replace(/\]\s*$/, '')
  const parts = inner.split(/}\s*,\s*{/)
  const rows: ScrapedRow[] = []
  const skippedLabels: string[] = []
  parts.forEach((part, i) => {
    const withBraces = (i > 0 ? '{' : '') + part + (i < parts.length - 1 ? '}' : '')
    try {
      const obj = JSON.parse(withBraces)
      rows.push(obj)
    } catch {
      skippedLabels.push(identifyBrokenRow(withBraces))
    }
  })
  return { rows, skippedLabels }
}

// ipoji's own Qty/Amount fields are scraped now (see ScrapedRow), so the
// real lot count is Qty ÷ the matched IPO's lot size — the previous
// hardcoded "always 1 lot" assumption only held because every application
// observed so far happened to be the retail default; a genuine multi-lot
// bid silently got treated as 1 lot with no way to tell from the preview
// table. Falls back to that old assumption only when Qty didn't parse
// cleanly (malformed scrape) or there's no matched IPO yet to divide by —
// `lotsGuessed` tells the caller which case happened.
export function computeLotsAndAmount(
  ipo: Ipo | null,
  qtyRaw: string | undefined,
  amountRaw: string | undefined,
): { lots: number | null; amount: number | null; lotsGuessed: boolean } {
  if (!ipo) return { lots: null, amount: null, lotsGuessed: false }
  const qtyNum = qtyRaw ? Number(qtyRaw.replace(/[^0-9.]/g, '')) : NaN
  const amountNum = amountRaw ? Number(amountRaw.replace(/[^0-9.]/g, '')) : NaN
  if (Number.isFinite(qtyNum) && qtyNum > 0 && ipo.lot_size) {
    const lots = Math.max(1, Math.round(qtyNum / ipo.lot_size))
    const amount =
      Number.isFinite(amountNum) && amountNum > 0
        ? amountNum
        : ipo.price_high != null
          ? ipo.lot_size * ipo.price_high * lots
          : null
    return { lots, amount, lotsGuessed: false }
  }
  return { lots: 1, amount: ipo.price_high != null ? ipo.lot_size * ipo.price_high : null, lotsGuessed: true }
}

// Best-effort mapping from ipoji's own free-text status to this app's
// mandate_status enum — ipoji's status line IS the UPI mandate lifecycle
// ("Bid placed successfully" / "Request Accepted By Sponsor Bank" both mean
// still awaiting the investor's UPI approval; "Accepted by Investor" means
// the investor actually approved it). Only three ipoji strings have been
// observed so far, so this leans on keyword matching rather than an exact
// lookup table — treated as a guess to review, not silently trusted; a
// reject/fail/expire keyword maps to CANCELLED, everything else PENDING.
export function guessMandateStatus(ipojiStatus: string): MandateStatus {
  const s = ipojiStatus.toLowerCase()
  if (s.includes('accepted by investor') || s.includes('mandate approved') || s.includes('approved')) return 'APPROVED'
  if (s.includes('reject') || s.includes('declin') || s.includes('fail') || s.includes('expir') || s.includes('cancel')) {
    return 'CANCELLED'
  }
  return 'PENDING'
}

// Every ipoji status string actually observed and accounted for above —
// anything outside this set falls through guessMandateStatus's default
// (PENDING) even though it isn't necessarily "still awaiting approval" at
// all. Real example: "Invalid Combination Of BOID and PAN" — that's ipoji
// itself rejecting the bid's own data (a demat detail mismatch), not a
// mandate waiting on the investor, and guessing PENDING for it would import
// a dead application looking like a normal in-progress one. Anything not
// matched here is surfaced as an unusual/unrecognized status for a manual
// look instead of being silently absorbed into "pending."
export function isKnownIpojiStatus(ipojiStatus: string): boolean {
  const s = ipojiStatus.toLowerCase()
  return (
    s.includes('accepted by investor') ||
    s.includes('mandate approved') ||
    s.includes('approved') ||
    s.includes('reject') ||
    s.includes('declin') ||
    s.includes('fail') ||
    s.includes('expir') ||
    s.includes('cancel') ||
    s.includes('bid placed') ||
    s.includes('accepted by sponsor bank') ||
    s.includes('pending')
  )
}
