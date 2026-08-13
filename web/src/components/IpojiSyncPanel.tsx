import { useState } from 'react'
import { InfoIcon } from '@primer/octicons-react'
import { supabase } from '../lib/supabase'
import { hasBiddingClosed } from '../lib/ipoStatus'
import type { BankAccount, DematAccount, Ipo, MandateStatus } from '../types/database'

// Deliberately ONE PAGE per run, not auto-paginated. An earlier version
// tried to detect and click ipoji's "Next" control automatically — with no
// visibility into ipoji's real pager markup, that guess ended up clicking
// the wrong element (observed: it left the list showing no results at all
// after advancing). Multi-page IPOs just mean running this script again
// after you click Next yourself — completely safe to do, since the portal
// dedupes by ipoji's own application number, so pasting page 2's output
// after page 1's only ever adds what's new.

// Console script the user runs themselves, once per page, while logged into
// ipoji in their own browser (Orders/Bids -> Current tab) — reads the page
// they're already looking at, opens each card's detail sheet for its UPI ID
// and PAN (the only place ipoji shows either), and copies a JSON summary to
// the clipboard. No ipoji credential ever touches this app; this only ever
// sees what the user explicitly pastes back in. Text-line heuristic (not
// brittle CSS selectors) because ipoji's classes are opaque Bootstrap
// utility names, not semantic — see IpojiSyncPanel below for why a shape
// mismatch fails loudly instead of silently importing garbage. The earlier
// "fast" no-click variant was dropped — PAN is what makes account matching
// reliable (name matching alone collides/misses), so there was no real case
// left for the version that skips it.
const SYNC_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const cards = [...document.querySelectorAll('.order-card-v2')];
  const rows = []; const errors = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const idx = (label) => lines.findIndex(l => l.toLowerCase() === label);
    // price/qty/amount labels are still used to LOCATE the status line —
    // their values aren't kept. Price and lot size are already in the
    // portal per-IPO; qty/amount default to the IPO's own minimum lot on
    // the portal side, editable by hand for the rare multi-lot application.
    const appIdx = idx('app'), priceIdx = idx('price'), qtyIdx = idx('qty'), amtIdx = idx('amount');
    if (appIdx < 2 || priceIdx < 0 || qtyIdx < 0 || amtIdx < 0) { errors.push({ card: i, stage: 'list' }); continue; }
    const row = {
      ipo: lines[0], applicant: lines[1],
      appNumber: lines[appIdx + 1] || '',
      status: lines[amtIdx + 2] || '', upiId: '', panNumber: '',
    };
    try {
      // Neither "first clickable child" (the refresh icon) nor the whole
      // card (triggers some other handler on ipoji's side — observed
      // throwing their own 'buildAccountForm is not defined' error, not
      // ours, and never opening the detail sheet) is the right target.
      // The chevron/arrow at the row's right edge is visually the LAST
      // icon in the card, distinct from the refresh icon at the top —
      // prefer that, walking up to its nearest clickable ancestor in case
      // the icon itself isn't the click handler's target.
      const icons = [...card.querySelectorAll('svg')];
      const chevron = icons.length > 1 ? icons[icons.length - 1] : null;
      const target = (chevron && (chevron.closest('button,a,[role="button"]') || chevron)) || card;
      target.click();
      let sheet = null;
      for (let t = 0; t < 15 && !sheet; t++) { await sleep(120); sheet = document.querySelector('#orderDetailSheet.show, #orderDetailSheet[aria-modal="true"]'); }
      if (sheet) {
        // A fixed sleep isn't enough — the fields animate in staggered
        // (each with its own animation-delay), and reading mid-transition
        // captured a BLEND of the previous card's still-fading-out text and
        // this card's still-fading-in text (observed: two cards' fields
        // concatenated into one garbled row). Poll until the body's text
        // stops changing between reads, so only a fully-settled sheet gets
        // read — 150ms/2-stable-reads is enough now that this only waits
        // on text settling, not a fixed worst-case guess.
        const body = sheet.querySelector('#orderDetailBody') || sheet;
        let prevText = null, stableReads = 0, text = '';
        for (let t = 0; t < 12 && stableReads < 2; t++) {
          await sleep(150);
          text = body.innerText || '';
          stableReads = text === prevText ? stableReads + 1 : 0;
          prevText = text;
        }
        const dLines = text.split('\\n').map(s => s.trim()).filter(Boolean);
        // Cross-check: the settled text must actually contain THIS card's
        // application number — if it doesn't, we're still looking at a
        // stale/wrong sheet (e.g. it never advanced past the previous
        // card), so don't trust anything read from it.
        if (row.appNumber && !dLines.some(l => l.includes(row.appNumber))) {
          errors.push({ card: i, stage: 'stale-sheet-content', gotText: text.slice(0, 200) });
        } else {
          const upiIdx = dLines.findIndex(l => l.toLowerCase() === 'upi id');
          if (upiIdx >= 0) row.upiId = dLines[upiIdx + 1] || '';
          const panIdx = dLines.findIndex(l => l.toLowerCase() === 'pan number');
          if (panIdx >= 0) row.panNumber = dLines[panIdx + 1] || '';
        }
        if (window.bootstrap?.Offcanvas) window.bootstrap.Offcanvas.getOrCreateInstance(sheet).hide();
        else (sheet.querySelector('.btn-close,[data-bs-dismiss="offcanvas"]') || {}).click?.();
        await sleep(200);
      } else {
        errors.push({ card: i, stage: 'detail-sheet-not-found' });
      }
    } catch (e) {
      errors.push({ card: i, stage: 'click', error: String(e) });
    }
    console.log('ipoji sync — card', i, row.upiId ? 'got UPI' : 'no UPI', row.panNumber ? 'got PAN' : 'no PAN');
    rows.push(row);
  }
  const out = JSON.stringify(rows);
  const done = () => alert('Copied ' + rows.length + ' application(s) from this page (' + rows.filter(r => r.upiId).length + ' with UPI ID, ' + rows.filter(r => r.panNumber).length + ' with PAN) to clipboard.' +
    (errors.length ? ' ' + errors.length + " card(s) had an issue — see console." : '') +
    '\\n\\nPaste into the sync panel now. If there are more pages, click Next on ipoji, then run this script again for that page.');
  navigator.clipboard.writeText(out).then(done).catch(() => prompt('Clipboard blocked — copy this manually (' + rows.length + ' found):', out));
  console.log('ipoji sync — parsed', rows, 'errors', errors);
})();`

interface ScrapedRow {
  ipo: string
  applicant: string
  appNumber: string
  status: string
  upiId?: string
  panNumber?: string
}

interface MatchedRow extends ScrapedRow {
  matchedIpo: Ipo | null
  matchedDemat: DematAccount | null
  dematMatchedByPan: boolean
  matchedBank: BankAccount | null
  existingId: string | null
  existingMandate: MandateStatus | null
  existingAppNumber: string | null
  guessedMandate: MandateStatus
  // Not scraped — assumed the IPO's own minimum lot (matches every real
  // application observed so far), computed once the IPO is matched.
  // Editable afterward like any manually entered application for the rare
  // case someone actually applied for more than one lot.
  lots: number | null
  amountNum: number | null
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ipoji shows truncated/caps company names ("DHOOTTRANS") that don't
// literally equal our full company_name ("Dhoot Transmission") — a prefix
// match on the normalized strings covers ipoji's actual abbreviation style
// without guessing at a fuzzy-distance threshold.
function matchIpo(ipojiName: string, ipos: Ipo[]): Ipo | null {
  const n = normalize(ipojiName)
  if (!n) return null
  return (
    ipos.find((i) => {
      const full = normalize(i.company_name)
      return full.startsWith(n) || n.startsWith(full) || full.includes(n)
    }) ?? null
  )
}

function matchDematByName(applicantName: string, accounts: DematAccount[]): DematAccount | null {
  const n = normalize(applicantName)
  if (!n) return null
  const exact = accounts.find((a) => normalize(a.holder_name) === n)
  if (exact) return exact
  // First-token match ("Manya Singh" vs a holder_name that starts "Manya…")
  // catches the common case of a nickname/short form without over-matching
  // on a bare surname shared by multiple accounts.
  const firstToken = applicantName.trim().split(/\s+/)[0]
  const nt = normalize(firstToken)
  return accounts.find((a) => normalize(a.holder_name.split(/\s+/)[0]) === nt) ?? null
}

// PAN is never stored in plaintext (see reveal-pan / PAN_KEY in
// CLAUDE.md) — but demat_accounts.pan_hash is sha256(upper(pan)), computed
// the same way at insert time (0006_update_demat_encrypted.sql). Hashing
// the scraped PAN client-side with the same algorithm and comparing hashes
// gives an exact, unique match without ever decrypting anything — strictly
// better than the name-based fallback below, which can collide (two
// "Arpit"s) or miss on a nickname.
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function matchDemat(
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
function matchBank(upiId: string | undefined, banks: BankAccount[]): BankAccount | null {
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
function identifyBrokenRow(raw: string): string {
  const field = (name: string) => raw.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`))?.[1]
  const parts = [field('applicant'), field('panNumber') && `PAN ${field('panNumber')}`, field('ipo')].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : 'unidentified row'
}

function parseScrapedRows(text: string): { rows: ScrapedRow[]; skippedLabels: string[] } {
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

// One lot at the IPO's cutoff (highest) price — the retail default every
// scraped application in practice matched exactly (ipoji's own qty/amount
// were always lot_size and lot_size*price_high respectively before this was
// dropped from scraping). Not scraped per-application anymore; see the
// MatchedRow.lots comment for the multi-lot edge case this accepts.
function defaultLotsAndAmount(ipo: Ipo | null): { lots: number | null; amount: number | null } {
  if (!ipo) return { lots: null, amount: null }
  const lots = 1
  const amount = ipo.price_high != null ? ipo.lot_size * ipo.price_high : null
  return { lots, amount }
}

// Best-effort mapping from ipoji's own free-text status to this app's
// mandate_status enum — ipoji's status line IS the UPI mandate lifecycle
// ("Bid placed successfully" / "Request Accepted By Sponsor Bank" both mean
// still awaiting the investor's UPI approval; "Accepted by Investor" means
// the investor actually approved it). Only three ipoji strings have been
// observed so far, so this leans on keyword matching rather than an exact
// lookup table — treated as a guess to review, not silently trusted; a
// reject/fail/expire keyword maps to CANCELLED, everything else PENDING.
function guessMandateStatus(ipojiStatus: string): MandateStatus {
  const s = ipojiStatus.toLowerCase()
  if (s.includes('accepted by investor') || s.includes('mandate approved') || s.includes('approved')) return 'APPROVED'
  if (s.includes('reject') || s.includes('declin') || s.includes('fail') || s.includes('expir') || s.includes('cancel')) {
    return 'CANCELLED'
  }
  return 'PENDING'
}

export function IpojiSyncPanel({
  open,
  ipos,
  accounts,
  banks,
  existingByKey,
  onImported,
  lookupsLoading,
}: {
  // Owned by the parent, not this component — the trigger button lives in
  // the page's own "+ New application"/"+ Backdated application" row, not
  // beside the panel body, so the open/close state has to live where both
  // pieces can see it.
  open: boolean
  ipos: Ipo[]
  accounts: DematAccount[]
  banks: BankAccount[]
  existingByKey: Map<string, { id: string; mandate_status: MandateStatus; ipoji_app_number: string | null }>
  onImported: () => void
  lookupsLoading: boolean
}) {
  const [scriptCopied, setScriptCopied] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [rows, setRows] = useState<MatchedRow[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{
    created: number
    alreadyExisted: number
    mandateUpdated: number
    appNumbersBackfilled: number
    failed: number
  } | null>(null)
  const [errorDetails, setErrorDetails] = useState<string[]>([])

  async function handleParse() {
    setResult(null)
    const { rows: scraped, skippedLabels } = parseScrapedRows(pasteText)
    if (scraped.length === 0) {
      setParseError('Could not read that as sync data — make sure you pasted the exact clipboard content the script copied.')
      setRows(null)
      return
    }
    setParseError(
      skippedLabels.length > 0
        ? `Couldn't read ${skippedLabels.length} row(s), add manually: ${skippedLabels.join('; ')}. The rest parsed fine below.`
        : null,
    )
    const matched: MatchedRow[] = await Promise.all(
      scraped.map(async (r) => {
        const matchedIpo = matchIpo(r.ipo, ipos)
        const { account: matchedDemat, byPan: dematMatchedByPan } = await matchDemat(r.applicant, r.panNumber, accounts)
        const matchedBank = matchBank(r.upiId, banks)
        const { lots, amount: amountNum } = defaultLotsAndAmount(matchedIpo)
        const existing = matchedIpo && matchedDemat ? existingByKey.get(`${matchedIpo.id}_${matchedDemat.id}`) : undefined
        return {
          ...r,
          matchedIpo,
          matchedDemat,
          dematMatchedByPan,
          matchedBank,
          existingId: existing?.id ?? null,
          existingMandate: existing?.mandate_status ?? null,
          existingAppNumber: existing?.ipoji_app_number ?? null,
          guessedMandate: guessMandateStatus(r.status),
          lots,
          amountNum,
        }
      }),
    )
    setRows(matched)
  }

  const toCreate = (rows ?? []).filter((r) => r.matchedIpo && r.matchedDemat && !r.existingId && r.lots)
  // Only ever move PENDING -> a decided state here — never overwrite a
  // mandate this app already has a real decision for, in case ipoji's
  // status text and this app's own state ever disagree for a legitimate
  // reason (e.g. an admin manually cancelled a mandate ipoji still shows as
  // pending).
  const toUpdateMandate = (rows ?? []).filter(
    (r) => r.existingId && r.existingMandate === 'PENDING' && r.guessedMandate !== 'PENDING',
  )
  // An application that already exists here but was created before this
  // sync (or backdated/manually) never got ipoji's own App number recorded
  // — backfill it now that we have it, so the portal shows something
  // checkable against ipoji even for older rows.
  const toBackfillAppNumber = (rows ?? []).filter((r) => r.existingId && !r.existingAppNumber && r.appNumber)

  async function handleImport() {
    setSubmitting(true)
    setErrorDetails([])
    const [createOutcomes, mandateOutcomes, appNumberOutcomes] = await Promise.all([
      Promise.all(
        toCreate.map(async (r) => {
          const { data: inserted, error } = await supabase
            .from('applications')
            .insert({
              ipo_id: r.matchedIpo!.id,
              demat_id: r.matchedDemat!.id,
              bank_account_id: r.matchedBank?.id ?? null,
              category: 'RETAIL',
              lots: r.lots!,
              bid_amount: r.amountNum,
              // Was hardcoded true — every ipoji-synced application showed
              // the "Backdated" badge even when it was a completely normal
              // same-window application, just recorded via sync instead of
              // by hand. Only genuinely true once this IPO's bidding has
              // actually closed (see hasBiddingClosed's 4:50pm IST cutoff).
              is_backdated: hasBiddingClosed(r.matchedIpo!),
              imported_from_ipoji: true,
              ipoji_app_number: r.appNumber,
            })
            .select('id')
            .single()
          // A guessed non-PENDING mandate on a brand-new row goes through
          // the same ipoji-sourced RPC as an update — best-effort, doesn't
          // fail the whole row if this second call errors (the application
          // itself was still created fine; worst case its mandate just
          // stays PENDING for a manual look).
          if (!error && inserted && r.guessedMandate !== 'PENDING') {
            const { error: mandateErr } = await supabase.rpc('set_mandate_status_from_ipoji', {
              p_application_id: inserted.id,
              p_status: r.guessedMandate,
            })
            if (mandateErr) {
              console.error('ipoji sync — initial mandate set failed for', r.matchedDemat?.holder_name, r.matchedIpo?.company_name, mandateErr)
            }
          }
          // 23505 = unique_violation on (ipo_id, demat_id) — this pair was
          // already applied for, most likely by an earlier sync run whose
          // result this panel's local existingByKey hadn't picked up yet
          // (created between page loads/parses). Same "duplicate insert
          // race -> treat as already-there, not a failure" handling this
          // app already uses for IPO upserts, not a new pattern.
          const alreadyExists = error?.code === '23505'
          if (error && !alreadyExists) {
            console.error('ipoji sync — insert failed for', r.matchedDemat?.holder_name, r.matchedIpo?.company_name, error)
          }
          return {
            ok: !error || alreadyExists,
            skipped: alreadyExists,
            label: `${r.matchedDemat?.holder_name} / ${r.matchedIpo?.company_name}`,
            error: alreadyExists ? null : error,
          }
        }),
      ),
      Promise.all(
        toUpdateMandate.map(async (r) => {
          // Not set_mandate_status — this is a guess derived from ipoji's
          // status text, not a reviewed human decision, so it shouldn't
          // show up as "marked by <the admin running the sync>" in the UI.
          const { error } = await supabase.rpc('set_mandate_status_from_ipoji', {
            p_application_id: r.existingId,
            p_status: r.guessedMandate,
          })
          if (error) console.error('ipoji sync — mandate update failed for', r.matchedDemat?.holder_name, r.matchedIpo?.company_name, error)
          return { ok: !error, label: `${r.matchedDemat?.holder_name} / ${r.matchedIpo?.company_name} (mandate)`, error }
        }),
      ),
      Promise.all(
        toBackfillAppNumber.map(async (r) => {
          const { error } = await supabase
            .from('applications')
            .update({ ipoji_app_number: r.appNumber })
            .eq('id', r.existingId)
          if (error) console.error('ipoji sync — app number backfill failed for', r.matchedDemat?.holder_name, r.matchedIpo?.company_name, error)
          return { ok: !error, label: `${r.matchedDemat?.holder_name} / ${r.matchedIpo?.company_name} (app #)`, error }
        }),
      ),
    ])
    setSubmitting(false)
    const created = createOutcomes.filter((o) => o.ok && !o.skipped).length
    const alreadyExisted = createOutcomes.filter((o) => o.skipped).length
    const mandateUpdated = mandateOutcomes.filter((o) => o.ok).length
    const appNumbersBackfilled = appNumberOutcomes.filter((o) => o.ok).length
    const failed =
      createOutcomes.filter((o) => !o.ok).length +
      mandateOutcomes.filter((o) => !o.ok).length +
      appNumberOutcomes.filter((o) => !o.ok).length
    setErrorDetails(
      [...createOutcomes, ...mandateOutcomes, ...appNumberOutcomes]
        .filter((o) => !o.ok)
        .map((o) => `${o.label}: ${o.error?.message ?? 'unknown error'}`),
    )
    setResult({ created, alreadyExisted, mandateUpdated, appNumbersBackfilled, failed })
    setRows(null)
    setPasteText('')
    if (created > 0 || mandateUpdated > 0 || appNumbersBackfilled > 0) onImported()
  }

  if (!open) return null

  return (
    <div className="card mt-3 space-y-4 p-5">
      <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
                1. Copy the sync script
              </p>
              {/* Native title tooltip on hover — full instructions live here
                  instead of as permanent on-page text/code blocks, so the
                  Applications page stays clean when this panel isn't in use. */}
              <span
                title={
                  'Open ipoji.com/bids → Orders/Bids → Current tab in your own browser. ' +
                  'Open DevTools (F12) → Console, paste the copied script, press Enter. ' +
                  "It only reads the page you're already logged into (opening each card's " +
                  'detail sheet for its UPI ID and PAN) and copies a summary to your clipboard — ' +
                  'your ipoji login never touches this app.\n\n' +
                  'If ipoji\'s list has more than one page, this only reads the current page. ' +
                  'Paste this page\'s result below, then click Next on ipoji and run the script ' +
                  'again for the next page — running it multiple times and pasting each result ' +
                  'is safe, already-applied entries are automatically skipped.\n\n' +
                  "Lots/amount aren't scraped — they're assumed to be 1 lot at the IPO's own " +
                  'cutoff price (true for every application seen so far); edit an imported ' +
                  'application afterward if someone actually applied for more than one lot.'
                }
                style={{ cursor: 'help', display: 'inline-flex' }}
              >
                <InfoIcon size={14} fill="var(--ink-muted)" />
              </span>
            </div>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(SYNC_SCRIPT)
                setScriptCopied(true)
                setTimeout(() => setScriptCopied(false), 1500)
              }}
              className="btn-secondary mt-2"
            >
              {scriptCopied ? 'Copied — paste it into ipoji\'s console' : 'Copy sync script'}
            </button>
          </div>

          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
              2. Paste what it copied
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste the clipboard content here…"
              className="input mt-2 h-24 w-full font-mono text-xs"
            />
            {parseError && (
              <p className="mt-1 text-xs" style={{ color: 'var(--critical-text)' }}>
                {parseError}
              </p>
            )}
            <button
              onClick={handleParse}
              disabled={!pasteText.trim() || lookupsLoading}
              className="btn-secondary mt-2"
            >
              {lookupsLoading ? 'Loading IPOs/accounts…' : 'Preview'}
            </button>
          </div>

          {rows && (
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
                3. Review before importing ({toCreate.length} new, {toUpdateMandate.length} mandate update
                {toUpdateMandate.length === 1 ? '' : 's'}, {toBackfillAppNumber.length} app # backfill
                {toBackfillAppNumber.length === 1 ? '' : 's'} of {rows.length} found)
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                Mandate status is a best-effort guess from ipoji's own status text — double-check it
                rather than treating it as certain.
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ color: 'var(--ink-muted)' }}>
                      <th className="p-1.5 text-left">ipoji IPO</th>
                      <th className="p-1.5 text-left">Matched IPO</th>
                      <th className="p-1.5 text-left">ipoji account</th>
                      <th className="p-1.5 text-left">Matched account</th>
                      <th className="p-1.5 text-left">Lots / amount</th>
                      <th className="p-1.5 text-left">Funder (UPI)</th>
                      <th className="p-1.5 text-left">Mandate</th>
                      <th className="p-1.5 text-left">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
                        <td className="p-1.5">{r.ipo}</td>
                        <td className="p-1.5">
                          {r.matchedIpo ? r.matchedIpo.company_name : <span style={{ color: 'var(--critical-text)' }}>not found</span>}
                        </td>
                        <td className="p-1.5">{r.applicant}</td>
                        <td className="p-1.5">
                          {r.matchedDemat ? (
                            <>
                              {r.matchedDemat.holder_name}{' '}
                              <span style={{ color: r.dematMatchedByPan ? 'var(--good-text)' : 'var(--warning-text)' }}>
                                ({r.dematMatchedByPan ? 'by PAN' : 'by name'})
                              </span>
                            </>
                          ) : (
                            <span style={{ color: 'var(--critical-text)' }}>not found</span>
                          )}
                        </td>
                        <td className="p-1.5">
                          {r.lots != null ? `${r.lots} lot${r.lots === 1 ? '' : 's'}` : '—'}
                          {r.amountNum != null && (
                            <span style={{ color: 'var(--ink-muted)' }}> (₹{r.amountNum.toLocaleString('en-IN')})</span>
                          )}
                        </td>
                        <td className="p-1.5">
                          {!r.upiId ? (
                            <span style={{ color: 'var(--ink-muted)' }}>—</span>
                          ) : r.matchedBank ? (
                            r.matchedBank.account_holder_name ?? r.upiId
                          ) : (
                            <span title={r.upiId} style={{ color: 'var(--warning-text)' }}>
                              no funder account for {r.upiId}
                            </span>
                          )}
                        </td>
                        <td className="p-1.5">{r.guessedMandate}</td>
                        <td className="p-1.5">
                          {r.existingId ? (
                            toUpdateMandate.includes(r) ? (
                              <span style={{ color: 'var(--accent)' }}>update mandate → {r.guessedMandate}</span>
                            ) : toBackfillAppNumber.includes(r) ? (
                              <span style={{ color: 'var(--accent)' }}>backfill app # {r.appNumber}</span>
                            ) : (
                              <span style={{ color: 'var(--ink-muted)' }}>already applied</span>
                            )
                          ) : r.matchedIpo && r.matchedDemat && r.lots ? (
                            <span style={{ color: 'var(--good-text)' }}>will import</span>
                          ) : (
                            <span style={{ color: 'var(--critical-text)' }}>skip</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {toCreate.length === 0 && toUpdateMandate.length === 0 && toBackfillAppNumber.length === 0 ? (
                // Nothing actionable (e.g. every row was already applied) —
                // this used to leave Import disabled with no way off the
                // review table short of closing the whole panel. Same spot,
                // same size, but now just clears the preview so the next
                // page's paste can go straight in.
                <button
                  onClick={() => {
                    setRows(null)
                    setPasteText('')
                  }}
                  className="btn-secondary mt-3"
                >
                  Nothing to import — clear
                </button>
              ) : (
                <button onClick={handleImport} disabled={submitting} className="btn-primary mt-3">
                  {submitting
                    ? 'Importing…'
                    : `Import ${toCreate.length}, update ${toUpdateMandate.length} mandate(s), backfill ${toBackfillAppNumber.length} app #`}
                </button>
              )}
            </div>
          )}

          {result && (
            <div>
              <p className="text-xs" style={{ color: result.failed ? 'var(--critical-text)' : 'var(--good-text)' }}>
                Imported {result.created} application(s), updated {result.mandateUpdated} mandate(s),
                backfilled {result.appNumbersBackfilled} app number(s)
                {result.alreadyExisted ? `, ${result.alreadyExisted} already existed (skipped)` : ''}
                {result.failed ? `, ${result.failed} failed` : ''}.
              </p>
              {errorDetails.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-xs" style={{ color: 'var(--critical-text)' }}>
                  {errorDetails.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
    </div>
  )
}
