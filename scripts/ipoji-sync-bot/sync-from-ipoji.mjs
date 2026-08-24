// Local automation for the ipoji -> portal sync flow. Run with `npm start`
// (or `node sync-from-ipoji.mjs`) from this directory.
//
// What it does:
//   1. Opens a real (visible) Chromium window against ipoji.com/bids, using
//      a persistent browser profile stored in ./browser-profile — your
//      ipoji login session is saved there by Chromium itself (cookies),
//      the same way a normal browser remembers you're logged in. This
//      script never sees, asks for, or stores your ipoji password.
//   2. Injects the EXACT same sync script the portal's ipoji-sync panel
//      already asks you to paste into DevTools manually — read straight out
//      of web/src/components/IpojiSyncPanel.tsx at run time, not copied
//      here, so this can never drift out of sync with the real thing.
//   3. Waits for it to finish (it paginates through every page itself, same
//      as the manual flow), then reads the result straight out of
//      localStorage instead of relying on the "Copy all" button + clipboard
//      (clipboard access from automation is flaky across OSes; this is more
//      reliable and does the exact same JSON.stringify(Object.values(store))
//      the button does).
//   4. Opens the portal's Applications page in a new tab (same browser
//      profile — log into the portal manually the first time too, same
//      session-persistence deal), pastes the result into the sync panel,
//      and clicks Preview.
//
// It deliberately STOPS at Preview. Reviewing the multi-lot/duplicate/
// unusual-status/new-UPI warnings and clicking Import is left to you, on
// purpose — that review step exists specifically to catch things an
// automated run can't judge.
//
// First-time setup:
//   npm install              (also downloads a Chromium build for Playwright)
//   set PORTAL_URL if it's not the local dev server — see README.md
//
// Every run after that: npm start. The browser window opens, logs you in
// automatically if the saved session is still valid, and does the rest.

import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORTAL_URL = (process.env.PORTAL_URL || 'http://localhost:5173').replace(/\/+$/, '')
const PROFILE_DIR = join(__dirname, 'browser-profile')

// Reads SYNC_SCRIPT straight out of the real component file rather than
// keeping a second copy here — the exact same extraction technique used to
// validate the script's escaping during development (see the file's own
// comment above SYNC_SCRIPT for why the backtick/backslash escaping matters).
function extractSyncScript() {
  const panelPath = join(__dirname, '..', '..', 'web', 'src', 'components', 'IpojiSyncPanel.tsx')
  let src
  try {
    src = readFileSync(panelPath, 'utf8')
  } catch (err) {
    throw new Error(
      `Couldn't read IpojiSyncPanel.tsx at ${panelPath} — is this script still at scripts/ipoji-sync-bot/ inside the repo? (${err.message})`,
    )
  }
  const startMarker = 'const SYNC_SCRIPT = `'
  const start = src.indexOf(startMarker)
  if (start === -1) {
    throw new Error('Could not find "const SYNC_SCRIPT = `" in IpojiSyncPanel.tsx — has it been renamed or restructured?')
  }
  const afterStart = start + startMarker.length
  const end = src.indexOf('`\n\n// Same script', afterStart)
  if (end === -1) {
    throw new Error('Could not find the end of SYNC_SCRIPT (looked for the comment right after it) — IpojiSyncPanel.tsx may have changed shape.')
  }
  const body = src.slice(afterStart, end)
  // Undo the TS template-literal escaping the source file needs (\` for a
  // literal backtick, \\ for a literal backslash) — same as the real
  // component does implicitly just by being parsed as a JS template string.
  return body.replaceAll('\\`', '`').replaceAll('\\\\', '\\')
}

async function waitForEnter(message) {
  const rl = readline.createInterface({ input, output })
  await rl.question(message)
  rl.close()
}

async function main() {
  console.log('Reading the current sync script from the repo...')
  const syncScript = extractSyncScript()

  console.log(`Launching Chromium (profile: ${PROFILE_DIR})...`)
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  })
  const page = context.pages()[0] ?? (await context.newPage())

  console.log('Opening ipoji.com/bids...')
  await page.goto('https://www.ipoji.com/bids', { waitUntil: 'domcontentloaded' })

  const loggedIn = await page
    .getByRole('link', { name: /my profile/i })
    .or(page.getByRole('button', { name: /log out/i }))
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false)

  if (!loggedIn) {
    await waitForEnter(
      '\nNot logged into ipoji in this browser profile yet.\n' +
        'Log in now in the window that just opened (go to Orders/Bids -> Current tab), ' +
        'then come back here and press Enter to continue...\n',
    )
  } else {
    console.log('Already logged in (saved session) — continuing.')
  }

  // Best-effort — if ipoji's own markup for these labels changes, or we're
  // already on the right tab, these just no-op rather than failing the run.
  await page
    .getByRole('link', { name: /orders\/?bids/i })
    .first()
    .click({ timeout: 5000 })
    .catch(() => {})
  await page
    .getByRole('tab', { name: /^current$/i })
    .click({ timeout: 5000 })
    .catch(() => {})

  console.log('Running the sync script on ipoji — this pages through every entry itself, can take a while for a lot of applications...')
  await page.addScriptTag({ content: syncScript })

  // No fixed short timeout — a real multi-page run genuinely takes minutes.
  await page.waitForSelector('#__ipojiAccumBox', { timeout: 10 * 60 * 1000 })
  console.log('ipoji finished — reading the scraped data out of localStorage...')

  const rows = await page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem('ipojiAccumV1') || '{}')
    return Object.values(store)
  })
  console.log(`Got ${rows.length} row(s) from ipoji.`)

  if (rows.length === 0) {
    console.log('Nothing scraped — leaving the ipoji tab open so you can see why (check its own results box for the reason).')
    return
  }

  console.log(`Opening the portal (${PORTAL_URL}/applications)...`)
  const portalPage = await context.newPage()
  await portalPage.goto(`${PORTAL_URL}/applications`, { waitUntil: 'domcontentloaded' })

  const syncButton = portalPage.getByRole('button', { name: 'Sync from ipoji' })
  const syncButtonVisible = await syncButton.isVisible({ timeout: 8000 }).catch(() => false)
  if (syncButtonVisible) {
    await syncButton.click()
  }
  // If the button wasn't found (panel already open, or you're not logged
  // into the portal as an admin in this profile yet), the textarea.waitFor
  // below will time out with a clear error instead of silently doing nothing.

  const textarea = portalPage.getByPlaceholder('Paste what the script showed you here, then press Enter…')
  await textarea.waitFor({ state: 'visible', timeout: 20000 })
  await textarea.fill(JSON.stringify(rows, null, 2))

  await portalPage.getByRole('button', { name: 'Preview' }).click()

  console.log(
    '\nPasted into the portal and clicked Preview. Review the warnings in the table (multi-lot, ' +
      'possible duplicates, unusual status, new UPI), then click Import yourself when it looks right.\n' +
      'Leaving both browser tabs open — close the window whenever you\'re done.',
  )
}

main().catch((err) => {
  console.error('\nSomething went wrong:', err.message ?? err)
  process.exitCode = 1
})
