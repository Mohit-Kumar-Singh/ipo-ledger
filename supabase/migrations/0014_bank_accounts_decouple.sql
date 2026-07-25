-- ============================================================
-- Decouple bank/UPI accounts from a single demat account: an entry no
-- longer belongs to exactly one demat holder, so any bank/UPI account can
-- be combined with any demat account at application time (e.g. a shared
-- family bank account used across several holders' applications).
-- ============================================================
alter table bank_accounts alter column demat_id drop not null;

-- Member visibility used to depend entirely on demat_id matching one of
-- their own accounts. Now that demat_id is usually null going forward,
-- also grant visibility when the bank/UPI entry is actually used on one
-- of their applications — that's how members reach it under the new model.
drop policy if exists p_bank_member on bank_accounts;
create policy p_bank_member on bank_accounts for select
  using (
    exists (select 1 from demat_accounts d
            where d.id = demat_id and d.linked_user_id = auth.uid())
    or exists (select 1 from applications a
               join demat_accounts d on d.id = a.demat_id
               where a.bank_account_id = bank_accounts.id and d.linked_user_id = auth.uid())
  );
