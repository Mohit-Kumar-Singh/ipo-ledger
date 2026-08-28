-- ============================================================
-- Confirmed live from two side-by-side screenshots of the SAME allotted
-- application (Augmont / funded by Jigyansh / holder Manya singh):
--
--   admin  sees  profit ₹1,886   return ₹16,859   holder "Manya singh"
--   funder sees  profit ₹2,022   return ₹16,994   holder "Unknown"
--
-- Both numbers came from the same expectedProfitBreakdown() call. The gap
-- is entirely demat_accounts RLS: a funder is NOT linked to the demat
-- account they funded (0034 deliberately removed the row-level grant that
-- used to leak phone_e164/dp_client_id/notes along with it), so:
--
--   * `holder_name`          -> already survived, via get_demat_holder_name()
--   * `profit_share_percent` -> came back NULL, and every consumer falls
--                               back to `?? 25`. This account's real cut is
--                               30%, so the funder's own projection skipped
--                               5% of the gross and over-reported their
--                               share by exactly the observed ₹136.
--   * `account_manager_id`   -> came back NULL too, so CASE_2 shared-account
--                               detection silently failed the same way.
--
-- Fix follows the pattern 0035 already established for holder_name rather
-- than re-opening the row: narrow `stable security definer` scalar
-- resolvers for the two specific fields, used inside v_allotment_board
-- (which is security_invoker = true, so its own `left join demat_accounts`
-- stays RLS-filtered for everything else).
--
-- Why profit_share_percent is safe to show a funder: it's already disclosed
-- to them in plain text by the funder WhatsApp message this app sends
-- (buildFunderAllottedMessage prints "− 30% (account holder tax cut)" as a
-- line of the profit breakdown). It is not secret from the funder; it was
-- only ever collateral damage from 0034 dropping the whole-row grant.
-- phone_e164, dp_client_id, notes and the login credential columns stay
-- exactly as locked down as 0034 left them.
-- ============================================================

create or replace function get_demat_profit_share_percent(p_demat_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select profit_share_percent from demat_accounts where id = p_demat_id;
$$;
revoke execute on function get_demat_profit_share_percent(uuid) from public, anon;
grant execute on function get_demat_profit_share_percent(uuid) to authenticated;

create or replace function get_demat_account_manager_id(p_demat_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select account_manager_id from demat_accounts where id = p_demat_id;
$$;
revoke execute on function get_demat_account_manager_id(uuid) from public, anon;
grant execute on function get_demat_account_manager_id(uuid) to authenticated;

-- Same view as 0079, with d.profit_share_percent / d.account_manager_id
-- swapped for the definer resolvers above. The account_managers join keys
-- off the resolved id for the same reason -- it was silently producing NULL
-- manager rows for a funder viewer, which is what made CASE_2 shared
-- accounts fall back to the ordinary 3-way split on their side only.
create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       get_demat_holder_name(a.demat_id) as holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name,
       -- ::numeric(5,2), not bare numeric — `create or replace view` cannot
       -- change an existing column's data type, and the column this replaces
       -- (d.profit_share_percent) carries the table's own numeric(5,2)
       -- typmod. Without the cast Postgres rejects the whole replace with
       -- 42P16 "cannot change data type of view column".
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
       m.case_type as account_manager_case_type
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id)
left join account_managers m on m.id = get_demat_account_manager_id(a.demat_id);

-- Extend the narrow row resolver the frontend uses for the embedded-join
-- paths (Dashboard's profit projection, Payouts' expected/settlement
-- queries) -- those fetch demat_accounts(...) as a PostgREST embed, which
-- RLS blocks wholesale for a funder-funded row, so they need the same two
-- fields back through a resolver rather than the embed.
drop function if exists resolve_demat_holder_names(uuid[]);

create function resolve_demat_holder_names(p_ids uuid[])
returns table(id uuid, holder_name text, pan_masked text, profit_share_percent numeric, account_manager_id uuid)
language sql security definer set search_path = public as $$
  select id, holder_name, pan_masked, profit_share_percent, account_manager_id
  from demat_accounts where id = any(p_ids);
$$;
revoke execute on function resolve_demat_holder_names(uuid[]) from public, anon;
grant execute on function resolve_demat_holder_names(uuid[]) to authenticated;
