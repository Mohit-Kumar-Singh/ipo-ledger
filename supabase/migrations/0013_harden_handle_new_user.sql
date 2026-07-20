-- ============================================================
-- Open self-registration means signups can come in without an email
-- (phone-only accounts) or without a full_name in metadata (edge cases
-- across providers). The old fallback chain (full_name -> email) would
-- insert a NULL into profiles.full_name (NOT NULL) for a phone-only
-- signup, aborting the trigger and the entire auth.users insert with it.
-- ============================================================
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, role)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      new.email,
      new.phone,
      'New user'
    ),
    'member'
  )
  on conflict (id) do nothing;
  return new;
end $$;
