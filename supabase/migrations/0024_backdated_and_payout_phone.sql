-- Backdated applications: an explicit flag set when an admin deliberately
-- records an application for an IPO whose window has already passed
-- (catching up records after the fact), rather than inferring it from dates.
alter table applications add column is_backdated boolean not null default false;

-- Add the bank/UPI account's own phone so the sold-payout WhatsApp message
-- can reach the funder directly, not just the demat holder.
create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       d.holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name,
       d.profit_share_percent, a.sell_price, i.lot_size,
       a.split_profit_with_funder, a.demat_cut_paid, a.funder_share_paid,
       b.phone_e164 as bank_account_phone
from applications a
join ipos i on i.id = a.ipo_id
join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = a.bank_account_id;
