-- ============================================================
-- PAN encryption/decryption helpers. The encryption key (PAN_KEY) is passed
-- in from the Edge Function's secret at call time and never stored in
-- Postgres config — only ciphertext rests in the database. These functions
-- are restricted to service_role, so they can only be reached via the
-- add-demat / reveal-pan Edge Functions (which enforce the admin check).
-- ============================================================

create or replace function insert_demat_encrypted(
  p_name text,
  p_phone text,
  p_pan text,
  p_key text,
  p_broker text default null,
  p_dp_client_id text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid;
begin
  insert into demat_accounts (holder_name, phone_e164, pan_encrypted, pan_masked, pan_hash, broker, dp_client_id)
  values (
    p_name,
    p_phone,
    pgp_sym_encrypt(p_pan, p_key),
    left(p_pan, 5) || '****' || right(p_pan, 1),
    encode(digest(upper(p_pan), 'sha256'), 'hex'),
    p_broker,
    p_dp_client_id
  )
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function insert_demat_encrypted(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function insert_demat_encrypted(text, text, text, text, text, text) to service_role;

create or replace function decrypt_pan(p_demat_id uuid, p_key text) returns text
language sql security definer set search_path = public, extensions as $$
  select pgp_sym_decrypt(pan_encrypted, p_key) from demat_accounts where id = p_demat_id;
$$;

revoke execute on function decrypt_pan(uuid, text) from public, anon, authenticated;
grant execute on function decrypt_pan(uuid, text) to service_role;
