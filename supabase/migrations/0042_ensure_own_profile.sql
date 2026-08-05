-- Found via investigation of a real "friend can't log in" report: an
-- auth.users row (uitest_tiles_...@example.com, full_name in metadata) with
-- NO matching profiles row, despite trg_on_auth_user_created being enabled —
-- the handle_new_user trigger can apparently fail/skip for a signup without
-- erroring the signup itself. When that happens, AuthContext's profile fetch
-- (`.single()`) permanently returns null (no client-side retry or repair),
-- so the account is stuck signed-in-but-broken: every page that reads
-- `profile` sees it as perpetually null, which looks exactly like "can't
-- log in" from the user's side even though auth succeeded.
--
-- This function is a self-heal callable from the client: idempotent, same
-- insert as handle_new_user, restricted to inserting a row for the caller's
-- own auth.uid() only (not arbitrary ids) since it's granted to
-- `authenticated`, not just service_role.
create or replace function ensure_own_profile() returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, role)
  select
    auth.uid(),
    coalesce(
      u.raw_user_meta_data->>'full_name',
      u.raw_user_meta_data->>'name',
      u.email,
      u.phone,
      'New user'
    ),
    'member'
  from auth.users u
  where u.id = auth.uid()
  on conflict (id) do nothing;
end $$;
revoke execute on function ensure_own_profile() from public, anon;
grant execute on function ensure_own_profile() to authenticated;
