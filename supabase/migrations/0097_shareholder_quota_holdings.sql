-- Reusable master list of listed parent/associate companies whose existing
-- shareholders get a quota in a future IPO (e.g. Coal India shareholders
-- getting a CMPDI quota) — distinct from ipos.parent_company_name/
-- parent_company_symbol (0077), which are free-text, re-typed per IPO, and
-- stay purely cosmetic. This table is the actual reusable entity: add a
-- company once, then any IPO can point at it via ipos.parent_company_id
-- below, and any account holder's purchase of its shares (below) carries
-- forward to every future IPO with the same parent.
create table parent_companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  symbol      text,                     -- NSE symbol, feeds the existing fetch-stock-price live quote
  notes       text,
  created_at  timestamptz not null default now()
);
alter table parent_companies enable row level security;
create policy p_parent_companies_admin on parent_companies for all
  using (is_admin()) with check (is_admin());

create type holding_stat as enum ('HELD', 'SOLD');

-- One row per purchase lot (not one row per holder-company pair) — the same
-- holder can buy the same company's shares in separate batches at different
-- prices, and each needs its own buy price / P&L, same reasoning as
-- application_sells being tranche-based rather than one aggregate row.
create table parent_company_holdings (
  id                uuid primary key default gen_random_uuid(),
  parent_company_id uuid not null references parent_companies(id) on delete cascade,
  demat_id          uuid not null references demat_accounts(id),
  quantity          int not null check (quantity > 0),
  buy_price         numeric(12,2) not null check (buy_price >= 0),
  -- Who paid for this purchase. Null = the demat holder bought it with
  -- their own money (self-funded) — same convention as
  -- applications.bank_account_id.
  funder_id         uuid references bank_accounts(id),
  -- Only meaningful when this lot is self-funded (funder_id is null): names
  -- someone who covers a LOSS on it despite not having funded it (e.g. the
  -- holder bought on the admin's instruction with their own money, but the
  -- admin still owes them if it drops). Deliberately asymmetric — this
  -- field only ever redirects a LOSS, never a gain; a profit on a
  -- self-funded lot always stays with the holder regardless of this field.
  -- See lib/parentCompanyPnl.ts for the attribution logic that reads it.
  loss_bearer_id    uuid references bank_accounts(id),
  status            holding_stat not null default 'HELD',
  sell_price        numeric(12,2),
  created_at        timestamptz not null default now(),
  check (status = 'SOLD' or sell_price is null)
);
alter table parent_company_holdings enable row level security;
create policy p_parent_company_holdings_admin on parent_company_holdings for all
  using (is_admin()) with check (is_admin());

-- Lets an IPO reference a REUSABLE parent company for shareholder-quota
-- eligibility lookups (who already holds shares of it, via
-- parent_company_holdings above) — independent of the free-text
-- parent_company_name/symbol (0077), which stays exactly as-is for display.
-- Nullable: most IPOs have no shareholder quota at all.
alter table ipos add column if not exists parent_company_id uuid references parent_companies(id);

-- Broadens the "one active application per (ipo, demat, funder)" rule
-- (0070_multiple_funders_per_application) to also allow a second row when
-- the CATEGORY differs — e.g. the same demat account applying once under
-- RETAIL and once under SHAREHOLDER quota for the same IPO, funded via the
-- same UPI. SHAREHOLDER has been a selectable category in ApplicationsPage's
-- add-application form since the original schema (0001), but inserting that
-- second row for an account that already has an active RETAIL application
-- (funded the same way) hit the old index and failed with a 23505
-- unique_violation — this is what actually unblocks the feature this
-- migration otherwise just supports the data model for.
drop index if exists applications_ipo_demat_bank_active_key;
create unique index if not exists applications_ipo_demat_bank_category_active_key
  on applications (ipo_id, demat_id, coalesce(bank_account_id, '00000000-0000-0000-0000-000000000000'::uuid), category)
  where mandate_status is distinct from 'CANCELLED';

-- Exposes category on the board so a SHAREHOLDER application can actually be
-- told apart from a RETAIL one on screen — today category is written and
-- readable but never surfaced anywhere in the UI. Appended at the end of the
-- select list per the existing convention (0090): create or replace view can
-- add columns but not reorder/retype existing ones (0088 hit 42P16 doing that).
create or replace view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       get_demat_holder_name(a.demat_id) as holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4,
       a.lots, a.bid_amount, a.status,
       b.upi_id, b.account_holder_name as bank_account_holder_name,
       get_demat_profit_share_percent(a.demat_id)::numeric(5,2) as profit_share_percent,
       a.sell_price, i.lot_size,
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
       get_demat_account_manager_id(a.demat_id) as account_manager_id,
       m.full_name as account_manager_name,
       m.phone_e164 as account_manager_phone,
       m.case_type as account_manager_case_type,
       b.linked_user_id as bank_account_linked_user_id,
       a.category
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id)
left join account_managers m on m.id = get_demat_account_manager_id(a.demat_id);
