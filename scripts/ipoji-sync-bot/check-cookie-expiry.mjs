// Reads ipoji-cookies.json and reports when each cookie actually expires -
// entirely locally, never sends anything anywhere. Two different kinds of
// expiry get reported, because they're genuinely different things:
//
//   1. The browser-cookie-level expirationDate (when the exported cookie
//      itself expires, if it has one at all - some, like accessToken, are
//      exported as "session" cookies with no fixed date).
//   2. For any cookie whose value happens to be a JWT (three base64url
//      segments separated by dots, a very common access-token format),
//      the token's own internal "exp" claim - decoded read-only, no
//      signature verification, since all this needs is the public expiry
//      field every JWT already carries in plain sight. Never prints the
//      token value itself, only the decoded expiry.
//
// Run: node check-cookie-expiry.mjs

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const COOKIES_PATH = join(__dirname, 'ipoji-cookies.json')

function base64UrlDecode(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

function decodeJwtExpiry(value) {
  const parts = value.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]))
    if (typeof payload.exp !== 'number') return null
    return new Date(payload.exp * 1000)
  } catch {
    return null
  }
}

function formatRelative(date) {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)
  if (diffMs < 0) return `${Math.abs(diffHours).toFixed(1)}h AGO - already expired`
  if (diffHours < 48) return `in ${diffHours.toFixed(1)}h`
  return `in ${(diffHours / 24).toFixed(1)} days`
}

if (!existsSync(COOKIES_PATH)) {
  console.log(`No ipoji-cookies.json found at ${COOKIES_PATH} - export it first (see README.md).`)
  process.exit(1)
}

const cookies = JSON.parse(readFileSync(COOKIES_PATH, 'utf8'))
if (!Array.isArray(cookies)) {
  console.log('ipoji-cookies.json is not an array of cookies - re-export it.')
  process.exit(1)
}

console.log(`Checked ${cookies.length} cookie(s) in ipoji-cookies.json:\n`)

for (const c of cookies) {
  const parts = []
  if (typeof c.expirationDate === 'number') {
    const d = new Date(c.expirationDate * 1000)
    parts.push(`browser-cookie expiry: ${d.toLocaleString()} (${formatRelative(d)})`)
  } else {
    parts.push('browser-cookie expiry: none set (exported as a "session" cookie)')
  }
  const jwtExp = typeof c.value === 'string' ? decodeJwtExpiry(c.value) : null
  if (jwtExp) {
    parts.push(`JWT's own expiry: ${jwtExp.toLocaleString()} (${formatRelative(jwtExp)})`)
  }
  console.log(`${c.name}\n  ${parts.join('\n  ')}\n`)
}

console.log(
  'Whichever of these is soonest is effectively when you\'ll need to re-export - the bot will tell you ' +
    'clearly with a specific error if it\'s actually expired by the time you run it, rather than failing silently.',
)
