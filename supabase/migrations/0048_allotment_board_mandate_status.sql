-- ============================================================
-- Expose mandate_status (0047) on v_allotment_board so the Dashboard's
-- "Awaiting mandate approval" tile can filter on the real field instead of
-- its previous proxy (every application still in APPLIED status, which
-- conflated "mandate not yet approved" with "allotment just hasn't run
-- yet" — most APPLIED applications have nothing to do with mandate status
-- at all once the mandate itself has already been approved).
-- ============================================================
create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       get_demat_holder_name(a.demat_id) as holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name,
       d.profit_share_percent, a.sell_price, i.lot_size,
       a.split_profit_with_funder, a.demat_cut_paid, a.funder_share_paid,
       b.phone_e164 as bank_account_phone,
       a.mandate_status
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = a.bank_account_id;
