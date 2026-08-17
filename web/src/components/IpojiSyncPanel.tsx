import { useState } from 'react'
import { InfoTooltip } from './HoverCard'
import { supabase } from '../lib/supabase'
import type { BankAccount, DematAccount, Ipo, MandateStatus } from '../types/database'

// Fully automatic across every page — confirmed live (5-page real run).
// Earlier versions required the user to click ipoji's "Next" themselves and
// re-paste per page, because ipoji's "Next" turned out to be a REAL
// full-page navigation (not an SPA update): clicking it on the visible tab
// destroys any in-memory script state, and DevTools "Preserve log" doesn't
// help. The fix isn't avoiding that navigation — it's making it harmless:
// this script loads ipoji's own current page inside a hidden same-origin
// iframe, scrapes it, clicks that iframe's own "Next" link, waits for the
// iframe (not the visible tab) to reload, and repeats. The outer script's
// execution context never navigates, so it survives the whole run. Progress
// merges into a localStorage accumulator (keyed by ipoji's own application
// number) so a manual Stop mid-run still keeps everything scraped so far;
// each run starts by clearing that accumulator first, since this script is
// meant to complete a whole pass in one go, not merge across separate runs.
// Confirmed live that ipoji blocks navigator.clipboard writes outright (the
// call just never resolves), so Copy falls back to auto-selecting a
// textarea for a manual Ctrl+C when that happens. No ipoji credential ever
// touches this app; this only ever sees what the user explicitly pastes
// back in. Text-line heuristic (not brittle CSS selectors) because ipoji's
// classes are opaque Bootstrap utility names, not semantic — see
// IpojiSyncPanel below for why a shape mismatch fails loudly instead of
// silently importing garbage.
const SYNC_SCRIPT = `(async () => {
  const KEY = 'ipojiAccumV1';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function findNextLink(doc) {
    return doc.querySelector('a[aria-label="Next"]') ||
      [...doc.querySelectorAll('a')].find(a => (a.textContent || '').trim().toLowerCase() === 'next') || null;
  }
  function isDisabled(el) {
    if (!el) return true;
    const li = el.closest('li');
    if (li && li.classList.contains('disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.classList.contains('disabled')) return true;
    return false;
  }
  function waitForIframeLoad(iframe, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const onLoad = () => { if (!done) { done = true; iframe.removeEventListener('load', onLoad); resolve(); } };
      iframe.addEventListener('load', onLoad);
      setTimeout(() => { if (!done) { done = true; iframe.removeEventListener('load', onLoad); reject(new Error('iframe load timeout')); } }, timeoutMs);
    });
  }
  async function waitForCards(doc, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (doc.querySelectorAll('.order-card-v2').length > 0) return;
      await sleep(150);
    }
  }

  // Reading the rendered detail sheet (innerText) turned out to be
  // fundamentally fragile on phone — three real-device debug rounds (see
  // git history) never pinned down why the panel's text stayed empty there.
  // This sidesteps that entirely: ipoji's own page still has to fetch the
  // PAN/UPI data from its API to render that sheet at all, on any device —
  // so capture the raw network responses instead of the DOM they get
  // rendered into, and pull the fields out of the actual JSON. Patched once
  // per fresh iframe window (a full-page nav creates a new window object,
  // so this re-runs each page but no-ops if already patched on this one).
  function patchNetworkCapture(win) {
    if (win.__ipojiPatched) return;
    win.__ipojiPatched = true;
    win.__ipojiNet = [];
    const origFetch = win.fetch;
    if (origFetch) {
      win.fetch = function (...args) {
        return origFetch.apply(this, args).then((res) => {
          try {
            res
              .clone()
              .text()
              .then((body) => { win.__ipojiNet.push({ url: String(args[0]), body }); })
              .catch(() => {});
          } catch {}
          return res;
        });
      };
    }
    const OrigXHR = win.XMLHttpRequest;
    if (OrigXHR) {
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (method, url) {
        this.__ipojiUrl = url;
        return origOpen.apply(this, arguments);
      };
      OrigXHR.prototype.send = function (...args) {
        this.addEventListener('loadend', () => {
          try { win.__ipojiNet.push({ url: this.__ipojiUrl, body: this.responseText }); } catch {}
        });
        return origSend.apply(this, args);
      };
    }
  }

  // Depth-limited recursive walk for any key whose NAME (not value) mentions
  // pan/upi — far more reliable than a blind text regex over the whole
  // response, since it can't accidentally grab an unrelated PAN-shaped
  // string or someone's login email from a sibling field.
  function walkForKeys(obj, panOut, upiOut, depth) {
    if (depth > 6 || obj == null || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const kl = k.toLowerCase();
      if (typeof v === 'string' && v.trim()) {
        if (!panOut.value && kl.includes('pan')) panOut.value = v.trim();
        if (!upiOut.value && kl.includes('upi')) upiOut.value = v.trim();
      } else if (v && typeof v === 'object') {
        walkForKeys(v, panOut, upiOut, depth + 1);
      }
    }
  }

  function extractFromNetwork(entries, appNumber) {
    const panOut = { value: '' }, upiOut = { value: '' };
    const relevant = entries.filter((e) => e.body && (!appNumber || e.body.includes(appNumber)));
    for (const e of relevant) {
      let parsed = null;
      try { parsed = JSON.parse(e.body); } catch {}
      if (parsed) walkForKeys(parsed, panOut, upiOut, 0);
      if (panOut.value && upiOut.value) break;
    }
    // Regex fallback (strict PAN format / UPI's @handle shape) in case the
    // response wasn't parseable JSON (e.g. server-rendered HTML fragment).
    if (!panOut.value || !upiOut.value) {
      for (const e of relevant) {
        if (!panOut.value) {
          const m = e.body.match(/\\b[A-Z]{5}[0-9]{4}[A-Z]\\b/);
          if (m) panOut.value = m[0];
        }
        if (!upiOut.value) {
          const m = e.body.match(/[a-zA-Z0-9.\\-_]{2,}@[a-zA-Z]{2,}\\b/);
          if (m) upiOut.value = m[0];
        }
      }
    }
    return { pan: panOut.value, upi: upiOut.value };
  }

  async function scrapeDoc(win, doc, shouldStop) {
    patchNetworkCapture(win);
    const cards = [...doc.querySelectorAll('.order-card-v2')];
    const rows = []; const errors = [];
    for (let i = 0; i < cards.length; i++) {
      if (shouldStop()) { errors.push({ card: i, stage: 'stopped-mid-page' }); break; }
      const card = cards[i];
      const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const idx = (label) => lines.findIndex(l => l.toLowerCase() === label);
      const appIdx = idx('app'), priceIdx = idx('price'), qtyIdx = idx('qty'), amtIdx = idx('amount');
      if (appIdx < 2 || priceIdx < 0 || qtyIdx < 0 || amtIdx < 0) { errors.push({ card: i, stage: 'list' }); continue; }
      const row = { ipo: lines[0], applicant: lines[1], appNumber: lines[appIdx + 1] || '', status: lines[amtIdx + 2] || '', upiId: '', panNumber: '' };
      if (!row.appNumber) { errors.push({ card: i, stage: 'no-app-number', applicant: row.applicant }); rows.push(row); continue; }
      try {
        const icons = [...card.querySelectorAll('svg')];
        const chevron = icons.length > 1 ? icons[icons.length - 1] : null;
        const target = (chevron && (chevron.closest('button,a,[role="button"]') || chevron)) || card;
        const netStart = (win.__ipojiNet || []).length;
        target.click();
        let sheet = null;
        // 15x120ms (1.8s) was tuned against a desktop's wired connection —
        // on a phone (mobile data/slower CPU) ipoji's async call to populate
        // this panel can take longer than that, so every row silently fell
        // through to the no-PAN/no-UPI fallback there while the card-list
        // fields (no round trip needed) still came through fine. Widened to
        // 40x150ms (6s) and re-clicks the target once at the halfway point,
        // in case the very first click landed before ipoji's own listener
        // had attached (observed as a total, not partial, phone failure —
        // consistent with a listener-not-ready race, not a wrong selector).
        for (let t = 0; t < 40 && !sheet; t++) {
          await sleep(150);
          if (t === 20) target.click();
          sheet = doc.querySelector('#orderDetailSheet.show, #orderDetailSheet[aria-modal="true"]');
        }
        if (sheet) {
          const body = sheet.querySelector('#orderDetailBody') || sheet;
          let prevText = null, stableReads = 0, text = '';
          // Real phone diagnostic (_debug field) showed the sheet DOES open
          // promptly on mobile — it's this loop that was the bug: two
          // consecutive empty reads ('' === '') counted as "stable" and
          // exited after ~300ms, before ipoji's own async call had actually
          // populated the sheet on a slower connection. Requiring non-empty
          // text before counting toward stability (plus a longer 30x150ms=
          // 4.5s cap, up from 12x150ms=1.8s) fixes the real race instead of
          // the sheet-opening timing guessed at in the previous attempt.
          for (let t = 0; t < 30 && stableReads < 2; t++) {
            await sleep(150);
            text = body.innerText || '';
            stableReads = (text && text === prevText) ? stableReads + 1 : 0;
            prevText = text;
          }
          const dLines = text.split('\\n').map(s => s.trim()).filter(Boolean);
          if (!dLines.some(l => l.includes(row.appNumber))) {
            errors.push({ card: i, stage: 'stale-sheet-content' });
            // v1.143.3's fix (require non-empty text before counting
            // "stable") still came back permanently empty on a real phone
            // re-test even after a 4.5s cap — ruling out timing entirely.
            // innerText can read as empty even when real markup exists
            // (elements with visibility:hidden/display:none, or content
            // that only lives in an attribute/nested structure) — dumping
            // raw innerHTML here (not innerText) distinguishes "genuinely
            // no content rendered" from "content's there, just not the way
            // innerText can see it," which decides the fix.
            row._debug = !text
              ? 'empty-after-full-wait, sheet.innerHTML: ' + (sheet.innerHTML || '').replace(/\\s+/g, ' ').slice(0, 300)
              : 'stale-sheet-content: ' + dLines.slice(0, 8).join(' | ').slice(0, 200);
          } else {
            const upiIdx = dLines.findIndex(l => l.toLowerCase() === 'upi id');
            if (upiIdx >= 0) row.upiId = dLines[upiIdx + 1] || '';
            const panIdx = dLines.findIndex(l => l.toLowerCase() === 'pan number');
            if (panIdx >= 0) row.panNumber = dLines[panIdx + 1] || '';
            if (!row.upiId && !row.panNumber) {
              row._debug = 'sheet-found-but-no-upi/pan-lines: ' + dLines.slice(0, 10).join(' | ').slice(0, 200);
            }
          }
          if (win.bootstrap?.Offcanvas) win.bootstrap.Offcanvas.getOrCreateInstance(sheet).hide();
          else (sheet.querySelector('.btn-close,[data-bs-dismiss="offcanvas"]') || {}).click?.();
          await sleep(200);
        } else {
          errors.push({ card: i, stage: 'detail-sheet-not-found' });
          // Same reasoning as above — since the expected #orderDetailSheet
          // selector never matched, look for anything modal/offcanvas-like
          // that DID appear, so a mismatch between this selector and
          // ipoji's actual mobile markup shows up in the pasted data
          // instead of needing phone DevTools to see it.
          const candidates = [...doc.querySelectorAll(
            '[id*="offcanvas" i],[id*="modal" i],[class*="offcanvas" i],[class*="modal" i],[role="dialog"]'
          )].slice(0, 6).map(el => ({
            id: el.id || null,
            cls: (el.className || '').toString().slice(0, 60),
            visible: el.classList.contains('show') || el.getAttribute('aria-modal') === 'true',
          }));
          row._debug = 'detail-sheet-not-found, candidates: ' + JSON.stringify(candidates);
        }
        // Enrichment pass, not a replacement — only fills gaps the DOM read
        // above left empty, using whatever ipoji's own page actually fetched
        // from its API while that detail sheet was opening (see
        // patchNetworkCapture). Works regardless of how/whether the sheet
        // rendered, which is the whole point: the render step is what kept
        // failing on phone across three prior fix attempts, the underlying
        // data fetch never needed to be in question.
        if (!row.panNumber || !row.upiId) {
          const netEntries = (win.__ipojiNet || []).slice(netStart);
          const net = extractFromNetwork(netEntries, row.appNumber);
          const recovered = (!row.panNumber && net.pan) || (!row.upiId && net.upi);
          if (!row.panNumber && net.pan) row.panNumber = net.pan;
          if (!row.upiId && net.upi) row.upiId = net.upi;
          if (recovered) row._debug = (row._debug ? row._debug + ' | ' : '') + 'recovered-via-network';
          else if (!row.panNumber && !row.upiId) row._debug = (row._debug ? row._debug + ' | ' : '') + 'network-capture-empty (' + netEntries.length + ' response(s) seen)';
        }
      } catch (e) {
        errors.push({ card: i, stage: 'click', error: String(e) });
        row._debug = 'click-error: ' + String(e);
      }
      rows.push(row);
    }
    return { rows, errors, cardCount: cards.length };
  }

  let store = {};
  localStorage.removeItem(KEY);

  document.querySelectorAll('#__ipojiAutoBox,#__ipojiAutoIframe,#__ipojiAccumBox,#__ipojiAccumStyle').forEach(el => el.remove());

  let stopRequested = false;
  const statusBox = document.createElement('div');
  statusBox.id = '__ipojiAutoBox';
  statusBox.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;background:#1a1a2e;color:#fff;' +
    'padding:12px 16px;border-radius:10px;font:13px sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:320px;display:flex;flex-direction:column;gap:8px;';
  statusBox.innerHTML =
    '<div id="__ipojiAutoMsg" style="white-space:pre-wrap;"></div>' +
    '<button id="__ipojiAutoStop" style="align-self:flex-start;padding:5px 12px;border-radius:6px;border:1px solid #555;background:#2a2a3e;color:#fff;cursor:pointer;font-size:12px;">Stop and show data scraped so far</button>';
  document.body.appendChild(statusBox);
  const msgEl = statusBox.querySelector('#__ipojiAutoMsg');
  const setStatus = (msg) => { msgEl.textContent = msg; console.log('[ipoji auto]', msg); };
  statusBox.querySelector('#__ipojiAutoStop').onclick = () => {
    stopRequested = true;
    setStatus('Stopping after the current page finishes.');
  };

  const iframe = document.createElement('iframe');
  iframe.id = '__ipojiAutoIframe';
  iframe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;right:0;';
  document.body.appendChild(iframe);

  let pageNum = 1;
  const MAX_PAGES = 50;
  let stoppedReason = '';
  let totalErrors = 0;

  try {
    setStatus('Loading page 1 in a hidden iframe.');
    const firstLoad = waitForIframeLoad(iframe);
    iframe.src = location.href;
    await firstLoad;

    while (pageNum <= MAX_PAGES) {
      if (stopRequested) { stoppedReason = 'Stopped manually before page ' + pageNum + '.'; break; }
      let doc, win;
      try {
        doc = iframe.contentDocument;
        win = iframe.contentWindow;
        if (!doc) throw new Error('no contentDocument');
      } catch (e) {
        stoppedReason = 'Cannot read the iframe content (' + String(e) + ').';
        break;
      }
      await waitForCards(doc);
      setStatus('Scraping page ' + pageNum + '.');
      const { rows, errors, cardCount } = await scrapeDoc(win, doc, () => stopRequested);
      totalErrors += errors.length;
      let added = 0;
      for (const r of rows) { if (r.appNumber && !store[r.appNumber]) added++; if (r.appNumber) store[r.appNumber] = r; }
      localStorage.setItem(KEY, JSON.stringify(store));
      const total = Object.keys(store).length;
      setStatus('Page ' + pageNum + ': ' + cardCount + ' card(s), ' + added + ' new.\\nTotal stored: ' + total + '.' + (errors.length ? ' (' + errors.length + ' issue(s), see console)' : ''));
      console.log('[ipoji auto] page', pageNum, { cardCount, added, errors });

      if (stopRequested) { stoppedReason = 'Stopped manually mid-page ' + pageNum + ' - everything scraped before the stop is saved.'; break; }
      if (cardCount < 10) { stoppedReason = 'Page ' + pageNum + ' had fewer than 10 cards - last page.'; break; }
      if (added === 0 && pageNum > 1) { stoppedReason = 'Page ' + pageNum + ' had no new app numbers - stopped to avoid a loop.'; break; }

      const nextLink = findNextLink(doc);
      if (isDisabled(nextLink)) { stoppedReason = 'Next is disabled on page ' + pageNum + '.'; break; }

      setStatus('Clicking Next (leaving page ' + pageNum + ').');
      const nextLoad = waitForIframeLoad(iframe);
      nextLink.click();
      await nextLoad;
      pageNum++;
    }
    if (pageNum > MAX_PAGES && !stoppedReason) {
      stoppedReason = 'Hit the ' + MAX_PAGES + '-page safety cap - there may be more pages left. Run again to continue (already-stored rows are skipped automatically).';
    }
  } catch (e) {
    stoppedReason = 'Stopped on an error: ' + String(e) + '. Everything scraped before the error is still saved.';
  }

  iframe.remove();
  statusBox.remove();

  const total = Object.keys(store).length;
  const statusCounts = {};
  for (const r of Object.values(store)) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

  const style = document.createElement('style');
  style.id = '__ipojiAccumStyle';
  style.textContent = \`
    #__ipojiAccumBox { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
    #__ipojiAccumBox * { box-sizing: border-box; }
    #__ipojiAccumBox button { font-family: inherit; }
    .ia-btn { border-radius: 999px; padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid transparent; transition: filter .15s; }
    .ia-btn:hover { filter: brightness(0.96); }
    .ia-btn-primary { background: #4f46e5; color: #fff; }
    .ia-btn-secondary { background: #eef0ff; color: #4f46e5; }
    .ia-btn-danger { background: #fdecea; color: #d93025; }
    .ia-btn-ghost { background: transparent; color: #6b7280; }
    .ia-pill { display: inline-flex; align-items: center; gap: 6px; background: #e8f5e9; color: #1e7e34; border-radius: 999px; padding: 4px 12px; font-size: 12px; font-weight: 600; }
    .ia-pill-warn { background: #fff4e5; color: #b26a00; }
  \`;
  document.head.appendChild(style);

  const box = document.createElement('div');
  box.id = '__ipojiAccumBox';
  box.style.cssText = 'position:fixed;inset:5% 6%;z-index:999999;background:#f4f5fb;color:#1a1a2e;' +
    'border-radius:18px;padding:0;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(30,20,80,.35);';

  const statusLine = Object.entries(statusCounts).map(([s, n]) => s + ': <b>' + n + '</b>').join(' &nbsp;\\u00b7&nbsp; ');

  box.innerHTML =
    '<div style="padding:18px 22px;background:#fff;border-bottom:1px solid #ececf5;display:flex;align-items:center;justify-content:space-between;gap:10px;">' +
      '<div>' +
        '<div style="font-size:15px;font-weight:700;color:#2b2350;">ipoji sync \\u2014 ' + (stopRequested ? 'stopped early' : 'auto-pagination done') + '</div>' +
        '<div style="font-size:12px;color:#8a8aa3;margin-top:2px;">' + stoppedReason + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0;">' +
        (totalErrors > 0 ? '<span class="ia-pill ia-pill-warn">\\u26a0 ' + totalErrors + ' issue(s)</span>' : '') +
        '<span class="ia-pill">\\u2713 ' + total + ' total stored</span>' +
      '</div>' +
    '</div>' +
    '<div style="padding:10px 22px;background:#fbfbff;border-bottom:1px solid #ececf5;font-size:12px;color:#6b6b85;">' +
      (statusLine || 'No rows stored') +
    '</div>' +
    '<div style="display:flex;gap:10px;padding:14px 22px;background:#fff;border-bottom:1px solid #ececf5;">' +
      '<button id="__ipojiShowAll" class="ia-btn ia-btn-secondary">Show all (' + total + ')</button>' +
      '<button id="__ipojiCopyAll" class="ia-btn ia-btn-primary">\\ud83d\\udccb Copy all</button>' +
      '<div style="flex:1;"></div>' +
      '<button id="__ipojiClearAll" class="ia-btn ia-btn-danger">Clear stored data</button>' +
      '<button id="__ipojiAccumClose" class="ia-btn ia-btn-ghost">Close \\u2715</button>' +
    '</div>' +
    '<div id="__ipojiCopyStatus" style="display:none;padding:10px 22px;font-size:12px;font-weight:600;"></div>' +
    '<textarea id="__ipojiAccumTA" style="flex:1;width:100%;border:0;outline:0;resize:none;' +
      'padding:16px 22px;font:12px/1.6 \\'IBM Plex Mono\\',Consolas,monospace;color:#2b2350;background:#f4f5fb;display:none;" readonly></textarea>';
  document.body.appendChild(box);

  const ta = document.getElementById('__ipojiAccumTA');
  const statusEl = document.getElementById('__ipojiCopyStatus');
  const fill = () => { ta.value = JSON.stringify(Object.values(store), null, 2); ta.style.display = 'block'; };

  document.getElementById('__ipojiAccumClose').onclick = () => { box.remove(); style.remove(); };
  document.getElementById('__ipojiClearAll').onclick = () => {
    if (confirm('Clear all ' + total + ' stored rows?')) { localStorage.removeItem(KEY); box.remove(); style.remove(); }
  };
  document.getElementById('__ipojiShowAll').onclick = () => { fill(); ta.focus(); ta.select(); };
  document.getElementById('__ipojiCopyAll').onclick = async () => {
    fill();
    statusEl.style.display = 'block';
    try {
      await navigator.clipboard.writeText(ta.value);
      statusEl.style.background = '#e8f5e9'; statusEl.style.color = '#1e7e34';
      statusEl.textContent = '\\u2713 Copied ' + total + ' row(s) to clipboard.';
    } catch {
      ta.focus(); ta.select();
      statusEl.style.background = '#fff4e5'; statusEl.style.color = '#b26a00';
      statusEl.textContent = 'Clipboard blocked by ipoji - text is selected, press Ctrl+C to copy.';
    }
  };
  console.log('[ipoji auto] FINISHED', stoppedReason, 'total stored:', total, 'errors:', totalErrors, Object.values(store));
})();`

// Same script, wrapped as a bookmarklet for phones — where there's no
// DevTools console to paste into. The user saves this once as a bookmark,
// then taps it on the ipoji page and it runs identically (ipoji sends no
// CSP, confirmed, so a javascript: bookmarklet executes fine). encodeURIComponent
// keeps the whole IIFE valid inside a single javascript: URL. Single source of
// truth — always in lockstep with the console script above.
const SYNC_BOOKMARKLET = 'javascript:' + encodeURIComponent(SYNC_SCRIPT)

interface ScrapedRow {
  ipo: string
  applicant: string
  appNumber: string
  status: string
  upiId?: string
  panNumber?: string
  // Diagnostic only, set by the scrape script when it couldn't open/read the
  // UPI/PAN detail sheet for a row — surfaces what actually happened on a
  // phone (no DevTools console there) so it round-trips into this app
  // instead of being invisible. Never written back to the database.
  _debug?: string
}

interface MatchedRow extends ScrapedRow {
  matchedIpo: Ipo | null
  matchedDemat: DematAccount | null
  dematMatchedByPan: boolean
  matchedBank: BankAccount | null
  existingId: string | null
  existingMandate: MandateStatus | null
  existingAppNumber: string | null
  // Whether the EXISTING row (before this sync run) was already flagged as
  // ipoji-sourced. A manually-created application that a sync then
  // successfully matches against ipoji IS proof it really exists there —
  // this drives flipping its badge from "added manually" to "synced".
  existingImportedFromIpoji: boolean
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

// ipoji's own shorthand comes in two different styles, not just one — a
// truncated/caps prefix of the name ("DHOOTTRANS" for "Dhoot Transmission"),
// which the prefix/substring check below covers, OR a first-letter acronym
// of each word ("BLEL" for "Behari Lal Engineering Limited" — none of
// DHOOTTRANS's rules matched that one at all, since "blel" isn't a prefix,
// suffix, or substring of "beharilalengineeringlimited"). Both are real,
// observed ipoji abbreviation styles, so both get checked.
function acronym(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toLowerCase()
}

function nameMatches(ipojiName: string, companyName: string): boolean {
  const n = normalize(ipojiName)
  if (!n) return false
  const full = normalize(companyName)
  if (full.startsWith(n) || n.startsWith(full) || full.includes(n)) return true
  const acr = acronym(companyName)
  return acr.length > 0 && (acr === n || acr.startsWith(n) || n.startsWith(acr))
}

function matchIpo(ipojiName: string, ipos: Ipo[]): Ipo | null {
  if (!normalize(ipojiName)) return null
  return ipos.find((i) => nameMatches(ipojiName, i.company_name)) ?? null
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

// Minimal local mirror of import-ipos' response shapes (IposPage.tsx keeps
// its own copy for its own manual/bulk import UI) — this panel only needs
// enough to create a missing IPO row, not the full picker experience.
interface ImportCandidate {
  company_name: string
  open_date: string | null
  close_date: string | null
  price_low: number | null
  price_high: number | null
  lot_size: number | null
  gmp: string | null
  issue_size: string | null
  source_url: string
}

interface ImportDetail {
  allotment_date: string | null
  listing_date: string | null
  registrar: Ipo['registrar'] | null
  issue_size: string | null
  retail_issue_size: string | null
  retail_subscription_rate: string | null
  allotment_out: boolean | null
}

// Same prefix/substring rule as matchIpo above, just against ipoji's own
// list-candidate names instead of this portal's saved IPOs.
function matchCandidateName(ipojiName: string, candidates: ImportCandidate[]): ImportCandidate | null {
  if (!normalize(ipojiName)) return null
  return candidates.find((c) => nameMatches(ipojiName, c.company_name)) ?? null
}

// A scraped application can name an IPO this portal has no row for at all
// (never imported, never manually added) — previously that row just sat
// unmatched forever with no way to import it short of leaving this panel,
// going to the IPOs page, importing it by hand, then coming back to paste
// again. Reuses the exact same two-step ipoji fetch (list candidates, then
// that candidate's detail page for allotment/listing date + registrar) and
// upsert-by-name pattern IposPage's own "Import from ipoji.com" flow uses,
// so a sync-created IPO is indistinguishable from one added the normal way.
async function fetchAndCreateMissingIpo(ipojiName: string): Promise<Ipo | null> {
  const { data: listData } = await supabase.functions.invoke<{ candidates?: ImportCandidate[] }>('import-ipos', {
    body: { mode: 'list', source: 'current' },
  })
  const candidate = matchCandidateName(ipojiName, listData?.candidates ?? [])
  if (!candidate || !candidate.open_date || !candidate.close_date || !candidate.lot_size) return null

  const { data: detail } = await supabase.functions.invoke<ImportDetail>('import-ipos', {
    body: { mode: 'detail', detail_url: candidate.source_url },
  })

  const payload = {
    company_name: candidate.company_name.trim().replace(/\s+/g, ' '),
    price_low: candidate.price_low,
    price_high: candidate.price_high,
    lot_size: candidate.lot_size,
    open_date: candidate.open_date,
    close_date: candidate.close_date,
    allotment_date: detail?.allotment_date ?? null,
    listing_date: detail?.listing_date ?? null,
    registrar: detail?.registrar ?? 'OTHER',
    gmp_notes: candidate.gmp,
    issue_size: detail?.issue_size ?? candidate.issue_size,
    retail_issue_size: detail?.retail_issue_size ?? null,
    retail_subscription_rate: detail?.retail_subscription_rate ?? null,
    ...(detail?.allotment_out != null ? { allotment_out: detail.allotment_out } : {}),
  }

  // Same ilike-then-insert/update-on-conflict pattern as IposPage's
  // upsertIpo — a concurrent cron import or a second sync run racing this
  // one shouldn't ever produce a duplicate row for the same company.
  const { data: existingRows } = await supabase
    .from('ipos')
    .select('*')
    .ilike('company_name', payload.company_name)
    .order('created_at', { ascending: true })
    .limit(1)
  if (existingRows?.[0]) {
    const { data: updated } = await supabase.from('ipos').update(payload).eq('id', existingRows[0].id).select('*').single()
    return (updated as Ipo) ?? (existingRows[0] as Ipo)
  }
  const { data: inserted, error } = await supabase.from('ipos').insert(payload).select('*').single()
  if (!error) return inserted as Ipo
  if (error.code === '23505') {
    const { data: retryExisting } = await supabase
      .from('ipos')
      .select('*')
      .ilike('company_name', payload.company_name)
      .limit(1)
    return (retryExisting?.[0] as Ipo) ?? null
  }
  console.error('ipoji sync — failed to create missing IPO', ipojiName, error)
  return null
}

export function IpojiSyncPanel({
  open,
  ipos,
  accounts,
  banks,
  existingByKey,
  existingByAppNumber,
  onImported,
  onIposCreated,
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
  existingByKey: Map<
    string,
    { id: string; mandate_status: MandateStatus; ipoji_app_number: string | null; imported_from_ipoji: boolean }
  >
  // Keyed by (ipo_id, demat_id, ipoji_app_number) instead — checked FIRST,
  // since ipoji's own application number is the actual stable identity of a
  // bid and has to win over a bank-account-derived key that isn't
  // guaranteed stable run to run (see the ApplicationsPage comment where
  // this is built for the real duplicate bug it fixes).
  existingByAppNumber: Map<
    string,
    { id: string; mandate_status: MandateStatus; ipoji_app_number: string | null; imported_from_ipoji: boolean }
  >
  onImported: () => void
  // Called after this panel creates one or more IPOs that didn't exist in
  // the portal at all — lets the parent refresh its own `ipos` prop so a
  // second paste (or the plain "New application" form) sees them without a
  // manual page reload.
  onIposCreated: () => void
  lookupsLoading: boolean
}) {
  const [scriptCopied, setScriptCopied] = useState(false)
  const [bookmarkletCopied, setBookmarkletCopied] = useState(false)
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
  const [creatingIpos, setCreatingIpos] = useState(false)
  const [createdIpoNames, setCreatedIpoNames] = useState<string[]>([])
  const [unmatchableIpoNames, setUnmatchableIpoNames] = useState<string[]>([])

  async function handleParse() {
    setResult(null)
    setCreatedIpoNames([])
    setUnmatchableIpoNames([])
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

    // Any ipoji IPO name this portal has no row for at all gets created
    // for real before matching runs — otherwise every application under it
    // would report an unmatched IPO forever, with no way to fix that short
    // of leaving this panel to import it by hand first. Distinct names only
    // (one fetch-and-create per IPO, not per application row).
    let effectiveIpos = ipos
    const unmatchedNames = Array.from(new Set(scraped.map((r) => r.ipo).filter((name) => !matchIpo(name, ipos))))
    if (unmatchedNames.length > 0) {
      setCreatingIpos(true)
      const created: string[] = []
      const unmatchable: string[] = []
      for (const name of unmatchedNames) {
        const ipo = await fetchAndCreateMissingIpo(name)
        if (ipo) {
          effectiveIpos = [...effectiveIpos, ipo]
          created.push(ipo.company_name)
        } else {
          unmatchable.push(name)
        }
      }
      setCreatingIpos(false)
      setCreatedIpoNames(created)
      setUnmatchableIpoNames(unmatchable)
      if (created.length > 0) onIposCreated()
    }

    const matched: MatchedRow[] = await Promise.all(
      scraped.map(async (r) => {
        const matchedIpo = matchIpo(r.ipo, effectiveIpos)
        const { account: matchedDemat, byPan: dematMatchedByPan } = await matchDemat(r.applicant, r.panNumber, accounts)
        const matchedBank = matchBank(r.upiId, banks)
        const { lots, amount: amountNum } = defaultLotsAndAmount(matchedIpo)
        // App-number match FIRST — ipoji's own application number is the
        // real stable identity of a bid, and has to win over a
        // bank-account-derived key that isn't guaranteed stable run to run
        // (matchBank() can resolve the same bid to a different
        // bank_accounts row on a later sync — a UPI-text case difference,
        // a newly-added bank account, etc.). Only when there's no app
        // number to go on (or no existing row matches it) does this fall
        // back to (ipo_id, demat_id, bank_account_id) — migration 0070's
        // "more than one active application per account+IPO when each is
        // funded via a different bank/UPI account" case, which ipoji
        // reports with genuinely different app numbers per bid, not the
        // same one resolving differently.
        const existing =
          matchedIpo && matchedDemat
            ? (r.appNumber && existingByAppNumber.get(`${matchedIpo.id}_${matchedDemat.id}_${r.appNumber}`)) ||
              existingByKey.get(`${matchedIpo.id}_${matchedDemat.id}_${matchedBank?.id ?? 'self'}`)
            : undefined
        return {
          ...r,
          matchedIpo,
          matchedDemat,
          dematMatchedByPan,
          matchedBank,
          existingId: existing?.id ?? null,
          existingMandate: existing?.mandate_status ?? null,
          existingAppNumber: existing?.ipoji_app_number ?? null,
          existingImportedFromIpoji: existing?.imported_from_ipoji ?? false,
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
  // sync (or manually) either never got ipoji's own App number recorded, or
  // is still flagged "added manually" even though this sync run just
  // proved it's real (found a matching row on ipoji) — either case gets
  // the same update: backfill the app number if missing, and flip the
  // manually-added badge to synced. A manually-created application that
  // genuinely doesn't exist on ipoji never appears here at all (nothing to
  // match it to), which is exactly what the "Not on ipoji" filter on
  // Applications surfaces for review/cleanup.
  const toSyncExisting = (rows ?? []).filter(
    (r) => r.existingId && ((!r.existingAppNumber && r.appNumber) || !r.existingImportedFromIpoji),
  )

  async function handleImport() {
    setSubmitting(true)
    setErrorDetails([])
    const [createOutcomes, mandateOutcomes, syncExistingOutcomes] = await Promise.all([
      Promise.all(
        toCreate.map(async (r) => {
          const { data: inserted, error } = await supabase
            .from('applications')
            .insert({
              ipo_id: r.matchedIpo!.id,
              demat_id: r.matchedDemat!.id,
              bank_account_id: r.matchedBank?.id ?? null,
              // Deliberately never set here, on create OR on any of the
              // update paths below (mandate/app-number backfill) — the
              // funder_override_id manual credit override (migration 0063)
              // is admin-set-only, always, regardless of whether the
              // scraped UPI happens to match some other funder's own
              // account on file. A re-sync must never silently clear or
              // change an override someone set by hand.
              category: 'RETAIL',
              lots: r.lots!,
              bid_amount: r.amountNum,
              // Always false, deliberately — was previously
              // hasBiddingClosed(r.matchedIpo!), which was still wrong: that
              // checks whether the IPO's window is closed AT SYNC TIME, not
              // whether the bid itself was placed late, and a sync can run
              // any time after the bid was placed (even days later, well
              // after the IPO closed). "Backdated" is a PORTAL-entry-timing
              // concept — did an admin type this in after the fact — not an
              // ipoji-bidding-timing one. Every application ipoji shows at
              // all was, by construction, placed while bidding was still
              // genuinely open (ipoji itself refuses bids after its own
              // cutoff), so nothing scraped from ipoji is ever legitimately
              // "backdated." Only the manual "+ Backdated application" flow
              // (NewApplicationForm's `backdated` prop) should ever set this.
              is_backdated: false,
              imported_from_ipoji: true,
              ipoji_app_number: r.appNumber,
              ipoji_status_text: r.status,
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
              p_status_text: r.status,
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
            p_status_text: r.status,
          })
          if (error) console.error('ipoji sync — mandate update failed for', r.matchedDemat?.holder_name, r.matchedIpo?.company_name, error)
          return { ok: !error, label: `${r.matchedDemat?.holder_name} / ${r.matchedIpo?.company_name} (mandate)`, error }
        }),
      ),
      Promise.all(
        toSyncExisting.map(async (r) => {
          const patch: Record<string, unknown> = { imported_from_ipoji: true }
          if (!r.existingAppNumber && r.appNumber) patch.ipoji_app_number = r.appNumber
          const { error } = await supabase.from('applications').update(patch).eq('id', r.existingId)
          if (error) console.error('ipoji sync — existing-row sync failed for', r.matchedDemat?.holder_name, r.matchedIpo?.company_name, error)
          return { ok: !error, label: `${r.matchedDemat?.holder_name} / ${r.matchedIpo?.company_name} (synced)`, error }
        }),
      ),
    ])
    setSubmitting(false)
    const created = createOutcomes.filter((o) => o.ok && !o.skipped).length
    const alreadyExisted = createOutcomes.filter((o) => o.skipped).length
    const mandateUpdated = mandateOutcomes.filter((o) => o.ok).length
    const appNumbersBackfilled = syncExistingOutcomes.filter((o) => o.ok).length
    const failed =
      createOutcomes.filter((o) => !o.ok).length +
      mandateOutcomes.filter((o) => !o.ok).length +
      syncExistingOutcomes.filter((o) => !o.ok).length
    setErrorDetails(
      [...createOutcomes, ...mandateOutcomes, ...syncExistingOutcomes]
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
              <InfoTooltip
                text={
                  'How to use this:\n\n' +
                  '1. Go to ipoji.com/bids -> Orders/Bids -> Current tab, in your own browser, logged in as usual.\n' +
                  '2. Click "Copy sync script" below.\n' +
                  '3. On the ipoji tab, open DevTools (press F12), click the Console tab, paste (Ctrl+V), press Enter.\n' +
                  '4. The script runs by itself from there — it reads the page in the background, opens every ' +
                  'card to grab its UPI ID and PAN, then automatically moves to the next page and repeats, ' +
                  'until it runs out of pages. A small box in the bottom-right corner shows progress as it goes. ' +
                  'You do not need to click Next yourself, and you can leave that tab alone while it runs.\n' +
                  '5. If you ever want to stop early, click "Stop and show data scraped so far" in that progress box.\n' +
                  '6. When it finishes (or you stop it), a bigger box pops up with everything found. Click ' +
                  '"Copy all", then come back here and paste into the box below, then press Enter.\n\n' +
                  'Notes: your ipoji login never touches this app — the script only reads what is already on ' +
                  'the page you are logged into, and this app only ever sees what you paste back in. ipoji blocks ' +
                  'the normal "Copy" button from working sometimes, so if Copy all fails, the text in that box is ' +
                  'already selected — just press Ctrl+C. Lots/amount are not scraped — they are assumed to be ' +
                  '1 lot at the IPO\'s own cutoff price (true for every application seen so far); edit an imported ' +
                  'application afterward if someone actually applied for more than one lot. If a scraped ' +
                  'application\'s IPO is not in this portal at all yet, Preview fetches it from ipoji\'s own ' +
                  'current-IPO list and creates it automatically before matching.'
                }
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(SYNC_SCRIPT)
                  setScriptCopied(true)
                  setTimeout(() => setScriptCopied(false), 1500)
                }}
                className="btn-secondary"
              >
                {scriptCopied ? 'Copied — paste it into ipoji\'s console' : 'Copy sync script (computer)'}
              </button>
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(SYNC_BOOKMARKLET)
                  setBookmarkletCopied(true)
                  setTimeout(() => setBookmarkletCopied(false), 1500)
                }}
                className="btn-secondary"
              >
                {bookmarkletCopied ? 'Copied — save it as a bookmark' : 'Copy phone bookmarklet'}
              </button>
              {/* Phones have no DevTools console, so the computer flow can't
                  run there. A bookmarklet is the standard replacement — saved
                  once, tapped on the ipoji page to run the exact same script. */}
              <InfoTooltip
                text={
                  'On a phone (no console to paste into) — use the bookmarklet instead:\n\n' +
                  'iPhone (Safari):\n' +
                  '1. Tap "Copy phone bookmarklet" above.\n' +
                  '2. In Safari, open any page, tap Share -> Add Bookmark -> Save.\n' +
                  '3. Tap the book icon -> Edit -> open that bookmark, rename it "ipoji sync", clear its address, and paste (the javascript: text you copied). Done.\n' +
                  '4. Go to ipoji.com/bids (logged in, Orders/Bids -> Current tab).\n' +
                  '5. Open Bookmarks and tap "ipoji sync" — the script runs on the page, same as on a computer.\n' +
                  '6. When the results box appears, long-press its text -> Select All -> Copy.\n' +
                  '7. Come back here and paste into the box below, then press Enter.\n\n' +
                  'Android (Chrome): same idea — copy the bookmarklet, add a bookmark, Edit it, paste the javascript: text as the URL, name it "ipoji sync". On ipoji, type "ipoji sync" in the address bar and pick it to run.\n\n' +
                  'Your ipoji login still never touches this app — the bookmarklet only reads the page you are already logged into, exactly like the computer script.'
                }
              />
            </div>
          </div>

          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
              2. Paste what it copied
            </p>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              onKeyDown={(e) => {
                // Plain Enter (no Shift) previews immediately instead of
                // requiring a separate click on "Preview" right after a
                // paste — Shift+Enter still inserts a literal newline, in
                // case someone's hand-editing the pasted JSON.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (pasteText.trim() && !lookupsLoading) handleParse()
                }
              }}
              placeholder="Paste what the script showed you here, then press Enter…"
              // A big multi-page paste is hundreds of lines of JSON — fixed
              // height + resize-none + its own scrollbar keeps this box a
              // constant size regardless of paste size (or a manual drag),
              // instead of growing the whole page down with it.
              className="input mt-2 h-24 w-full resize-none overflow-y-auto font-mono text-xs"
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
            {creatingIpos && (
              <p className="mt-2 text-xs" style={{ color: 'var(--ink-muted)' }}>
                Checking ipoji for IPO(s) this portal doesn't have yet…
              </p>
            )}
            {createdIpoNames.length > 0 && (
              <p className="mt-2 text-xs" style={{ color: 'var(--good)' }}>
                Created {createdIpoNames.length} new IPO{createdIpoNames.length === 1 ? '' : 's'} from ipoji:{' '}
                {createdIpoNames.join(', ')}.
              </p>
            )}
            {unmatchableIpoNames.length > 0 && (
              <p className="mt-2 text-xs" style={{ color: 'var(--warning-text)' }}>
                Couldn't find {unmatchableIpoNames.join(', ')} on ipoji's current list — add it manually on the
                IPOs page, then paste again.
              </p>
            )}
          </div>

          {rows && (
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--ink-primary)' }}>
                3. Review before importing ({toCreate.length} new, {toUpdateMandate.length} mandate update
                {toUpdateMandate.length === 1 ? '' : 's'}, {toSyncExisting.length} existing row
                {toSyncExisting.length === 1 ? '' : 's'} synced of {rows.length} found)
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                Mandate status is a best-effort guess from ipoji's own status text — double-check it
                rather than treating it as certain.
              </p>
              {/* A big multi-page batch is dozens/hundreds of rows — capped
                  height + its own scroll (both axes) keeps this table a
                  constant size regardless of how many rows matched, instead
                  of pushing "Import" far down the page. thead isn't sticky
                  here (would need its own layout rework); the row count in
                  the heading above already orients you without it. */}
              <div className="mt-2 max-h-96 overflow-auto">
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
                            // _debug (scrape-side diagnostic — see ScrapedRow)
                            // surfaces via title/hover instead of a visible
                            // column: it only ever has a value when the
                            // detail-sheet fetch failed, which is the
                            // uncommon case, and it's meant for
                            // troubleshooting phone runs (no DevTools
                            // console there), not routine review.
                            <span style={{ color: 'var(--ink-muted)' }} title={r._debug}>
                              —{r._debug ? ' ⓘ' : ''}
                            </span>
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
                            ) : toSyncExisting.includes(r) ? (
                              <span style={{ color: 'var(--accent)' }}>
                                {!r.existingImportedFromIpoji ? 'mark synced' : ''}
                                {!r.existingImportedFromIpoji && !r.existingAppNumber && r.appNumber ? ' + ' : ''}
                                {!r.existingAppNumber && r.appNumber ? `backfill app # ${r.appNumber}` : ''}
                              </span>
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
              {toCreate.length === 0 && toUpdateMandate.length === 0 && toSyncExisting.length === 0 ? (
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
                    : `Import ${toCreate.length}, update ${toUpdateMandate.length} mandate(s), sync ${toSyncExisting.length} existing`}
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
