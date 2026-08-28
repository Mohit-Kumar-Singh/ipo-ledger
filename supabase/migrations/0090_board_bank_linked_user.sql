-- ============================================================
-- Exposes which portal user owns the FUNDING bank account on each row, so
-- the funder-facing settlement statement can scope to "rows I actually
-- funded" instead of "rows that have some funder."
--
-- Why this is needed — a latent money-misattribution bug:
--
--   p_apps_member_write on `applications` is `for ALL`, and ALL includes
--   SELECT. So an account holder who is a linked portal user can select
--   every application on their own demat account, including ones funded by
--   somebody else.
--
--   FunderPayoutsPage's funder-only path (no :funderName in the route, so
--   it relies purely on RLS scoping) filtered those rows with
--   `hasFunder && !isFunderSelf`, which is true for exactly those
--   someone-else-funded rows. That holder would then see another person's
--   outstanding balance totalled into their own "Total to be sent."
--
--   It does not fire on current data — there are no SOLD applications today
--   where the holder is a linked user and the funder is a different one, so
--   nothing is wrong on screen right now. But nothing prevents it either,
--   and the failure mode is showing one user another user's money in a
--   financial statement, so it's worth closing before that data exists
--   rather than after.
--
-- This is the same "a SELECT grant is not the same as the row being YOURS"
-- gotcha this schema has hit before; the fix is to give the frontend the
-- ownership fact it needs to filter on, not to loosen or tighten RLS (the
-- holder genuinely should be able to see their own application — they just
-- shouldn't have its funder's balance attributed to them).
--
-- Appended at the END of the select list on purpose: `create or replace
-- view` can add columns, but only at the end, and cannot reorder or retype
-- existing ones (0088 already hit 42P16 doing the latter).
-- ============================================================

create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       get_demat_holder_name(a.demat_id) as holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name,
       get_demat_profit_share_percent(a.demat_id)::numeric(5,2) as profit_share_percent,
       a.sell_price, i.lot_size,
       a.split_profit_with_funder, a.demat_cut_paid, a.funder_share_paid,
       b.phone_e164 as bank_account_phone,
       a.mandate_status,
       i.is_archived as ipo_is_archived,
       a.funder_override_id is not null as is_funder_override,
       i.close_date,
       d.linked_user_id as demat_linked_user_id,
       a.status_changed_at,
       i.gmp_notes,
       d.platform,
       get_demat_account_manager_id(a.demat_id) as account_manager_id,
       m.full_name as account_manager_name,
       m.phone_e164 as account_manager_phone,
       m.case_type as account_manager_case_type,
       b.linked_user_id as bank_account_linked_user_id
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id)
left join account_managers m on m.id = get_demat_account_manager_id(a.demat_id);
