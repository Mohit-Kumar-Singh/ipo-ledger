import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { CopyButton } from './CopyButton'
import type { BankAccount, DematAccount, Ipo, MandateStatus } from '../types/database'

// Deliberately ONE PAGE per run, not auto-paginated. An earlier version
// tried to detect and click ipoji's "Next" control automatically — with no
// visibility into ipoji's real pager markup, that guess ended up clicking
// the wrong element (observed: it left the list showing no results at all
// after advancing). Multi-page IPOs just mean running this script again
// after you click Next yourself — completely safe to do, since the portal
// dedupes by ipoji's own application number, so pasting page 2's output
// after page 1's only ever adds what's new.

// Console script the user runs themselves, once per page, while logged
// into ipoji in their own browser (Orders/Bids -> Current tab) — reads the
// page they're already looking at and copies a JSON summary to the
// clipboard. No ipoji credential ever touches this app; this only ever sees
// what the user explicitly pastes back in. Text-line heuristic (not brittle
// CSS selectors) because ipoji's classes are opaque Bootstrap utility
// names, not semantic — see IpojiSyncPanel below for why a shape mismatch
// fails loudly instead of silently importing garbage.
const SYNC_SCRIPT_BASIC = `(() => {
  const cards = document.querySelectorAll('.order-card-v2');
  const rows = []; const errors = [];
  cards.forEach((card, i) => {
    const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const idx = (label) => lines.findIndex(l => l.toLowerCase() === label);
    const appIdx = idx('app'), priceIdx = idx('price'), qtyIdx = idx('qty'), amtIdx = idx('amount');
    if (appIdx < 2 || priceIdx < 0 || qtyIdx < 0 || amtIdx < 0) { errors.push({ card: i, lines }); return; }
    rows.push({
      ipo: lines[0], applicant: lines[1],
      appNumber: lines[appIdx + 1] || '', price: lines[priceIdx + 1] || '',
      qty: lines[qtyIdx + 1] || '', amount: lines[amtIdx + 1] || '',
      status: lines[amtIdx + 2] || '',
    });
  });
  const out = JSON.stringify(rows);
  const done = () => alert('Copied ' + rows.length + ' application(s) from this page to clipboard.' +
    (errors.length ? ' ' + errors.length + " card(s) didn't match the expected layout (skipped) — ipoji's page may have changed." : '') +
    '\\n\\nPaste into the sync panel now. If there are more pages, click Next on ipoji, then run this script again for that page.');
  navigator.clipboard.writeText(out).then(done).catch(() => prompt('Clipboard blocked — copy this manually (' + rows.length + ' found):', out));
  console.log('ipoji sync — parsed', rows, 'errors', errors);
})();`

// Slower variant — same single-page list-scrape, then clicks into each
// card's detail sheet (ipoji only shows UPI ID and PAN there, not on the
// list view) to pull both, so the portal can match by PAN — a real unique
// identifier, unlike names which collide/vary — and drive funder
// matching/messaging. This is the fragile half: it depends on ipoji's
// Bootstrap offcanvas markup and a click target inside each card, both
// best-effort — if a card's detail sheet doesn't open or doesn't contain a
// "UPI ID"/"PAN NUMBER" line within the timeout, that one field is left
// blank on that row and logged, never guessed at. Run the basic script
// above first if this one misbehaves — and if EVERY card fails to open its
// detail sheet, that's very likely a bug on ipoji's own site (observed:
// their own 'buildAccountForm is not defined' error), not this script.
const SYNC_SCRIPT_WITH_UPI = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const cards = [...document.querySelectorAll('.order-card-v2')];
  const rows = []; const errors = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const idx = (label) => lines.findIndex(l => l.toLowerCase() === label);
    const appIdx = idx('app'), priceIdx = idx('price'), qtyIdx = idx('qty'), amtIdx = idx('amount');
    if (appIdx < 2 || priceIdx < 0 || qtyIdx < 0 || amtIdx < 0) { errors.push({ card: i, stage: 'list' }); continue; }
    const row = {
      ipo: lines[0], applicant: lines[1],
      appNumber: lines[appIdx + 1] || '', price: lines[priceIdx + 1] || '',
      qty: lines[qtyIdx + 1] || '', amount: lines[amtIdx + 1] || '',
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
      for (let t = 0; t < 20 && !sheet; t++) { await sleep(150); sheet = document.querySelector('#orderDetailSheet.show, #orderDetailSheet[aria-modal="true"]'); }
      if (sheet) {
        await sleep(500); // let the staggered field animation finish
        const body = sheet.querySelector('#orderDetailBody') || sheet;
        const dLines = (body.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
        const upiIdx = dLines.findIndex(l => l.toLowerCase() === 'upi id');
        if (upiIdx >= 0) row.upiId = dLines[upiIdx + 1] || '';
        const panIdx = dLines.findIndex(l => l.toLowerCase() === 'pan number');
        if (panIdx >= 0) row.panNumber = dLines[panIdx + 1] || '';
        if (window.bootstrap?.Offcanvas) window.bootstrap.Offcanvas.getOrCreateInstance(sheet).hide();
        else (sheet.querySelector('.btn-close,[data-bs-dismiss="offcanvas"]') || {}).click?.();
        await sleep(300);
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
  console.log('ipoji sync (with UPI) — parsed', rows, 'errors', errors);
})();`

interface ScrapedRow {
  ipo: string
  applicant: string
  appNumber: string
  price: string
  qty: string
  amount: string
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
  guessedMandate: MandateStatus
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
function parseScrapedRows(text: string): { rows: ScrapedRow[]; skipped: number } {
  try {
    const whole = JSON.parse(text)
    if (Array.isArray(whole)) return { rows: whole, skipped: 0 }
  } catch {
    // fall through to per-row recovery below
  }
  const inner = text.trim().replace(/^\[/, '').replace(/\]\s*$/, '')
  const parts = inner.split(/}\s*,\s*{/)
  const rows: ScrapedRow[] = []
  let skipped = 0
  parts.forEach((part, i) => {
    const withBraces = (i > 0 ? '{' : '') + part + (i < parts.length - 1 ? '}' : '')
    try {
      const obj = JSON.parse(withBraces)
      rows.push(obj)
    } catch {
      skipped++
    }
  })
  return { rows, skipped }
}

function parseAmount(s: string): number | null {
  const n = Number(s.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
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
  ipos,
  accounts,
  banks,
  existingByKey,
  onImported,
  ensureLookupsLoaded,
  lookupsLoading,
}: {
  ipos: Ipo[]
  accounts: DematAccount[]
  banks: BankAccount[]
  existingByKey: Map<string, { id: string; mandate_status: MandateStatus }>
  onImported: () => void
  // IPOs/demat accounts are only fetched lazily (when the "New application"
  // form opens) — this panel can be opened without that ever having
  // happened, which silently left `ipos`/`accounts` empty and made every
  // row match as "not found". Call the same loader when this panel opens.
  ensureLookupsLoaded: () => void
  lookupsLoading: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [rows, setRows] = useState<MatchedRow[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ created: number; alreadyExisted: number; mandateUpdated: number; failed: number } | null>(
    null,
  )
  const [errorDetails, setErrorDetails] = useState<string[]>([])

  async function handleParse() {
    setResult(null)
    const { rows: scraped, skipped } = parseScrapedRows(pasteText)
    if (scraped.length === 0) {
      setParseError('Could not read that as sync data — make sure you pasted the exact clipboard content the script copied.')
      setRows(null)
      return
    }
    setParseError(
      skipped > 0
        ? `${skipped} row(s) couldn't be read (malformed) and were skipped — the rest parsed fine below.`
        : null,
    )
    const matched: MatchedRow[] = await Promise.all(
      scraped.map(async (r) => {
        const matchedIpo = matchIpo(r.ipo, ipos)
        const { account: matchedDemat, byPan: dematMatchedByPan } = await matchDemat(r.applicant, r.panNumber, accounts)
        const matchedBank = matchBank(r.upiId, banks)
        const lots = Number.isFinite(Number(r.qty)) ? Number(r.qty) : null
        const existing = matchedIpo && matchedDemat ? existingByKey.get(`${matchedIpo.id}_${matchedDemat.id}`) : undefined
        return {
          ...r,
          matchedIpo,
          matchedDemat,
          dematMatchedByPan,
          matchedBank,
          existingId: existing?.id ?? null,
          existingMandate: existing?.mandate_status ?? null,
          guessedMandate: guessMandateStatus(r.status),
          lots,
          amountNum: parseAmount(r.amount),
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

  async function handleImport() {
    setSubmitting(true)
    setErrorDetails([])
    const [createOutcomes, mandateOutcomes] = await Promise.all([
      Promise.all(
        toCreate.map(async (r) => {
          const { error } = await supabase.from('applications').insert({
            ipo_id: r.matchedIpo!.id,
            demat_id: r.matchedDemat!.id,
            bank_account_id: r.matchedBank?.id ?? null,
            category: 'RETAIL',
            lots: r.lots!,
            bid_amount: r.amountNum,
            is_backdated: true,
            imported_from_ipoji: true,
          })
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
          const { error } = await supabase.rpc('set_mandate_status', {
            p_application_id: r.existingId,
            p_status: r.guessedMandate,
          })
          if (error) console.error('ipoji sync — mandate update failed for', r.matchedDemat?.holder_name, r.matchedIpo?.company_name, error)
          return { ok: !error, label: `${r.matchedDemat?.holder_name} / ${r.matchedIpo?.company_name} (mandate)`, error }
        }),
      ),
    ])
    setSubmitting(false)
    const created = createOutcomes.filter((o) => o.ok && !o.skipped).length
    const alreadyExisted = createOutcomes.filter((o) => o.skipped).length
    const mandateUpdated = mandateOutcomes.filter((o) => o.ok).length
    const failed = createOutcomes.filter((o) => !o.ok).length + mandateOutcomes.filter((o) => !o.ok).length
    setErrorDetails(
      [...createOutcomes, ...mandateOutcomes]
        .filter((o) => !o.ok)
        .map((o) => `${o.label}: ${o.error?.message ?? 'unknown error'}`),
    )
    setResult({ created, alreadyExisted, mandateUpdated, failed })
    setRows(null)
    setPasteText('')
    if (created > 0 || mandateUpdated > 0) onImported()
  }

  return (
    <div>
      <button
        onClick={() => {
          setOpen((v) => !v)
          if (!open) ensureLookupsLoaded()
        }}
        className="btn-secondary"
      >
        {open ? 'Close sync panel' : 'Sync from ipoji'}
      </button>

      {open && (
        <div className="card mt-3 space-y-4 p-5">
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
              1. Run this while logged into ipoji
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Open ipoji.com/bids → Orders/Bids → Current tab in your own browser. Open DevTools (F12) →
              Console, paste one of the scripts below, press Enter. It only reads the page you're already
              logged into and copies a summary to your clipboard — your ipoji login never touches this
              app.
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
              If ipoji's list has more than one page, this only reads the current page. Paste this
              page's result below, then click Next on ipoji and run the same script again for the next
              page — running it multiple times and pasting each result is safe, already-applied entries
              are automatically skipped.
            </p>

            <p className="mt-3 text-xs font-medium" style={{ color: 'var(--ink-secondary)' }}>
              Fast — IPO, account, amount, status
            </p>
            <div className="relative mt-1">
              <pre
                className="max-h-28 overflow-auto rounded-md p-3 text-xs"
                style={{ background: 'var(--hover-surface)', color: 'var(--ink-secondary)' }}
              >
                {SYNC_SCRIPT_BASIC}
              </pre>
              <div className="absolute top-2 right-2">
                <CopyButton value={SYNC_SCRIPT_BASIC} label="script" />
              </div>
            </div>

            <p className="mt-3 text-xs font-medium" style={{ color: 'var(--ink-secondary)' }}>
              Slower — also opens each card to pull its UPI ID and PAN (for accurate account matching)
            </p>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Clicks into every card's detail sheet, so it takes longer and is more likely to need
              adjusting if ipoji's page changes. Use the fast one above if this misbehaves. PAN, when
              found, is matched exactly (no name guessing) — the review table shows which method matched
              each account.
            </p>
            <div className="relative mt-1">
              <pre
                className="max-h-28 overflow-auto rounded-md p-3 text-xs"
                style={{ background: 'var(--hover-surface)', color: 'var(--ink-secondary)' }}
              >
                {SYNC_SCRIPT_WITH_UPI}
              </pre>
              <div className="absolute top-2 right-2">
                <CopyButton value={SYNC_SCRIPT_WITH_UPI} label="script" />
              </div>
            </div>
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
                {toUpdateMandate.length === 1 ? '' : 's'} of {rows.length} found)
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
                      <th className="p-1.5 text-left">Qty</th>
                      <th className="p-1.5 text-left">Amount</th>
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
                        <td className="p-1.5">{r.qty}</td>
                        <td className="p-1.5">{r.amount}</td>
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
              <button
                onClick={handleImport}
                disabled={submitting || (toCreate.length === 0 && toUpdateMandate.length === 0)}
                className="btn-primary mt-3"
              >
                {submitting
                  ? 'Importing…'
                  : `Import ${toCreate.length} application(s), update ${toUpdateMandate.length} mandate(s)`}
              </button>
            </div>
          )}

          {result && (
            <div>
              <p className="text-xs" style={{ color: result.failed ? 'var(--critical-text)' : 'var(--good-text)' }}>
                Imported {result.created} application(s), updated {result.mandateUpdated} mandate(s)
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
      )}
    </div>
  )
}
