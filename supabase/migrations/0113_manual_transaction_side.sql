-- Which side of the Payouts ledger a manual transaction nets against.
--
-- 0104 picked the side from direction alone: 'from_person' always reduced
-- what that person owes you (holder side), 'to_person' always reduced what
-- you owe them (funder side). That can't express money going BACK on an
-- overpaid balance — a funder returning an overpayment is 'from_person' but
-- belongs on the funder side (it raises what you owe them back to zero),
-- and a refund to an overpaid holder is 'to_person' on the holder side.
--
-- null keeps the old behaviour (the app picks the side from where the person
-- appears, falling back to direction), so every existing row is unchanged.
-- No RLS change: p_manual_transactions_admin already covers every column.
alter table manual_transactions
  add column side text check (side in ('funder', 'holder'));
