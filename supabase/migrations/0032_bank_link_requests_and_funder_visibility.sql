-- ============================================================
-- Two gaps this closes:
--
-- 1. bank/UPI linking had no approval gate at all (member insert sets
--    linked_user_id = self directly, 0016) while demat/PAN linking already
--    requires a request + admin decision (0028). This adds the same
--    request/approve shape for *claiming an existing, admin-added* bank/UPI
--    account — self-added-and-immediately-own-it (BankAccountsPage's normal
--    "+ Add bank/UPI account" flow) is unchanged and intentionally left
--    ungated, since that's declaring a brand new account as yours, not
--    claiming a record someone else already created.
--
-- 2. A member could only ever see applications through their own linked
--    demat account — being the *funder* (a linked bank/UPI account used to
--    pay for someone else's application, e.g. an admin applying from a
--    family demat but paying via a member's UPI) gave zero row visibility,
--    only a 0.5 attribution-chart credit (0029). This adds real SELECT
--    visibility (not write access — editing/deleting stays owner-only) for
--    the funder side, plus the demat_accounts/notifications rows needed to
--    render those application rows, and enables Realtime on applications so
--    it shows up live without a refresh.
-- ============================================================

-- ---------- 1. bank/UPI link requests (mirrors demat_link_requests) ----------

create table bank_link_requests (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  bank_account_id uuid not null references bank_accounts(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  requested_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz
);
create index on bank_link_requests (member_id);
create index on bank_link_requests (bank_account_id);
create unique index uq_bank_link_requests_pending on bank_link_requests (member_id, bank_account_id)
  where status = 'PENDING';

alter table bank_link_requests enable row level security;
create policy p_bank_link_requests_select on bank_link_requests for select
  using (member_id = auth.uid() or is_admin());
create policy p_bank_link_requests_member_cancel on bank_link_requests for delete
  using (member_id = auth.uid() and status = 'PENDING');

-- Same reasoning as 0030: a member's own pending/rejected request needs to
-- render the account it points at (masked in search, full row once they've
-- already proven they know the secret by requesting it).
create policy p_bank_member_requested on bank_accounts for select
  using (exists (
    select 1 from bank_link_requests r
    where r.bank_account_id = bank_accounts.id and r.member_id = auth.uid()
  ));

-- Search: unclaimed bank/UPI accounts only, minimal masked projection —
-- upi_id's local part and last4's first two digits are the "secret" proven
-- server-side in request_bank_link, never returned here.
create or replace function search_unlinked_bank_accounts(p_query text)
returns table(id uuid, account_holder_name text, bank_name text, last4_masked text, upi_domain_masked text)
language sql security definer set search_path = public as $$
  select id, account_holder_name, bank_name,
         case when last4 is not null then '••' || right(last4, 2) else null end,
         case when upi_id is not null and position('@' in upi_id) > 0
              then '•••' || substring(upi_id from position('@' in upi_id))
              else null end
  from bank_accounts
  where linked_user_id is null
    and (account_holder_name ilike '%' || p_query || '%'
         or (last4 is not null and right(last4, 2) = right(p_query, 2)))
  order by account_holder_name
  limit 20;
$$;
revoke execute on function search_unlinked_bank_accounts(text) from public, anon;
grant execute on function search_unlinked_bank_accounts(text) to authenticated;

-- Create a request — p_secret must match the account's full upi_id (if it
-- has one) or its last4 (if it doesn't); the caller never learns which one
-- was expected or what the stored value is, only a status outcome. Weaker
-- than PAN's sha256 proof (upi_id/last4 aren't stored as secrets elsewhere
-- in this app — they're already shown in the Allotment board etc.), but
-- it's the same trust model as the rest of this self-service portal: a
-- plausible self-attestation that an admin still has to approve.
create or replace function request_bank_link(p_bank_account_id uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_account record;
  v_norm text := lower(trim(coalesce(p_secret, '')));
begin
  if v_norm = '' then
    return jsonb_build_object('status', 'no_secret');
  end if;

  select upi_id, last4, linked_user_id into v_account from bank_accounts where id = p_bank_account_id;
  if v_account is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_account.linked_user_id is not null then
    return jsonb_build_object('status', 'already_linked');
  end if;
  if not (
    (v_account.upi_id is not null and lower(trim(v_account.upi_id)) = v_norm)
    or (v_account.last4 is not null and trim(v_account.last4) = trim(p_secret))
  ) then
    return jsonb_build_object('status', 'secret_mismatch');
  end if;
  if exists (select 1 from bank_link_requests where member_id = auth.uid()
             and bank_account_id = p_bank_account_id and status = 'PENDING') then
    return jsonb_build_object('status', 'already_pending');
  end if;

  insert into bank_link_requests (member_id, bank_account_id) values (auth.uid(), p_bank_account_id);
  return jsonb_build_object('status', 'requested');
end $$;
revoke execute on function request_bank_link(uuid, text) from public, anon;
grant execute on function request_bank_link(uuid, text) to authenticated;

-- Admin decision — the only path that can ever set bank_accounts.linked_user_id
-- from a request (admin's own direct link/unlink control on BankAccountsPage
-- goes through p_bank_admin's existing "for all" access instead, same as
-- AccountsPage already does for demat accounts).
create or replace function decide_bank_link_request(p_request_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_req record;
begin
  if not is_admin() then
    raise exception 'forbidden';
  end if;
  select * into v_req from bank_link_requests where id = p_request_id and status = 'PENDING';
  if v_req is null then
    raise exception 'Request not found or already decided.';
  end if;
  if p_approve then
    update bank_accounts set linked_user_id = v_req.member_id where id = v_req.bank_account_id;
    update bank_link_requests set status = 'APPROVED', decided_by = auth.uid(), decided_at = now()
      where id = p_request_id;
  else
    update bank_link_requests set status = 'REJECTED', decided_by = auth.uid(), decided_at = now()
      where id = p_request_id;
  end if;
  return jsonb_build_object('status', 'ok');
end $$;
revoke execute on function decide_bank_link_request(uuid, boolean) from public, anon;
grant execute on function decide_bank_link_request(uuid, boolean) to authenticated;

-- ---------- 2. self-service de-linking (distinct from delete) ----------

-- Unlinking your own claim is safe and reversible (re-request/re-add later),
-- unlike *creating* a link — so no approval needed here, unlike the request
-- flows above. Keeps the demat_accounts/bank_accounts row, PAN, and all
-- application/audit history intact; only severs the ownership pointer.
create or replace function unlink_demat_account(p_demat_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update demat_accounts set linked_user_id = null
  where id = p_demat_id and linked_user_id = auth.uid();
  if not found then
    raise exception 'Not linked to you.';
  end if;
end $$;
revoke execute on function unlink_demat_account(uuid) from public, anon;
grant execute on function unlink_demat_account(uuid) to authenticated;

create or replace function unlink_bank_account(p_bank_account_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update bank_accounts set linked_user_id = null
  where id = p_bank_account_id and linked_user_id = auth.uid();
  if not found then
    raise exception 'Not linked to you.';
  end if;
end $$;
revoke execute on function unlink_bank_account(uuid) from public, anon;
grant execute on function unlink_bank_account(uuid) to authenticated;

-- ---------- 3. funder-side visibility (read-only) ----------

-- applications: split the old "for all" member policy into a write policy
-- (unchanged condition — own demat only) and a separate, broader select
-- policy that also covers being the funder. Multiple permissive policies
-- OR together for SELECT, so this only ever adds rows, never removes any;
-- INSERT/UPDATE/DELETE still only ever match the write policy below.
drop policy if exists p_apps_member on applications;
create policy p_apps_member_write on applications for all
  using (exists (select 1 from demat_accounts d where d.id = demat_id and d.linked_user_id = auth.uid()))
  with check (exists (select 1 from demat_accounts d where d.id = demat_id and d.linked_user_id = auth.uid()));
create policy p_apps_member_funder_select on applications for select
  using (exists (select 1 from bank_accounts b where b.id = bank_account_id and b.linked_user_id = auth.uid()));

-- demat_accounts: a funder-only viewer needs the holder_name (etc.) of the
-- demat used on an application they funded, to render that application row
-- at all — same masked-not-PAN shape as every other member-facing select.
create policy p_demat_member_funder on demat_accounts for select
  using (exists (
    select 1 from applications a
    join bank_accounts b on b.id = a.bank_account_id
    where a.demat_id = demat_accounts.id and b.linked_user_id = auth.uid()
  ));

-- notifications: same funder parity for the notification list embedded in
-- the Applications page.
create policy p_notif_member_funder on notifications for select
  using (exists (
    select 1 from applications a
    join bank_accounts b on b.id = a.bank_account_id
    where a.id = notifications.application_id and b.linked_user_id = auth.uid()
  ));

-- ---------- 4. Realtime, so a funder's dashboard updates live ----------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'applications'
  ) then
    alter publication supabase_realtime add table applications;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'demat_link_requests'
  ) then
    alter publication supabase_realtime add table demat_link_requests;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bank_link_requests'
  ) then
    alter publication supabase_realtime add table bank_link_requests;
  end if;
end $$;
