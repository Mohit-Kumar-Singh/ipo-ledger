-- Per-application settlement transaction ledger for SOLD applications —
-- replaces the implicit "one lump payment, all-or-nothing" assumption
-- behind applications.demat_cut_paid/funder_share_paid with a real log of
-- individual money movements, so partial payments and the three different
-- routes money can actually take are all trackable:
--
--   holder_to_admin  — the account holder paid the managing person (you).
--   admin_to_funder  — you forwarded money on to the funder.
--   holder_to_funder — the holder paid the funder directly, bypassing you
--                      entirely (you told them to pay the funder's UPI
--                      themselves instead of routing it through you).
--
-- "How much do I still need to send the funder" for one application is then
-- amountToFunder (computed client-side by computeProfitSplit, same as
-- today) minus the sum of that application's admin_to_funder AND
-- holder_to_funder rows — a holder_to_funder payment reduces what's owed
-- out just as much as one you forwarded yourself, since either way the
-- funder actually has the money now.
create type settlement_payment_kind as enum ('holder_to_admin', 'admin_to_funder', 'holder_to_funder');

create table settlement_payments (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references applications(id) on delete cascade,
  kind            settlement_payment_kind not null,
  amount          numeric not null check (amount > 0),
  note            text,
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now()
);

create index idx_settlement_payments_application_id on settlement_payments(application_id);

alter table settlement_payments enable row level security;

-- Admin-only, full stop — same reasoning as sell_instruction_pdfs (0075):
-- Payouts is already an admin-only page (PayoutsPage.tsx gates on
-- profile.role === 'admin' before rendering anything), and this ledger only
-- ever needs to be read/written from there. No member policy exists on
-- purpose — a holder or funder never sees this table directly, only
-- whatever the admin chooses to tell them via the existing WhatsApp
-- messaging flow. Doesn't read any other RLS-enabled table's rows itself
-- (is_admin() is stable security definer), so no cross-table policy cycle.
create policy p_settlement_payments_admin on settlement_payments for all
  using (is_admin()) with check (is_admin());
