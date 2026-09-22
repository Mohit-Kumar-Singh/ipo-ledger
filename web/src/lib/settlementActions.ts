// The one write path for "mark this side of a sold application settled" —
// pulled out of PayoutsPage.tsx (where it first lived as markCardSettled)
// so AllotmentBoardPage.tsx's own "Mark paid" buttons can share it instead
// of keeping a second, independent implementation.
//
// Root-cause fix: both call sites used to write `applications.demat_cut_paid`
// / `funder_share_paid` directly via a raw `.update()`, entirely bypassing
// the settlement_payments ledger (migration 0078). That let the flag say
// "settled" while every ledger-based view (Payouts "You need to receive",
// Settlement — by IPO, Dashboard, FunderPayoutsPage) still showed the FULL
// amount outstanding forever, since nothing had ever been logged for
// buildSettlementCards to net against — confirmed live for Charu's Karamtara
// application (flag true, ledger still showing the full ₹19,354 owed). This
// function is now the only place either call site writes through, always
// via the log_settlement_payment RPC (same atomic payment-row-insert +
// flag-update transaction the granular per-application form already used),
// so the two can never drift apart again.
import { supabase } from './supabase'
import { maybeAutoArchiveIpo } from './autoArchive'
import { settledPaidFlags, SETTLED_EPSILON, type SettlementCard } from './settlement'

export type SettleSide = 'holder_to_admin' | 'admin_to_funder'

export async function markSideSettled(card: SettlementCard, kind: SettleSide): Promise<{ error: string | null }> {
  const amount = kind === 'holder_to_admin' ? card.remainingFromHolder : card.remainingToFunder
  if (amount <= SETTLED_EPSILON) return { error: null }
  const nextFromHolder = card.remainingFromHolder - (kind === 'holder_to_admin' ? amount : 0)
  const nextToFunder = card.remainingToFunder - (kind === 'admin_to_funder' ? amount : 0)
  const flags = settledPaidFlags(card, nextFromHolder, nextToFunder)
  const { error } = await supabase.rpc('log_settlement_payment', {
    p_application_id: card.applicationId,
    p_kind: kind,
    p_amount: amount,
    p_note: null,
    p_idempotency_key: crypto.randomUUID(),
    p_set_demat_cut_paid: !!flags.demat_cut_paid,
    p_set_funder_share_paid: !!flags.funder_share_paid,
  })
  // 23505 = this exact key already landed (a retry after a timeout) — same
  // "already saved" treatment the granular log-a-payment form uses.
  if (error && error.code !== '23505') return { error: error.message }
  if (!error && Object.keys(flags).length > 0) await maybeAutoArchiveIpo(card.ipoId)
  return { error: null }
}
