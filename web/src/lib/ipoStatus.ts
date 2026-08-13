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

// Retail bidding on NSE/BSE actually cuts off in the late afternoon on the
// close date, not at midnight — a pure calendar-date comparison (today <=
// close_date) stays "open" until 11:59pm on the close date, which is
// generous in one direction (fine) but wrong in the other: it can't ever
// flip to Closed until the NEXT calendar day even though bidding really
// ended hours earlier that same afternoon. This models that cutoff
// directly instead of only having date-level granularity.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const BID_CUTOFF_HOUR = 16
const BID_CUTOFF_MINUTE = 50

// "Now," expressed as IST wall-clock fields — shifts the UTC clock by IST's
// offset and then reads UTC getters off the shifted value, which is the
// standard trick for getting a fixed-offset zone's wall-clock time without
// a timezone database.
function nowIst(): { dateStr: string; hour: number; minute: number } {
  const ist = new Date(Date.now() + IST_OFFSET_MS)
  return { dateStr: ist.toISOString().slice(0, 10), hour: ist.getUTCHours(), minute: ist.getUTCMinutes() }
}

// The exact instant (epoch ms) bidding ends for a given close date — 4:50pm
// IST that day, i.e. 11:20 UTC (16:50 - the 5:30 IST offset). Exported so
// anything rendering a continuous/time-based fill (IpoTimeline's progress
// line) can treat the Open->Close segment as ending here instead of at
// that day's midnight, matching the same cutoff isOpenForBidding/
// hasBiddingClosed already enforce for eligibility.
export function bidCutoffMs(closeDateIso: string): number {
  const [y, m, d] = closeDateIso.split('-').map(Number)
  const cutoffMinutesIst = BID_CUTOFF_HOUR * 60 + BID_CUTOFF_MINUTE
  const cutoffMinutesUtc = cutoffMinutesIst - IST_OFFSET_MS / 60000
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) + cutoffMinutesUtc * 60 * 1000
}

// Strictly the bidding window (open_date..close_date, cut off at 4:50pm IST
// on close_date itself) — "live" in the narrower sense of "can actually
// apply to this right now," not "still worth tracking." Used to gate the
// new-application IPO picker: an IPO that's closed-but-not-yet-listed is
// still isLiveIpo (see above) but applying to it now would be a mistake,
// not a legitimate late entry — that's what backdated mode is for instead.
export function isOpenForBidding(ipo: Pick<Ipo, 'open_date' | 'close_date'>): boolean {
  const { dateStr, hour, minute } = nowIst()
  if (dateStr < ipo.open_date || dateStr > ipo.close_date) return false
  if (dateStr === ipo.close_date && (hour > BID_CUTOFF_HOUR || (hour === BID_CUTOFF_HOUR && minute >= BID_CUTOFF_MINUTE))) {
    return false
  }
  return true
}

// The stricter, one-directional half of isOpenForBidding — true once
// bidding has definitively ended (past the close date, or past the 4:50pm
// IST cutoff on the close date itself), false the entire time it's still
// open OR hasn't opened yet. Distinct from `!isOpenForBidding` because that
// would also be true for an IPO that hasn't opened yet — this only ever
// means "too late," never "too early."
export function hasBiddingClosed(ipo: Pick<Ipo, 'open_date' | 'close_date'>): boolean {
  const { dateStr, hour, minute } = nowIst()
  if (dateStr > ipo.close_date) return true
  if (dateStr === ipo.close_date) return hour > BID_CUTOFF_HOUR || (hour === BID_CUTOFF_HOUR && minute >= BID_CUTOFF_MINUTE)
  return false
}
