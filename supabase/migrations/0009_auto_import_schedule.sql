-- ============================================================
-- Schedules auto-import-ipos to run every 4 hours via pg_cron + pg_net.
--
-- Before running in the SQL Editor, replace __CRON_SECRET__ below with the
-- actual value (see supabase/.secrets.local, gitignored) — this file
-- intentionally keeps a placeholder.
-- ============================================================
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'auto-import-ipos-4h',
  '0 */4 * * *',
  $$
  select net.http_post(
    url := 'https://nzflndquzlzafrbyivyz.supabase.co/functions/v1/auto-import-ipos',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '__CRON_SECRET__'),
    body := '{}'::jsonb
  );
  $$
);
