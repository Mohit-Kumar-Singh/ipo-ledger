-- ============================================================
-- Retail subscription rate (e.g. "2.77x") — only meaningful once bidding
-- has opened, pulled from ipoji's subscription-status table on import, or
-- entered manually. Separate column, same pattern as issue_size/retail_issue_size.
-- ============================================================
alter table ipos add column if not exists retail_subscription_rate text;
