-- Regression test for AUTHZ-01 (migration 0098:
-- lock_down_unlinked_search_rpcs) — proves search_unlinked_demat_accounts
-- and search_unlinked_bank_accounts are unreachable by ANY authenticated
-- client role (a freshly-registered stranger, or even an admin, since
-- Postgres has no distinct "admin" role here), and that the actual
-- currently-used admin linking path (a direct UPDATE on
-- demat_accounts/bank_accounts under the admin RLS policy) is completely
-- unaffected.
--
-- Run with the Supabase CLI's pgTAP runner (needs Docker):
--   npx --prefix web supabase test db
begin;
select plan(7);

-- ---------- fixtures ----------
-- A "stranger" (no relationship to anything below), an admin, and a
-- "target" user the admin will link an account to at the end.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000b0001', 'authenticated', 'authenticated',
   'authz01-stranger@example.test', crypt('not-a-real-password', gen_salt('bf')), now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000b0002', 'authenticated', 'authenticated',
   'authz01-admin@example.test', crypt('not-a-real-password', gen_salt('bf')), now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000b0003', 'authenticated', 'authenticated',
   'authz01-target-user@example.test', crypt('not-a-real-password', gen_salt('bf')), now(), now(), now(), '{}', '{}');

update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000b0002';

-- An unlinked demat + bank account — exactly the "ledger" AUTHZ-01 says a
-- stranger could enumerate. Real-looking holder_name on purpose, matching
-- the actual harm (harvesting real people's names).
insert into demat_accounts (id, holder_name, phone_e164, pan_encrypted, pan_masked, pan_hash)
values (
  '00000000-0000-0000-0000-00000da0b001',
  'Priya Sharma',
  '+919999900101',
  pgp_sym_encrypt('ZZBAT0001A', 'test-key-not-real'),
  'ZZBAT****A',
  encode(digest('ZZBAT0001A', 'sha256'), 'hex')
);
insert into bank_accounts (id, account_holder_name, upi_id)
values ('00000000-0000-0000-0000-00000ba0b001', 'Priya Sharma', 'priya.sharma@okhdfcbank');

-- Impersonation helper — same pattern as the AUTHZ-02 test.
create or replace function pg_temp.authenticate_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$ language plpgsql;

-- ================= a freshly-registered stranger, no relationship at all =================
select pg_temp.authenticate_as('00000000-0000-0000-0000-0000000b0001');

select throws_ok(
  $$ select * from search_unlinked_demat_accounts('') $$,
  '42501',
  'permission denied for function search_unlinked_demat_accounts',
  'stranger cannot call search_unlinked_demat_accounts at all, even with an empty query'
);

select throws_ok(
  $$ select * from search_unlinked_demat_accounts('sharma') $$,
  '42501',
  'permission denied for function search_unlinked_demat_accounts',
  'stranger cannot enumerate by a real name substring either'
);

select throws_ok(
  $$ select * from search_unlinked_bank_accounts('') $$,
  '42501',
  'permission denied for function search_unlinked_bank_accounts',
  'stranger cannot call search_unlinked_bank_accounts at all'
);

-- ================= even an admin has no direct grant on the retired RPC =================
select pg_temp.authenticate_as('00000000-0000-0000-0000-0000000b0002');

select throws_ok(
  $$ select * from search_unlinked_demat_accounts('') $$,
  '42501',
  'permission denied for function search_unlinked_demat_accounts',
  'admin also cannot call the retired search RPC directly (admin already has full-table visibility instead)'
);

-- ================= the ACTUAL current admin linking path still works =================
select lives_ok(
  $$ update demat_accounts set linked_user_id = '00000000-0000-0000-0000-0000000b0003'
     where id = '00000000-0000-0000-0000-00000da0b001' $$,
  'admin can still link a demat account directly (UsersPage.tsx linkDemat path), unaffected by this fix'
);

select lives_ok(
  $$ update bank_accounts set linked_user_id = '00000000-0000-0000-0000-0000000b0003'
     where id = '00000000-0000-0000-0000-00000ba0b001' $$,
  'admin can still link a bank/UPI account directly (UsersPage.tsx linkBank path), unaffected by this fix'
);

select is(
  (select linked_user_id from demat_accounts where id = '00000000-0000-0000-0000-00000da0b001'),
  '00000000-0000-0000-0000-0000000b0003'::uuid,
  'the demat account is actually linked after the admin update'
);

select * from finish();
rollback;
