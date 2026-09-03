-- settlement_payments has been append-only from the UI since 0078 — the
-- only writer was log_settlement_payment (0087), which inserts and can only
-- ever flip a paid-flag false -> true. A mistyped amount or wrong `kind`
-- therefore had no fix short of hand-editing the row in the SQL editor.
--
-- These two RPCs add edit + delete, admin-only, atomic, and audited:
--   * the mutation itself,
--   * a financial_change_log row per changed field (0086 pattern — old/new
--     value, changed_by), so a corrected or removed payment still leaves a
--     trail,
--   * an ABSOLUTE re-set of the application's demat_cut_paid /
--     funder_share_paid flags (NOT the monotonic OR in log_settlement_payment
--     — lowering or deleting a payment can legitimately push a side back
--     from settled to outstanding), with the resulting booleans computed
--     client-side exactly as settledPaidFlags/isCardFullySettled already do
--     (computeProfitSplit stays on the client — see settlement.ts), and
--   * an archive re-sync: an IPO that auto-archived because every row was
--     resolved must come back if an edit/delete un-resolves one, which the
--     client-side maybeAutoArchiveIpo never did (it only ever archives).
--
-- All writes run in the one function body = one implicit transaction, same
-- guarantee 0087 gives the insert path.

-- Archive iff every application on the IPO is resolved (NOT_ALLOTTED, or
-- SOLD with both paid-flags) — the exact rule maybeAutoArchiveIpo checks
-- client-side, but here it also UN-archives when the rule stops holding.
-- No-op for an IPO with no applications (bool_and over zero rows is null).
create or replace function sync_ipo_archive(p_ipo uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_all_resolved boolean;
begin
  select bool_and(
           status = 'NOT_ALLOTTED'
           or (status = 'SOLD' and demat_cut_paid and funder_share_paid)
         )
    into v_all_resolved
  from applications
  where ipo_id = p_ipo;

  if v_all_resolved is null then
    return;
  end if;

  update ipos
     set is_archived = v_all_resolved
   where id = p_ipo
     and is_archived is distinct from v_all_resolved;
end;
$$;
revoke execute on function sync_ipo_archive(uuid) from public, anon;
grant execute on function sync_ipo_archive(uuid) to authenticated;

create or replace function update_settlement_payment(
  p_id uuid,
  p_kind settlement_payment_kind,
  p_amount numeric,
  p_note text,
  p_demat_cut_paid boolean,
  p_funder_share_paid boolean
) returns settlement_payments
language plpgsql security definer set search_path = public as $$
declare
  v_old settlement_payments;
  v_new settlement_payments;
  v_ipo uuid;
begin
  if not is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_old from settlement_payments where id = p_id;
  if not found then
    raise exception 'settlement payment % not found', p_id using errcode = 'P0002';
  end if;

  update settlement_payments
     set kind = p_kind, amount = p_amount, note = p_note
   where id = p_id
   returning * into v_new;

  if v_old.amount is distinct from v_new.amount then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('settlement_payments', p_id, 'amount', v_old.amount::text, v_new.amount::text, auth.uid());
  end if;
  if v_old.kind is distinct from v_new.kind then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('settlement_payments', p_id, 'kind', v_old.kind::text, v_new.kind::text, auth.uid());
  end if;
  if v_old.note is distinct from v_new.note then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('settlement_payments', p_id, 'note', v_old.note, v_new.note, auth.uid());
  end if;

  update applications
     set demat_cut_paid = p_demat_cut_paid,
         funder_share_paid = p_funder_share_paid
   where id = v_new.application_id
   returning ipo_id into v_ipo;

  perform sync_ipo_archive(v_ipo);
  return v_new;
end;
$$;
revoke execute on function update_settlement_payment(uuid, settlement_payment_kind, numeric, text, boolean, boolean) from public, anon;
grant execute on function update_settlement_payment(uuid, settlement_payment_kind, numeric, text, boolean, boolean) to authenticated;

create or replace function delete_settlement_payment(
  p_id uuid,
  p_demat_cut_paid boolean,
  p_funder_share_paid boolean
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_old settlement_payments;
  v_ipo uuid;
begin
  if not is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_old from settlement_payments where id = p_id;
  if not found then
    raise exception 'settlement payment % not found', p_id using errcode = 'P0002';
  end if;

  delete from settlement_payments where id = p_id;

  -- Whole removed row captured as JSON in old_value so a deletion is just as
  -- recoverable-by-hand as a field edit, without a column_name that pretends
  -- one field changed.
  insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
  values ('settlement_payments', p_id, 'deleted', to_jsonb(v_old)::text, null, auth.uid());

  update applications
     set demat_cut_paid = p_demat_cut_paid,
         funder_share_paid = p_funder_share_paid
   where id = v_old.application_id
   returning ipo_id into v_ipo;

  perform sync_ipo_archive(v_ipo);
end;
$$;
revoke execute on function delete_settlement_payment(uuid, boolean, boolean) from public, anon;
grant execute on function delete_settlement_payment(uuid, boolean, boolean) to authenticated;
