-- Security audit finding AUTHZ-02 (HIGH): every guard this schema has ever
-- built for `applications` — enforce_allotment_date (0046), the admin-only
-- column guard (0081/0083), guard_application_delete (0082) — is wired as a
-- `before UPDATE` trigger. None of them fire on INSERT. p_apps_member_write's
-- own `with check` (0032) only verifies the caller owns demat_id; it places
-- no constraint on any other column. RLS is row-level, not column-level
-- (CLAUDE.md), so a linked member's own JWT can INSERT a new application row
-- with status='SOLD', mandate_status='APPROVED', demat_cut_paid=true,
-- funder_share_paid=true, created_by=<anyone>, in one request — a fully
-- fabricated "sold, paid, mandate-approved" record that skips the allotment-
-- date check (0046 only fires on UPDATE), the admin-only mandate/payout guard
-- (0081/0083 only fire on UPDATE), and the application_sells reconciliation
-- (0096, which only watches application_sells, not direct applications
-- writes) — the exact class of harm 0081/0082/0084 were written to prevent,
-- reachable through a path those migrations didn't cover.
--
-- Fix, same pattern as 0081 (is_admin() bypass, everyone else guarded) but
-- on INSERT instead of UPDATE: a non-admin's new row is forced into the same
-- safe starting state self-service creation already produces today (verified
-- against ApplicationsPage.tsx's NewApplicationForm create path — it never
-- sets status/mandate_status/demat_cut_paid/funder_share_paid/created_by at
-- all, relying entirely on their column defaults), so this is a no-op for
-- every legitimate caller and a hard rejection for anyone trying to insert
-- an already-privileged row.
--
-- created_by / mandate_marked_by / mandate_marked_at are corrected rather
-- than rejected — there's no legitimate reason to fail the whole insert over
-- misattribution when it can just be fixed; created_by already defaults to
-- auth.uid() (0029) so this only matters if a caller explicitly overrides it.
--
-- funder_override_id is DELIBERATELY left untouched: verified live in
-- ApplicationsPage.tsx that the "Funder" override field on the application
-- form is shown to any owner (isOwner), not gated `isAdmin` the way the
-- Mandate field explicitly is a few lines below it in the same form, and
-- IpojiSyncPanel's own insert comment confirms this is an intentional
-- self-service field ("the real funder handed money over some other way and
-- someone else's UPI actually paid"). Restricting it here would break a
-- working, deliberately-designed capability, not close a hole introduced by
-- this migration's scope — the residual "can point it at a bank account you
-- don't own" concern is a separate, pre-existing question (identical for
-- INSERT and UPDATE, neither newly opened nor closed by this fix) worth a
-- product decision of its own, not a silent side effect here.
--
-- is_backdated is also left untouched — a plain descriptive flag with no
-- financial/workflow effect, and legitimately owner-set today (autoBackdated
-- in NewApplicationForm).
create or replace function guard_application_insert_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Admin keeps full insert freedom (manual backfills, the ipoji sync panel
  -- setting mandate_status/imported_from_ipoji/etc. at create time) — every
  -- check below is about a non-admin caller reaching these columns directly.
  if is_admin() then
    return new;
  end if;

  if new.status is distinct from 'APPLIED' then
    raise exception 'A new application must start in APPLIED status.';
  end if;

  if new.mandate_status is distinct from 'PENDING' then
    raise exception 'A new application''s mandate must start PENDING.';
  end if;

  if new.demat_cut_paid then
    raise exception 'Only an admin can record a payout as already paid.';
  end if;

  if new.funder_share_paid then
    raise exception 'Only an admin can record a payout as already paid.';
  end if;

  if new.mandate_marked_by_ipoji then
    raise exception 'Only an admin can mark a mandate as ipoji-sourced.';
  end if;

  -- Corrected, not rejected — no legitimate reason to fail the insert over
  -- misattribution when it can just be fixed. mandate_marked_by/_at only
  -- matter once mandate_status is non-PENDING, which the check above already
  -- guarantees can't happen here, but forced null anyway rather than left as
  -- whatever a caller passed.
  new.created_by := auth.uid();
  new.mandate_marked_by := null;
  new.mandate_marked_at := null;

  return new;
end $$;

drop trigger if exists trg_guard_application_insert_columns on applications;
create trigger trg_guard_application_insert_columns
  before insert on applications
  for each row execute function guard_application_insert_columns();
