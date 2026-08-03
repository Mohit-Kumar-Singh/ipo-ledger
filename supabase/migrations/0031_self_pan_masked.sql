-- ============================================================
-- self_pan_hash is a one-way hash — nothing to show back on Profile after
-- saving, so the PAN card just went blank again post-save with no
-- confirmation of what's on file, reading as "did that even save?" and
-- inviting a re-save. Store a masked display value alongside the hash
-- (same shape as demat_accounts.pan_masked) so the card can show
-- "ABCPD****E" instead.
-- ============================================================
alter table profiles add column if not exists self_pan_masked text;

create or replace function set_self_pan_hash(p_pan text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pan is null or p_pan !~ '^[A-Za-z]{5}[0-9]{4}[A-Za-z]$' then
    raise exception 'PAN must be in the format ABCPD1234E (5 letters, 4 digits, 1 letter).';
  end if;
  update profiles set
    self_pan_hash = encode(digest(upper(trim(p_pan)), 'sha256'), 'hex'),
    self_pan_masked = left(upper(trim(p_pan)), 5) || '****' || right(upper(trim(p_pan)), 1)
  where id = auth.uid();
end $$;
