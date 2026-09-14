-- Free-text list of upcoming/watched IPO names a parent company's
-- shareholder quota could apply to — e.g. Coal India shareholders are
-- separately eligible for both an "MCL" and a "SECL" IPO, neither of which
-- may exist as a real ipos row yet (they're being watched for, not applied
-- to). Deliberately a plain text array, not a child table or a link to the
-- ipos table: there's no per-entry metadata beyond the label itself, so a
-- whole table + RLS policy would be pure overhead. This is separate from
-- ipos.parent_company_id (migration 0097), which links a REAL, already-
-- entered IPO row for eligibility lookups once one exists.
alter table parent_companies add column if not exists watched_ipo_names text[] not null default '{}';
