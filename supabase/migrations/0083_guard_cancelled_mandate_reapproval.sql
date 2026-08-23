-- A cancelled mandate must stay cancelled — not even an admin should be able
-- to flip mandate_status straight from CANCELLED back to APPROVED in the
-- portal. Checked ahead of the existing is_admin() early-return in
-- guard_admin_only_application_columns() (0081) so this applies to every
-- caller, admin included, unlike the rest of that function which only
-- restricts non-admins. PENDING remains reachable from CANCELLED (an admin
-- re-opening review is fine — it's specifically CANCELLED -> APPROVED, the
-- one transition that skips review entirely, that's blocked).
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

  return new;
end $$;
