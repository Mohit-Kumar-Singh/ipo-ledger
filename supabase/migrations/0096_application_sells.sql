-- Partial-sell ledger. Until now an application was all-or-nothing: one
-- applications.sell_price, status jumping straight ALLOTTED -> SOLD. In
-- practice a holder often sells only some of the allotted shares on listing
-- day and trades the rest over the following days/weeks, so the remainder
-- keeps moving with the market inside their demat account.
--
-- application_sells records each individual sell (a "tranche"): share count,
-- price, date. Triggers keep applications.status / applications.sell_price in
-- sync so every EXISTING profit/payout/settlement consumer keeps working
-- unchanged:
--   * 0 shares sold                -> status ALLOTTED,       sell_price null
--   * some but not all sold        -> status PARTIALLY_SOLD, sell_price null
--   * all allotted shares sold     -> status SOLD,           sell_price =
--                                     weighted-average tranche price
-- While PARTIALLY_SOLD, sell_price stays null on purpose — the existing
-- computeProfitSplit-based math multiplies sell_price by the FULL allotted
-- quantity, which would overstate a partial realization. Per-tranche
-- realized profit is computed client-side in lib/partialSells.ts by
-- prorating bid_amount over the tranche's shares.
--
-- The legacy direct "Mark sold" path on the allotment board (writes
-- status='SOLD' + sell_price straight onto applications) is untouched and
-- still valid — it just leaves application_sells empty, and every downstream
-- calc still reads sell_price exactly as before.
--
-- Personal/family bookkeeping tool. Not audited-grade accounting.

create table application_sells (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references applications(id) on delete cascade,
  shares          int not null check (shares > 0),
  price           numeric(12,2) not null check (price > 0),  -- rupees per share
  sold_on         date not null default current_date,
  note            text,
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_application_sells_application_id on application_sells(application_id);

-- ---------- guard: a tranche must fit, and only against a live allotment ----------
create or replace function check_application_sell() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_status   application_stat;
  v_allotted int;
  v_already  int;
begin
  select a.status, a.lots * i.lot_size
    into v_status, v_allotted
  from applications a
  join ipos i on i.id = a.ipo_id
  where a.id = new.application_id;

  if not found then
    raise exception 'application % not found', new.application_id using errcode = 'P0002';
  end if;
  if v_status not in ('ALLOTTED', 'PARTIALLY_SOLD', 'SOLD') then
    raise exception 'cannot record a sell against a % application', v_status using errcode = 'P0001';
  end if;

  select coalesce(sum(shares), 0) into v_already
  from application_sells
  where application_id = new.application_id
    and id is distinct from new.id;   -- exclude the row being updated, if any

  if v_already + new.shares > v_allotted then
    raise exception
      'sell of % shares exceeds the % still unsold (allotted %, already recorded %)',
      new.shares, v_allotted - v_already, v_allotted, v_already
      using errcode = 'P0001';
  end if;

  return new;
end $$;

create trigger trg_check_application_sell
  before insert or update on application_sells
  for each row execute function check_application_sell();

-- ---------- sync: recompute the parent application's status + sell_price ----------
create or replace function sync_application_sold_state() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_app      uuid := coalesce(new.application_id, old.application_id);
  v_ipo      uuid;
  v_allotted int;
  v_sold     int;
  v_amount   numeric;
  v_next     application_stat;
  v_price    numeric;
begin
  select a.ipo_id, a.lots * i.lot_size
    into v_ipo, v_allotted
  from applications a
  join ipos i on i.id = a.ipo_id
  where a.id = v_app;

  if not found then           -- parent already gone (cascade delete)
    return null;
  end if;

  select coalesce(sum(shares), 0), coalesce(sum(shares * price), 0)
    into v_sold, v_amount
  from application_sells
  where application_id = v_app;

  if v_sold <= 0 then
    v_next := 'ALLOTTED';
    v_price := null;
  elsif v_sold >= v_allotted then
    v_next := 'SOLD';
    v_price := round(v_amount / v_sold, 2);   -- weighted-average realized price
  else
    v_next := 'PARTIALLY_SOLD';
    v_price := null;
  end if;

  update applications
     set status = v_next,
         sell_price = v_price
   where id = v_app
     and (status is distinct from v_next or sell_price is distinct from v_price);

  perform sync_ipo_archive(v_ipo);
  return null;
end $$;

create trigger trg_sync_application_sold_state
  after insert or update or delete on application_sells
  for each row execute function sync_application_sold_state();

-- ---------- RLS ----------
alter table application_sells enable row level security;

-- Mirrors who can see the parent application itself (admin; the demat
-- holder; the funder via bank_account_id or funder_override_id). All three
-- reads happen inside this `security definer` helper, which bypasses RLS on
-- applications/demat_accounts/bank_accounts — and nothing reads
-- application_sells from inside a policy — so there is no policy cycle of
-- the kind 0033 had to unwind.
create or replace function can_see_application(p_app uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select
    is_admin()
    or exists (
      select 1 from applications a
      join demat_accounts d on d.id = a.demat_id
      where a.id = p_app and d.linked_user_id = auth.uid()
    )
    or exists (
      select 1 from applications a
      join bank_accounts b on b.id = a.bank_account_id
      where a.id = p_app and b.linked_user_id = auth.uid()
    )
    or exists (
      select 1 from applications a
      join bank_accounts b on b.id = a.funder_override_id
      where a.id = p_app and b.linked_user_id = auth.uid()
    );
$$;
revoke execute on function can_see_application(uuid) from public, anon;
grant execute on function can_see_application(uuid) to authenticated;

create policy p_app_sells_admin on application_sells for all
  using (is_admin()) with check (is_admin());

create policy p_app_sells_viewer on application_sells for select
  using (can_see_application(application_id));

-- ---------- write RPCs (admin-only, audited like settlement_payments) ----------
create or replace function add_application_sell(
  p_application_id uuid,
  p_shares int,
  p_price numeric,
  p_sold_on date,
  p_note text
) returns application_sells
language plpgsql security definer set search_path = public as $$
declare
  v_row application_sells;
begin
  if not is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  insert into application_sells (application_id, shares, price, sold_on, note, created_by)
  values (p_application_id, p_shares, p_price, coalesce(p_sold_on, current_date), p_note, auth.uid())
  returning * into v_row;

  insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
  values ('application_sells', v_row.id, 'created', null, to_jsonb(v_row)::text, auth.uid());

  return v_row;
end $$;
revoke execute on function add_application_sell(uuid, int, numeric, date, text) from public, anon;
grant execute on function add_application_sell(uuid, int, numeric, date, text) to authenticated;

create or replace function update_application_sell(
  p_id uuid,
  p_shares int,
  p_price numeric,
  p_sold_on date,
  p_note text
) returns application_sells
language plpgsql security definer set search_path = public as $$
declare
  v_old application_sells;
  v_new application_sells;
begin
  if not is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_old from application_sells where id = p_id;
  if not found then
    raise exception 'application sell % not found', p_id using errcode = 'P0002';
  end if;

  update application_sells
     set shares = p_shares,
         price = p_price,
         sold_on = coalesce(p_sold_on, sold_on),
         note = p_note,
         updated_at = now()
   where id = p_id
   returning * into v_new;

  if v_old.shares is distinct from v_new.shares then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('application_sells', p_id, 'shares', v_old.shares::text, v_new.shares::text, auth.uid());
  end if;
  if v_old.price is distinct from v_new.price then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('application_sells', p_id, 'price', v_old.price::text, v_new.price::text, auth.uid());
  end if;
  if v_old.sold_on is distinct from v_new.sold_on then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('application_sells', p_id, 'sold_on', v_old.sold_on::text, v_new.sold_on::text, auth.uid());
  end if;
  if v_old.note is distinct from v_new.note then
    insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
    values ('application_sells', p_id, 'note', v_old.note, v_new.note, auth.uid());
  end if;

  return v_new;
end $$;
revoke execute on function update_application_sell(uuid, int, numeric, date, text) from public, anon;
grant execute on function update_application_sell(uuid, int, numeric, date, text) to authenticated;

create or replace function delete_application_sell(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_old application_sells;
begin
  if not is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_old from application_sells where id = p_id;
  if not found then
    raise exception 'application sell % not found', p_id using errcode = 'P0002';
  end if;

  delete from application_sells where id = p_id;

  insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
  values ('application_sells', p_id, 'deleted', to_jsonb(v_old)::text, null, auth.uid());
end $$;
revoke execute on function delete_application_sell(uuid) from public, anon;
grant execute on function delete_application_sell(uuid) to authenticated;

-- ---------- realtime, so the board / holdings view update live ----------
alter publication supabase_realtime add table application_sells;
