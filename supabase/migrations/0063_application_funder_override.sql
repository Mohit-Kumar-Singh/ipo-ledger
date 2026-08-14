-- Separates two things that bank_account_id has always conflated: "which
-- literal UPI paid ipoji" (needed for mandate-approval tracking — that has
-- to stay tied to the real UPI, since that's whose banking app the mandate
-- approval actually happens in) vs "who gets funding credit / gets the
-- profit-split message" (a real-world funder can hand over money OFF this
-- app entirely, e.g. a lump sum to the admin, who then applies using their
-- OWN UPI — ipoji sync then correctly matches that UPI back to the admin's
-- own bank_accounts row, with nowhere to record that the real funder was
-- actually someone else).
--
-- funder_override_id is a second, independent pointer at bank_accounts —
-- null by default (existing rows behave identically to before), settable
-- only by hand on the application form, and NEVER touched by the ipoji
-- sync (see IpojiSyncPanel.tsx — its insert/update payloads only ever set
-- bank_account_id). Every "who funded this" consumer (attribution pie
-- chart, allotment-board payout names/messages) now reads
-- coalesce(funder_override_id, bank_account_id) instead of bank_account_id
-- alone, so setting an override changes credit/messaging everywhere at
-- once. mandate_status and everything else UPI-approval-related stays
-- keyed to the real bank_account_id — untouched by this migration.
alter table applications add column funder_override_id uuid references bank_accounts(id);
create index on applications (funder_override_id);

create or replace view v_application_attribution with (security_invoker = true) as
select a.id as application_id, a.ipo_id, i.company_name, i.open_date,
       a.demat_id, get_demat_holder_name(a.demat_id) as holder_name,
       a.bank_account_id, b.linked_user_id as funder_user_id,
       a.created_by,
       get_bank_holder_name(coalesce(a.funder_override_id, a.bank_account_id)) as funder_name
from applications a
join ipos i on i.id = a.ipo_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id)
where a.mandate_status is distinct from 'CANCELLED';

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
       i.is_archived as ipo_is_archived
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id);
