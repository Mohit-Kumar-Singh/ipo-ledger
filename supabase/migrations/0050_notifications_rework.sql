-- ============================================================
-- Notifications rework:
-- 1. is_archived flag — notifications for an application whose IPO ended
--    up NOT_ALLOTTED (or never got an allotment status at all) more than
--    3 days past the IPO's own allotment_date move out of the active list
--    on their own, via a daily cron sweep below. Archiving, not deleting —
--    same "never destroy a notification row" convention already used
--    everywhere else in this app (IPOs archive, applications never hard-
--    delete their notification trail).
-- 2. A new notif_type value for the per-IPO-close-date rollup message (one
--    funder, every demat account they applied through for that IPO) —
--    distinct from APPLIED/ALLOTTED so it can be told apart in the UI and
--    from the archive sweep (a rollup is never archived on its own; it
--    just correctly won't get created for an application whose
--    notification was already archived, since the sweep only touches
--    already-existing APPLIED rows).
-- ============================================================
alter table notifications add column is_archived boolean not null default false;
create index on notifications (is_archived);

alter type notif_type add value if not exists 'ROLLUP';

-- Daily sweep, not tied to any particular time-of-day dependency (unlike
-- gmp-alert-notify, which must run before market open) — just needs to run
-- once a day. Pure SQL, no Edge Function/net.http_post needed since this
-- never leaves the database.
select cron.schedule(
  'archive-stale-notifications-daily',
  '0 3 * * *',
  $$
  update notifications n
  set is_archived = true
  from applications a
  join ipos i on i.id = a.ipo_id
  where n.application_id = a.id
    and n.is_archived = false
    and n.type = 'APPLIED'
    and a.status in ('APPLIED', 'NOT_ALLOTTED')
    and i.allotment_date is not null
    and i.allotment_date <= current_date - 3;
  $$
);
