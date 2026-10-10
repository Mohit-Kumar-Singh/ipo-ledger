-- A general, non-application-scoped money ledger — "Person A sent me X" /
-- "I sent Person B X" with a note — for exactly the kind of transaction
-- that doesn't belong to any specific sold application: a bulk repayment,
-- an advance, a reimbursement, or simply a debt (like the Honey ~₹2,527
-- case raised earlier this session) the admin wants tracked without
-- inventing a fake application to hang it on.
--
-- Unlike settlement_payments, there's no application_id, no kind enum tied
-- to holder/funder roles, and no paid-flag/archive-sync side effect — this
-- is a plain admin-only table with ordinary RLS, not an RPC. Audited the
-- same way as settlement_payments edits (financial_change_log, 0086), but
-- via an AFTER trigger rather than per-call-site inserts (0092's pattern),
-- so the audit entry can never be forgotten at a future call site that logs,
-- edits, or deletes a row here.
create table manual_transactions (
  id uuid primary key default gen_random_uuid(),
  person_name text not null,
  -- 'from_person': they sent the admin this amount (nets the same way a
  -- holder_to_admin settlement_payment would — reduces what this person
  -- owes, or adds to what the admin owes them if nothing was owed).
  -- 'to_person': the admin sent them this amount (nets the same way an
  -- admin_to_funder settlement_payment would).
  direction text not null check (direction in ('from_person', 'to_person')),
  amount numeric not null check (amount > 0),
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

alter table manual_transactions enable row level security;

create policy p_manual_transactions_admin on manual_transactions
  for all using (is_admin()) with check (is_admin());

revoke all on manual_transactions from public, anon;
grant select, insert, update, delete on manual_transactions to authenticated;

create or replace function log_manual_transaction_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('manual_transactions', NEW.id, 'created', null, to_jsonb(NEW)::text, auth.uid());
  elsif TG_OP = 'UPDATE' then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('manual_transactions', NEW.id, 'updated', to_jsonb(OLD)::text, to_jsonb(NEW)::text, auth.uid());
  elsif TG_OP = 'DELETE' then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('manual_transactions', OLD.id, 'deleted', to_jsonb(OLD)::text, null, auth.uid());
  end if;
  return coalesce(NEW, OLD);
end;
$$;

create trigger trg_log_manual_transaction_change
  after insert or update or delete on manual_transactions
  for each row execute function log_manual_transaction_change();
