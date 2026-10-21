import { describe, expect, it } from 'vitest'
import { ALLOTMENT_SCRIPT } from './ipojiAllotmentScript'

interface Row {
  kind: string
  ipo: string
  applicant: string
  panNumber: string
  status: string
  result: string
  shares: number | null
}
interface Helpers {
  readProgress: (lines: string[]) => { checked: number; total: number; ipo: string; endIdx: number } | null
  classify: (status: string) => string
  parseRows: (lines: string[], startIdx: number, ipo: string) => Row[]
}

// The helpers sit between two marker comments so they can be run on their own.
function loadHelpers(): Helpers {
  const m = ALLOTMENT_SCRIPT.match(/const PAN_RE[^\n]*\n[^\n]*LABELS[^\n]*\n[\s\S]*?\/\/ --- helpers end/)
  const withNl = "const NL = String.fromCharCode(10);\n"
  return new Function(`${withNl}${m![0]}\nreturn { readProgress, classify, parseRows }`)() as Helpers
}

// Shape copied from what ipoji's allotment page actually rendered (2026-10-21).
const PAGE = [
  'Home', 'IPO', 'Allotment', 'IPO Allotment Status', 'Check all your accounts in one place',
  'SHELLZ INDIA LIMITED', 'SHELLZ INDIA LIMITED', '5', '/67', 'CHECKED',
  'Allotted', '1', 'Not Allotted', '1', 'No Record Found', '2', 'Checking', '1', 'Pending', '62',
  'Manage Acc', 'Add Acc',
  'Aditya Arpit', 'DZSPP0186A', 'No record found',
  'Amit Patel', 'IJKPK0707F', 'Allotted',
  'Anshika Prakhar', 'DVTPP8730D', 'Not Allotted',
  'Arpit Pal', 'KFUPS6316L', 'Checking…',
  'Arpit Patel', 'DZSPP0184C',
  'Z Vikki', 'EOXPR9303N',
  'IPO Allotment Guide', 'Complete guide to understanding IPO allotment process',
]

describe('ipoji allotment script', () => {
  it('is valid JavaScript once the template literal is evaluated', () => {
    expect(() => new Function(ALLOTMENT_SCRIPT)).not.toThrow()
  })

  it('has no backslashes (they would be dropped by the template literal)', () => {
    expect(ALLOTMENT_SCRIPT.includes(String.fromCharCode(92))).toBe(false)
  })

  it('reads progress, the IPO name and the counters', () => {
    const p = loadHelpers().readProgress(PAGE)!
    expect(p.checked).toBe(5)
    expect(p.total).toBe(67)
    expect(p.ipo).toBe('SHELLZ INDIA LIMITED')
    expect(PAGE[p.endIdx]).toBe('Manage Acc')
  })

  it('classifies the status wordings', () => {
    const { classify } = loadHelpers()
    expect(classify('Allotted')).toBe('ALLOTTED')
    expect(classify('Allotted 21 shares')).toBe('ALLOTTED')
    expect(classify('Not Allotted')).toBe('NOT_ALLOTTED')
    expect(classify('No record found')).toBe('NO_RECORD')
    expect(classify('Checking…')).toBe('PENDING')
    expect(classify('')).toBe('PENDING')
    expect(classify('Something odd')).toBe('UNKNOWN')
  })

  it('pairs each PAN with its own name and status, including rows with no status yet', () => {
    const h = loadHelpers()
    const p = h.readProgress(PAGE)!
    const rows = h.parseRows(PAGE, p.endIdx, p.ipo)
    expect(rows.map((r) => [r.applicant, r.panNumber, r.result])).toEqual([
      ['Aditya Arpit', 'DZSPP0186A', 'NO_RECORD'],
      ['Amit Patel', 'IJKPK0707F', 'ALLOTTED'],
      ['Anshika Prakhar', 'DVTPP8730D', 'NOT_ALLOTTED'],
      ['Arpit Pal', 'KFUPS6316L', 'PENDING'],
      ['Arpit Patel', 'DZSPP0184C', 'PENDING'],
      ['Z Vikki', 'EOXPR9303N', 'PENDING'],
    ])
    expect(rows[1].kind).toBe('allotment')
    expect(rows[1].ipo).toBe('SHELLZ INDIA LIMITED')
  })
})
