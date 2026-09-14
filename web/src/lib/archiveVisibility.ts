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
