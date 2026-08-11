-- ============================================================
-- Schedules ipo-close-rollup-notify daily at 6pm IST (12:30 UTC) — after
-- close-day bidding has actually ended for the day, well after
-- auto-import-ipos/gmp-alert-notify's early-morning runs so this always
-- sees that day's close_date IPOs with today's freshest application data.
--
-- Before running in the SQL Editor, replace __CRON_SECRET__ below with the
-- actual value (see supabase/.secrets.local, gitignored) — this file
-- intentionally keeps a placeholder, same pattern as migration 0040.
-- ============================================================
select cron.schedule(
  'ipo-close-rollup-notify-daily-6pm-ist',
  '30 12 * * *',
  $$
  select net.http_post(
    url := 'https://nzflndquzlzafrbyivyz.supabase.co/functions/v1/ipo-close-rollup-notify',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '__CRON_SECRET__'),
    body := '{}'::jsonb
  );
  $$
);
