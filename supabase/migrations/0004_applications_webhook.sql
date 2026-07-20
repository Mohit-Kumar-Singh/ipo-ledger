-- ============================================================
-- Database webhook: applications INSERT/UPDATE -> send-whatsapp Edge Function.
-- Equivalent to a dashboard-created "Database Webhook", built directly on the
-- supabase_functions.http_request trigger function every Supabase project ships with.
--
-- Before running in the SQL Editor, replace __DB_WEBHOOK_SECRET__ below with the
-- actual value (see supabase/.secrets.local, which is gitignored and never
-- committed — this file intentionally keeps a placeholder).
-- ============================================================
create trigger trg_applications_notify
after insert or update on public.applications
for each row execute function supabase_functions.http_request(
  'https://nzflndquzlzafrbyivyz.supabase.co/functions/v1/send-whatsapp',
  'POST',
  '{"Content-Type":"application/json","x-webhook-secret":"__DB_WEBHOOK_SECRET__"}',
  '{}',
  '5000'
);
