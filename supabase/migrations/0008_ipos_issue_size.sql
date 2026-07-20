-- ============================================================
-- Issue size (free text, like gmp_notes — ipoji formats it as "₹9795.31 Cr"
-- which doesn't warrant a numeric column) for display on IPO cards.
-- ============================================================
alter table ipos add column if not exists issue_size text;
