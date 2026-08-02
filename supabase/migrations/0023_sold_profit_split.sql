-- ============================================================
-- Sold-status profit split: track whether a sold application's
-- profit is split 50/50 with the funding bank/UPI holder, and
-- whether the demat holder's cut / funder's share have been paid
-- out. Amounts themselves are computed client-side (sell_price,
-- bid_amount, profit_share_percent, lot_size) rather than stored,
-- so they stay correct if a sell price gets corrected later.
-- ============================================================
alter table applications
  add column split_profit_with_funder boolean not null default false,
  add column demat_cut_paid boolean not null default false,
  add column funder_share_paid boolean not null default false;

-- `create or replace view` can only append columns, not reorder/rename
-- existing ones — new columns must go at the end of the select list.
create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       d.holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name,
       d.profit_share_percent, a.sell_price, i.lot_size,
       a.split_profit_with_funder, a.demat_cut_paid, a.funder_share_paid
from applications a
join ipos i on i.id = a.ipo_id
join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = a.bank_account_id;
