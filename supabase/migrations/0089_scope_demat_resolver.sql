-- ============================================================
-- Tightens resolve_demat_holder_names(), which 0088 just widened.
--
-- The function is `security definer` and takes an arbitrary uuid[], with no
-- check on whether the caller has any relationship to the ids passed — so
-- ANY authenticated user could hand it any demat id and get that account's
-- details back. That hole predates 0088 (0045 already returned holder_name +
-- pan_masked this way), but 0088 added profit_share_percent and
-- account_manager_id to the payload, so it now leaks strictly more per id
-- and is worth closing rather than widening and moving on.
--
-- Uuids aren't guessable, so this was never trivially exploitable — but
-- "hard to guess" is not an authorization check, and every other narrow
-- resolver in this schema is reachable only for rows the caller is actually
-- entitled to. Same rule applied here, in the function body (a security
-- definer function bypasses RLS by design, so the filter has to be explicit):
--
--   * admin                       -> everything, via is_admin()
--   * the account's own owner     -> their own linked row
--   * a funder of an application  -> only the demat accounts they funded
--     on that demat account
--
-- The funder branch checks BOTH bank_account_id and funder_override_id
-- (migration 0063) — "who funded this" is coalesce(funder_override_id,
-- bank_account_id) everywhere else in this app, and 0032's original policy
-- predicate only ever checked bank_account_id, which would have silently
-- hidden manually-reassigned applications from the funder actually credited
-- for them.
--
-- Return shape is unchanged from 0088, so no frontend change is needed —
-- callers just get fewer rows back than ids they asked for when they ask
-- for something that isn't theirs, which lib/hydrateDemat.ts already
-- handles (it looks up per id and leaves a row untouched on a miss).
-- ============================================================

drop function if exists resolve_demat_holder_names(uuid[]);

create function resolve_demat_holder_names(p_ids uuid[])
returns table(id uuid, holder_name text, pan_masked text, profit_share_percent numeric, account_manager_id uuid)
language sql stable security definer set search_path = public as $$
  select d.id, d.holder_name, d.pan_masked, d.profit_share_percent, d.account_manager_id
  from demat_accounts d
  where d.id = any(p_ids)
    and (
      is_admin()
      or d.linked_user_id = auth.uid()
      or exists (
        select 1
        from applications a
        join bank_accounts b
          on b.id = coalesce(a.funder_override_id, a.bank_account_id)
        where a.demat_id = d.id
          and b.linked_user_id = auth.uid()
      )
    );
$$;
revoke execute on function resolve_demat_holder_names(uuid[]) from public, anon;
grant execute on function resolve_demat_holder_names(uuid[]) to authenticated;
