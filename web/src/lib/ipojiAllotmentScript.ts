// Browser script that reads ipoji's allotment results (ipoji.com/ipo-allotment-
// status) for every saved account of the logged-in user and hands them back to
// this portal. Run with the IPO already picked in ipoji's "Select IPO to Check
// Allotment" dropdown: picking it makes ipoji check each saved account one
// after another (~5 s each), listing name + PAN + a status per account.
//
// Plain text-line reading (same idea as the applications script) because the
// markup is opaque. Rows come back as { kind: 'allotment', ipo, applicant,
// panNumber, status, result } - the portal matches by PAN, so no ipoji login or
// PAN ever leaves the browser except what is pasted/sent back to this app.
//
// IMPORTANT - this lives in a TS template literal: a lone backslash is
// silently dropped there, so the script must contain NO backslashes (newline is
// String.fromCharCode(10), regexes use character classes), no backticks and no
// dollar-brace sequences. ipojiAllotmentScript.test.ts evaluates the literal
// exactly as the runtime does and exercises the parsing helpers.
export const ALLOTMENT_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const NL = String.fromCharCode(10);
  const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
  const LABELS = ['Allotted', 'Not Allotted', 'No Record Found', 'Checking', 'Pending'];

  // --- helpers begin
  function readProgress(lines) {
    const i = lines.findIndex((l) => l.toUpperCase() === 'CHECKED');
    if (i < 3) return null;
    const checked = Number(lines[i - 2]);
    const total = Number(String(lines[i - 1]).replace('/', ''));
    if (!Number.isFinite(checked) || !Number.isFinite(total) || total <= 0) return null;
    const counts = {};
    let j = i + 1;
    for (const label of LABELS) {
      if (lines[j] === label) { counts[label] = Number(lines[j + 1]); j += 2; }
    }
    return { checked, total, counts, ipo: lines[i - 3] || '', endIdx: j };
  }

  function classify(status) {
    const s = String(status || '').toLowerCase();
    if (s.includes('not allot') || s.includes('not-allot') || s.includes('unsuccess')) return 'NOT_ALLOTTED';
    if (s.includes('allot')) return 'ALLOTTED';
    if (s.includes('no record')) return 'NO_RECORD';
    if (!s || s.includes('checking') || s.includes('pending')) return 'PENDING';
    return 'UNKNOWN';
  }

  function parseRows(lines, startIdx, ipo) {
    const rows = [];
    for (let k = Math.max(startIdx, 1); k < lines.length; k++) {
      if (lines[k].startsWith('IPO Allotment Guide')) break;
      if (!PAN_RE.test(lines[k])) continue;
      let p = k + 1;
      while (p < lines.length && !PAN_RE.test(lines[p + 1] || '') && !lines[p].startsWith('IPO Allotment Guide')) p++;
      const status = lines.slice(k + 1, p).join(' ').trim();
      const nums = status.match(/[0-9]+/);
      rows.push({
        kind: 'allotment',
        ipo,
        applicant: lines[k - 1],
        panNumber: lines[k],
        status,
        result: classify(status),
        shares: nums ? Number(nums[0]) : null,
      });
    }
    return rows;
  }
  // --- helpers end

  const mainEl = () => document.querySelector('main') || document.body;
  const readLines = () => (mainEl().innerText || '').split(NL).map((s) => s.trim()).filter(Boolean);

  document.querySelectorAll('#__ipojiAllotBox,#__ipojiAllotResult').forEach((el) => el.remove());
  let stopRequested = false;
  const box = document.createElement('div');
  box.id = '__ipojiAllotBox';
  box.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;background:#0b0e15;color:#e2e8f0;border:1px solid rgba(148,163,184,.22);padding:12px 16px;border-radius:12px;font:13px -apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.6);max-width:320px;display:flex;flex-direction:column;gap:8px;';
  box.innerHTML = '<div id="__ipojiAllotMsg" style="white-space:pre-wrap;"></div><button id="__ipojiAllotStop" style="align-self:flex-start;padding:6px 14px;border-radius:8px;border:1px solid rgba(148,163,184,.22);background:#12151f;color:#e2e8f0;cursor:pointer;font-size:12px;">Stop and use what is checked so far</button>';
  document.body.appendChild(box);
  const msgEl = box.querySelector('#__ipojiAllotMsg');
  const setStatus = (m) => { msgEl.textContent = m; console.log('[ipoji allotment]', m); };
  box.querySelector('#__ipojiAllotStop').onclick = () => { stopRequested = true; };

  let progress = readProgress(readLines());
  if (!progress) {
    box.querySelector('#__ipojiAllotStop').remove();
    setStatus('No allotment results on this page yet. Open ipoji.com/ipo-allotment-status, pick the IPO in the dropdown, then run this again.');
    setTimeout(() => box.remove(), 12000);
    return;
  }

  let lastChecked = -1;
  let lastChange = Date.now();
  let stoppedReason = '';
  for (;;) {
    progress = readProgress(readLines()) || progress;
    setStatus(progress.ipo + ': checked ' + progress.checked + ' of ' + progress.total + '.');
    if (progress.checked !== lastChecked) { lastChecked = progress.checked; lastChange = Date.now(); }
    if (progress.checked >= progress.total) break;
    if (stopRequested) { stoppedReason = 'Stopped early.'; break; }
    if (Date.now() - lastChange > 120000) { stoppedReason = 'ipoji stopped making progress for 2 minutes.'; break; }
    await sleep(2000);
  }

  const lines = readLines();
  const finalProgress = readProgress(lines) || progress;
  const rows = parseRows(lines, finalProgress.endIdx, finalProgress.ipo);
  box.remove();

  const counts = {};
  for (const r of rows) counts[r.result] = (counts[r.result] || 0) + 1;
  const summary = finalProgress.ipo + ': ' + rows.length + ' account(s) - ' +
    (counts.ALLOTTED || 0) + ' allotted, ' + (counts.NOT_ALLOTTED || 0) + ' not allotted, ' +
    (counts.NO_RECORD || 0) + ' no record, ' + (counts.PENDING || 0) + ' still pending, ' + (counts.UNKNOWN || 0) + ' unrecognised.' +
    (stoppedReason ? ' ' + stoppedReason : '');

  let sentToApp = '';
  const inbox = window.__IPOJI_INBOX;
  if (inbox && rows.length > 0) {
    try {
      const res = await fetch(inbox.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ key: inbox.key, rows }),
      });
      sentToApp = res.ok ? 'ok' : 'fail';
    } catch (e) { sentToApp = 'fail'; }
  }

  const json = JSON.stringify(rows);
  const result = document.createElement('div');
  result.id = '__ipojiAllotResult';
  result.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999999;width:min(560px,92vw);background:#0b0e15;color:#e2e8f0;border:1px solid rgba(148,163,184,.22);padding:16px;border-radius:14px;font:13px -apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;box-shadow:0 18px 48px rgba(0,0,0,.7);display:flex;flex-direction:column;gap:10px;';
  const note = sentToApp === 'ok'
    ? 'Sent to your IPO Ledger inbox. Open the portal Applications page: it applies the results by itself, or shows what needs a look.'
    : (sentToApp === 'fail' ? 'Could not send to the app. ' : '') + 'Copy the text below and paste it into the portal (Applications, ipoji sync, paste box), then press Enter.';
  const head = document.createElement('div');
  head.style.cssText = 'font-weight:600;';
  head.textContent = summary;
  const sub = document.createElement('div');
  sub.style.cssText = 'color:#94a3b8;';
  sub.textContent = note;
  const ta = document.createElement('textarea');
  ta.value = json;
  ta.readOnly = true;
  ta.style.cssText = 'width:100%;height:120px;background:#12151f;color:#e2e8f0;border:1px solid rgba(148,163,184,.22);border-radius:8px;padding:8px;font:11px monospace;';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy all';
  copyBtn.style.cssText = 'padding:7px 14px;border-radius:8px;border:0;background:#10b981;color:#04130d;cursor:pointer;font-weight:600;';
  copyBtn.onclick = async () => {
    ta.select();
    try { await navigator.clipboard.writeText(json); copyBtn.textContent = 'Copied'; } catch (e) { copyBtn.textContent = 'Press Ctrl+C'; }
  };
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'padding:7px 14px;border-radius:8px;border:1px solid rgba(148,163,184,.22);background:#12151f;color:#e2e8f0;cursor:pointer;';
  closeBtn.onclick = () => result.remove();
  bar.appendChild(copyBtn);
  bar.appendChild(closeBtn);
  result.appendChild(head);
  result.appendChild(sub);
  result.appendChild(ta);
  result.appendChild(bar);
  document.body.appendChild(result);
  ta.select();
})();`
