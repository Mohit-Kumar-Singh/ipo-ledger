-- Confirmed live bug: a funder viewing their own /payouts page (added in
-- 0090/FunderPayoutsPage) always saw "Remaining" equal to the full amount
-- ever owed, never reduced by payments already logged — because
-- settlement_payments is admin-only under RLS (0078: "a holder or funder
-- never sees this table directly"), which was true until 0090 gave funders
-- a self-service settlement statement that reads exactly this table via
-- buildSettlementCards' sentToFunder/paidByHolder reducers. With payments
-- invisible to them, `sentToFunder` computed client-side is always 0, so
-- remainingToFunder == amountToFunder for every card no matter how much has
-- actually been sent.
--
-- Confirmed with real data: Jigyansh funded 4 SOLD applications totalling
-- ₹65,045.45 owed; ₹33,243.58 of that (two applications) was already paid
-- via logged admin_to_funder payments, leaving a true ₹31,801.88 remaining
-- — exactly what the admin's per-funder statement showed. Jigyansh's own
-- portal showed the full ₹65,045 as still owed, because it could not see
-- either of the two admin_to_funder rows at all.
--
-- Fix: let a funder read (SELECT only — insert/update/delete stay
-- admin-only via the existing p_settlement_payments_admin policy, which
-- this one only adds to, not replaces) the payments that move money to
-- THEM specifically — kind admin_to_funder/holder_to_funder, same two
-- kinds buildSettlementCards' sentToFunder already filters to before
-- forming this same policy — scoped to applications they actually funded.
-- Narrower than a plain per-application grant on purpose: holder_to_admin
-- rows on the very same application (what the demat holder separately paid
-- back) are not this funder's business and stay hidden, same "narrow the
-- grant to just what the new viewer needs" rule as resolve_demat_holder_name
-- and friends (see CLAUDE.md's RLS section).
--
-- is_own_funder_application is `stable security definer` so it bypasses
-- applications/bank_accounts RLS internally rather than the policy itself
-- reading those tables — breaks any cross-table RLS cycle risk before it
-- can start, same reasoning as 0033's fix for the demat/bank/applications
-- cycle.
create or replace function is_own_funder_application(p_application_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from applications a
    join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id)
    where a.id = p_application_id and b.linked_user_id = auth.uid()
  );
$$;

create policy p_settlement_payments_own_funder on settlement_payments for select
  using (
    kind in ('admin_to_funder', 'holder_to_funder')
    and is_own_funder_application(application_id)
  );
