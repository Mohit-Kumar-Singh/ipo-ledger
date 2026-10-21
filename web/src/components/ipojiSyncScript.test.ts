import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// SYNC_SCRIPT is a TS template literal, so what actually runs in ipoji's
// console is the template's *evaluated* value - a lone backslash in the source
// (e.g. \s or \/ in a regex) silently disappears and can break the script
// (v1.249.11 shipped "Invalid regular expression flags" this way). This
// evaluates the literal exactly like the runtime does and checks it parses.
function runtimeScript(): string {
  const src = readFileSync(join(__dirname, 'IpojiSyncPanel.tsx'), 'utf8')
  const start = src.indexOf('const SYNC_SCRIPT = `') + 'const SYNC_SCRIPT = `'.length
  const end = src.indexOf('`\n\n// Same script', start)
  // eslint-disable-next-line no-eval
  return (0, eval)('`' + src.slice(start, end) + '`') as string
}

describe('ipoji sync script', () => {
  it('is valid JavaScript once the template literal is evaluated', () => {
    expect(() => new Function(runtimeScript())).not.toThrow()
  })

  it('tells a SHAREHOLDER card line from a plain retail card', () => {
    const script = runtimeScript()
    const helpers = script.match(/const SHAREHOLDER_RE[\s\S]*?(?=\n {2}function walkForShareholder)/)![0]
    const { findShareholderText } = new Function(`${helpers}; return { findShareholderText }`)() as {
      findShareholderText: (lines: string[], skip: string[]) => string
    }
    const skip = ['JPL', 'Mohit']
    expect(findShareholderText(['JPL', 'Mohit', 'SHAREHOLDER', 'App', '1'], skip)).toBe('SHAREHOLDER')
    expect(findShareholderText(['JPL', 'Mohit', 'App', '1'], skip)).toBe('')
    expect(findShareholderText(['JPL', 'Mohit', 'Shareholder', 'No'], skip)).toBe('')
  })
})
