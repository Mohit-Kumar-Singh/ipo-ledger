// The portal-wide convention: only the dedicated IPOs page shows a company's
// full name (that's the one place it's actually the point — picking the
// right one out of a list of similarly-named IPOs, or confirming exact
// spelling). Every other screen that references an IPO by name — Payouts,
// Allotment board, Applications, Archives, Holdings, Notifications — shows
// just the first word, so a long name like "ESDS Software Solution" or
// "Kanohar Electricals" doesn't dominate a compact row/card the way the full
// name would. Centralized here instead of each page hand-rolling its own
// `.split(' ')[0]` (which a few pages already did, inconsistently, before
// this existed) so the trim rule can't drift between screens.
//
// Deliberately NOT used for: outbound WhatsApp/notification message text
// (the recipient needs the real, unambiguous company name, not a hint of
// it) or an IPO-picker <select>/<option> list (picking the wrong IPO because
// two names share a first word is worse than a slightly longer dropdown).
export function firstIpoWord(companyName: string | null | undefined): string {
  if (!companyName) return ''
  return companyName.trim().split(/\s+/)[0]
}
