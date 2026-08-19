-- "Shared accounts" — a demat account someone else (Person X / Person Y)
-- sourced, that you manage/apply for, with a profit split going to that
-- person instead of (or in addition to) a normal funder. Two real cases:
--
--   CASE_1 — X provided the account, you fund it (yours or a funder's
--   money). X gets a cut (e.g. 40%, already covering their own tax), a
--   separate funder still gets a share, you keep the rest. This is exactly
--   the app's existing 3-way computeProfitSplit (demat-cut / funder / admin)
--   — X just replaces the literal PAN holder as the cut's real recipient and
--   contact.
--
--   CASE_2 — Y provided the account AND funds it with their own UPI. Y gets
--   a bigger cut (e.g. 70%) covering both the account-holder and funder
--   roles combined; there's no separate third-party funder to split with.
--
-- account_managers is a new, distinct identity table (not reusing
-- bank_accounts) — a manager isn't necessarily a funder on any given
-- application and needs their own case/cut/tax bookkeeping fields a funder
-- row has no use for. cut_percent gets copied onto each assigned
-- demat_accounts.profit_share_percent at assignment time (see the app's own
-- write path), so every existing computeProfitSplit call site keeps working
-- unchanged — the override that IS new is who the money/message actually
-- routes to, which downstream code resolves via account_manager_id.
create table account_managers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone_e164 text,
  upi_id text,
  case_type text not null check (case_type in ('CASE_1', 'CASE_2')),
  cut_percent numeric not null check (cut_percent >= 0 and cut_percent <= 100),
  -- Sub-portion of cut_percent that's tax, for bookkeeping display only —
  -- never subtracted a second time in the actual payout math, which only
  -- ever uses cut_percent as a whole.
  tax_percent numeric check (tax_percent is null or (tax_percent >= 0 and tax_percent <= 100)),
  -- Portal login for this person, set directly by an admin picking an
  -- existing signed-up profile (not a self-service request/approve flow
  -- like demat/bank linking — deliberately simpler for this first version).
  linked_user_id uuid references profiles(id),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table account_managers enable row level security;

create policy p_account_managers_admin on account_managers for all
  using (is_admin()) with check (is_admin());

-- A linked manager can see their own row (name/cut/case/etc.) — doesn't read
-- any other RLS-enabled table, so no cycle risk.
create policy p_account_managers_self on account_managers for select
  using (linked_user_id = auth.uid());

alter table demat_accounts add column account_manager_id uuid references account_managers(id);

-- Same reasoning/pattern as is_funder_of_demat (0033) — a direct policy on
-- demat_accounts/applications reading account_managers (which itself doesn't
-- read back into demat_accounts/applications) wouldn't actually cycle here,
-- but routing through a security definer helper keeps the pattern consistent
-- and makes a future change to either side safe by construction rather than
-- by accident.
create or replace function is_manager_of_demat(p_demat_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from demat_accounts d
    join account_managers m on m.id = d.account_manager_id
    where d.id = p_demat_id and m.linked_user_id = auth.uid()
  );
$$;
revoke execute on function is_manager_of_demat(uuid) from public, anon;
grant execute on function is_manager_of_demat(uuid) to authenticated;

-- Read-only — a manager reviews their accounts/applications, same as a
-- funder does today; only the account's real owner or an admin can write.
create policy p_demat_member_manager on demat_accounts for select
  using (is_manager_of_demat(demat_accounts.id));

create policy p_apps_member_manager_select on applications for select
  using (is_manager_of_demat(applications.demat_id));

-- Surface manager identity on the board so Payouts/AllotmentBoard/Dashboard
-- can route messages and payout math to the manager instead of the literal
-- holder, without a second round trip. security_invoker view, same as
-- before — RLS on the underlying tables still applies per querying user.
create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       get_demat_holder_name(a.demat_id) as holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name,
       d.profit_share_percent, a.sell_price, i.lot_size,
       a.split_profit_with_funder, a.demat_cut_paid, a.funder_share_paid,
       b.phone_e164 as bank_account_phone,
       a.mandate_status,
       i.is_archived as ipo_is_archived,
       a.funder_override_id is not null as is_funder_override,
       i.close_date,
       d.linked_user_id as demat_linked_user_id,
       a.status_changed_at,
       i.gmp_notes,
       d.platform,
       d.account_manager_id,
       m.full_name as account_manager_name,
       m.phone_e164 as account_manager_phone,
       m.case_type as account_manager_case_type
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id)
left join account_managers m on m.id = d.account_manager_id;
