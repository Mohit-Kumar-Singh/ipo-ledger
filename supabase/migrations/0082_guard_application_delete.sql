-- Security audit finding (CRITICAL): p_apps_member_write grants a demat
-- account owner `for ALL` on their own application rows — 0080/0081 already
-- narrowed UPDATE (mandate_status, demat_cut_paid, funder_share_paid are
-- admin-only), but DELETE was never addressed. Verified live: a member can
-- delete their own application at ANY status, including ALLOTTED/SOLD, via
-- a raw REST call — and settlement_payments.application_id is ON DELETE
-- CASCADE, so deleting a SOLD application silently destroys every real
-- settlement_payments row logged against it too (actual money-movement
-- records, not something recoverable from anywhere else). notifications and
-- allotment_auto_checks are ON DELETE SET NULL, so those just orphan rather
-- than vanish, but the settlement_payments cascade is a genuine, permanent
-- data-loss path with zero admin visibility before or after.
--
-- Self-service delete of a fresh APPLIED row (the case deleteApplication in
-- ApplicationsPage.tsx is actually meant for — removing a duplicate/mistaken
-- entry before anything real has happened to it) stays allowed. Once status
-- has moved past APPLIED, a real business event is on record — same
-- threshold isEligibleForNotAllotted() and the whole allotment/mandate
-- guard already use elsewhere in this app for "this now needs an admin."
create or replace function guard_application_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_admin() then
    return old;
  end if;
  if old.status <> 'APPLIED' then
    raise exception 'Only an admin can delete an application once it has a result recorded.';
  end if;
  return old;
end $$;

drop trigger if exists trg_guard_application_delete on applications;
create trigger trg_guard_application_delete
  before delete on applications
  for each row execute function guard_application_delete();
