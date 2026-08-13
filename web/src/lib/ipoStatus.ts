import type { Ipo } from '../types/database'

// "Live" = from the IPO's open date through its listing date (falling back
// to close date if listing isn't set yet) — covers bidding as well as the
// allotment/pre-listing window, since applications are still relevant to
// track right up to listing, not just while bidding is open. Used where
// "still relevant to track" is the question (Dashboard's progress gauges,
// the close-date notification rollup) — NOT the same as "can I still apply
// to this," see isOpenForBidding below for that.
export function isLiveIpo(ipo: Pick<Ipo, 'open_date' | 'close_date' | 'listing_date'>): boolean {
  const today = new Date().toISOString().slice(0, 10)
  const end = ipo.listing_date ?? ipo.close_date
  return today >= ipo.open_date && today <= end
}

// Strictly the bidding window (open_date..close_date) — "live" in the
// narrower sense of "can actually apply to this right now," not "still
// worth tracking." Used to gate the new-application IPO picker: an IPO
// that's closed-but-not-yet-listed is still isLiveIpo (see above) but
// applying to it now would be a mistake, not a legitimate late entry —
// that's what backdated mode is for instead.
export function isOpenForBidding(ipo: Pick<Ipo, 'open_date' | 'close_date'>): boolean {
  const today = new Date().toISOString().slice(0, 10)
  return today >= ipo.open_date && today <= ipo.close_date
}
