-- ============================================================
-- Records who created each application (previously only status-change
-- actor was tracked, via touch_status()/changed_by, never the creator) and
-- exposes a per-application attribution view for the Dashboard/Profile
-- charts: who gets credit for an application, factoring in that it may
-- have been funded through a bank/UPI account linked to a different
-- portal member than the demat holder.
-- ============================================================
alter table applications add column created_by uuid references profiles(id) default auth.uid();
create index on applications (created_by);

-- Row-scoping only (uuids, no names) — security_invoker means this inherits
-- the same applications/demat_accounts RLS v_allotment_board already relies
-- on, so "which rows" is correctly scoped for free, same as that view.
create or replace view v_application_attribution with (security_invoker = true) as
select a.id as application_id, a.ipo_id, i.company_name, i.open_date,
       a.demat_id, d.holder_name,
       a.bank_account_id, b.linked_user_id as funder_user_id,
       a.created_by
from applications a
join ipos i on i.id = a.ipo_id
join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = a.bank_account_id;

-- Narrow, name-only resolver for ids surfaced by the view above (which
-- already scoped which applications the caller may see) — lets a member
-- resolve e.g. the admin's display name without broader profiles access.
-- full_name isn't sensitive the way PAN/phone are (already shown across
-- the shared portal), so this is safe to grant broadly.
create or replace function resolve_profile_names(p_ids uuid[])
returns table(id uuid, full_name text)
language sql security definer set search_path = public as $$
  select id, full_name from profiles where id = any(p_ids);
$$;
revoke execute on function resolve_profile_names(uuid[]) from public, anon;
grant execute on function resolve_profile_names(uuid[]) to authenticated;
