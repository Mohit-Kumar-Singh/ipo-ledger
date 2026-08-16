-- SCAFFOLD ONLY (not yet wired to anything). A place to persist the results
-- of automated allotment checks so we can build the "flag likely allotments
-- instead of marking each by hand" feature later on top of real captured
-- data. The intended flow (future work):
--   1. A cron Edge Function, per live IPO past its allotment_date, queries the
--      registrar's allotment-status page (or ipoji) for each applied PAN/
--      demat — the same scraping approach _shared/ipoji.ts already uses.
--   2. Each check writes one row here: what was queried, what the source
--      returned (raw, for re-parsing when heuristics improve), a detected
--      status + a confidence score.
--   3. The Allotment board surfaces high-confidence detections as a
--      one-tap "accept" instead of the admin marking ALLOTTED/NOT_ALLOTTED
--      by hand; accepting flips applications.status and sets
--      applied_to_board = true here for an audit trail.
-- Nothing reads/writes this table yet; it exists so future polling has a
-- durable home and we accumulate history from day one.
create table allotment_auto_checks (
  id                uuid primary key default gen_random_uuid(),
  ipo_id            uuid references ipos(id) on delete cascade,
  application_id    uuid references applications(id) on delete set null,
  demat_id          uuid references demat_accounts(id) on delete set null,
  registrar         text,
  source            text,          -- 'registrar' | 'ipoji' | ...
  pan_masked        text,          -- which identifier was queried (masked, never raw PAN)
  detected_status   text,          -- 'ALLOTTED' | 'NOT_ALLOTTED' | 'UNKNOWN'
  confidence        numeric,       -- 0..1 heuristic score
  raw               jsonb,         -- exactly what the source returned, for later re-parsing
  applied_to_board  boolean not null default false,  -- an admin accepted this into applications.status
  checked_at        timestamptz not null default now()
);
create index on allotment_auto_checks (ipo_id);
create index on allotment_auto_checks (application_id);

alter table allotment_auto_checks enable row level security;

-- Admin-only, full stop — this is operational/audit data across every
-- account, same scope as the allotment board itself. No cross-table read in
-- the policy, so no RLS cycle; is_admin() is the whole boundary.
create policy p_allotment_checks_admin on allotment_auto_checks for all
  using (is_admin()) with check (is_admin());
