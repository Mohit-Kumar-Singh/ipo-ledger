-- ============================================================
-- Bug fix: a member's own PENDING/REJECTED demat_link_requests rows embed
-- demat_accounts(holder_name) in the client (ProfilePage "Your requests",
-- Dashboard "Your link requests"), but p_demat_member only grants SELECT
-- once linked_user_id = auth.uid() — which is only true after APPROVED.
-- Result: the account name silently renders as "--" for every request that
-- isn't approved yet, even though the member already saw that same name via
-- search_unlinked_demat_accounts() when they requested it.
--
-- Fix: grant a member SELECT on a demat_accounts row if they have any
-- link request (any status) against it — same fields already visible for
-- their own approved/linked accounts (masked PAN, not the plaintext).
-- ============================================================
create policy p_demat_member_requested on demat_accounts for select
  using (exists (
    select 1 from demat_link_requests r
    where r.demat_id = demat_accounts.id and r.member_id = auth.uid()
  ));
