import type { Ipo } from '../types/database'

// "Live" = from the IPO's open date through its listing date (falling back
// to close date if listing isn't set yet) — covers bidding as well as the
// allotment/pre-listing window, since applications are still relevant to
// track right up to listing, not just while bidding is open.
export function isLiveIpo(ipo: Pick<Ipo, 'open_date' | 'close_date' | 'listing_date'>): boolean {
  const today = new Date().toISOString().slice(0, 10)
  const end = ipo.listing_date ?? ipo.close_date
  return today >= ipo.open_date && today <= end
}
