# ipoji sync bot

Automates the manual part of the ipoji sync flow: opening ipoji.com,
pasting the sync script into DevTools, waiting for it to page through
every application, copying the result, switching to the portal, pasting,
and clicking Preview. This does all of that for you — it stops at Preview
and leaves clicking **Import** to you, on purpose (that's the step where
you actually look at the multi-lot / possible-duplicate / unusual-status /
new-UPI warnings).

It runs entirely on your own machine. Your ipoji password is never seen by,
typed into, or stored by this script — see "Logging into ipoji" below for
why that's a hard requirement here, not just a nice-to-have. Your portal
password isn't either; log in there once in the automated window and the
saved browser profile remembers it on later runs.

## Logging into ipoji — read this first

Google's "Sign in with Google" refuses to complete inside ANY browser
Playwright is driving — confirmed live, this isn't specific to Chrome or to
the first version of this script. Every automation framework (Playwright,
Selenium, Puppeteer) marks the browser it controls as automated, on every
engine, and Google's sign-in explicitly checks for that and blocks it. This
script does not try to hide that marker to get around Google's check — that
would be circumventing bot-detection on your own account, which isn't
something to route around even when it's inconvenient.

The actual fix: **don't let this script attempt the sign-in at all.**

1. Log into ipoji normally, in your regular everyday browser (Chrome,
   Firefox, whatever you already use day to day) — completely unautomated,
   so Google's sign-in works exactly as it always does for you.
2. Export that session's cookies (see "Exporting your ipoji cookies" below)
   to `ipoji-cookies.json` in this folder.
3. This script loads those cookies into its own browser *before* it ever
   navigates to ipoji — so it shows up already logged in, the same way
   syncing a saved session across devices doesn't "log in" either. It never
   goes near the Google sign-in flow.

If `ipoji-cookies.json` isn't present, the script still lets you try
logging in directly in the automated window as a fallback — but be aware
"Continue with Google" specifically is very likely to get blocked there.
The cookie file is the reliable path.

## Exporting your ipoji cookies

Any cookie-export browser extension that outputs JSON works; **Cookie-Editor**
(by cgagnier — free, open-source, available for both Chrome and Firefox) is
a common, well-known choice:

1. Install "Cookie-Editor" from your browser's extension store.
2. Log into `ipoji.com` normally in that browser.
3. With an ipoji.com tab open and active, click the Cookie-Editor icon.
4. Click **Export** (top toolbar) → choose the **JSON** format → this
   copies the cookies to your clipboard.
5. Paste that into a new file named `ipoji-cookies.json`, saved directly in
   this folder (`scripts/ipoji-sync-bot/ipoji-cookies.json`).

That file is already gitignored — never commit it, it's a live login
session for your ipoji account. Re-export it whenever the session expires
(the script will tell you clearly if that's happened, rather than silently
scraping nothing).

## Setup (one-time)

From this folder (`scripts/ipoji-sync-bot/`):

```bash
npm install
```

This also downloads a Firefox build for Playwright to drive (via the
`postinstall` script) — a few hundred MB, one-time.

If your deployed portal isn't at `http://localhost:5173`, set `PORTAL_URL`
before running — see "Configuring the portal URL" below.

## Running it

```bash
npm start
```

A real Firefox window opens. First run:

1. It loads `ipoji-cookies.json` if present (see "Logging into ipoji"
   above) and navigates to `ipoji.com/bids` — you should land there already
   logged in. If it's not present and you're not logged in, it pauses and
   offers to let you try logging in manually in that window, then press
   Enter in the terminal to continue (heads up: Google sign-in is likely to
   be blocked there — see above for why the cookie file is the reliable
   path).
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

`./browser-profile/` — a local Firefox profile directory (cookies, local
storage, etc.) created on first run. This is what makes you not need to log
in every single time. It's already gitignored — never commit it, it holds
live session cookies for both ipoji and the portal.

To force a fresh login (e.g. you changed your password, or want to switch
which account this runs as), just delete that folder and run `npm start`
again.

## If something breaks

- **"Couldn't sign you in" / "This browser or app may not be secure" when
  using "Continue with Google" inside the automated window** — expected,
  see "Logging into ipoji" above. Set up `ipoji-cookies.json` instead of
  trying to sign in inside the automated browser directly.
- **"ipoji-cookies.json loaded but the page still shows logged out"** — the
  exported session has expired. Re-export fresh cookies (same steps as
  above) and re-run.
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
