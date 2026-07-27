// Extracts a percentage like "17%" or "17.5 %" out of free-text GMP notes
// (e.g. "GMP: ₹95-96 (17%)") — returns null if none is present, since manual
// entries and some ipoji cards don't always include one.
export function parseGmpPercent(gmpNotes: string | null | undefined): number | null {
  if (!gmpNotes) return null
  const match = gmpNotes.match(/(-?\d+(?:\.\d+)?)\s*%/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isNaN(value) ? null : value
}
