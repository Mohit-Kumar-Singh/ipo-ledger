-- ============================================================
-- Test-mode support: send-whatsapp logs a SIMULATED status instead of
-- attempting a real WhatsApp send while WA_ACCESS_TOKEN/WA_PHONE_NUMBER_ID
-- are unset (no Meta setup done yet). Also enable Realtime on notifications
-- so the admin UI can show a popup the instant a row is inserted.
-- ============================================================
alter type notif_status add value if not exists 'SIMULATED';

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table notifications;
  end if;
end $$;
