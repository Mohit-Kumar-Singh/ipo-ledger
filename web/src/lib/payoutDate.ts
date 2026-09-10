// ── The ONE business date that decides which month a Payout-portal figure
//    belongs to ───────────────────────────────────────────────────────────
//
// The Payouts analytics dashboard groups everything it shows — realized and
// unrealized profit, the invested amount behind them, the per-IPO and
// per-account breakdown, capital utilisation, allotment/sale counts — into a
// selected month range (This month / Last month / …). Every one of those
// figures is classified by THIS function and nothing else, so one
// application can never straddle two months.
//
// Why not applied_at (what the dashboard used before): an IPO's ~3-day
// application window routinely crosses a month boundary — ESDS opened 28 Aug
// and closed 1 Sep, Lumino opened 27 Aug. "When did I submit the bid" is not
// a money event, and this is a payout ledger, not an activity log. The money
// events are ALLOTMENT and SALE:
//
//   ALLOTTED               → the IPO's allotment_date. The real allotment
//                            day, shared by every application on that IPO,
//                            and always populated on this data set. Falls
//                            back to status_changed_at (when the admin
//                            actually marked the row), then applied_at.
//   PARTIALLY_SOLD         → same as ALLOTTED for the row itself — its
//                            still-held remainder is an open position. Each
//                            already-sold tranche is dated individually by
//                            its own application_sells.sold_on inside
//                            buildBookedProfitLines, so a partial sale in a
//                            different month from the allotment still lands
//                            in the right bucket.
//   SOLD                   → the sale date: the latest
//                            application_sells.sold_on, else
//                            status_changed_at, else applied_at.
//   APPLIED / NOT_ALLOTTED → applied_at. No allotment, no profit line — they
//                            only ever feed the secondary "applications
//                            submitted" count, for which the submission date
//                            is exactly right.
//
// The returned value is always a bare IST `yyyy-mm-dd` (see istDateOf): a
// timestamptz is shifted into IST first so an event just after IST midnight
// is not bucketed into the previous UTC day, and the range boundaries it is
// compared against are themselves built from an IST "today".
import { istDateOf } from './ipoStatus'

type SellDate = { sold_on?: string | null }

// The most recent tranche sale date recorded against a row, or null when the
// row has no dated tranches (older data, or a direct sell_price entry with
// no application_sells rows). Exported so buildBookedProfitLines can date a
// fully-SOLD row's single realized line by its actual last sale rather than
// by whenever its status column was last touched.
export function latestSoldOn(row: { application_sells?: readonly SellDate[] | null }): string | null {
  let max: string | null = null
  for (const s of row.application_sells ?? []) {
    if (s.sold_on && (max === null || s.sold_on > max)) max = s.sold_on
  }
  return max
}

export type PayoutClassifiableRow = {
  status: 'APPLIED' | 'ALLOTTED' | 'NOT_ALLOTTED' | 'PARTIALLY_SOLD' | 'SOLD'
  applied_at: string
  status_changed_at?: string
  application_sells?: readonly SellDate[] | null
  ipos: { allotment_date?: string | null } | null
}

export function payoutClassificationDate(row: PayoutClassifiableRow): string {
  switch (row.status) {
    case 'SOLD':
      return istDateOf(latestSoldOn(row) ?? row.status_changed_at ?? row.applied_at)
    case 'ALLOTTED':
    case 'PARTIALLY_SOLD':
      return istDateOf(row.ipos?.allotment_date ?? row.status_changed_at ?? row.applied_at)
    default:
      return istDateOf(row.applied_at)
  }
}

// True once a row has a real money event (allotment or sale) — i.e. it can
// carry a realized or unrealized profit line and a payout obligation. The
// per-IPO / per-account / capital breakdowns are built only from these;
// APPLIED and NOT_ALLOTTED rows are payout noise and never appear in them.
export function isAllotmentStatus(status: PayoutClassifiableRow['status']): boolean {
  return status === 'ALLOTTED' || status === 'PARTIALLY_SOLD' || status === 'SOLD'
}
