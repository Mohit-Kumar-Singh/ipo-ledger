-- Optional purchase date for a shareholder-quota holding — admins often
-- don't have (or don't bother recording) the exact date a lot was bought,
-- especially for older holdings entered after the fact, so this stays
-- nullable rather than forcing a value at insert time like applications'
-- applied_at (which is always known, since that's today's own action).
alter table parent_company_holdings add column if not exists bought_at date;
