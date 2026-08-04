-- ============================================================
-- Schedules gmp-alert-notify to run daily at 4am IST (22:30 UTC the
-- previous day) via pg_cron + pg_net — same pattern as migration 0009's
-- auto-import-ipos schedule.
--
-- Before running in the SQL Editor, replace __CRON_SECRET__ below with the
-- actual value (see supabase/.secrets.local, gitignored) — this file
-- intentionally keeps a placeholder.
-- ============================================================
select cron.schedule(
  'gmp-alert-notify-daily-4am-ist',
  '30 22 * * *',
  $$
  select net.http_post(
    url := 'https://nzflndquzlzafrbyivyz.supabase.co/functions/v1/gmp-alert-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '__CRON_SECRET__'),
    body := '{}'::jsonb
  );
  $$
);
