-- ============================================================
-- Update-capable counterpart to insert_demat_encrypted (0003). Same
-- security model: key passed in from the Edge Function's secret at call
-- time, restricted to service_role so it can only be reached via the
-- add-demat Edge Function (which enforces the admin check and re-validates
-- phone/PAN format server-side).
-- ============================================================

create or replace function update_demat_encrypted(
  p_id uuid,
  p_name text,
  p_phone text,
  p_pan text,
  p_key text,
  p_dp_client_id text default null
) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update demat_accounts
  set holder_name = p_name,
      phone_e164 = p_phone,
      pan_encrypted = pgp_sym_encrypt(p_pan, p_key),
      pan_masked = left(p_pan, 5) || '****' || right(p_pan, 1),
      pan_hash = encode(digest(upper(p_pan), 'sha256'), 'hex'),
      dp_client_id = p_dp_client_id
  where id = p_id;
end $$;

revoke execute on function update_demat_encrypted(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function update_demat_encrypted(uuid, text, text, text, text, text) to service_role;
