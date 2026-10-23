import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALLOTMENT_SCRIPT } from './ipojiAllotmentScript'

// End-to-end runs of the two browser scripts (applications + allotment) inside
// a fake browser: a stub DOM, a fake fetch serving ipoji-shaped pages, a fake
// localStorage and a fake inbox endpoint. Verifies the whole script - paging,
// dedupe, age cut-off, logged-out / HTTP-failure handling, what is saved and
// what is posted to the portal inbox - not just its helper functions.

function runtimeSyncScript(): string {
  const src = readFileSync(join(__dirname, '../components/IpojiSyncPanel.tsx'), 'utf8')
  const start = src.indexOf('const SYNC_SCRIPT = `') + 'const SYNC_SCRIPT = `'.length
  const end = src.indexOf('`\n\n// Same script', start)
  // eslint-disable-next-line no-eval
  return (0, eval)('`' + src.slice(start, end) + '`') as string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// A callable object that answers any property/call with itself - lets the
// scripts' UI code (status boxes, buttons, textareas) run without a real DOM.
function stub(): any {
  const store: Record<string | symbol, unknown> = {}
  const fn: any = new Proxy(function () {}, {
    get(_t, p) {
      if (p in store) return store[p]
      if (p === Symbol.toPrimitive) return () => ''
      if (p === 'then') return undefined
      if (p === 'style') return (store.style ??= {})
      return fn
    },
    set(_t, p, v) {
      store[p] = v
      return true
    },
    apply() {
      return fn
    },
  })
  return fn
}

function placed(d: Date): string {
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  const h = d.getHours() % 12 || 12
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getDate()} ${mon} ${d.getFullYear()}, ${h}:${mm} ${d.getHours() >= 12 ? 'PM' : 'AM'}`
}

interface Order {
  appNo: string
  companyName: string
  applicantName: string
  category?: string
  placedAt: string
  orderType: string
  panNumber?: string
  upiId?: string
}
const order = (n: number, o: Partial<Order> = {}): Record<string, string> => ({
  appNo: String(70000000 + n),
  companyName: 'JPL',
  applicantName: `Person ${n}`,
  category: 'IND',
  bidQty: '12',
  bidPrice: '₹1,119.00',
  bidAmount: '₹13,428.00',
  placedAt: placed(new Date()),
  message: 'Accepted by Investor',
  panNumber: `AAAPA${String(1000 + n).padStart(4, '0')}A`,
  upiId: `u${n}@ibl`,
  fullDpId: `120800000000${n}`,
  orderType: 'current',
  ...(o as Record<string, string>),
})

const html = (orders: Record<string, string>[]) =>
  orders.map((p) => `<div class="order-card-v2" data-order-payload="${encodeURIComponent(JSON.stringify(p))}"></div>`).join('')

class FakeDOMParser {
  parseFromString(h: string) {
    return {
      querySelectorAll: (sel: string) =>
        sel === '.order-card-v2'
          ? [...h.matchAll(/data-order-payload="([^"]*)"/g)].map((m) => ({ getAttribute: () => m[1] }))
          : [],
    }
  }
}

interface Site {
  /** path (with query) -> orders on that page, or a function for custom responses */
  pages: Record<string, Record<string, string>[] | ((url: string) => { ok: boolean; status: number; url: string; body: string })>
  inbox?: { status: number } | 'throw'
}

async function runSync(site: Site, withInbox = false) {
  const requested: string[] = []
  const posts: { url: string; body: any }[] = []
  const logs: unknown[][] = []
  const ls: Record<string, string> = {}
  const origin = 'https://www.ipoji.com'
  const fakeFetch = async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body as string) })
      if (site.inbox === 'throw') throw new Error('network down')
      return { ok: (site.inbox ?? { status: 200 }).status < 400, status: 200 }
    }
    const path = url.replace(origin, '')
    requested.push(path)
    const page = site.pages[path]
    if (page === undefined) return { ok: true, status: 200, url, text: async () => html([]) }
    if (typeof page === 'function') {
      const r = page(url)
      return { ok: r.ok, status: r.status, url: r.url, text: async () => r.body }
    }
    return { ok: true, status: 200, url, text: async () => html(page) }
  }
  const document = {
    createElement: () => stub(),
    body: stub(),
    head: stub(),
    querySelectorAll: () => [],
    getElementById: () => stub(),
    querySelector: () => stub(),
  }
  const win: any = {}
  if (withInbox) win.__IPOJI_INBOX = { url: 'https://example.test/functions/v1/ipoji-inbox', key: 'test-key' }
  const run = new Function(
    'document', 'window', 'location', 'localStorage', 'fetch', 'DOMParser', 'console', 'setTimeout', 'navigator', 'confirm',
    'return ' + runtimeSyncScript(),
  )
  await run(
    document, win, { origin, href: origin + '/bids' },
    { getItem: (k: string) => ls[k] ?? null, setItem: (k: string, v: string) => { ls[k] = v }, removeItem: (k: string) => { delete ls[k] } },
    fakeFetch, FakeDOMParser, { log: (...a: unknown[]) => logs.push(a), error() {} },
    (fn: () => void) => { fn(); return 0 }, { clipboard: { writeText: async () => {} } }, () => true,
  )
  const finished = logs.find((l) => l[0] === '[ipoji auto] FINISHED')
  return {
    requested,
    posts,
    reason: finished?.[1] as string,
    total: finished?.[3] as number,
    errors: finished?.[5] as number,
    stored: Object.values(JSON.parse(ls.ipojiAccumV1 ?? '{}')) as any[],
  }
}

const many = (from: number, n: number, o: Partial<Order> = {}) => Array.from({ length: n }, (_, i) => order(from + i, o))

describe('applications script, end to end (fake ipoji)', () => {
  it('pages current bids until a short page, then reads recent past bids, and stores every row once', async () => {
    const r = await runSync({
      pages: {
        '/bids': many(1, 10),
        '/bids?currentIndex=1': many(11, 10),
        '/bids?currentIndex=2': many(21, 4),
        '/bids/past': many(100, 10, { orderType: 'past' }),
        '/bids/past?pastIndex=1': many(110, 3, { orderType: 'past' }),
      },
    })
    expect(r.requested).toEqual([
      '/bids', '/bids?currentIndex=1', '/bids?currentIndex=2', '/bids/past', '/bids/past?pastIndex=1',
    ])
    expect(r.total).toBe(37)
    expect(r.stored).toHaveLength(37)
    expect(r.errors).toBe(0)
    expect(r.reason).toMatch(/Read current bids and the last 21 days/)
    expect(new Set(r.stored.map((x) => x.appNumber)).size).toBe(37)
  })

  it('sends rows with category / PAN / UPI / status in the portal format, shareholder kept apart', async () => {
    const r = await runSync(
      { pages: { '/bids': [order(1), order(2, { category: 'SHAREHOLDER', appNo: '100000002' })] } },
      true,
    )
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0].body.key).toBe('test-key')
    const rows = r.posts[0].body.rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ ipo: 'JPL', category: 'RETAIL', status: 'Accepted by Investor', qty: '12', amount: '₹13,428' })
    expect(rows[1]).toMatchObject({ category: 'SHAREHOLDER', categoryText: 'SHAREHOLDER', appNumber: '100000002' })
    expect(rows[0].panNumber).toMatch(/^[A-Z]{5}[0-9]{4}[A-Z]$/)
  })

  it('stops paging past bids once a whole page is older than 21 days, and drops the old rows', async () => {
    const old = placed(new Date(Date.now() - 40 * 86400000))
    const r = await runSync({
      pages: {
        '/bids': many(1, 3),
        '/bids/past': [...many(100, 4, { orderType: 'past' }), ...many(110, 6, { orderType: 'past', placedAt: old })],
        '/bids/past?pastIndex=1': many(120, 10, { orderType: 'past', placedAt: old }),
        '/bids/past?pastIndex=2': many(130, 10, { orderType: 'past', placedAt: old }),
      },
    })
    expect(r.total).toBe(7) // 3 current + 4 recent past
    expect(r.requested).toContain('/bids/past?pastIndex=1')
    expect(r.requested).not.toContain('/bids/past?pastIndex=2')
  })

  it('does not loop forever if the server ignores the page parameter', async () => {
    const same = many(1, 10)
    const r = await runSync({ pages: { '/bids': same, '/bids?currentIndex=1': same, '/bids?currentIndex=2': same } })
    expect(r.requested.filter((p) => p.startsWith('/bids?')).length).toBe(1)
    expect(r.total).toBe(10)
  })

  it('reports a logged-out session instead of syncing nothing silently', async () => {
    const r = await runSync({
      pages: { '/bids': () => ({ ok: true, status: 200, url: 'https://www.ipoji.com/login', body: '<html>login</html>' }) },
    })
    expect(r.reason).toMatch(/Not logged in to ipoji/)
    expect(r.total).toBe(0)
  })

  it('keeps what it already read when a later page fails, and says so', async () => {
    const r = await runSync({
      pages: {
        '/bids': many(1, 10),
        '/bids?currentIndex=1': () => ({ ok: false, status: 500, url: 'x', body: '' }),
      },
    })
    expect(r.total).toBe(10)
    expect(r.errors).toBe(1)
    expect(r.reason).toMatch(/failed .*HTTP 500.*saved/)
  })

  it('still finishes (and shows the copy box) when the inbox send fails', async () => {
    const r = await runSync({ pages: { '/bids': many(1, 2) }, inbox: 'throw' }, true)
    expect(r.posts).toHaveLength(1)
    expect(r.total).toBe(2)
  })

  it('does not post to the inbox when there are no rows', async () => {
    const r = await runSync({ pages: { '/bids': [] } }, true)
    expect(r.posts).toHaveLength(0)
  })
})

// ---------------- allotment script ----------------

interface AllotAccount {
  name: string
  pan: string
  status: string
}
async function runAllot(opts: { frames: string[][]; inbox?: boolean }) {
  const posts: any[] = []
  let readCount = 0
  const main = {
    get innerText() {
      const frame = opts.frames[Math.min(readCount++, opts.frames.length - 1)]
      return frame.join(String.fromCharCode(10))
    },
  }
  const document = {
    createElement: () => stub(),
    body: stub(),
    querySelector: (sel: string) => (sel === 'main' ? main : stub()),
    querySelectorAll: () => [],
  }
  const win: any = opts.inbox ? { __IPOJI_INBOX: { url: 'https://example.test/inbox', key: 'k' } } : {}
  const run = new Function('document', 'window', 'fetch', 'console', 'setTimeout', 'navigator', 'return ' + ALLOTMENT_SCRIPT)
  await run(
    document, win,
    async (_u: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body))
      return { ok: true }
    },
    { log() {}, error() {} }, (fn: () => void) => { fn(); return 0 }, { clipboard: { writeText: async () => {} } },
  )
  return { posts }
}

function allotPage(checked: number, total: number, accounts: AllotAccount[]): string[] {
  return [
    'Home', 'IPO Allotment Status', 'HD FIRE PROTECT LIMITED', 'HD FIRE PROTECT LIMITED', String(checked), '/' + total, 'CHECKED',
    'Allotted', '1', 'Not Allotted', '1', 'No Record Found', '1', 'Checking', '0', 'Pending', '0',
    'Manage Acc', 'Add Acc',
    ...accounts.flatMap((a) => [a.name, a.pan, ...(a.status ? [a.status] : [])]),
    'IPO Allotment Guide', 'text',
  ]
}

describe('allotment script, end to end (fake ipoji)', () => {
  const accounts: AllotAccount[] = [
    { name: 'Amit', pan: 'IJKPK0707F', status: 'Allotted' },
    { name: 'Anshit', pan: 'DUIPG7530Q', status: 'Not Allotted' },
    { name: 'Avinash', pan: 'DPBPR5373N', status: 'No record found' },
  ]

  it('waits for the check to finish, then sends classified results to the inbox', async () => {
    const r = await runAllot({
      inbox: true,
      frames: [
        allotPage(0, 3, [accounts[0], { ...accounts[1], status: '' }, { ...accounts[2], status: '' }]),
        allotPage(2, 3, [accounts[0], accounts[1], { ...accounts[2], status: '' }]),
        allotPage(3, 3, accounts),
      ],
    })
    expect(r.posts).toHaveLength(1)
    const rows = r.posts[0].rows
    expect(rows.map((x: any) => [x.applicant, x.result])).toEqual([
      ['Amit', 'ALLOTTED'],
      ['Anshit', 'NOT_ALLOTTED'],
      ['Avinash', 'NO_RECORD'],
    ])
    expect(rows.every((x: any) => x.kind === 'allotment' && x.ipo === 'HD FIRE PROTECT LIMITED')).toBe(true)
  })

  it('does nothing (and does not post) when no IPO has been selected on the page', async () => {
    const r = await runAllot({ inbox: true, frames: [['Home', 'IPO Allotment Status', 'Select an IPO', 'IPO Allotment Guide']] })
    expect(r.posts).toHaveLength(0)
  })
})
