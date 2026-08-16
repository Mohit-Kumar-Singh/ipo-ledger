-- Turns the free-text "which app" field (demat_accounts.application_name,
-- added 0066) into a constrained trading-platform value, so listing-day
-- "sell this IPO" reminders can auto-attach a platform-specific how-to-sell
-- PDF (Groww / Kite / Dhan / Paytm Money / Upstox). 'other' is a real,
-- valid value — a holder on a broker with no PDF on file still gets the
-- text reminder, just without an attachment.
--
-- Non-destructive: application_name is LEFT IN PLACE (still displayed/copied
-- as free-text detail, and the source this column is backfilled from). A
-- later migration can drop it once nothing reads it; keeping it now means no
-- data is lost if the pattern-match backfill below miscategorises a row.
create type demat_platform as enum ('groww', 'kite', 'dhan', 'paytm_money', 'upstox', 'other');

alter table demat_accounts add column platform demat_platform;

-- Best-effort backfill from the existing free text. Kite is Zerodha's app,
-- so both spellings map to it. Anything non-empty that matches none of the
-- five known apps becomes 'other' (a deliberate value, not null); a blank/
-- null application_name stays null ("not recorded").
update demat_accounts
set platform = case
  when application_name ilike '%groww%'                                   then 'groww'::demat_platform
  when application_name ilike '%kite%' or application_name ilike '%zerodha%' then 'kite'::demat_platform
  when application_name ilike '%dhan%'                                    then 'dhan'::demat_platform
  when application_name ilike '%paytm%'                                   then 'paytm_money'::demat_platform
  when application_name ilike '%upstox%'                                  then 'upstox'::demat_platform
  when application_name is not null and btrim(application_name) <> ''     then 'other'::demat_platform
  else null
end
where application_name is not null and btrim(application_name) <> '';

-- Surface the platform on the allotment board so the sell-reminder send flow
-- (which already reads this view for the ALLOTTED holder list + phone) can
-- resolve each holder's PDF without a second round trip. security_invoker
-- view — unchanged, just one more passthrough column.
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
       d.platform
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id);
