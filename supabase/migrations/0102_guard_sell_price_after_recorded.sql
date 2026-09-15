-- Security audit finding AUTHZ-04 (MEDIUM): guard_admin_only_application_columns
-- (0081, extended 0083) protects demat_cut_paid/funder_share_paid/
-- mandate_status from a non-admin owner, but explicitly left sell_price
-- alone — 0081's own comment: "sell_price — reachable from the owner-gated
-- edit form (isOwner, not isAdmin). Worth revisiting: a holder setting
-- their own sell price understates what they owe back. Left alone for now
-- because closing it is a UI change, not just a policy one."
--
-- Re-traced against the CURRENT frontend before choosing a fix: there are
-- two independent non-admin-reachable write paths, not one —
-- ApplicationsPage.tsx's owner-gated edit form (no status restriction at
-- all) and AllotmentBoardPage.tsx's "Mark sold"/"Edit sale" flow, the
-- latter explicitly re-editable by the owner even after status is already
-- SOLD (canMark() includes the demat owner, and the SoldPayoutsSection
-- feeding it includes ALLOTTED/PARTIALLY_SOLD/SOLD rows). Both funnel into
-- a plain `applications` UPDATE with no column-level restriction beyond
-- what this trigger already enforces.
--
-- The owner *reporting* a sale for the first time is real, intentional,
-- actively-used self-service functionality (AllotmentBoardPage's whole
-- SoldForm/SoldPayoutsSection UI exists because the account holder is the
-- one who actually executed the sale and knows the real price) — not
-- something to remove. The gap is specifically an owner *revising* a price
-- that's already on record, after admin/funder accounting may already be
-- relying on it (financial_change_log entries, settlement_payments rows,
-- demat_cut_paid/funder_share_paid flags).
--
-- sell_price is NULL for every status except SOLD (PARTIALLY_SOLD
-- deliberately keeps it NULL — see migration 0096), so "already recorded"
-- and "old.sell_price is not null" are the same condition — no need to
-- reference status at all, and this stays correct regardless of any
-- separate status-transition question. Extends the existing trigger
-- (per this app's own established pattern) rather than adding a new one;
-- REJECTS the whole update for a non-admin, matching this function's
-- existing convention for every other column it guards, rather than
-- silently coercing.
create or replace function public.guard_admin_only_application_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.mandate_status = 'CANCELLED' and new.mandate_status = 'APPROVED' then
    raise exception 'A cancelled mandate cannot be marked approved directly — move it to pending first.';
  end if;

  if is_admin() then
    return new;
  end if;

  if new.demat_cut_paid is distinct from old.demat_cut_paid
     or new.funder_share_paid is distinct from old.funder_share_paid then
    raise exception 'Only an admin can change payout status.';
  end if;

  if new.mandate_status is distinct from old.mandate_status then
    raise exception 'Only an admin can change the mandate status.';
  end if;

  if old.sell_price is not null and new.sell_price is distinct from old.sell_price then
    raise exception 'Only an admin can change a sell price that has already been recorded.';
  end if;

  return new;
end $$;
