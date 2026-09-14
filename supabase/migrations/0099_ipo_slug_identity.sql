-- The actual architectural fix for "NSE" and "National Stock Exchange of
-- India" showing up as two separate cards for the same real IPO — and for
-- the same class of bug happening again with a future rename. Every IPO
-- upsert path (auto-import-ipos, IposPage's bulk import, IpojiSyncPanel's
-- fetch-and-create-missing-IPO) has only ever matched candidates against
-- existing rows by company_name (case-insensitive, migrations 0043/0044).
-- That catches whitespace/casing drift, but has no way to catch ipoji
-- renaming an IPO's display name mid-bidding — "NSE" and "National Stock
-- Exchange of India" share no normalizable substring.
--
-- ipoji's own detail-page slug survives a rename like that: fetching
-- either https://www.ipoji.com/ipo/national-stock-exchange-of-india-ipo or
-- https://www.ipoji.com/ipo/nse-ipo resolves (the first via a live
-- confirmed 301 redirect) to the same underlying page. See
-- supabase/functions/_shared/ipoji.ts (fetchHtml/fetchDetail, now capturing
-- Response.url after following the redirect) and web/src/lib/ipoIdentity.ts
-- (the match-by-slug-first decision, ported into auto-import-ipos since a
-- Deno Edge Function can't import from the Vite web app).
alter table ipos add column if not exists ipoji_slug text;
create unique index if not exists ipos_ipoji_slug_key on ipos (ipoji_slug) where ipoji_slug is not null;

-- One-time, hand-verified cleanup for the specific pair this bug already
-- produced — not a generic fuzzy-merge sweep. A heuristic broad enough to
-- auto-match "NSE" against "National Stock Exchange of India" would also be
-- broad enough to wrongly merge two genuinely different companies whose
-- IPOs happen to open/close on the same dates, which really happens when
-- SEBI clusters a batch of mainboard IPOs into one week. Confirmed safe by
-- direct query before writing this: both rows share identical open/close/
-- listing dates (unmistakably the same real IPO) and have zero applications
-- and zero notifications on either side — nothing to move, nothing at risk.
-- Keeps the older row (same convention 0043/0044 already established:
-- oldest survives) and updates it to the name + slug ipoji currently shows.
do $$
declare
  keeper_id uuid;
  dup_id uuid;
begin
  select id into keeper_id from ipos where lower(company_name) = lower('National Stock Exchange of India') limit 1;
  select id into dup_id from ipos where lower(company_name) = lower('NSE') limit 1;

  if keeper_id is not null and dup_id is not null and keeper_id <> dup_id then
    update applications set ipo_id = keeper_id where ipo_id = dup_id;
    update notifications set ipo_id = keeper_id where ipo_id = dup_id;
    delete from ipos where id = dup_id;
    update ipos set company_name = 'NSE', ipoji_slug = 'nse-ipo' where id = keeper_id;
  end if;
end $$;
