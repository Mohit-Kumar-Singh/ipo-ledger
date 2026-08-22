-- Marking a mandate is an admin-only decision now. Both mandate RPCs
-- previously authorized `is_admin() or is_funder` (0047, extended in 0059/
-- 0060) — a funder could approve/cancel the mandate on any application their
-- own linked bank/UPI account paid for. That's the wrong boundary: whether
-- the UPI block was actually honored is a record the admin keeps, not
-- something the funder self-reports.
--
-- Both functions are locked down, not just set_mandate_status: they write
-- the same three mandate_* columns, and `authenticated` holds execute on
-- both, so leaving the _from_ipoji variant on the old check would leave the
-- exact same write open to a funder calling it directly with the sync panel
-- (already admin-gated in the UI) entirely out of the picture. Hiding a
-- button is not an authorization boundary — CLAUDE.md.

create or replace function set_mandate_status(p_application_id uuid, p_status mandate_stat)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Only an admin can mark this mandate.';
  end if;

  update applications
  set mandate_status = p_status,
      mandate_marked_by = auth.uid(),
      mandate_marked_at = now(),
      -- Clears the sync-source flag (0059). This path is a deliberate human
      -- decision, so an application the sync had previously guessed at must
      -- stop rendering the "Set by the ipoji sync" logo / "by ipoji" label
      -- the moment an admin overrides it by hand — otherwise the override is
      -- silently misattributed to the sync.
      mandate_marked_by_ipoji = false
  where id = p_application_id;
end $$;
revoke execute on function set_mandate_status(uuid, mandate_stat) from public, anon;
grant execute on function set_mandate_status(uuid, mandate_stat) to authenticated;

-- Unchanged apart from the authorization check and dropping the now-unused
-- is_funder lookup — still records mandate_marked_by (which admin ran the
-- sync) and still flags the row as sync-derived rather than reviewed.
create or replace function set_mandate_status_from_ipoji(p_application_id uuid, p_status mandate_stat, p_status_text text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Only an admin can mark this mandate.';
  end if;

  update applications
  set mandate_status = p_status,
      mandate_marked_by = auth.uid(),
      mandate_marked_at = now(),
      mandate_marked_by_ipoji = true,
      ipoji_status_text = coalesce(p_status_text, ipoji_status_text)
  where id = p_application_id;
end $$;
revoke execute on function set_mandate_status_from_ipoji(uuid, mandate_stat, text) from public, anon;
grant execute on function set_mandate_status_from_ipoji(uuid, mandate_stat, text) to authenticated;
