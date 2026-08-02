-- ============================================================
-- Tracks whether a user has seen (or skipped) the first-login
-- onboarding tour, so it only shows once per account regardless of
-- device/browser. Mutated via a narrow security-definer function
-- (same pattern as update_own_full_name/update_own_profile) rather than
-- a client-side RLS update policy, since RLS can't restrict an update to
-- a single column and a member must never be able to touch `role`.
-- ============================================================
alter table profiles add column if not exists has_seen_tour boolean not null default false;

create or replace function mark_tour_seen() returns void
language plpgsql security definer set search_path = public as $$
begin
  update profiles set has_seen_tour = true where id = auth.uid();
end $$;

revoke execute on function mark_tour_seen() from public, anon;
grant execute on function mark_tour_seen() to authenticated;
