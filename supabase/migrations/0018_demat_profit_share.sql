-- ============================================================
-- Profit-sharing cut per demat account (e.g. what % of allotment profit is
-- shared back), defaulting to 25% but editable per account when saving.
-- ============================================================
alter table demat_accounts
  add column if not exists profit_share_percent numeric(5,2) not null default 25
  check (profit_share_percent >= 0 and profit_share_percent <= 100);
