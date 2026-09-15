-- Regression test for AUTHZ-02 (migration 0097:
-- guard_application_insert_columns) — proves a non-admin cannot mass-assign
-- privileged workflow/financial columns on `applications` INSERT, and that
-- legitimate self-service creation and admin creation both still work.
--
-- Run with the Supabase CLI's pgTAP runner (needs Docker):
--   npx --prefix web supabase test db
-- This file lives under supabase/tests/database/, which `supabase test db`
-- picks up automatically and runs against a fresh local database seeded
-- with every migration in supabase/migrations/ — never against a real
-- project. Everything below runs inside one transaction that is rolled
-- back at the end, so nothing persists even if run against a shared DB.
--
-- Auth impersonation uses the standard Supabase pattern of setting
-- request.jwt.claims and switching to the `authenticated` role, matching
-- how PostgREST itself invokes queries on behalf of a signed-in user — no
-- extra test-helper extension required. If your Supabase Postgres image
-- resolves auth.uid() from a different GUC, adjust the `authenticate_as`
-- helper below to match (check `\df+ auth.uid` on your instance).
begin;
select plan(9);

-- ---------- fixtures ----------
-- Three throwaway auth.users rows: a plain member, an admin, and a
-- "victim" whose id we'll try to forge into created_by.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000a0001', 'authenticated', 'authenticated',
   'authz02-member@example.test', crypt('not-a-real-password', gen_salt('bf')), now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000a0002', 'authenticated', 'authenticated',
   'authz02-admin@example.test', crypt('not-a-real-password', gen_salt('bf')), now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000a0003', 'authenticated', 'authenticated',
   'authz02-victim@example.test', crypt('not-a-real-password', gen_salt('bf')), now(), now(), now(), '{}', '{}');

-- handle_new_user already inserted 'member' profile rows for all three.
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000a0002';

-- A demat account linked to the member test user (bypasses the add-demat
-- Edge Function entirely — this test only exercises the applications
-- table's own INSERT guard, not the PAN-encryption RPCs).
insert into demat_accounts (id, holder_name, phone_e164, pan_encrypted, pan_masked, pan_hash, linked_user_id)
values (
  '00000000-0000-0000-0000-00000da00001',
  'AuthZ02 Test Holder',
  '+919999900001',
  pgp_sym_encrypt('ZZZAT0001A', 'test-key-not-real'),
  'ZZZAT****A',
  encode(digest('ZZZAT0001A', 'sha256'), 'hex'),
  '00000000-0000-0000-0000-0000000a0001'
);

insert into ipos (id, company_name, lot_size, open_date, close_date)
values ('00000000-0000-0000-0000-000000a00001', 'AuthZ02 Test IPO', 100, current_date - 10, current_date - 5);

-- Impersonates a signed-in PostgREST request as the given user id, the same
-- way PostgREST itself sets these GUCs per-request.
create or replace function pg_temp.authenticate_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$ language plpgsql;

-- ================= non-admin: privileged fields rejected =================
select pg_temp.authenticate_as('00000000-0000-0000-0000-0000000a0001');

select throws_ok(
  $$ insert into applications (ipo_id, demat_id, lots, status)
     values ('00000000-0000-0000-0000-000000a00001', '00000000-0000-0000-0000-00000da00001', 1, 'SOLD') $$,
  'P0001',
  'A new application must start in APPLIED status.',
  'non-admin cannot INSERT an application already at status=SOLD'
);

select throws_ok(
  $$ insert into applications (ipo_id, demat_id, lots, mandate_status)
     values ('00000000-0000-0000-0000-000000a00001', '00000000-0000-0000-0000-00000da00001', 1, 'APPROVED') $$,
  'P0001',
  'A new application''s mandate must start PENDING.',
  'non-admin cannot INSERT an application already mandate_status=APPROVED'
);

select throws_ok(
  $$ insert into applications (ipo_id, demat_id, lots, demat_cut_paid)
     values ('00000000-0000-0000-0000-000000a00001', '00000000-0000-0000-0000-00000da00001', 1, true) $$,
  'P0001',
  'Only an admin can record a payout as already paid.',
  'non-admin cannot INSERT an application already demat_cut_paid=true'
);

select throws_ok(
  $$ insert into applications (ipo_id, demat_id, lots, funder_share_paid)
     values ('00000000-0000-0000-0000-000000a00001', '00000000-0000-0000-0000-00000da00001', 1, true) $$,
  'P0001',
  'Only an admin can record a payout as already paid.',
  'non-admin cannot INSERT an application already funder_share_paid=true'
);

-- The exact adversarial payload from the audit finding: everything at once.
select throws_ok(
  $$ insert into applications (ipo_id, demat_id, lots, status, mandate_status, demat_cut_paid, funder_share_paid, created_by)
     values ('00000000-0000-0000-0000-000000a00001', '00000000-0000-0000-0000-00000da00001', 1,
             'SOLD', 'APPROVED', true, true, '00000000-0000-0000-0000-0000000a0003') $$,
  'P0001',
  'A new application must start in APPLIED status.',
  'non-admin cannot INSERT the full fabricated sold+paid+approved payload'
);

-- ================= non-admin: legitimate self-service create still works, safely =================
insert into applications (ipo_id, demat_id, lots, created_by)
values ('00000000-0000-0000-0000-000000a00001', '00000000-0000-0000-0000-00000da00001', 1,
        '00000000-0000-0000-0000-0000000a0003'); -- attempted impersonation of the "victim" as creator

select is(
  (select status::text from applications where ipo_id = '00000000-0000-0000-0000-000000a00001'
     and demat_id = '00000000-0000-0000-0000-00000da00001'),
  'APPLIED',
  'legitimate non-admin create lands in APPLIED'
);

select is(
  (select created_by from applications where ipo_id = '00000000-0000-0000-0000-000000a00001'
     and demat_id = '00000000-0000-0000-0000-00000da00001'),
  '00000000-0000-0000-0000-0000000a0001'::uuid,
  'created_by is corrected to the real caller, not the impersonated victim id'
);

select is(
  (select mandate_status::text from applications where ipo_id = '00000000-0000-0000-0000-000000a00001'
     and demat_id = '00000000-0000-0000-0000-00000da00001'),
  'PENDING',
  'legitimate non-admin create lands with mandate PENDING'
);

-- clean up the one row this branch created, so the admin check below starts fresh
delete from applications where ipo_id = '00000000-0000-0000-0000-000000a00001'
  and demat_id = '00000000-0000-0000-0000-00000da00001';

-- ================= admin: unrestricted create still works (no regression) =================
select pg_temp.authenticate_as('00000000-0000-0000-0000-0000000a0002');

select lives_ok(
  $$ insert into applications (ipo_id, demat_id, lots, status, mandate_status)
     values ('00000000-0000-0000-0000-000000a00001', '00000000-0000-0000-0000-00000da00001', 1, 'ALLOTTED', 'APPROVED') $$,
  'admin retains full INSERT freedom (e.g. manual backfills, ipoji sync)'
);

select * from finish();
rollback;
