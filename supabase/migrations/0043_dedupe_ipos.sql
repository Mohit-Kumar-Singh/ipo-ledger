-- ============================================================
-- Duplicate IPO rows: the company_name matching in both import paths
-- (IposPage's upsertIpo, auto-import-ipos's upsertCandidate) used a plain
-- case-insensitive `ilike` exact match with no whitespace normalization —
-- if ipoji rendered the same company name with a stray double space or
-- trailing whitespace on a later scrape (or an admin typed a re-import
-- slightly differently), that comparison silently missed and created a
-- second row for the same IPO instead of updating the first. Both call
-- sites now normalize (trim + collapse internal whitespace) before
-- comparing and storing — this migration cleans up rows that already went
-- sideways before that fix.
--
-- Two steps: (1) normalize existing company_name values so post-fix
-- comparisons actually match, then (2) merge any rows that are now exact
-- duplicates — moving their applications onto the row with the most
-- applications already on it (ties broken by earliest created_at, i.e. the
-- original row), then deleting the emptied duplicate(s).
--
-- applications.ipo_id has been `on delete restrict` since 0037, so a
-- duplicate row can only be deleted once every application on it has been
-- moved off — if that move fails (e.g. because the *same* demat account
-- has, unusually, applications recorded on both duplicate rows for the
-- same IPO, which would collide with the (ipo_id, demat_id) unique
-- constraint on the keeper), both the move and the delete are rolled back
-- for that row and it's left in place rather than force-merged, so no
-- application is ever silently dropped. Any such case is reported via
-- RAISE NOTICE for manual admin resolution.
-- ============================================================

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
