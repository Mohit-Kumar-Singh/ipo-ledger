-- Marks applications created by the ipoji sync panel (IpojiSyncPanel.tsx),
-- same purpose as is_backdated already has for the backdated-entry flow —
-- lets the UI show a "synced from ipoji" badge instead of it looking like
-- any other manually-entered application.
alter table applications
  add column if not exists imported_from_ipoji boolean not null default false;
