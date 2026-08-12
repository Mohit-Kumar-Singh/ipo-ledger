import { supabase } from './supabase'

// Archives an IPO the instant every one of its applications is resolved —
// either NOT_ALLOTTED, or SOLD with both payout flags settled — instead of
// waiting for the nightly cron sweep (migration 0052) to notice. Marking
// the last application on an IPO (bulk "not allotted," or the last "mark
// paid") is what actually closes the loop for whoever's doing it, so the
// card should disappear from Applications/Allotment board/Dashboard right
// then, not up to a day later.
//
// Mixed IPOs count too — some applications NOT_ALLOTTED and others
// SOLD-and-paid is still "nothing left to do here," same as all-one-status.
// An IPO with zero applications is left alone (nothing to resolve, and the
// existing close-date-with-no-applications cron rule already covers that
// case on its own schedule).
export async function maybeAutoArchiveIpo(ipoId: string): Promise<void> {
  const { data, error } = await supabase
    .from('applications')
    .select('status, demat_cut_paid, funder_share_paid')
    .eq('ipo_id', ipoId)
  if (error || !data || data.length === 0) return

  const allResolved = data.every(
    (a) => a.status === 'NOT_ALLOTTED' || (a.status === 'SOLD' && a.demat_cut_paid && a.funder_share_paid),
  )
  if (!allResolved) return

  await supabase.from('ipos').update({ is_archived: true }).eq('id', ipoId)
}
