-- ============================================================
-- One archive rule, kept in the database.
--
-- Before this migration, three places each had their own version of
-- "when does an IPO archive":
--   * the nightly cron (0038/0047/0052/0054), which still archived every IPO
--     7 days after listing whether or not anything on it was done. 13 live
--     IPOs ended up archived with APPLIED / ALLOTTED / PARTIALLY_SOLD /
--     unpaid rows on them. Those rows were hidden from Applications, the
--     Allotment board and the Dashboard, so nobody could act on them. The
--     rule also re-archived every manual Unarchive the next night.
--   * maybeAutoArchiveIpo (client): could only archive, never unarchive, and
--     ignored a failed write.
--   * sync_ipo_archive (0092): archived/unarchived both ways, but was
--     callable by any signed-in user for any IPO.
--
-- Now:
--   1. sync_ipo_archive is the only rule: archived iff every application is
--      NOT_ALLOTTED, or SOLD with both payout flags settled. It now runs from
--      a trigger on applications (status, paid flags, insert, delete), so
--      every write path — admin pages, ipoji sync, self-sell, settlement
--      RPCs — keeps the flag right without the client having to ask.
--   2. ipos.keep_unarchived: set when an admin unarchives by hand. Automatic
--      archiving (trigger + cron) leaves those IPOs alone until an admin
--      archives them again. Automatic UN-archiving still happens (new open
--      work should never be hidden).
--   3. sync_ipo_archive is no longer executable by `authenticated`; every
--      caller is a security definer function/trigger owned by postgres.
--   4. The 7-day-after-listing cron rule is gone. The cron keeps the
--      "closed with zero applications" rule and the resolved rule as a
--      safety net.
--   5. One-time: unarchive every IPO that is archived but still has
--      unresolved applications, so that work is visible again.
-- ============================================================

alter table ipos add column keep_unarchived boolean not null default false;

create or replace function sync_ipo_archive(p_ipo uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_all_resolved boolean;
begin
  select bool_and(
           status = 'NOT_ALLOTTED'
           or (status = 'SOLD' and demat_cut_paid and funder_share_paid)
         )
    into v_all_resolved
  from applications
  where ipo_id = p_ipo;

  -- No applications: nothing to decide here (cron's close-date rule covers it).
  if v_all_resolved is null then
    return;
  end if;

  update ipos
     set is_archived = v_all_resolved
   where id = p_ipo
     and is_archived is distinct from v_all_resolved
     -- An admin kept this one out of Archives on purpose: don't auto-archive.
     and not (v_all_resolved and keep_unarchived);
end;
$$;
revoke execute on function sync_ipo_archive(uuid) from public, anon, authenticated;

create or replace function trg_applications_sync_ipo_archive() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform sync_ipo_archive(old.ipo_id);
    return null;
  end if;
  perform sync_ipo_archive(new.ipo_id);
  if tg_op = 'UPDATE' and old.ipo_id is distinct from new.ipo_id then
    perform sync_ipo_archive(old.ipo_id);
  end if;
  return null;
end;
$$;
revoke execute on function trg_applications_sync_ipo_archive() from public, anon, authenticated;

create trigger trg_applications_sync_ipo_archive
  after insert or delete or update of status, demat_cut_paid, funder_share_paid, ipo_id
  on applications
  for each row execute function trg_applications_sync_ipo_archive();

select cron.schedule(
  'archive-listed-ipos-daily',
  '0 2 * * *',
  $$
  update ipos set is_archived = true
  where not is_archived
    and not keep_unarchived
    and close_date < current_date
    and not exists (select 1 from applications a where a.ipo_id = ipos.id);

  update ipos set is_archived = true
  where not is_archived
    and not keep_unarchived
    and exists (select 1 from applications a where a.ipo_id = ipos.id)
    and not exists (
      select 1 from applications a
      where a.ipo_id = ipos.id
        and not (a.status = 'NOT_ALLOTTED' or (a.status = 'SOLD' and a.demat_cut_paid and a.funder_share_paid))
    );
  $$
);

-- Bring back archived IPOs that still have open work.
update ipos set is_archived = false
where is_archived
  and exists (
    select 1 from applications a
    where a.ipo_id = ipos.id
      and not (a.status = 'NOT_ALLOTTED' or (a.status = 'SOLD' and a.demat_cut_paid and a.funder_share_paid))
  );
