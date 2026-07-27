-- ============================================================
-- Realtime UPDATE payloads only include old row data when a table's replica
-- identity is FULL (default is just the primary key). ToastHost needs the
-- previous status to tell "a message was actually (re)dispatched" apart from
-- "this row's application_id got nulled by an unrelated application delete"
-- (notifications.application_id is ON DELETE SET NULL) — without old.status
-- to compare against, every touch to the row looked like a fresh dispatch.
-- ============================================================
alter table notifications replica identity full;
