-- Hardening for 0106: a "not applying" tick may only point at one of the
-- caller's OWN broadcast contacts. The original policy only checked
-- owner_id, so a row could reference someone else's contact id.
drop policy p_broadcast_not_applying_owner on broadcast_not_applying;

create policy p_broadcast_not_applying_owner on broadcast_not_applying
  for all using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and exists (
      select 1 from broadcast_contacts c
      where c.id = contact_id and c.owner_id = auth.uid()
    )
  );
