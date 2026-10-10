-- Phone-friendly ipoji import. The ipoji scrape used to end with "copy all,
-- switch apps, paste" — slow and error-prone on a phone. Now the bookmarklet
-- POSTs its result straight to the `ipoji-inbox` Edge Function, which parks it
-- here; the admin opens the app and taps Review.
--
-- ipoji_import_keys: one secret per admin, embedded in that admin's
-- bookmarklet. It can ONLY drop rows into that admin's own inbox (write-only,
-- and everything in the inbox is reviewed in the Preview step before anything
-- is imported), so a leaked key can at worst add junk to review. Rotating it
-- (rotate_ipoji_import_key) invalidates old bookmarklets.
create table ipoji_import_keys (
  user_id    uuid primary key references auth.users on delete cascade,
  key        text not null unique,
  created_at timestamptz not null default now()
);
alter table ipoji_import_keys enable row level security;
create policy p_ipoji_import_keys_self on ipoji_import_keys
  for select using (user_id = auth.uid() and is_admin());

-- Rows are inserted only by the Edge Function (service role bypasses RLS);
-- the admin can read and clear their own.
create table ipoji_inbox (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  rows       jsonb not null,
  row_count  int not null,
  created_at timestamptz not null default now()
);
create index ipoji_inbox_user_created_idx on ipoji_inbox (user_id, created_at desc);
alter table ipoji_inbox enable row level security;
create policy p_ipoji_inbox_select on ipoji_inbox
  for select using (user_id = auth.uid() and is_admin());
create policy p_ipoji_inbox_delete on ipoji_inbox
  for delete using (user_id = auth.uid() and is_admin());

create or replace function rotate_ipoji_import_key() returns text
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  k := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into ipoji_import_keys (user_id, key) values (auth.uid(), k)
  on conflict (user_id) do update set key = excluded.key, created_at = now();
  return k;
end $$;
revoke all on function rotate_ipoji_import_key() from public, anon;
grant execute on function rotate_ipoji_import_key() to authenticated;
