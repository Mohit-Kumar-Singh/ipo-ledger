-- ============================================================
-- Performance: index every foreign-key column that RLS policies
-- filter on. Postgres never auto-indexes FK columns (unlike PKs),
-- and several of these are evaluated by an EXISTS(...) subquery on
-- *every* row of *every* query a member makes (p_bank_member,
-- p_apps_member, p_notif_member and the bank_accounts member
-- policies in 0016_self_service.sql) — plus every cascade-delete
-- check on these tables. Pure index additions: no behavior change.
-- ============================================================
create index if not exists idx_demat_accounts_linked_user_id on demat_accounts (linked_user_id);
create index if not exists idx_bank_accounts_demat_id on bank_accounts (demat_id);
create index if not exists idx_bank_accounts_linked_user_id on bank_accounts (linked_user_id);
create index if not exists idx_applications_demat_id on applications (demat_id);
create index if not exists idx_applications_bank_account_id on applications (bank_account_id);
create index if not exists idx_notifications_demat_id on notifications (demat_id);
