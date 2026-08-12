-- p_bank_member's third clause grants a demat holder full SELECT on
-- bank_accounts for anyone who funded one of their applications — RLS is
-- row-level, not column-level, so that's not just "who funded me" but the
-- funder's full upi_id/phone_e164/bank_name/last4. Verified live: a plain
-- member (demat owner, not the bank owner, not admin) got back their
-- funder's real UPI ID and phone number via a direct scoped query. Same
-- mistake this app already fixed once on demat_accounts (0032 -> 0034),
-- now found on bank_accounts too.
--
-- Fix: same pattern — drop the row-level grant for that relationship,
-- replace with a narrow SECURITY DEFINER resolver returning only
-- account_holder_name. The other two p_bank_member clauses (own account,
-- account directly linked to your own demat) are untouched — those really
-- are "this is yours."

drop policy if exists p_bank_member on bank_accounts;
create policy p_bank_member on bank_accounts for select
  using (
    linked_user_id = auth.uid()
    or exists (select 1 from demat_accounts d where d.id = bank_accounts.demat_id and d.linked_user_id = auth.uid())
  );

create or replace function resolve_bank_holder_names(p_ids uuid[])
returns table(id uuid, account_holder_name text)
language sql security definer set search_path = public as $$
  select id, account_holder_name from bank_accounts where id = any(p_ids);
$$;
revoke execute on function resolve_bank_holder_names(uuid[]) from public, anon;
grant execute on function resolve_bank_holder_names(uuid[]) to authenticated;
