-- Regression test for AUTHZ-04 (migration 0099: extends
-- guard_admin_only_application_columns to protect sell_price once recorded)
-- — proves an owner can still report a sale for the first time (the real,
-- actively-used AllotmentBoardPage "Mark sold" flow), but cannot revise or
-- clear an already-recorded price; an unrelated user's write is still
-- blocked by the pre-existing RLS boundary; admin retains full control; and
-- financial_change_log only ever gains entries for the legitimate changes.
--
-- Run with the Supabase CLI's pgTAP runner (needs Docker):
--   npx --prefix web supabase test db
begin;
select plan(11);

-- ---------- fixtures ----------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000c0001', 'authenticated', 'authenticated',
   'authz04-owner@example.test', crypt('not-a-real-password', gen_salt('bf')), now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000c0002', 'authenticated', 'authenticated',
   'authz04-admin@example.test', crypt('not-a-real-password', gen_salt('bf')), now(), now(), now(), '{}', '{}'),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000c0003', 'authenticated', 'authenticated',
   'authz04-stranger@example.test', crypt('not-a-real-password', gen_salt('bf')), now(), now(), now(), '{}', '{}');

update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000c0002';

insert into demat_accounts (id, holder_name, phone_e164, pan_encrypted, pan_masked, pan_hash, linked_user_id)
values (
  '00000000-0000-0000-0000-00000da0c001',
  'AuthZ04 Test Holder',
  '+919999900201',
  pgp_sym_encrypt('ZZCAT0001A', 'test-key-not-real'),
  'ZZCAT****A',
  encode(digest('ZZCAT0001A', 'sha256'), 'hex'),
  '00000000-0000-0000-0000-0000000c0001'
);

insert into ipos (id, company_name, lot_size, open_date, close_date, allotment_date)
values ('00000000-0000-0000-0000-000000a00c01', 'AuthZ04 Test IPO', 100, current_date - 20, current_date - 15, current_date - 5);

create or replace function pg_temp.authenticate_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$ language plpgsql;

-- Inserted as admin (not as an unauthenticated fixture-setup statement) so
-- this doesn't trip the AUTHZ-02 insert guard (migration 0097), which
-- forces a non-admin's new row to start at status='APPLIED' — same as a
-- real admin backfill/ipoji-sync insert would.
select pg_temp.authenticate_as('00000000-0000-0000-0000-0000000c0002');

insert into applications (id, ipo_id, demat_id, lots, status, created_by)
values (
  '00000000-0000-0000-0000-00000a000001',
  '00000000-0000-0000-0000-000000a00c01',
  '00000000-0000-0000-0000-00000da0c001',
  1,
  'ALLOTTED',
  '00000000-0000-0000-0000-0000000c0001'
);

-- ================= owner reports the sale for the first time =================
select pg_temp.authenticate_as('00000000-0000-0000-0000-0000000c0001');

select lives_ok(
  $$ update applications set status = 'SOLD', sell_price = 100
     where id = '00000000-0000-0000-0000-00000a000001' $$,
  'owner can report sell_price the first time (old value was NULL) — the real AllotmentBoardPage "Mark sold" flow'
);

select is(
  (select sell_price from applications where id = '00000000-0000-0000-0000-00000a000001'),
  100::numeric,
  'first-time report actually stored 100'
);

select is(
  (select status::text from applications where id = '00000000-0000-0000-0000-00000a000001'),
  'SOLD',
  'status moved to SOLD alongside the first-time price report'
);

-- ================= same owner cannot revise or clear it afterward =================
select throws_ok(
  $$ update applications set sell_price = 50 where id = '00000000-0000-0000-0000-00000a000001' $$,
  'P0001',
  'Only an admin can change a sell price that has already been recorded.',
  'owner cannot lower an already-recorded sell_price'
);

select throws_ok(
  $$ update applications set sell_price = null where id = '00000000-0000-0000-0000-00000a000001' $$,
  'P0001',
  'Only an admin can change a sell price that has already been recorded.',
  'owner cannot clear an already-recorded sell_price back to NULL either'
);

select is(
  (select sell_price from applications where id = '00000000-0000-0000-0000-00000a000001'),
  100::numeric,
  'sell_price is untouched by either rejected owner attempt'
);

-- ================= an unrelated user cannot touch it (pre-existing RLS boundary) =================
select pg_temp.authenticate_as('00000000-0000-0000-0000-0000000c0003');

select lives_ok(
  $$ update applications set sell_price = 999 where id = '00000000-0000-0000-0000-00000a000001' $$,
  'a stranger''s UPDATE statement does not error (RLS silently matches zero rows, same as any other PostgREST write to a row you cannot see)'
);

select is(
  (select sell_price from applications where id = '00000000-0000-0000-0000-00000a000001'),
  100::numeric,
  'the stranger''s update affected nothing — RLS ownership check still holds'
);

-- ================= admin retains full control =================
select pg_temp.authenticate_as('00000000-0000-0000-0000-0000000c0002');

select lives_ok(
  $$ update applications set sell_price = 120 where id = '00000000-0000-0000-0000-00000a000001' $$,
  'admin can still change an already-recorded sell_price'
);

select is(
  (select sell_price from applications where id = '00000000-0000-0000-0000-00000a000001'),
  120::numeric,
  'admin''s change actually persisted'
);

-- ================= financial_change_log only reflects the two legitimate changes =================
select is(
  (select count(*) from financial_change_log
     where table_name = 'applications' and row_id = '00000000-0000-0000-0000-00000a000001' and column_name = 'sell_price'),
  2::bigint,
  'exactly two audit entries exist: the owner''s first report (NULL->100) and admin''s correction (100->120) — nothing from the two rejected owner attempts or the no-op stranger attempt'
);

select * from finish();
rollback;
