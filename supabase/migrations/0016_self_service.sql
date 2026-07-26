-- ============================================================
-- Self-service accounts: any signed-in member can now add and manage their
-- own demat/PAN and bank/UPI accounts and IPO applications (previously only
-- an admin could write these; members could only view rows an admin had
-- manually linked to them). Admin retains full visibility/control over
-- everyone's data via the existing is_admin() policies, unchanged.
-- ============================================================

-- bank_accounts previously had no owner column (decoupled from demat_id in
-- 0014 so any bank/UPI account could be reused across holders). Self-added
-- entries need an owner for RLS, same shape as demat_accounts.linked_user_id.
alter table bank_accounts add column if not exists linked_user_id uuid references profiles(id);

-- demat_accounts: writes for members go through the add-demat Edge Function
-- (service role, authorization enforced in code) — only the direct client
-- delete() call needs an RLS policy.
create policy p_demat_member_delete on demat_accounts for delete
  using (linked_user_id = auth.uid());

-- bank_accounts: writes happen directly from the client (no Edge Function),
-- so RLS is the actual enforcement here.
drop policy if exists p_bank_member on bank_accounts;
create policy p_bank_member on bank_accounts for select
  using (
    linked_user_id = auth.uid()
    or exists (select 1 from demat_accounts d
               where d.id = demat_id and d.linked_user_id = auth.uid())
    or exists (select 1 from applications a
               join demat_accounts d on d.id = a.demat_id
               where a.bank_account_id = bank_accounts.id and d.linked_user_id = auth.uid())
  );
create policy p_bank_member_write on bank_accounts for all
  using (linked_user_id = auth.uid())
  with check (linked_user_id = auth.uid());

-- applications: members can now create/edit/delete applications on their own
-- linked demat accounts (previously select-only).
drop policy if exists p_apps_member on applications;
create policy p_apps_member on applications for all
  using (exists (select 1 from demat_accounts d
                 where d.id = demat_id and d.linked_user_id = auth.uid()))
  with check (exists (select 1 from demat_accounts d
                       where d.id = demat_id and d.linked_user_id = auth.uid()));

-- notifications: members can mark their own QUEUED/FAILED notification as
-- SENT after manually sending it via wa.me from their own WhatsApp (no
-- delivery webhook exists for that path, so this is self-attested).
create policy p_notif_member_send on notifications for update
  using (exists (select 1 from demat_accounts d
                 where d.id = demat_id and d.linked_user_id = auth.uid()))
  with check (exists (select 1 from demat_accounts d
                       where d.id = demat_id and d.linked_user_id = auth.uid()));
