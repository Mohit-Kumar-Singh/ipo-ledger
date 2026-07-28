-- ============================================================
-- Adds a phone number to the self-service profile, alongside full_name.
-- Replaces update_own_full_name with update_own_profile (same
-- security-definer scoping — only full_name/phone_e164 are touched, never
-- role, so this still can't be used to self-promote to admin).
-- ============================================================
alter table profiles add column if not exists phone_e164 text
  check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

drop function if exists update_own_full_name(text);

create or replace function update_own_profile(p_full_name text, p_phone_e164 text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'full_name cannot be empty';
  end if;
  if p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'phone_e164 must be a valid E.164 number';
  end if;
  update profiles set full_name = trim(p_full_name), phone_e164 = p_phone_e164 where id = auth.uid();
end $$;

revoke execute on function update_own_profile(text, text) from public, anon;
grant execute on function update_own_profile(text, text) to authenticated;
