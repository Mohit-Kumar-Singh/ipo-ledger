-- ============================================================
-- Schedules resolve-listing-symbols to run daily at 10am IST (04:30 UTC) —
-- same pg_cron + pg_net pattern as migration 0040's gmp-alert-notify, and
-- the exact moment CLAUDE.md/the user asked for: the point on listing day a
-- share actually starts trading, so a freshly-listed IPO's "Expected
-- profit" can start tracking a real price instead of the frozen GMP guess
-- as soon as its NSE symbol can be found automatically. Also catches any
-- IPO that already listed but is still un-resolved, since the function
-- filters on listing_date <= today, not just = today — it keeps retrying
-- once a day for every current and future IPO, with nothing here tied to
-- any specific company.
--
-- Before running in the SQL Editor, replace __CRON_SECRET__ below with the
-- actual value (see supabase/.secrets.local, gitignored) — this file
-- intentionally keeps a placeholder, same pattern as migrations 0040/0051.
-- ============================================================
select cron.schedule(
  'resolve-listing-symbols-daily-10am-ist',
  '30 4 * * *',
  $$
  select net.http_post(
    url := 'https://nzflndquzlzafrbyivyz.supabase.co/functions/v1/resolve-listing-symbols',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '__CRON_SECRET__'),
    body := '{}'::jsonb
  );
  $$
);
