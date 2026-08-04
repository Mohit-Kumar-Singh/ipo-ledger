-- ============================================================
-- applications.ipo_id was `on delete cascade` since 0001 — deleting an IPO
-- silently deleted every application on it too (no separate confirmation,
-- no way to undo). This is the same footgun bank_accounts/demat_accounts
-- don't have: deleting a demat account with existing applications already
-- fails with a foreign-key error today (23503, caught in AccountsPage and
-- shown as "delete applications first") rather than cascading. Bring IPOs
-- in line with that: deleting an IPO now requires its applications to be
-- gone first, an explicit, deliberate, separate action instead of a side
-- effect of a different delete.
-- ============================================================
alter table applications drop constraint applications_ipo_id_fkey;
alter table applications add constraint applications_ipo_id_fkey
  foreign key (ipo_id) references ipos(id);
