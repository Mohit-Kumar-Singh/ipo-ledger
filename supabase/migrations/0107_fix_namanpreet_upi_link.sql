-- Data fix: the UPI Namanpreetsingh.m12@okicici (bank_accounts 5cea036f…,
-- holder "Naman") was linked to Mohit Singh's login instead of Namanpreet
-- Singh's, so every application funded from it (5 on HD Fire Protect, plus
-- Moneyview / Lalithaa) credited the funder as Mohit on the dashboard and
-- Namanpreet never showed up. A duplicate row for the same UPI
-- (d5b7873d…, unused) was already linked to Namanpreet correctly.
--
-- Scoped to that one row and guarded on its current wrong link, so it is a
-- no-op if someone already corrected it by hand.
update bank_accounts
set linked_user_id = '460cfd52-0f46-4054-bb69-cd9cc72fc297',
    account_holder_name = 'Namanpreet'
where id = '5cea036f-2abd-4234-8985-20f256f71fc3'
  and linked_user_id = 'a01984f9-5ac9-4cff-917e-05dafcc59796';
