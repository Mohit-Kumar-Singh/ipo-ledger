#!/usr/bin/env node
// Compact terminal banner. Run: node scripts/banner.mjs
const FONT = {
  I: ['╦', '║', '╩'],
  P: ['╔═╗', '╠═╝', '╩  '],
  O: ['╔═╗', '║ ║', '╚═╝'],
  L: ['╦  ', '║  ', '╩═╝'],
  E: ['╔═╗', '║╣ ', '╚═╝'],
  D: ['╔╦╗', ' ║║', '═╩╝'],
  G: ['╔═╗', '║ ╦', '╚═╝'],
  R: ['╦═╗', '╠╦╝', '╩╚═'],
  ' ': ['  ', '  ', '  '],
}
const TEXT = 'IPO LEDGER'
const LOGO = Array.from({ length: 3 }, (_, r) => [...TEXT].map((c) => FONT[c][r]).join(' '))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORANGE = '\x1b[38;2;217;119;87m'
const RESET = '\x1b[0m'

async function main() {
  if (!process.stdout.isTTY) {
    console.log(LOGO.join('\n'))
    return
  }
  const out = process.stdout
  const width = LOGO[0].length
  out.write('\x1b[?25l')
  try {
    for (let n = 1; n <= width; n++) {
      out.write(LOGO.map((row) => ORANGE + row.slice(0, n) + RESET).join('\n') + '\n\x1b[3A')
      await sleep(25)
    }
    out.write('\x1b[3B')
  } finally {
    out.write('\x1b[?25h')
  }
}

main()
