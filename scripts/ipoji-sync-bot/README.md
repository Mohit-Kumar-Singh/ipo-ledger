# ipoji sync bot

Automates the manual part of the ipoji sync flow: opening ipoji.com,
pasting the sync script into DevTools, waiting for it to page through
every application, copying the result, switching to the portal, pasting,
and clicking Preview. This does all of that for you — it stops at Preview
and leaves clicking **Import** to you, on purpose (that's the step where
you actually look at the multi-lot / possible-duplicate / unusual-status /
new-UPI warnings).

It runs entirely on your own machine. Your ipoji password and portal
password are never seen by, typed into, or stored by this script — you log
into both manually, once, in the real browser window it opens, and Chromium
saves that session the same way it would in your normal browser. Every run
after that reuses the saved session automatically.

## Setup (one-time)

From this folder (`scripts/ipoji-sync-bot/`):

```bash
npm install
```

This also downloads a Chromium build for Playwright to drive (via the
`postinstall` script) — a few hundred MB, one-time.

If your deployed portal isn't at `http://localhost:5173`, set `PORTAL_URL`
before running — see "Configuring the portal URL" below.

## Running it

```bash
npm start
```

A real Chromium window opens. First run:

1. It navigates to `ipoji.com/bids`. If you're not logged in yet, it pauses
   and asks you to log in manually in that window (go to **Orders/Bids ->
   Current** tab), then press Enter in the terminal to continue.
2. It injects the same sync script the portal's "Copy sync script" button
   gives you — read live from `web/src/components/IpojiSyncPanel.tsx`, so
   it can never drift out of sync with what the portal actually does — and
   waits for it to finish paginating through every application.
3. It opens the portal's Applications page in a new tab. If you're not
   logged into the portal yet in this browser profile, log in there too
   when prompted (same one-time deal).
4. It clicks "Sync from ipoji", pastes the scraped data into the box, and
   clicks Preview.
5. It stops. Review the table — lots/duplicates/status/UPI warnings and
   all — and click Import yourself when it looks right.

On later runs, both logins are usually already saved, so it just opens the
window and runs straight through to the Preview step with no prompts.

## Configuring the portal URL

Defaults to `http://localhost:5173` (the dev server). To point it at your
deployed portal instead:

**PowerShell:**
```powershell
$env:PORTAL_URL = "https://your-deployed-portal-url"
npm start
```

**Git Bash / macOS / Linux:**
```bash
PORTAL_URL=https://your-deployed-portal-url npm start
```

## Where your session lives

`./browser-profile/` — a local Chromium profile directory (cookies, local
storage, etc.) created on first run. This is what makes you not need to log
in every single time. It's already gitignored — never commit it, it holds
live session cookies for both ipoji and the portal.

To force a fresh login (e.g. you changed your password, or want to switch
which account this runs as), just delete that folder and run `npm start`
again.

## If something breaks

- **"Could not find SYNC_SCRIPT" / "Could not find the end of SYNC_SCRIPT"**
  — the panel component's source structure changed since this script was
  written. Open `web/src/components/IpojiSyncPanel.tsx`, find where
  `SYNC_SCRIPT` is defined, and update the markers in
  `extractSyncScript()` in `sync-from-ipoji.mjs` to match.
- **Times out waiting for `#__ipojiAccumBox`** — the sync script itself
  errored on ipoji's page, most likely because ipoji changed their site
  layout (same risk the manual console-paste flow already has). Check the
  browser window's own DevTools console for `[ipoji auto]` log lines.
- **Times out waiting for the portal's textarea** — either the "Sync from
  ipoji" button wasn't found (not logged into the portal as an admin in
  this profile yet), or the portal's own UI changed. Log in manually in
  that tab and re-run.
