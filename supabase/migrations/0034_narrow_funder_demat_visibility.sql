-- ============================================================
-- p_demat_member_funder (0032, patched in 0033) grants a funder full
-- SELECT on the demat_accounts ROW their bank/UPI funded an application
-- from. RLS is row-level, not column-level, so that's not just holder_name
-- — it's phone_e164, dp_client_id, profit_share_percent, pan_masked, notes,
-- everything. AccountsPage does `select('*')` and has no admin gate (RLS is
-- meant to be the actual gate, same as every other page in this app), so a
-- funder who opens /accounts now sees the *full* account details of anyone
-- whose application they happened to fund — far more than the "who is this
-- application for" context the feature was meant to add.
--
-- Fix: drop the row-level grant entirely; replace it with a narrow
-- SECURITY DEFINER resolver (same shape as resolve_profile_names) that
-- returns only holder_name for a caller-supplied id list. ApplicationsPage
-- now resolves funder-only rows' holder names through that instead of an
-- RLS-backed embed.
-- ============================================================

drop policy if exists p_demat_member_funder on demat_accounts;
drop function if exists is_funder_of_demat(uuid);

create or replace function resolve_demat_holder_names(p_ids uuid[])
returns table(id uuid, holder_name text)
language sql security definer set search_path = public as $$
  select id, holder_name from demat_accounts where id = any(p_ids);
$$;
revoke execute on function resolve_demat_holder_names(uuid[]) from public, anon;
grant execute on function resolve_demat_holder_names(uuid[]) to authenticated;
