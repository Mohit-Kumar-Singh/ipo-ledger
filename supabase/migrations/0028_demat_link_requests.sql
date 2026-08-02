-- ============================================================
-- Member self-service demat-account linking, gated by admin approval.
-- Replaces link_self_by_pan()'s immediate auto-link (0027) with a
-- request/approve workflow: a member searches for the account they believe
-- is theirs, the app confirms their self-attested PAN hash actually matches
-- it (server-side only — the client never sees either hash), and only then
-- is a PENDING request created. linked_user_id is never touched by a client
-- write — only by decide_demat_link_request(), and only for admins.
-- ============================================================

create table demat_link_requests (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references profiles(id) on delete cascade,
  demat_id uuid not null references demat_accounts(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  requested_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz
);
create index on demat_link_requests (member_id);
create index on demat_link_requests (demat_id);
-- One active PENDING request per (member, demat) pair; resubmission after a
-- REJECTED row is just a fresh insert, so rejection history is preserved.
create unique index uq_link_requests_pending on demat_link_requests (member_id, demat_id)
  where status = 'PENDING';

alter table demat_link_requests enable row level security;
create policy p_link_requests_select on demat_link_requests for select
  using (member_id = auth.uid() or is_admin());
-- A member can withdraw their own still-pending request directly — safe,
-- touches only their own row, only while PENDING, never linked_user_id.
-- Approve/reject/insert all go through the RPCs below; there is no
-- INSERT/UPDATE policy for anyone (including admin), so a decision can
-- never be a raw client UPDATE.
create policy p_link_requests_member_cancel on demat_link_requests for delete
  using (member_id = auth.uid() and status = 'PENDING');

-- Distinguishes a self-reveal (member viewing their own linked account's
-- PAN) from an admin reveal, for the existing Settings audit table.
alter table pan_access_log add column is_self_reveal boolean not null default false;

-- Replaces link_self_by_pan(): this one only hashes+stores, never links.
drop function if exists link_self_by_pan(text);

create or replace function set_self_pan_hash(p_pan text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pan is null or p_pan !~ '^[A-Za-z]{5}[0-9]{4}[A-Za-z]$' then
    raise exception 'PAN must be in the format ABCPD1234E (5 letters, 4 digits, 1 letter).';
  end if;
  update profiles set self_pan_hash = encode(digest(upper(trim(p_pan)), 'sha256'), 'hex')
  where id = auth.uid();
end $$;
revoke execute on function set_self_pan_hash(text) from public, anon;
grant execute on function set_self_pan_hash(text) to authenticated;

-- Search: unlinked accounts only, minimal projection (name + masked phone),
-- never PAN. Capped result count as a light guard against enumeration.
create or replace function search_unlinked_demat_accounts(p_query text)
returns table(id uuid, holder_name text, phone_masked text)
language sql security definer set search_path = public as $$
  select id, holder_name, '••••••' || right(phone_e164, 4)
  from demat_accounts
  where linked_user_id is null
    and (holder_name ilike '%' || p_query || '%' or right(phone_e164, 4) = p_query)
  order by holder_name
  limit 20;
$$;
revoke execute on function search_unlinked_demat_accounts(text) from public, anon;
grant execute on function search_unlinked_demat_accounts(text) to authenticated;

-- Create a request — the PAN-match check happens entirely here, server-side;
-- the caller never learns the target's pan_hash, only a status outcome.
create or replace function request_demat_link(p_demat_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_self_hash text;
  v_account record;
begin
  select self_pan_hash into v_self_hash from profiles where id = auth.uid();
  if v_self_hash is null then
    return jsonb_build_object('status', 'no_pan_on_file');
  end if;

  select pan_hash, linked_user_id into v_account from demat_accounts where id = p_demat_id;
  if v_account is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_account.linked_user_id is not null then
    return jsonb_build_object('status', 'already_linked');
  end if;
  if v_account.pan_hash <> v_self_hash then
    return jsonb_build_object('status', 'pan_mismatch');
  end if;
  if exists (select 1 from demat_link_requests where member_id = auth.uid()
             and demat_id = p_demat_id and status = 'PENDING') then
    return jsonb_build_object('status', 'already_pending');
  end if;

  insert into demat_link_requests (member_id, demat_id) values (auth.uid(), p_demat_id);
  return jsonb_build_object('status', 'requested');
end $$;
revoke execute on function request_demat_link(uuid) from public, anon;
grant execute on function request_demat_link(uuid) to authenticated;

-- Admin decision — the only path that can ever set linked_user_id from a
-- request. Raises if the caller isn't admin or the request isn't PENDING.
create or replace function decide_demat_link_request(p_request_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_req record;
begin
  if not is_admin() then
    raise exception 'forbidden';
  end if;
  select * into v_req from demat_link_requests where id = p_request_id and status = 'PENDING';
  if v_req is null then
    raise exception 'Request not found or already decided.';
  end if;
  if p_approve then
    update demat_accounts set linked_user_id = v_req.member_id where id = v_req.demat_id;
    update demat_link_requests set status = 'APPROVED', decided_by = auth.uid(), decided_at = now()
      where id = p_request_id;
  else
    update demat_link_requests set status = 'REJECTED', decided_by = auth.uid(), decided_at = now()
      where id = p_request_id;
  end if;
  return jsonb_build_object('status', 'ok');
end $$;
revoke execute on function decide_demat_link_request(uuid, boolean) from public, anon;
grant execute on function decide_demat_link_request(uuid, boolean) to authenticated;

-- Narrow bank/UPI edit for members: UPI ID only, on a row tied to their own
-- linked demat account (mirrors p_bank_member's own scoping logic) — covers
-- rows an admin added on their behalf, which today a member can see but not
-- touch at all (p_bank_member_write only matches linked_user_id = self).
create or replace function update_own_bank_upi(p_bank_account_id uuid, p_upi_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from bank_accounts b
    left join demat_accounts d on d.id = b.demat_id
    where b.id = p_bank_account_id
      and (b.linked_user_id = auth.uid() or d.linked_user_id = auth.uid())
  ) then
    raise exception 'forbidden';
  end if;
  update bank_accounts set upi_id = p_upi_id where id = p_bank_account_id;
end $$;
revoke execute on function update_own_bank_upi(uuid, text) from public, anon;
grant execute on function update_own_bank_upi(uuid, text) to authenticated;
