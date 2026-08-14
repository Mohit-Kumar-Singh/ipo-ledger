-- One more optional plaintext field on demat_accounts, same "shown directly,
-- no reveal step" treatment as the credential fields added in 0066 — free
-- text for noting where/when this account has already been logged into
-- (e.g. "already logged in on Chrome, dad's phone" ) so nobody accidentally
-- re-triggers an OTP/re-login flow on an account that's already signed in
-- somewhere. Nullable — existing rows unaffected.
alter table demat_accounts add column logged_in_notes text;
