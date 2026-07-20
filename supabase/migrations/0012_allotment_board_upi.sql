-- ============================================================
-- v_allotment_board: include UPI + bank-account holder name, since
-- bank_name/last4 are now optional (UPI-only entries are common).
-- ============================================================
create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       d.holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name
from applications a
join ipos i on i.id = a.ipo_id
join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = a.bank_account_id;
