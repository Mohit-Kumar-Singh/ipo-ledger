-- ============================================================
-- High-GMP pre-open WhatsApp alerts: 2 days and 1 day before an IPO's
-- open_date, if its GMP is above 15%, notify every active demat holder.
-- ============================================================

-- Admin-editable, mirrors retail_issue_size — ipoji doesn't scrape a
-- shareholder-quota figure, so this stays manual, included in the alert
-- message only when set.
alter table ipos add column if not exists shareholder_issue_size text;

-- Ties an alert notification back to the IPO it's about, for idempotency
-- (never send the same "2 days out" / "1 day out" alert twice to the same
-- holder) and so the Notifications page can show which IPO it was for.
alter table notifications add column if not exists ipo_id uuid references ipos(id) on delete set null;
create index on notifications (ipo_id);

alter type notif_type add value if not exists 'GMP_ALERT';
