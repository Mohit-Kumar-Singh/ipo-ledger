// "Paste results" on the Allotment board: the admin checks results by hand
// (NSE's verify-bids page or the registrar's — both sit behind reCAPTCHA,
// so there's no scripted lookup), then pastes whatever they've collected —
// a typed list, a column copied from a spreadsheet, a WhatsApp message —
// and every application number found in it is marked Allotted in one go.
//
// Matching is on the application number only (the PAN is stored masked, so
// there's nothing to match a pasted PAN against). Tokens are any run of
// letters/digits at least 6 long that contains a digit — long enough to
// skip words like "allotted" or holder names, loose enough for both
// all-digit NSE numbers and broker-prefixed alphanumeric ones.

export interface PasteMatchRow {
  application_id: string
  ipoji_app_number: string | null
}

export interface PasteMatchResult {
  // application_ids whose number appeared in the pasted text
  matchedIds: string[]
  // Number-looking tokens that matched no pending application on this IPO,
  // shown back so a typo or a wrong-IPO paste is obvious.
  unmatched: string[]
}

function normalize(s: string): string {
  return s.replace(/[^0-9a-z]/gi, '').toUpperCase()
}

export function extractAppNumberTokens(text: string): string[] {
  const tokens = text.match(/[0-9a-z]+/gi) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    const n = normalize(t)
    if (n.length < 6 || !/\d/.test(n) || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

export function matchPastedAppNumbers(text: string, rows: PasteMatchRow[]): PasteMatchResult {
  const byNumber = new Map<string, string>()
  for (const r of rows) {
    if (r.ipoji_app_number) byNumber.set(normalize(r.ipoji_app_number), r.application_id)
  }
  const matched = new Set<string>()
  const unmatched: string[] = []
  for (const token of extractAppNumberTokens(text)) {
    const id = byNumber.get(token)
    if (id) matched.add(id)
    else unmatched.push(token)
  }
  return { matchedIds: [...matched], unmatched }
}
