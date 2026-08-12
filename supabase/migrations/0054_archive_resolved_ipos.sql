-- ============================================================
-- Broadens the "nothing left to do here" archive rule (0052) to match the
-- app's own new real-time check (maybeAutoArchiveIpo, called the instant an
-- admin marks the last application not-allotted or the last payout paid):
-- an IPO archives once EVERY application on it is either NOT_ALLOTTED, or
-- SOLD with both payout flags settled — no longer gated on allotment_date
-- having passed, since an IPO where every application is already resolved
-- obviously already had its allotment run regardless of what date is on
-- file for it.
--
-- Also does the catch-up once here, immediately, rather than waiting for
-- the nightly 2am run — an IPO an admin already fully resolved before this
-- migration shipped (e.g. marked NOT_ALLOTTED on every application) moves
-- to archive right away instead of sitting there another day.
-- ============================================================
update ipos set is_archived = true
where not is_archived
  and exists (select 1 from applications a where a.ipo_id = ipos.id)
  and not exists (
    select 1 from applications a
    where a.ipo_id = ipos.id
      and not (a.status = 'NOT_ALLOTTED' or (a.status = 'SOLD' and a.demat_cut_paid and a.funder_share_paid))
  );

select cron.schedule(
  'archive-listed-ipos-daily',
  '0 2 * * *',
  $$
  update ipos set is_archived = true
  where not is_archived
    and listing_date is not null
    and listing_date <= current_date - 7;

  update ipos set is_archived = true
  where not is_archived
    and close_date < current_date
    and not exists (select 1 from applications a where a.ipo_id = ipos.id);

  update ipos set is_archived = true
  where not is_archived
    and exists (select 1 from applications a where a.ipo_id = ipos.id)
    and not exists (
      select 1 from applications a
      where a.ipo_id = ipos.id
        and not (a.status = 'NOT_ALLOTTED' or (a.status = 'SOLD' and a.demat_cut_paid and a.funder_share_paid))
    );
  $$
);
