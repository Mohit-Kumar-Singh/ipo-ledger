-- ============================================================
-- Separate column for the retail-only issue size, alongside the existing
-- (total) issue_size — cards show both, not one replacing the other.
-- ============================================================
alter table ipos add column if not exists retail_issue_size text;
