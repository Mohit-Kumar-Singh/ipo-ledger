-- v_application_attribution only exposed bank_accounts.linked_user_id as
-- funder_user_id, so an application funded via a named UPI/bank account
-- that was never linked to a portal login (e.g. a family member with no
-- account) fell through to 100%-credit-to-holder instead of splitting with
-- whoever actually funded it. Add the raw account_holder_name so the
-- frontend can split credit to that name directly when there's no
-- linked_user_id to resolve.
create or replace view v_application_attribution with (security_invoker = true) as
select a.id as application_id, a.ipo_id, i.company_name, i.open_date,
       a.demat_id, get_demat_holder_name(a.demat_id) as holder_name,
       a.bank_account_id, b.linked_user_id as funder_user_id,
       a.created_by,
       b.account_holder_name as funder_name
from applications a
join ipos i on i.id = a.ipo_id
left join bank_accounts b on b.id = a.bank_account_id;
