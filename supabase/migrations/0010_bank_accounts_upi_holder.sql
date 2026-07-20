-- ============================================================
-- bank_accounts redesign: account holder name + UPI become the primary
-- fields, bank name and last-4 become optional (some entries are UPI-only).
-- ============================================================
alter table bank_accounts add column if not exists account_holder_name text;
alter table bank_accounts alter column bank_name drop not null;
alter table bank_accounts alter column last4 drop not null;
