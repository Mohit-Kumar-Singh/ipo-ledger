-- Financial audit finding (P0): settlement_payments had no protection at
-- all against a duplicate insert — no unique constraint beyond the primary
-- key. The UI's own `disabled={saving}` only stops a human double-click; it
-- does nothing for the actual idempotency failure mode a real audit cares
-- about — a request that times out client-side AFTER the insert already
-- committed server-side, or the same admin logging the same real transfer
-- from two open tabs. Either way, a retry created a second, indistinguishable
-- row, silently inflating "Paid" and deflating "Pending"/remainingToFunder —
-- the exact number a WhatsApp message gets built from.
--
-- Fix: a client-generated key, one per log-payment attempt (generated when
-- the form opens, reused across retries of that same attempt, never reused
-- across two distinct payments), unique-constrained here. A retry that
-- reuses the same key hits 23505 instead of creating a duplicate row — same
-- "23505 = already there, not a failure" pattern this app's own ipoji sync
-- already uses for application inserts. Nullable + a PARTIAL unique index
-- (not a NOT NULL column) so this doesn't require a backfill value for any
-- row inserted before the frontend started sending one.
alter table settlement_payments add column idempotency_key uuid;

create unique index settlement_payments_idempotency_key_key
  on settlement_payments (idempotency_key)
  where idempotency_key is not null;
