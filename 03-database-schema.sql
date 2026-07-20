-- ============================================================
-- IPO Ledger Portal — Postgres schema (Supabase)
-- Version 1.0 — run as a Supabase migration
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- enums ----------
create type user_role        as enum ('admin','member');
create type application_cat  as enum ('RETAIL','SHNI','BHNI','SHAREHOLDER','EMPLOYEE');
create type application_stat as enum ('APPLIED','ALLOTTED','NOT_ALLOTTED','SOLD');
create type registrar_t      as enum ('MUFG_INTIME','KFINTECH','BIGSHARE','CAMEO','SKYLINE','MAASHITLA','OTHER');
create type notif_type       as enum ('APPLIED','ALLOTTED','SELL_REMINDER','CUSTOM');
create type notif_status     as enum ('QUEUED','SENT','DELIVERED','READ','FAILED');

-- ---------- profiles (1:1 with auth.users) ----------
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  role        user_role not null default 'member',
  created_at  timestamptz not null default now()
);

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- demat accounts ----------
create table demat_accounts (
  id              uuid primary key default gen_random_uuid(),
  holder_name     text not null,
  phone_e164      text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  pan_encrypted   bytea not null,                        -- pgp_sym_encrypt(pan, key)
  pan_masked      text  not null,                        -- e.g. 'ABCPK****F'
  pan_hash        text  not null,                        -- sha256(pan) for uniqueness w/o decryption
  broker          text,
  dp_client_id    text,
  linked_user_id  uuid references profiles(id),          -- member login, nullable until invited
  notes           text,
  created_at      timestamptz not null default now(),
  unique (pan_hash)
);

create table bank_accounts (
  id          uuid primary key default gen_random_uuid(),
  demat_id    uuid not null references demat_accounts(id) on delete cascade,
  bank_name   text not null,
  last4       text not null check (last4 ~ '^[0-9]{4}$'),
  upi_id      text,
  is_default  boolean not null default false
);

-- ---------- IPO master ----------
create table ipos (
  id             uuid primary key default gen_random_uuid(),
  company_name   text not null,
  symbol         text,
  exchange       text default 'NSE,BSE',
  price_low      numeric(12,2),
  price_high     numeric(12,2),
  lot_size       int  not null check (lot_size > 0),
  open_date      date not null,
  close_date     date not null,
  allotment_date date,
  listing_date   date,
  registrar      registrar_t not null default 'OTHER',
  registrar_url  text,
  gmp_notes      text,
  created_at     timestamptz not null default now(),
  check (close_date >= open_date)
);

-- ---------- applications ----------
create table applications (
  id               uuid primary key default gen_random_uuid(),
  ipo_id           uuid not null references ipos(id) on delete cascade,
  demat_id         uuid not null references demat_accounts(id),
  bank_account_id  uuid references bank_accounts(id),
  category         application_cat not null default 'RETAIL',
  lots             int not null check (lots > 0),
  bid_amount       numeric(14,2),
  status           application_stat not null default 'APPLIED',
  applied_at       timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  changed_by       uuid references profiles(id),
  sell_price       numeric(12,2),        -- filled when SOLD (phase 4)
  unique (ipo_id, demat_id)              -- one application per PAN per IPO
);

create or replace function touch_status() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
    new.changed_by := auth.uid();
  end if;
  return new;
end $$;
create trigger trg_app_status before update on applications
for each row execute function touch_status();

-- ---------- notifications ----------
create table notifications (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid references applications(id) on delete set null,
  demat_id        uuid references demat_accounts(id),
  type            notif_type not null,
  to_phone        text not null,
  template_name   text not null,
  variables       jsonb not null default '{}',
  wa_message_id   text,
  status          notif_status not null default 'QUEUED',
  error_detail    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on notifications (status);
create index on notifications (application_id);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table profiles       enable row level security;
alter table demat_accounts enable row level security;
alter table bank_accounts  enable row level security;
alter table ipos           enable row level security;
alter table applications   enable row level security;
alter table notifications  enable row level security;

-- profiles: users see themselves; admin sees all
create policy p_profiles_self   on profiles for select using (id = auth.uid() or is_admin());
create policy p_profiles_admin  on profiles for all    using (is_admin()) with check (is_admin());

-- demat_accounts: admin full; member sees own linked accounts
create policy p_demat_admin  on demat_accounts for all
  using (is_admin()) with check (is_admin());
create policy p_demat_member on demat_accounts for select
  using (linked_user_id = auth.uid());

-- bank_accounts: follow parent demat visibility
create policy p_bank_admin  on bank_accounts for all
  using (is_admin()) with check (is_admin());
create policy p_bank_member on bank_accounts for select
  using (exists (select 1 from demat_accounts d
                 where d.id = demat_id and d.linked_user_id = auth.uid()));

-- ipos: any signed-in user can read; only admin writes
create policy p_ipos_read  on ipos for select using (auth.uid() is not null);
create policy p_ipos_admin on ipos for all    using (is_admin()) with check (is_admin());

-- applications: admin full; member sees own
create policy p_apps_admin  on applications for all
  using (is_admin()) with check (is_admin());
create policy p_apps_member on applications for select
  using (exists (select 1 from demat_accounts d
                 where d.id = demat_id and d.linked_user_id = auth.uid()));

-- notifications: admin full; member sees messages sent to them
create policy p_notif_admin  on notifications for all
  using (is_admin()) with check (is_admin());
create policy p_notif_member on notifications for select
  using (exists (select 1 from demat_accounts d
                 where d.id = demat_id and d.linked_user_id = auth.uid()));

-- ============================================================
-- Seed: registrar allotment-check URLs (verify before go-live)
-- ============================================================
create table registrar_links (
  registrar registrar_t primary key,
  check_url text not null
);
insert into registrar_links values
 ('MUFG_INTIME','https://in.mpms.mufg.com/Initial_Offer/public-issues.html'),
 ('KFINTECH',   'https://ipostatus.kfintech.com/'),
 ('BIGSHARE',   'https://ipo.bigshareonline.com/ipo_status.html'),
 ('CAMEO',      'https://ipo.cameoindia.com/'),
 ('SKYLINE',    'https://www.skylinerta.com/ipo.php'),
 ('MAASHITLA',  'https://maashitla.com/allotment-status/public-issues');
alter table registrar_links enable row level security;
create policy p_reg_read on registrar_links for select using (auth.uid() is not null);
create policy p_reg_admin on registrar_links for all using (is_admin()) with check (is_admin());

-- ============================================================
-- Helper view: allotment workday
-- ============================================================
create view v_allotment_board with (security_invoker = true) as
select a.id as application_id, a.ipo_id, a.demat_id, i.company_name, i.listing_date,
       d.holder_name, d.pan_masked, d.phone_e164,
       b.bank_name, b.last4, a.lots, a.bid_amount, a.status
from applications a
join ipos i on i.id = a.ipo_id
join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = a.bank_account_id;
