-- Exposes demat_accounts.linked_user_id on v_allotment_board — needed by
-- the Allotment board UI to tell apart "this viewer owns this account" from
-- "this viewer merely funded it," so the Allotted/Not-allotted mark
-- buttons and bulk 'mark selected not allotted' action can be hidden from a
-- funder-only viewer instead of silently no-op'ing.
--
-- Real bug this fixes: applications' own RLS write policy
-- (p_apps_member_write, migration 0032) only lets the DEMAT ACCOUNT OWNER
-- write status changes — a funder-only viewer has SELECT-only access
-- (p_apps_member_funder_select). The board's markStatus()/
-- bulkMarkNotAllotted() never checked the update's error/row count, so a
-- funder clicking "Allotted" saw the button, the request went out, RLS
-- silently matched zero rows, and the board just reloaded showing the same
-- unchanged status — no error, no feedback, just a button that appeared to
-- do nothing.
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
       a.funder_override_id is not null as is_funder_override,
       i.close_date,
       d.linked_user_id as demat_linked_user_id
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id);
