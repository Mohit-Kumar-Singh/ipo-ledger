-- Parent-company info for IPOs with a shareholder quota (e.g. CMPDI's quota
-- for existing Coal India shareholders) — ipoji has no concept of "which
-- listed company this refers to", so this is manual/admin-entered, same
-- pattern as shareholder_issue_size itself (0039).
alter table ipos add column if not exists parent_company_name text;
alter table ipos add column if not exists parent_company_symbol text; -- NSE symbol, e.g. 'COALINDIA'

-- Cache for the fetch-stock-price edge function so every card view doesn't
-- hit the upstream quote API directly, and so a failed live fetch still has
-- a stale-but-present fallback instead of showing nothing.
create table if not exists stock_price_cache (
  symbol text primary key,
  price numeric,
  fetched_at timestamptz not null default now()
);
alter table stock_price_cache enable row level security;
create policy p_stock_price_read on stock_price_cache for select using (auth.uid() is not null);
-- No insert/update policy for regular users — only the edge function
-- (service-role key, bypasses RLS) ever writes this table.
