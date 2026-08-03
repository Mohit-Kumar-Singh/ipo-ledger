-- ============================================================
-- 0034 dropped p_demat_member_funder (the row-level grant that leaked full
-- demat_accounts rows — phone, DP client ID, profit share, PAN mask — onto
-- /accounts for anyone who'd merely funded an application). But
-- v_allotment_board and v_application_attribution both INNER JOIN
-- demat_accounts, so for a funder-only viewer that join now fails to match
-- at all — the whole application row silently vanishes from both views,
-- which would have broken funder pie-chart credit (Dashboard/Profile) and
-- the "awaiting mandate"/"allotted" Dashboard sections for funders.
--
-- Fix: LEFT JOIN demat_accounts instead of INNER JOIN (so the row survives
-- regardless of that specific RLS check), and resolve holder_name through a
-- narrow SECURITY DEFINER function — same "just the name, nothing else"
-- shape as resolve_demat_holder_names, but usable inline in SQL. Genuinely
-- sensitive columns (pan_masked, phone_e164 in v_allotment_board) still
-- come straight from the LEFT JOIN, so they stay correctly null for a
-- funder-only viewer — only the name broadens, nothing else.
-- ============================================================

create or replace function get_demat_holder_name(p_demat_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select holder_name from demat_accounts where id = p_demat_id;
$$;
revoke execute on function get_demat_holder_name(uuid) from public, anon;
grant execute on function get_demat_holder_name(uuid) to authenticated;

create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       get_demat_holder_name(a.demat_id) as holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name,
       d.profit_share_percent, a.sell_price, i.lot_size,
       a.split_profit_with_funder, a.demat_cut_paid, a.funder_share_paid,
       b.phone_e164 as bank_account_phone
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = a.bank_account_id;

create or replace view v_application_attribution with (security_invoker = true) as
select a.id as application_id, a.ipo_id, i.company_name, i.open_date,
       a.demat_id, get_demat_holder_name(a.demat_id) as holder_name,
       a.bank_account_id, b.linked_user_id as funder_user_id,
       a.created_by
from applications a
join ipos i on i.id = a.ipo_id
left join bank_accounts b on b.id = a.bank_account_id;
