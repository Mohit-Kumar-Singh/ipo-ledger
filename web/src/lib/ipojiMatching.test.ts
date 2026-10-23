import { describe, expect, it } from 'vitest'
import type { BankAccount, DematAccount, Ipo } from '../types/database'
import {
  aliasedBank,
  aliasedIpo,
  computeLotsAndAmount,
  guessMandateStatus,
  isKnownIpojiStatus,
  matchBank,
  matchDemat,
  matchDematByName,
  matchIpo,
  matchIpoCandidates,
  nameMatches,
  parseScrapedRows,
  sha256Hex,
  upiKey,
} from './ipojiMatching'

const ipo = (over: Partial<Ipo>): Ipo =>
  ({ id: 'i', company_name: 'X', symbol: null, is_archived: false, lot_size: 12, price_high: 1119, ...over }) as unknown as Ipo
const demat = (over: Partial<DematAccount>): DematAccount =>
  ({ id: 'd', holder_name: 'X', pan_hash: 'h', ...over }) as unknown as DematAccount
const bank = (over: Partial<BankAccount>): BankAccount => ({ id: 'b', upi_id: null, ...over }) as unknown as BankAccount

describe('IPO name matching', () => {
  const jio = ipo({ id: 'jio', company_name: 'Jio Platforms' })
  const hd = ipo({ id: 'hd', company_name: 'HD Fire Protect' })
  const bon = ipo({ id: 'bon', company_name: 'Bonfiglioli Transmissions' })
  const tonbo = ipo({ id: 'tonbo', company_name: 'Tonbo Imaging India' })
  const all = [jio, hd, bon, tonbo]

  it("matches ipoji's shorthand: acronym, truncated name and ticker", () => {
    expect(matchIpo('JPL', all)?.id).toBe('jio') // acronym "jp" is a prefix of "jpl"
    expect(matchIpo('HDFIRE', all)?.id).toBe('hd') // truncated name
    expect(matchIpo('BONFIG', all)?.id).toBe('bon')
    expect(matchIpo('TONBO', all)?.id).toBe('tonbo')
    expect(matchIpo('ADROITIND', [ipo({ id: 'a', company_name: 'Adroit Industries', symbol: 'ADROITIND' })])?.id).toBe('a')
  })

  it('returns null for nothing and for an empty name', () => {
    expect(matchIpo('ZZZZ', all)).toBeNull()
    expect(matchIpo('', all)).toBeNull()
    expect(nameMatches('', 'Jio Platforms')).toBe(false)
  })

  it('prefers an exact name over a longer one, then a single active IPO over archived ones, and otherwise does not guess', () => {
    const a = ipo({ id: 'a', company_name: 'Acme Power', is_archived: true })
    const b = ipo({ id: 'b', company_name: 'Acme Power Systems', is_archived: false })
    expect(matchIpoCandidates('ACMEPOWER', [a, b])).toHaveLength(2)
    expect(matchIpo('ACMEPOWER', [a, b])?.id).toBe('a') // exact name wins, even though it is archived
    const c = ipo({ id: 'c', company_name: 'Acme Cables', is_archived: true })
    const d = ipo({ id: 'd', company_name: 'Acme Cables Ltd', is_archived: false })
    expect(matchIpo('ACME', [c, d])?.id).toBe('d') // nothing exact: the single active one wins
    const e = ipo({ id: 'e', company_name: 'Acme Cables Ltd' })
    expect(matchIpo('ACME', [d, e])).toBeNull() // two active candidates: left for the manual picker
  })

  it('honours a remembered mapping only while its target still exists', () => {
    expect(aliasedIpo({ jpl: 'jio' }, 'JPL', all)?.id).toBe('jio')
    expect(aliasedIpo({ jpl: 'gone' }, 'JPL', all)).toBeNull()
    expect(aliasedIpo({}, 'JPL', all)).toBeNull()
  })
})

describe('account matching', () => {
  it('matches by PAN hash first, whatever the name says', async () => {
    const pan = 'DBMPG3932B'
    const hash = await sha256Hex(pan)
    const a = demat({ id: 'a', holder_name: 'Harsh Gandhi', pan_hash: hash })
    const b = demat({ id: 'b', holder_name: 'Someone Else', pan_hash: 'other' })
    expect(await matchDemat('totally different name', pan.toLowerCase(), [a, b])).toEqual({ account: a, byPan: true })
  })

  it('falls back to an exact name, then a unique first name, and refuses to guess between two', async () => {
    const m1 = demat({ id: 'm1', holder_name: 'Manya Singh' })
    const m2 = demat({ id: 'm2', holder_name: 'Manya Gupta' })
    const h = demat({ id: 'h', holder_name: 'Harsh Kholi' })
    expect(matchDematByName('manya singh', [m1, m2, h])?.id).toBe('m1')
    expect(matchDematByName('Manya', [m1, m2, h])).toBeNull() // two Manyas
    expect(matchDematByName('Harsh', [m1, m2, h])?.id).toBe('h') // only one Harsh
    expect(matchDematByName('Zed', [m1, m2, h])).toBeNull()
    expect((await matchDemat('Harsh', undefined, [m1, h])).byPan).toBe(false)
  })
})

describe('funder (UPI) matching', () => {
  const banks = [bank({ id: 'b1', upi_id: 'Namanpreetsingh.m12@okicici' }), bank({ id: 'b2', upi_id: '8527172366@ptyes' })]
  it('matches a UPI exactly, ignoring case and spaces', () => {
    expect(matchBank(' namanpreetsingh.M12@OKICICI ', banks)?.id).toBe('b1')
    expect(matchBank('8527172366@ptyes', banks)?.id).toBe('b2')
    expect(matchBank('unknown@upi', banks)).toBeNull()
    expect(matchBank(undefined, banks)).toBeNull()
    expect(matchBank('  ', banks)).toBeNull()
  })
  it('normalises UPI keys and ignores a dead alias target', () => {
    expect(upiKey('  AB@Ok  ')).toBe('ab@ok')
    expect(upiKey(undefined)).toBe('')
    expect(aliasedBank({ 'x@ok': 'b2' }, 'X@OK', banks)?.id).toBe('b2')
    expect(aliasedBank({ 'x@ok': 'missing' }, 'x@ok', banks)).toBeNull()
  })
})

describe('lots and amount', () => {
  const j = ipo({ lot_size: 12, price_high: 1119 })
  it('derives lots from ipoji quantity and keeps the real amount', () => {
    expect(computeLotsAndAmount(j, '12', '₹13,428')).toEqual({ lots: 1, amount: 13428, lotsGuessed: false })
    expect(computeLotsAndAmount(j, '24', '₹26,856')).toEqual({ lots: 2, amount: 26856, lotsGuessed: false })
  })
  it('computes the amount itself when ipoji gave none, and guesses one lot when the quantity is unreadable', () => {
    expect(computeLotsAndAmount(j, '12', undefined)).toEqual({ lots: 1, amount: 13428, lotsGuessed: false })
    expect(computeLotsAndAmount(j, 'abc', '₹13,428')).toEqual({ lots: 1, amount: 13428, lotsGuessed: true })
    expect(computeLotsAndAmount(null, '12', '1')).toEqual({ lots: null, amount: null, lotsGuessed: false })
  })
})

describe('ipoji status wording', () => {
  it('maps the mandate lifecycle', () => {
    expect(guessMandateStatus('Accepted by Investor')).toBe('APPROVED')
    expect(guessMandateStatus('Request Accepted By Sponsor Bank')).toBe('PENDING')
    expect(guessMandateStatus('Rejected by Investor')).toBe('CANCELLED')
    expect(guessMandateStatus('Bid cancelled successfully')).toBe('CANCELLED')
    expect(guessMandateStatus('Block/Release Request rejected by Client Bank due to Technical Reason')).toBe('CANCELLED')
  })
  it('flags wording it has never seen instead of calling it pending', () => {
    expect(isKnownIpojiStatus('Accepted by Investor')).toBe(true)
    expect(isKnownIpojiStatus('Request Accepted By Sponsor Bank')).toBe(true)
    expect(isKnownIpojiStatus('Bid cancelled successfully')).toBe(true)
    expect(isKnownIpojiStatus('Invalid Combination Of BOID and PAN')).toBe(false)
  })
})

describe('parsing a paste', () => {
  const row = (n: number) => `{"ipo":"JPL","applicant":"Person ${n}","appNumber":"${n}","status":"Accepted by Investor","panNumber":"AAAPA000${n}A"}`

  it('reads a clean array', () => {
    const r = parseScrapedRows(`[${row(1)},${row(2)}]`)
    expect(r.rows).toHaveLength(2)
    expect(r.skippedLabels).toEqual([])
  })

  it('skips one broken row but keeps the rest, and says which one was skipped', () => {
    // a garbled value (stray quote) inside an otherwise complete object
    const broken = '{"ipo":"JPL","applicant":"Parnita","appNumber":"3","status":"x","upiId":"ab"c@ib","panNumber":"CHJPP2137B"}'
    const r = parseScrapedRows(`[${row(1)},${broken},${row(2)}]`)
    expect(r.rows.map((x) => x.applicant)).toEqual(['Person 1', 'Person 2'])
    expect(r.skippedLabels).toHaveLength(1)
    expect(r.skippedLabels[0]).toContain('Parnita')
    expect(r.skippedLabels[0]).toContain('CHJPP2137B')
  })

  it('reports nothing readable for garbage', () => {
    const r = parseScrapedRows('not json at all')
    expect(r.rows).toHaveLength(0)
  })
})
