-- Mandate decisions set by the ipoji sync (a guess derived from ipoji's own
-- status text, see guessMandateStatus in IpojiSyncPanel.tsx) were recorded
-- exactly like a human decision — mandate_marked_by was set to whichever
-- admin happened to click Import, and the UI showed "by <that admin's
-- name>", indistinguishable from them having actually reviewed and marked
-- it themselves. Add a flag so the UI can show "by ipoji" instead.
alter table applications
  add column if not exists mandate_marked_by_ipoji boolean not null default false;

-- Same authorization as set_mandate_status (admin or the funder), same
-- effect, but marks the source — mandate_marked_by still records which
-- admin ran the sync (real audit trail, not discarded), the new column is
-- purely a display hint for "this wasn't a reviewed human decision."
create or replace function set_mandate_status_from_ipoji(p_application_id uuid, p_status mandate_stat)
returns void
language plpgsql security definer set search_path = public as $$
declare
  is_funder boolean;
begin
  select exists (
    select 1 from applications a
    join bank_accounts b on b.id = a.bank_account_id
    where a.id = p_application_id and b.linked_user_id = auth.uid()
  ) into is_funder;

  if not (is_admin() or is_funder) then
    raise exception 'Not authorized to mark this mandate.';
  end if;

  update applications
  set mandate_status = p_status, mandate_marked_by = auth.uid(), mandate_marked_at = now(),
      mandate_marked_by_ipoji = true
  where id = p_application_id;
end $$;
revoke execute on function set_mandate_status_from_ipoji(uuid, mandate_stat) from public, anon;
grant execute on function set_mandate_status_from_ipoji(uuid, mandate_stat) to authenticated;
