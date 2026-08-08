-- ============================================================
-- Security review finding: v1.42.0 added a rule that an application can
-- only be marked ALLOTTED/NOT_ALLOTTED once the IPO's allotment_date has
-- passed — but that was enforced ONLY in the frontend (ApplicationsPage,
-- AllotmentBoardPage disabling the buttons / hiding the IPO from the
-- picker). This app's documented security model is that RLS is the ONLY
-- real authorization boundary (see CLAUDE.md) — a client-side check is not
-- one. applications' own RLS policy (p_apps_member_write, 0032) is `for
-- all` scoped only to "do you own this demat account," with no column- or
-- value-level restriction, so any owner (the demat's linked member, or
-- admin) could set status = 'ALLOTTED' via a raw REST PATCH at any time,
-- allotment date passed or not — completely bypassing the rule via the
-- exact same JWT the real UI already trusts. This closes that gap at the
-- only layer that actually enforces anything in this app: the database.
-- ============================================================

create or replace function enforce_allotment_date() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_allotment_date date;
begin
  if new.status in ('ALLOTTED', 'NOT_ALLOTTED') and new.status is distinct from old.status then
    select allotment_date into v_allotment_date from ipos where id = new.ipo_id;
    if v_allotment_date is null or v_allotment_date > current_date then
      raise exception 'Cannot mark an application allotted/not-allotted before the IPO''s allotment date.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_enforce_allotment_date on applications;
create trigger trg_enforce_allotment_date
  before update on applications
  for each row execute function enforce_allotment_date();
