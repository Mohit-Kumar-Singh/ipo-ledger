-- Security review finding, same root cause 0046 patched one symptom of:
-- p_apps_member_write (0032) is `for all` scoped only to "do you own this
-- demat account," and RLS is row-level, not column-level (CLAUDE.md) — so a
-- member who owns the demat account can write EVERY column of their own
-- application rows via a raw REST PATCH, using the same JWT the real UI
-- already trusts.
--
-- Verified against production as a real linked member, not inferred from
-- reading the policy: they could set mandate_status directly (defeating the
-- admin-only RPC added in 0080 entirely — the RPC is only the authorization
-- boundary for callers who actually go through it), flip
-- demat_cut_paid/funder_share_paid, and rewrite sell_price/status.
--
-- Marking your own payout as paid is the one that actually costs money: it
-- removes you from the admin's Outstanding list, under-reports the
-- Dashboard's "Payouts pending" tile, and can trip auto-archive (0052/0054)
-- into hiding the IPO — all while the money is still owed.
--
-- Guarded here with a before-update trigger rather than by narrowing
-- p_apps_member_write, following 0046's precedent: the policy also carries
-- the legitimate member self-service writes, so replacing it wholesale is a
-- much larger blast radius than guarding the specific columns that should
-- never have been member-writable.
--
-- DELIBERATELY NOT GUARDED — both have real member UI paths today, and
-- blocking them here would break working self-service rather than close a
-- hole:
--   status     — a demat owner marks their own APPLIED row NOT_ALLOTTED
--                (isEligibleForNotAllotted in ApplicationsPage). Already
--                value-guarded by 0046's allotment-date trigger.
--   sell_price — reachable from the owner-gated edit form (isOwner, not
--                isAdmin). Worth revisiting: a holder setting their own
--                sell price understates what they owe back. Left alone for
--                now because closing it is a UI change, not just a policy
--                one.
create or replace function guard_admin_only_application_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Admin keeps full row access via p_apps_admin; every check below is
  -- about a non-admin caller reaching these columns directly.
  if is_admin() then
    return new;
  end if;

  if new.demat_cut_paid is distinct from old.demat_cut_paid
     or new.funder_share_paid is distinct from old.funder_share_paid then
    raise exception 'Only an admin can change payout status.';
  end if;

  -- set_mandate_status / set_mandate_status_from_ipoji (0080) are the only
  -- legitimate writers, and both already reject non-admins before reaching
  -- this point. They're security definer but auth.uid() still resolves to
  -- the real caller inside them, so an admin calling the RPC passes the
  -- is_admin() check above and is unaffected by this branch.
  if new.mandate_status is distinct from old.mandate_status then
    raise exception 'Only an admin can change the mandate status.';
  end if;

  return new;
end $$;

drop trigger if exists trg_guard_admin_only_application_columns on applications;
create trigger trg_guard_admin_only_application_columns
  before update on applications
  for each row execute function guard_admin_only_application_columns();
