-- ============================================================
-- Lets any signed-in user edit their own display name (shown in the
-- sidebar and used to sign off WhatsApp messages they send) without
-- exposing a raw UPDATE on profiles to clients — a plain "update your own
-- row" RLS policy would also let a member rewrite their own `role` to
-- 'admin' (row-level security can't restrict to specific columns), so this
-- is scoped to full_name only via a narrow security-definer function.
-- ============================================================
create or replace function update_own_full_name(p_full_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'full_name cannot be empty';
  end if;
  update profiles set full_name = trim(p_full_name) where id = auth.uid();
end $$;

revoke execute on function update_own_full_name(text) from public, anon;
grant execute on function update_own_full_name(text) to authenticated;
