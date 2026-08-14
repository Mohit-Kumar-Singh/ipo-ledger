-- New optional, plaintext (deliberately not encrypted/masked like PAN —
-- shown directly, no reveal step) fields on demat_accounts for the actual
-- broker-app login: which app it's for, the email/user id, login password,
-- app-specific password, and transaction PIN. All nullable — existing rows
-- are unaffected.
alter table demat_accounts
  add column application_name text,
  add column login_email text,
  add column login_password text,
  add column app_password text,
  add column t_pin text;

-- Storing real plaintext credentials on this table makes a pre-existing RLS
-- gap actually dangerous, so this closes it as part of the same migration
-- rather than leaving it to a follow-up: p_demat_member_requested (0030)
-- grants a member full SELECT on any demat_accounts row they've ever filed
-- a link request against — PENDING or REJECTED, no admin approval needed.
-- It only exists so "Your requests" can render the account's holder_name
-- before a request is decided, but RLS is row-level, so it hands over the
-- WHOLE row — before this migration that was holder_name/phone/PAN-masked/
-- profit-share (already more than intended, per 0034's identical fix on the
-- funder-visibility path); now it would also hand over these new plaintext
-- credential fields to anyone who merely filed a request, approved or not.
-- Same fix as 0034: drop the row-level grant, resolve the name through the
-- existing narrow resolver instead (resolve_demat_holder_names, already
-- used elsewhere for exactly this "funder/requester only needs a name"
-- case — no new function needed).
drop policy if exists p_demat_member_requested on demat_accounts;

-- Same exact bug, same fix, on the parallel bank_accounts policy
-- (p_bank_member_requested, 0032) — not touched by this migration's new
-- columns, but it's the identical pattern (0057 already flagged bank_accounts'
-- upi_id/phone/bank_name as sensitive on its own), so closing it alongside
-- rather than leaving a known-shape hole sitting right next to the one just
-- fixed above. resolve_bank_holder_names already exists (0057) for the same
-- "requester only needs a name" case.
drop policy if exists p_bank_member_requested on bank_accounts;
