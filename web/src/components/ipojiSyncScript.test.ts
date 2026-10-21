import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// SYNC_SCRIPT is a TS template literal, so what actually runs in ipoji's
// console is the template's *evaluated* value - a lone backslash in the source
// (e.g. \s or \/ in a regex) silently disappears and can break the script
// (v1.249.11 shipped "Invalid regular expression flags" this way). This
// evaluates the literal exactly like the runtime does.
function runtimeScript(): string {
  const src = readFileSync(join(__dirname, 'IpojiSyncPanel.tsx'), 'utf8')
  const start = src.indexOf('const SYNC_SCRIPT = `') + 'const SYNC_SCRIPT = `'.length
  const end = src.indexOf('`\n\n// Same script', start)
  // eslint-disable-next-line no-eval
  return (0, eval)('`' + src.slice(start, end) + '`') as string
}

interface Row {
  ipo: string
  applicant: string
  appNumber: string
  status: string
  qty: string
  amount: string
  upiId: string
  panNumber: string
  category: string
  categoryText: string
  boId: string
  source: string
}
interface Helpers {
  decodePayload: (raw: string) => Record<string, string> | null
  formatRupees: (v: unknown) => string
  parsePlaced: (s: string) => Date | null
  rowFromPayload: (p: Record<string, string>) => Row
}

function loadHelpers(): Helpers {
  const script = runtimeScript()
  const a = script.indexOf('// --- helpers begin')
  const b = script.indexOf('// --- helpers end')
  return new Function(`${script.slice(a, b)}\nreturn { decodePayload, formatRupees, parsePlaced, rowFromPayload }`)() as Helpers
}

const payload = {
  companyName: 'JPL',
  applicantName: 'Mohit Kumar Singh',
  category: 'SHAREHOLDER',
  appNo: '100952530',
  fullDpId: '1234567812345678',
  upiId: 'x@ptyes',
  bidQty: '12',
  bidPrice: '₹1,119.00',
  bidAmount: '₹13,428.00',
  placedAt: '21 Oct 2026, 3:40 PM',
  message: 'Request Accepted By Sponsor Bank',
  panNumber: 'KFMPS9040M',
  orderType: 'current',
}

describe('ipoji sync script', () => {
  it('is valid JavaScript once the template literal is evaluated', () => {
    expect(() => new Function(runtimeScript())).not.toThrow()
  })

  it('turns an ipoji order payload into the row the portal expects', () => {
    const { rowFromPayload } = loadHelpers()
    const row = rowFromPayload(payload)
    expect(row).toMatchObject({
      ipo: 'JPL',
      applicant: 'Mohit Kumar Singh',
      appNumber: '100952530',
      status: 'Request Accepted By Sponsor Bank',
      qty: '12',
      amount: '₹13,428',
      upiId: 'x@ptyes',
      panNumber: 'KFMPS9040M',
      category: 'SHAREHOLDER',
      categoryText: 'SHAREHOLDER',
      boId: '1234567812345678',
      source: 'current',
    })
  })

  it('treats the individual category as retail', () => {
    const { rowFromPayload } = loadHelpers()
    const row = rowFromPayload({ ...payload, category: 'IND' })
    expect(row.category).toBe('RETAIL')
    expect(row.categoryText).toBe('')
  })

  it('decodes the URL-encoded JSON attribute and rejects garbage', () => {
    const { decodePayload } = loadHelpers()
    expect(decodePayload(encodeURIComponent(JSON.stringify(payload)))?.appNo).toBe('100952530')
    expect(decodePayload('%E0%A4%A')).toBeNull()
  })

  it('formats amounts like the old card text and parses ipoji placed-at dates', () => {
    const { formatRupees, parsePlaced } = loadHelpers()
    expect(formatRupees('₹14,905.00')).toBe('₹14,905')
    expect(formatRupees('13428')).toBe('₹13,428')
    const d = parsePlaced('21 Oct 2026, 3:40 PM')!
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 21, 15, 40])
    expect(parsePlaced('12 Jan 2026, 12:05 AM')!.getHours()).toBe(0)
    expect(parsePlaced('not a date')).toBeNull()
  })
})
