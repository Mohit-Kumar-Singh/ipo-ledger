-- ============================================================
-- 1. Mandate approval tracking on applications.
--    After an IPO application goes in, the investor's bank sends a UPI/
--    ASBA "mandate" request that must be approved in their bank/UPI app
--    before the application is actually honored — this records whether
--    that happened, not just that the application row exists.
-- ============================================================
create type mandate_stat as enum ('PENDING', 'APPROVED', 'CANCELLED');

alter table applications add column mandate_status mandate_stat not null default 'PENDING';
alter table applications add column mandate_marked_by uuid references profiles(id);
alter table applications add column mandate_marked_at timestamptz;

-- Write path is a security-definer RPC, not a direct RLS grant — "me and
-- the funder can mark it" needs to check funder status (bank_accounts.
-- linked_user_id) without also handing the funder a raw UPDATE on the rest
-- of the row (lots, bid_amount, status, ...), which is all an RLS policy
-- could grant (RLS is row-level, not column-level — CLAUDE.md). Admin
-- keeps full row access via the existing p_apps_admin policy; this
-- function is the only extra write surface a funder gets, and it only
-- ever touches the three mandate_* columns.
create or replace function set_mandate_status(p_application_id uuid, p_status mandate_stat)
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
  set mandate_status = p_status, mandate_marked_by = auth.uid(), mandate_marked_at = now()
  where id = p_application_id;
end $$;
revoke execute on function set_mandate_status(uuid, mandate_stat) from public, anon;
grant execute on function set_mandate_status(uuid, mandate_stat) to authenticated;

-- ============================================================
-- 2. Extend the existing auto-archive cron (0038) to also catch IPOs that
--    closed with zero applications — nothing to show, no reason to keep
--    cluttering the main IPOs list. Same "archive, never delete" approach
--    as the listing-based rule already there (reversible via the existing
--    unarchive control, and no applications ever point at a gone IPO).
--    cron.schedule with the same job name replaces it in place.
-- ============================================================
select cron.schedule(
  'archive-listed-ipos-daily',
  '0 2 * * *',
  $$
  update ipos set is_archived = true
  where not is_archived
    and listing_date is not null
    and listing_date <= current_date - 7;

  update ipos set is_archived = true
  where not is_archived
    and close_date < current_date
    and not exists (select 1 from applications a where a.ipo_id = ipos.id);
  $$
);
