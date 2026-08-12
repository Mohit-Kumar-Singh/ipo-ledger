-- ============================================================
-- Extends the daily archive sweep (0038, 0047) with a third rule: an IPO
-- where allotment has actually run (allotment_date has passed) and EVERY
-- application on it came back NOT_ALLOTTED — nothing to track anymore,
-- same "nothing left to do here" logic the zero-applications rule already
-- uses. Requires at least one application to exist (an IPO with zero
-- applications is already caught by the existing close-date rule instead)
-- and every one of them to be NOT_ALLOTTED specifically — an IPO with a
-- mix of NOT_ALLOTTED and APPLIED/ALLOTTED/SOLD stays active, since
-- there's still a live application on it.
-- ============================================================
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
    and allotment_date is not null
    and allotment_date <= current_date
    and exists (select 1 from applications a where a.ipo_id = ipos.id)
    and not exists (
      select 1 from applications a where a.ipo_id = ipos.id and a.status <> 'NOT_ALLOTTED'
    );
  $$
);
