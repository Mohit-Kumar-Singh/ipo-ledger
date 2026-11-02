-- ============================================================
-- RLS policies were re-running their checks once PER ROW.
--
-- Postgres can't inline a SECURITY DEFINER function, and it doesn't cache a
-- bare `auth.uid()` / `is_admin()` call inside a policy, so every row scanned
-- paid for a fresh `is_admin()` (a profiles lookup), `is_manager_of_demat(x)`,
-- `bank_account_linked_to_self(x)` and so on. With ~1,000 applications that
-- made the applications visibility check alone ~80 ms per read for an admin,
-- and the hot reads (v_allotment_board, v_application_attribution,
-- Applications/Dashboard embeds) 150–600 ms each, peaking at 4 s. Supabase's
-- advisor flags the same thing (auth_rls_initplan).
--
-- Fix, without changing who can see what:
--   * `is_admin()` / `auth.uid()` are wrapped as `(select ...)`, so Postgres
--     evaluates them once per query (an InitPlan) instead of per row.
--   * Per-row helper calls / EXISTS subqueries become `col in (select f())`,
--     where f() is a STABLE SECURITY DEFINER set-returning helper. Postgres
--     runs it once and probes a hash per row. Being SECURITY DEFINER, these
--     helpers read their tables without RLS, so they keep 0033's guarantee
--     that no policy reads back into another policy (no 42P17 cycle).
--
-- Measured on production data as an admin: the applications visibility
-- filter went from 80 ms to 1.5 ms.
-- ============================================================

-- Demat accounts the caller holds themselves.
create or replace function my_demat_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from demat_accounts where linked_user_id = auth.uid();
$$;

-- Demat accounts whose account manager is linked to the caller
-- (set-based twin of is_manager_of_demat).
create or replace function my_managed_demat_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select d.id from demat_accounts d
  join account_managers m on m.id = d.account_manager_id
  where m.linked_user_id = auth.uid();
$$;

-- Bank accounts linked to the caller (set-based twin of
-- bank_account_linked_to_self).
create or replace function my_bank_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from bank_accounts where linked_user_id = auth.uid();
$$;

-- Applications the caller funds, through either the original bank account or
-- a funder override (set-based twin of is_own_funder_application).
create or replace function my_funded_application_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select a.id from applications a
  join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id)
  where b.linked_user_id = auth.uid();
$$;

-- anon gets an empty set (auth.uid() is null), so it may call them; that
-- keeps an anonymous read returning no rows rather than a permission error.
revoke execute on function my_demat_ids() from public;
revoke execute on function my_managed_demat_ids() from public;
revoke execute on function my_bank_ids() from public;
revoke execute on function my_funded_application_ids() from public;
grant execute on function my_demat_ids() to anon, authenticated;
grant execute on function my_managed_demat_ids() to anon, authenticated;
grant execute on function my_bank_ids() to anon, authenticated;
grant execute on function my_funded_application_ids() to anon, authenticated;

-- ---------- applications ----------
alter policy p_apps_admin on applications
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_apps_member_funder_select on applications
  using (bank_account_id in (select my_bank_ids()));
alter policy p_apps_member_manager_select on applications
  using (demat_id in (select my_managed_demat_ids()));
alter policy p_apps_member_write on applications
  using (demat_id in (select my_demat_ids()))
  with check (demat_id in (select my_demat_ids()));

-- ---------- demat_accounts ----------
alter policy p_demat_admin on demat_accounts
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_demat_member on demat_accounts
  using (linked_user_id = (select auth.uid()));
alter policy p_demat_member_delete on demat_accounts
  using (linked_user_id = (select auth.uid()));
alter policy p_demat_member_manager on demat_accounts
  using (id in (select my_managed_demat_ids()));

-- ---------- bank_accounts ----------
alter policy p_bank_admin on bank_accounts
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_bank_member on bank_accounts
  using (linked_user_id = (select auth.uid()) or demat_id in (select my_demat_ids()));
alter policy p_bank_member_write on bank_accounts
  using (linked_user_id = (select auth.uid()))
  with check (linked_user_id = (select auth.uid()));

-- ---------- notifications ----------
alter policy p_notif_admin on notifications
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_notif_member on notifications
  using (demat_id in (select my_demat_ids()));
alter policy p_notif_member_send on notifications
  using (demat_id in (select my_demat_ids()))
  with check (demat_id in (select my_demat_ids()));

-- ---------- settlement_payments ----------
alter policy p_settlement_payments_admin on settlement_payments
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_settlement_payments_own_funder on settlement_payments
  using (
    kind in ('admin_to_funder'::settlement_payment_kind, 'holder_to_funder'::settlement_payment_kind)
    and application_id in (select my_funded_application_ids())
  );

-- ---------- profiles ----------
alter policy p_profiles_admin on profiles
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_profiles_self on profiles
  using (id = (select auth.uid()) or (select is_admin()));

-- ---------- ipos / registrar_links / stock_price_cache ----------
alter policy p_ipos_admin on ipos
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_ipos_read on ipos
  using ((select auth.uid()) is not null);
alter policy p_reg_admin on registrar_links
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_reg_read on registrar_links
  using ((select auth.uid()) is not null);
alter policy p_stock_price_read on stock_price_cache
  using ((select auth.uid()) is not null);

-- ---------- account_managers ----------
alter policy p_account_managers_admin on account_managers
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_account_managers_self on account_managers
  using (linked_user_id = (select auth.uid()));

-- ---------- link requests ----------
alter policy p_link_requests_select on demat_link_requests
  using (member_id = (select auth.uid()) or (select is_admin()));
alter policy p_link_requests_member_cancel on demat_link_requests
  using (member_id = (select auth.uid()) and status = 'PENDING');
alter policy p_bank_link_requests_select on bank_link_requests
  using (member_id = (select auth.uid()) or (select is_admin()));
alter policy p_bank_link_requests_member_cancel on bank_link_requests
  using (member_id = (select auth.uid()) and status = 'PENDING');

-- ---------- admin-only tables ----------
alter policy p_app_sells_admin on application_sells
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_allotment_checks_admin on allotment_auto_checks
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_financial_change_log_admin on financial_change_log
  using ((select is_admin()));
alter policy p_manual_transactions_admin on manual_transactions
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_pan_log_admin on pan_access_log
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_parent_companies_admin on parent_companies
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_parent_company_holdings_admin on parent_company_holdings
  using ((select is_admin())) with check ((select is_admin()));
alter policy p_sell_pdf_admin on sell_instruction_pdfs
  using ((select is_admin())) with check ((select is_admin()));

-- ---------- per-owner tables ----------
alter policy p_ipoji_import_keys_self on ipoji_import_keys
  using (user_id = (select auth.uid()) and (select is_admin()));
alter policy p_ipoji_inbox_select on ipoji_inbox
  using (user_id = (select auth.uid()) and (select is_admin()));
alter policy p_ipoji_inbox_delete on ipoji_inbox
  using (user_id = (select auth.uid()) and (select is_admin()));
alter policy p_broadcast_contacts_owner on broadcast_contacts
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
alter policy p_broadcast_not_applying_owner on broadcast_not_applying
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (
      select 1 from broadcast_contacts c
      where c.id = broadcast_not_applying.contact_id and c.owner_id = (select auth.uid())
    )
  );
