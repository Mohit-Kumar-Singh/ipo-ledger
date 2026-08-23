-- Financial audit finding (P2): an admin could edit applications.sell_price
-- (after marking something SOLD) or demat_accounts.profit_share_percent at
-- any time, and the previous value was simply gone — overwritten, not
-- versioned. mandate_status at least records who/when via
-- mandate_marked_by/mandate_marked_at; the two fields that actually drive
-- every profit figure in the app had nothing. Not a full audit-log
-- framework — just enough to answer "what did this used to say, and when
-- did it change" for the two columns that matter.
create table financial_change_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid not null,
  column_name text not null,
  old_value text,
  new_value text,
  changed_by uuid references profiles(id),
  changed_at timestamptz not null default now()
);

create index idx_financial_change_log_row on financial_change_log (table_name, row_id);

alter table financial_change_log enable row level security;

-- Admin-only, same reasoning settlement_payments (0078) already uses: this
-- is an internal ledger, never shown to a holder/funder directly. No
-- insert/update/delete policy for any role — the log is only ever written
-- by the trigger function below, which is security definer and bypasses
-- RLS on its own writes.
create policy p_financial_change_log_admin on financial_change_log for select
  using (is_admin());

-- One shared trigger function for both watched columns, dispatching on
-- TG_TABLE_NAME — a single AFTER UPDATE trigger per table (fired only when
-- the specific column actually changed, via "update of <col>"), not a
-- generic all-columns diff. auth.uid() still resolves to the real calling
-- user here even under security definer — that's a session-level GUC
-- PostgREST sets per request, unaffected by the role switch security
-- definer does for privilege checks.
create or replace function log_financial_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_TABLE_NAME = 'applications' then
    if OLD.sell_price is distinct from NEW.sell_price then
      insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
      values ('applications', NEW.id, 'sell_price', OLD.sell_price::text, NEW.sell_price::text, auth.uid());
    end if;
  elsif TG_TABLE_NAME = 'demat_accounts' then
    if OLD.profit_share_percent is distinct from NEW.profit_share_percent then
      insert into financial_change_log (table_name, row_id, column_name, old_value, new_value, changed_by)
      values ('demat_accounts', NEW.id, 'profit_share_percent', OLD.profit_share_percent::text, NEW.profit_share_percent::text, auth.uid());
    end if;
  end if;
  return NEW;
end;
$$;
revoke execute on function log_financial_change() from public, anon, authenticated;

create trigger trg_log_sell_price_change
  after update of sell_price on applications
  for each row execute function log_financial_change();

create trigger trg_log_profit_share_change
  after update of profit_share_percent on demat_accounts
  for each row execute function log_financial_change();
