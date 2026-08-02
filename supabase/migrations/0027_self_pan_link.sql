-- ============================================================
-- Self-service PAN verification: a member enters their own PAN in Profile
-- and, if it matches an unlinked demat account's pan_hash, gets linked to
-- it immediately — no admin action needed. Only the SHA-256 hash is ever
-- stored on profiles (same one-way hash demat_accounts.pan_hash already
-- uses), never the plaintext PAN, matching the app's existing PAN handling.
-- ============================================================
alter table profiles add column if not exists self_pan_hash text;

create or replace function link_self_by_pan(p_pan text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text;
  v_account record;
begin
  if p_pan is null or p_pan !~ '^[A-Za-z]{5}[0-9]{4}[A-Za-z]$' then
    raise exception 'PAN must be in the format ABCPD1234E (5 letters, 4 digits, 1 letter).';
  end if;

  v_hash := encode(digest(upper(trim(p_pan)), 'sha256'), 'hex');
  update profiles set self_pan_hash = v_hash where id = auth.uid();

  select id, holder_name, linked_user_id into v_account
  from demat_accounts where pan_hash = v_hash limit 1;

  if v_account.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_account.linked_user_id is not null and v_account.linked_user_id <> auth.uid() then
    return jsonb_build_object('status', 'linked_elsewhere');
  end if;

  update demat_accounts set linked_user_id = auth.uid() where id = v_account.id;
  return jsonb_build_object('status', 'linked', 'holder_name', v_account.holder_name);
end $$;

revoke execute on function link_self_by_pan(text) from public, anon;
grant execute on function link_self_by_pan(text) to authenticated;
