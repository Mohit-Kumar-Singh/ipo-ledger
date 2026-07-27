import type { Ipo } from '../types/database'

// "Live" = currently open for bidding (between open_date and close_date,
// inclusive) — the only IPOs it makes sense to apply for.
export function isLiveIpo(ipo: Pick<Ipo, 'open_date' | 'close_date'>): boolean {
  const today = new Date().toISOString().slice(0, 10)
  return today >= ipo.open_date && today <= ipo.close_date
}
