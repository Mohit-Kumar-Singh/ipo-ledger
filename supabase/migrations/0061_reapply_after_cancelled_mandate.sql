-- The original (ipo_id, demat_id) unique constraint (0001_init.sql) meant
-- once an account had ANY application on an IPO, it could never get a
-- second one — even after that first application's mandate came back
-- CANCELLED (the funder never actually approved the UPI block, so nothing
-- really happened). The UI already treats a CANCELLED mandate as "this
-- account is free again" everywhere else (Dashboard's "accounts left",
-- Settings' "Cancelled mandates — can reapply" section, and the
-- new-application picker as of the previous fix) — but the database itself
-- still rejected the resulting insert with a 23505 unique_violation the
-- moment someone actually tried it, surfacing as "already applied" even
-- though the picker no longer flagged the account that way.
--
-- Fix: replace the blanket unique constraint with a partial unique index
-- that only counts non-cancelled applications toward the "one per IPO per
-- account" rule. A cancelled row stays in the table (nothing is deleted —
-- same as every other "cancelled but keep the history" pattern in this
-- schema), it just no longer blocks a fresh application for that IPO.
alter table applications drop constraint if exists applications_ipo_id_demat_id_key;

create unique index if not exists applications_ipo_demat_active_key
  on applications (ipo_id, demat_id)
  where mandate_status is distinct from 'CANCELLED';
