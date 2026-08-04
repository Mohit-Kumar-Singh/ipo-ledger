-- ============================================================
-- Auto-archive IPOs 7 days after listing, instead of auto-deleting them.
-- Deleting would either be blocked by applications_ipo_id_fkey (0037, once
-- applications exist on it) or, if forced through some other path, leave
-- applications pointing at a gone IPO — company_name/listing_date etc. are
-- always pulled live via join, never copied onto the application row, so a
-- deleted IPO means those applications render broken everywhere (Applications
-- page, Allotment board, Dashboard). Archiving instead just hides the IPO
-- from the main list — the row (and every application on it) stays exactly
-- as functional as before, permanently, no matter how old it gets.
-- ============================================================
alter table ipos add column is_archived boolean not null default false;

-- Runs once a day rather than on the same 4h cadence as auto-import-ipos
-- (0009) — this only needs to catch a date rollover, not fresh scrape data.
-- Pure SQL, no pg_net/Edge Function needed (unlike auto-import-ipos), since
-- there's no external call to make.
select cron.schedule(
  'archive-listed-ipos-daily',
  '0 2 * * *',
  $$
  update ipos set is_archived = true
  where not is_archived
    and listing_date is not null
    and listing_date <= current_date - 7;
  $$
);
