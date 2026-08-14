-- Surfaces "this application's funding credit was manually reassigned to a
-- different UPI/bank account" (funder_override_id set, migration 0063) on
-- the allotment board too — previously only ApplicationsPage showed this
-- (the 🏷️ tag next to the holder's name); the board had no way to tell an
-- override-funded row apart from a normal one at all. is_funder_override is
-- a plain boolean, not the raw id, since the board already resolves the
-- effective funder's name via bank_account_holder_name (coalesce'd) — this
-- just flags that a coalesce actually happened for that row.
create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       get_demat_holder_name(a.demat_id) as holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name,
       d.profit_share_percent, a.sell_price, i.lot_size,
       a.split_profit_with_funder, a.demat_cut_paid, a.funder_share_paid,
       b.phone_e164 as bank_account_phone,
       a.mandate_status,
       i.is_archived as ipo_is_archived,
       a.funder_override_id is not null as is_funder_override
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id);
