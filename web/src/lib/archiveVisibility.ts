// The Archives page's own base list — every archived IPO, full stop. See
// ArchivesPage.tsx's call site for why this must never be filtered further
// (e.g. "only ones with at least one application") no matter how tempting
// that looks for cutting down noise: a prior version did exactly that,
// which silently made an archived IPO with ZERO applications permanently
// unreachable anywhere in the app — not in the active list (correct, by
// design) and also not in Archives (the bug), with no button left to
// unarchive it short of a direct database edit. Confirmed live: 16 real
// archived IPOs had exactly this problem before the fix.
export function selectArchivedIpos<T extends { is_archived: boolean }>(allIpos: T[]): T[] {
  return allIpos.filter((ipo) => ipo.is_archived)
}

type ArchiveRuleRow = { status: string; demat_cut_paid: boolean; funder_share_paid: boolean }

// The same "nothing left to do" rule the database uses to archive an IPO
// (sync_ipo_archive, migration 0115): NOT_ALLOTTED, or SOLD with both payout
// sides settled. Anything else is still open work.
export function isResolvedForArchive(a: ArchiveRuleRow): boolean {
  return a.status === 'NOT_ALLOTTED' || (a.status === 'SOLD' && a.demat_cut_paid && a.funder_share_paid)
}

// Plain-language list of what's still open on an IPO, for the "archive
// anyway?" prompt. Empty string when nothing is open.
export function describeOpenWork(rows: ArchiveRuleRow[]): string {
  const awaiting = rows.filter((a) => a.status === 'APPLIED').length
  const held = rows.filter((a) => a.status === 'ALLOTTED' || a.status === 'PARTIALLY_SOLD').length
  const unpaid = rows.filter((a) => a.status === 'SOLD' && !(a.demat_cut_paid && a.funder_share_paid)).length
  const parts = [
    awaiting > 0 ? `${awaiting} still waiting for an allotment result` : null,
    held > 0 ? `${held} with shares not fully sold` : null,
    unpaid > 0 ? `${unpaid} with payouts not settled` : null,
  ].filter(Boolean)
  return parts.join(', ')
}
