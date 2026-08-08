-- ============================================================
-- 0043 deduped existing rows but didn't stop new duplicates from forming —
-- root cause found: both upsert call sites (IposPage's upsertIpo,
-- auto-import-ipos's upsertCandidate) look up the existing row with
-- `.maybeSingle()`. The moment a company name has TWO matching rows for any
-- reason (e.g. the same company appearing twice in one ipoji scrape batch,
-- racing two concurrent upsert calls that both see "no existing row" before
-- either insert lands), `.maybeSingle()` starts erroring on every future
-- lookup for that name — so `existing` reads as absent forever after, and
-- every subsequent run (the cron fires every 4h) inserts yet another
-- duplicate instead of updating. That's exactly the growth pattern found in
-- prod: LEAP India / Dhoot Transmission / Technocraft Ventures each had a
-- new duplicate appear on nearly every 4-hourly cron run since whenever the
-- first double-insert happened.
--
-- Real fix: a database-level uniqueness guarantee so a duplicate can never
-- be inserted again, regardless of what the application-layer lookup does.
-- Application code (this commit) also stops relying on `.maybeSingle()` and
-- now handles the resulting unique_violation defensively, but the
-- constraint is what actually closes the hole.
-- ============================================================

-- Re-run 0043's normalize-then-merge (idempotent, safe even if nothing to do)
-- in case any duplicates have formed since that migration ran.
update ipos set company_name = regexp_replace(trim(company_name), '\s+', ' ', 'g')
where company_name <> regexp_replace(trim(company_name), '\s+', ' ', 'g');

do $$
declare
  grp record;
  keeper uuid;
  dup_id uuid;
  blocked_names text[] := '{}';
begin
  for grp in
    select lower(company_name) as name_key, array_agg(id) as ids
    from ipos
    group by lower(company_name)
    having count(*) > 1
  loop
    select i.id into keeper
    from ipos i
    left join applications a on a.ipo_id = i.id
    where i.id = any(grp.ids)
    group by i.id
    order by count(a.id) desc, i.created_at asc
    limit 1;

    foreach dup_id in array grp.ids loop
      if dup_id = keeper then continue; end if;

      begin
        update applications set ipo_id = keeper where ipo_id = dup_id;
        delete from ipos where id = dup_id;
      exception when unique_violation then
        blocked_names := array_append(blocked_names, grp.name_key);
      end;
    end loop;
  end loop;

  if array_length(blocked_names, 1) > 0 then
    raise notice 'Could not fully merge duplicate IPOs (a demat account has applications on more than one duplicate row) for: %', blocked_names;
  end if;
end $$;

-- The actual fix: make a second row with the same (case-insensitive) name
-- impossible at the database layer, not just discouraged at the app layer.
create unique index if not exists ipos_company_name_ci_key on ipos (lower(company_name));
