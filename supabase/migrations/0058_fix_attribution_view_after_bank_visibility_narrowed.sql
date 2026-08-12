-- 0057 narrowed p_bank_member (dropped the clause that let a demat owner see
-- the FULL bank_accounts row of anyone who funded them — that's what leaked
-- raw UPI ID/phone/bank name, not just a name). But v_application_attribution
-- is security_invoker and selected b.account_holder_name straight off that
-- same join — for a non-admin, non-bank-owner viewer, funder_name would now
-- silently come back null, breaking funder pie-chart credit on
-- Dashboard/Profile for exactly the case migration 0057 was fixing.
--
-- Same fix as 0035 already established for get_demat_holder_name: resolve
-- the name through a narrow SECURITY DEFINER function instead of the direct
-- join. Only the name broadens back out — funder_user_id and every other
-- column in this view still come straight from the RLS-scoped join, so
-- nothing sensitive is reintroduced.
create or replace function get_bank_holder_name(p_bank_account_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select account_holder_name from bank_accounts where id = p_bank_account_id;
$$;
revoke execute on function get_bank_holder_name(uuid) from public, anon;
grant execute on function get_bank_holder_name(uuid) to authenticated;

create or replace view v_application_attribution with (security_invoker = true) as
select a.id as application_id, a.ipo_id, i.company_name, i.open_date,
       a.demat_id, get_demat_holder_name(a.demat_id) as holder_name,
       a.bank_account_id, b.linked_user_id as funder_user_id,
       a.created_by,
       get_bank_holder_name(a.bank_account_id) as funder_name
from applications a
join ipos i on i.id = a.ipo_id
left join bank_accounts b on b.id = a.bank_account_id;
