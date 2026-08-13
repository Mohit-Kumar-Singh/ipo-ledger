-- The raw status text ipoji itself shows ("Bid placed successfully",
-- "Request Accepted By Sponsor Bank", "Accepted by Investor", ...) was only
-- ever used transiently to guess this app's own mandate_status (PENDING/
-- APPROVED/CANCELLED) and then discarded — collapsing "bid placed" and
-- "bank accepted" into the same PENDING bucket loses a real distinction the
-- user wants visible (and wants reflected in the funder WhatsApp message as
-- a different symbol). Keep the original text around.
alter table applications
  add column if not exists ipoji_status_text text;

-- Same authorization as set_mandate_status_from_ipoji, now also recording
-- the raw text alongside the derived mandate_status. Replaces the previous
-- 2-arg version (dropped — every caller already needs updating to pass the
-- new argument, no reason to keep both signatures around).
drop function if exists set_mandate_status_from_ipoji(uuid, mandate_stat);

create or replace function set_mandate_status_from_ipoji(p_application_id uuid, p_status mandate_stat, p_status_text text default null)
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
      mandate_marked_by_ipoji = true,
      ipoji_status_text = coalesce(p_status_text, ipoji_status_text)
  where id = p_application_id;
end $$;
revoke execute on function set_mandate_status_from_ipoji(uuid, mandate_stat, text) from public, anon;
grant execute on function set_mandate_status_from_ipoji(uuid, mandate_stat, text) to authenticated;
