-- ============================================================
-- Bank/UPI accounts can optionally carry their own phone number, so the
-- "applied" notification can go to the bank/UPI holder too, not just the
-- demat account holder — the two are no longer assumed to be the same
-- person now that bank_accounts is decoupled from demat_accounts.
-- ============================================================
alter table bank_accounts add column if not exists phone_e164 text
  check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
