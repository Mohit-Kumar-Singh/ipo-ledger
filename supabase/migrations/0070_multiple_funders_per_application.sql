-- Allows a demat account to have more than one ACTIVE (non-cancelled)
-- application on the same IPO, as long as each is funded via a different
-- bank/UPI account — e.g. someone genuinely bid twice for the same IPO
-- through two different funders, both "Accepted by Investor" on ipoji.
-- Real case this was built for: ipoji reported two fully-accepted
-- application entries for the same demat holder on the same IPO, each
-- through a different UPI — the OLD partial unique index (0061, one active
-- application per (ipo_id, demat_id)) made it structurally impossible to
-- import the second one at all; it silently had to be dropped or would
-- collide as an "update" on the first.
--
-- Still blocks the case that index was originally protecting against: two
-- applications for the same account+IPO funded via the SAME bank/UPI
-- account (or both genuinely self-funded, no bank account at all) — that's
-- still almost certainly an accidental double-entry, not two real bids.
-- coalesce() over bank_account_id, not a bare column reference — Postgres
-- treats every NULL in a unique index as distinct from every other NULL, so
-- without it two self-funded (null bank_account_id) rows for the same
-- account+IPO would've silently been allowed to duplicate, which is exactly
-- the accidental-double-entry case this still needs to catch.
drop index if exists applications_ipo_demat_active_key;

create unique index if not exists applications_ipo_demat_bank_active_key
  on applications (ipo_id, demat_id, coalesce(bank_account_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where mandate_status is distinct from 'CANCELLED';
