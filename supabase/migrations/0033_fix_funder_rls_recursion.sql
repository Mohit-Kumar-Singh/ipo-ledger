-- ============================================================
-- 0032's funder-visibility policies created a genuine RLS cycle:
--
--   demat_accounts.p_demat_member_funder  -> reads applications, bank_accounts
--   applications.p_apps_member_funder_select -> reads bank_accounts
--   bank_accounts.p_bank_member (0016)    -> reads applications, demat_accounts
--   applications.p_apps_member_write      -> reads demat_accounts
--
-- Evaluating any one of these can require evaluating another, which loops
-- back — Postgres can't even plan the query and fails every read with
-- "infinite recursion detected in policy for relation demat_accounts"
-- (42P17), for every user including admins (is_admin() never gets a chance
-- to short-circuit because planning fails first). The app swallowed this
-- error silently (only checked `data`, never `error`), so it just rendered
-- as "no applications, no accounts" instead of an error.
--
-- Fix: route the two newly-added cross-table checks through SECURITY
-- DEFINER helpers, which bypass RLS on the tables *they* read internally —
-- same pattern as resolve_profile_names/request_demat_link elsewhere in
-- this app. That breaks the cycle without changing who can see what.
-- ============================================================

create or replace function is_funder_of_demat(p_demat_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from applications a
    join bank_accounts b on b.id = a.bank_account_id
    where a.demat_id = p_demat_id and b.linked_user_id = auth.uid()
  );
$$;
revoke execute on function is_funder_of_demat(uuid) from public, anon;
grant execute on function is_funder_of_demat(uuid) to authenticated;

create or replace function bank_account_linked_to_self(p_bank_account_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from bank_accounts where id = p_bank_account_id and linked_user_id = auth.uid());
$$;
revoke execute on function bank_account_linked_to_self(uuid) from public, anon;
grant execute on function bank_account_linked_to_self(uuid) to authenticated;

drop policy if exists p_demat_member_funder on demat_accounts;
create policy p_demat_member_funder on demat_accounts for select
  using (is_funder_of_demat(demat_accounts.id));

drop policy if exists p_apps_member_funder_select on applications;
create policy p_apps_member_funder_select on applications for select
  using (bank_account_linked_to_self(bank_account_id));
