-- ============================================================
-- Active/inactive flag per demat account — some accounts (shared with other
-- people) aren't used regularly for applications. Defaults to active; can be
-- toggled without touching PAN/holder details.
-- ============================================================
alter table demat_accounts add column if not exists is_active boolean not null default true;
