-- A short free-text note on one application, typed from its Allotment board
-- card's "⋯" menu and shown on that card next to the application number
-- (e.g. "sold on Groww by holder", "call after 6pm"). Per application, so it
-- only ever shows on that one IPO's card. A plain column on applications, so
-- the existing applications RLS (owner/admin write, p_apps_member_write)
-- already governs who can change it — no new policy.
alter table applications add column card_note text;

-- Same view as 0111, with the note appended at the end.
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
       a.category,
       a.ipoji_app_number,
       a.self_sell,
       a.card_note
from applications a
join ipos i on i.id = a.ipo_id
left join demat_accounts d on d.id = a.demat_id
left join bank_accounts b on b.id = coalesce(a.funder_override_id, a.bank_account_id)
left join account_managers m on m.id = get_demat_account_manager_id(a.demat_id);
