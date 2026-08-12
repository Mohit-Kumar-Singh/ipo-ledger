-- ipoji's own "App" number for an application, when it was synced from
-- there (IpojiSyncPanel.tsx) — shown on the Applications list in place of
-- lots/amount, so an application can be cross-checked directly against
-- ipoji's Orders/Bids page. Null for manually-entered applications; backfilled
-- by re-running the sync for an already-existing application (the panel
-- updates it, not just new inserts).
alter table applications
  add column if not exists ipoji_app_number text;
