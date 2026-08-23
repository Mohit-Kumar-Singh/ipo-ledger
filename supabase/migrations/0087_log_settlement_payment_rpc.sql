-- Financial audit finding (P2): PayoutsPage's logPayment() did two
-- sequential, unrelated Supabase calls — insert the settlement_payments row,
-- then separately update applications' legacy paid-flags — with nothing
-- tying them together. If the second call failed, the payment was real and
-- saved (correctly treated as authoritative — the toast already said so
-- rather than lying), but the paid-flags could now silently drift from the
-- ledger until someone noticed the Dashboard tile / Outstanding list still
-- claiming money was owed that the ledger shows as received.
--
-- This wraps both writes in one actual Postgres transaction via an RPC —
-- genuinely atomic (both happen or neither does), not a client-side retry
-- pattern. Deliberately does NOT recompute amountFromHolder/amountToFunder
-- in SQL — that split still only exists in computeProfitSplit on the
-- client (this app's own settlement.ts already documents why: reimplementing
-- it in SQL is exactly the kind of duplicated math that drifts). The client
-- computes which flags a payment clears (settledPaidFlags) exactly as
-- before and passes the two booleans in; this function only makes applying
-- both writes atomic, not decides what to write.
create or replace function log_settlement_payment(
  p_application_id uuid,
  p_kind settlement_payment_kind,
  p_amount numeric,
  p_note text,
  p_idempotency_key uuid,
  p_set_demat_cut_paid boolean,
  p_set_funder_share_paid boolean
) returns settlement_payments
language plpgsql security definer set search_path = public as $$
declare
  v_row settlement_payments;
begin
  if not is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  insert into settlement_payments (application_id, kind, amount, note, idempotency_key, created_by)
  values (p_application_id, p_kind, p_amount, p_note, p_idempotency_key, auth.uid())
  returning * into v_row;

  if p_set_demat_cut_paid or p_set_funder_share_paid then
    update applications set
      demat_cut_paid = demat_cut_paid or p_set_demat_cut_paid,
      funder_share_paid = funder_share_paid or p_set_funder_share_paid
    where id = p_application_id;
  end if;

  return v_row;
end;
$$;
revoke execute on function log_settlement_payment(uuid, settlement_payment_kind, numeric, text, uuid, boolean, boolean) from public, anon;
grant execute on function log_settlement_payment(uuid, settlement_payment_kind, numeric, text, uuid, boolean, boolean) to authenticated;
