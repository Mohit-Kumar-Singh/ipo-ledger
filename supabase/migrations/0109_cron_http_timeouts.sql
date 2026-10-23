-- The scheduled Edge Function calls (auto-import-ipos every 4h, gmp-alert-notify,
-- ipo-close-rollup-notify, resolve-listing-symbols) use net.http_post with
-- pg_net's default 5-second timeout. auto-import-ipos fetches several ipoji
-- pages and sometimes takes longer than that: the 2026-10-23 08:00 UTC run was
-- recorded as "Timeout of 5000 ms reached" (net._http_response, status null)
-- while the cron job itself still reported "succeeded", so a slow run left no
-- visible trace. 30 seconds is well under the Edge Function wall-clock limit.
--
-- Done in place, inside the database, by appending the argument to the stored
-- command text - the x-cron-secret value in those commands is never read out or
-- re-typed here. Idempotent: jobs that already pass timeout_milliseconds are
-- left alone.
do $$
declare
  j record;
begin
  for j in
    select jobid, command
    from cron.job
    where command like '%net.http_post(%'
      and command not like '%timeout_milliseconds%'
      and command like E'%body := ''{}''::jsonb%'
  loop
    perform cron.alter_job(
      j.jobid,
      command := replace(
        j.command,
        E'body := ''{}''::jsonb',
        E'body := ''{}''::jsonb,\n    timeout_milliseconds := 30000'
      )
    );
  end loop;
end $$;
