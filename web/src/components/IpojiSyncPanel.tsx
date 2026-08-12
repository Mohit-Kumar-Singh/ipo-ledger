import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { CopyButton } from './CopyButton'
import type { BankAccount, DematAccount, Ipo } from '../types/database'

// Console script the user runs themselves, once, while logged into ipoji in
// their own browser (Orders/Bids -> Current tab) — reads the DOM they're
// already looking at and copies a JSON summary to the clipboard. No ipoji
// credential ever touches this app; this only ever sees what the user
// explicitly pastes back in. Text-line heuristic (not brittle CSS selectors)
// because ipoji's classes are opaque Bootstrap utility names, not semantic —
// see IpojiSyncPanel below for why a shape mismatch fails loudly instead of
// silently importing garbage.
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
  const done = () => alert('Copied ' + rows.length + ' application(s) to clipboard.' +
    (errors.length ? ' ' + errors.length + " card(s) didn't match the expected layout (skipped) — ipoji's page may have changed." : '') +
    '\\n\\nNow paste into the IPO Ledger sync panel.');
  navigator.clipboard.writeText(out).then(done).catch(() => prompt('Clipboard blocked — copy this manually (' + rows.length + ' found):', out));
  console.log('ipoji sync — parsed', rows, 'errors', errors);
})();`

// Slower variant — same list-scrape, then clicks into each card's detail
// sheet (ipoji only shows UPI ID there, not on the list view) to pull that
// too, so it can drive funder matching/messaging in the portal instead of
// staying blank. This is the fragile half: it depends on ipoji's Bootstrap
// offcanvas markup and a click target inside each card, both best-effort —
// if a card's detail sheet doesn't open or doesn't contain a "UPI ID" line
// within the timeout, that one row is skipped (upiId left blank) and logged,
// never guessed at. Run the basic script above first if this one misbehaves.
const SYNC_SCRIPT_WITH_UPI = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const cards = [...document.querySelectorAll('.order-card-v2')];
  const rows = []; const errors = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const idx = (label) => lines.findIndex(l => l.toLowerCase() === label);
    const appIdx = idx('app'), priceIdx = idx('price'), qtyIdx = idx('qty'), amtIdx = idx('amount');
    if (appIdx < 2 || priceIdx < 0 || qtyIdx < 0 || amtIdx < 0) { errors.push({ card: i, lines, stage: 'list' }); continue; }
    const row = {
      ipo: lines[0], applicant: lines[1],
      appNumber: lines[appIdx + 1] || '', price: lines[priceIdx + 1] || '',
      qty: lines[qtyIdx + 1] || '', amount: lines[amtIdx + 1] || '',
      status: lines[amtIdx + 2] || '', upiId: '',
    };
    try {
      (card.querySelector('svg,button,.chevron,[role="button"]') || card).click();
      let sheet = null;
      for (let t = 0; t < 20 && !sheet; t++) { await sleep(150); sheet = document.querySelector('#orderDetailSheet.show, #orderDetailSheet[aria-modal="true"]'); }
      if (sheet) {
        await sleep(500); // let the staggered field animation finish
        const body = sheet.querySelector('#orderDetailBody') || sheet;
        const dLines = (body.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
        const upiIdx = dLines.findIndex(l => l.toLowerCase() === 'upi id');
        if (upiIdx >= 0) row.upiId = dLines[upiIdx + 1] || '';
        if (window.bootstrap?.Offcanvas) window.bootstrap.Offcanvas.getOrCreateInstance(sheet).hide();
        else (sheet.querySelector('.btn-close,[data-bs-dismiss="offcanvas"]') || {}).click?.();
        await sleep(300);
      } else {
        errors.push({ card: i, stage: 'detail-sheet-not-found' });
      }
    } catch (e) {
      errors.push({ card: i, stage: 'click', error: String(e) });
    }
    rows.push(row);
  }
  const out = JSON.stringify(rows);
  const done = () => alert('Copied ' + rows.length + ' application(s) (' + rows.filter(r => r.upiId).length + ' with UPI ID) to clipboard.' +
    (errors.length ? ' ' + errors.length + " card(s) had an issue — see console." : '') +
    '\\n\\nNow paste into the IPO Ledger sync panel.');
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
}

interface MatchedRow extends ScrapedRow {
  matchedIpo: Ipo | null
  matchedDemat: DematAccount | null
  matchedBank: BankAccount | null
  alreadyExists: boolean
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

function matchDemat(applicantName: string, accounts: DematAccount[]): DematAccount | null {
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

// UPI IDs are exact identifiers, not names — no fuzz here. This is what
// actually lets the sync attribute an application to the right funder
// (bank_account_id) instead of leaving it unset, which is the whole point
// of pulling UPI ID off ipoji at all.
function matchBank(upiId: string | undefined, banks: BankAccount[]): BankAccount | null {
  if (!upiId?.trim()) return null
  const n = upiId.trim().toLowerCase()
  return banks.find((b) => b.upi_id?.trim().toLowerCase() === n) ?? null
}

function parseAmount(s: string): number | null {
  const n = Number(s.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

export function IpojiSyncPanel({
  ipos,
  accounts,
  banks,
  existingKeys,
  onImported,
  ensureLookupsLoaded,
  lookupsLoading,
}: {
  ipos: Ipo[]
  accounts: DematAccount[]
  banks: BankAccount[]
  existingKeys: Set<string>
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
  const [result, setResult] = useState<{ created: number; failed: number } | null>(null)

  function handleParse() {
    setParseError(null)
    setResult(null)
    let scraped: ScrapedRow[]
    try {
      scraped = JSON.parse(pasteText)
      if (!Array.isArray(scraped)) throw new Error('not an array')
    } catch {
      setParseError('Could not read that as sync data — make sure you pasted the exact clipboard content the script copied.')
      setRows(null)
      return
    }
    const matched: MatchedRow[] = scraped.map((r) => {
      const matchedIpo = matchIpo(r.ipo, ipos)
      const matchedDemat = matchDemat(r.applicant, accounts)
      const matchedBank = matchBank(r.upiId, banks)
      const lots = Number.isFinite(Number(r.qty)) ? Number(r.qty) : null
      const alreadyExists = !!(matchedIpo && matchedDemat && existingKeys.has(`${matchedIpo.id}_${matchedDemat.id}`))
      return { ...r, matchedIpo, matchedDemat, matchedBank, alreadyExists, lots, amountNum: parseAmount(r.amount) }
    })
    setRows(matched)
  }

  const importable = (rows ?? []).filter((r) => r.matchedIpo && r.matchedDemat && !r.alreadyExists && r.lots)

  async function handleImport() {
    setSubmitting(true)
    const outcomes = await Promise.all(
      importable.map(async (r) => {
        const { error } = await supabase.from('applications').insert({
          ipo_id: r.matchedIpo!.id,
          demat_id: r.matchedDemat!.id,
          bank_account_id: r.matchedBank?.id ?? null,
          category: 'RETAIL',
          lots: r.lots!,
          bid_amount: r.amountNum,
          is_backdated: true,
        })
        return !error
      }),
    )
    setSubmitting(false)
    const created = outcomes.filter(Boolean).length
    setResult({ created, failed: outcomes.length - created })
    setRows(null)
    setPasteText('')
    if (created > 0) onImported()
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
              Slower — also opens each card to pull its UPI ID (for funder matching)
            </p>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-muted)' }}>
              Clicks into every card's detail sheet, so it takes a few seconds per application and is
              more likely to need adjusting if ipoji's page changes. Use the fast one above if this
              misbehaves.
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
                3. Review before importing ({importable.length} new of {rows.length} found)
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
                          {r.matchedDemat ? r.matchedDemat.holder_name : <span style={{ color: 'var(--critical-text)' }}>not found</span>}
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
                        <td className="p-1.5">
                          {r.alreadyExists ? (
                            <span style={{ color: 'var(--ink-muted)' }}>already applied</span>
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
                disabled={submitting || importable.length === 0}
                className="btn-primary mt-3"
              >
                {submitting ? <InlineWait /> : `Import ${importable.length} application(s)`}
              </button>
            </div>
          )}

          {result && (
            <p className="text-xs" style={{ color: result.failed ? 'var(--critical-text)' : 'var(--good-text)' }}>
              Imported {result.created} application(s){result.failed ? `, ${result.failed} failed` : ''}.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function InlineWait() {
  return <>Importing…</>
}
