-- v_application_attribution (0029, reshaped by 0035/0041/0058) has never
-- filtered by mandate_status — every application counted toward the funder
-- pie chart (Dashboard + Profile) regardless of whether the funder's UPI
-- mandate was ever actually approved. A CANCELLED mandate means the funder
-- never approved the block and no money moved — same reasoning already
-- applied to "accounts left" (Dashboard), "IPOs applied" (Dashboard stat
-- tile), and the new-application account picker's "already applied" flag
-- (all fixed earlier) — but this view was missed, so the pie chart kept
-- crediting funders for applications that were, in effect, never funded.
--
-- Fix: exclude CANCELLED-mandate rows from the view itself, so every
-- consumer (Dashboard's AttributionChart, Profile's own chart, anything
-- built on this view later) gets the correction for free instead of each
-- caller having to remember to filter client-side.
create or replace view v_application_attribution with (security_invoker = true) as
select a.id as application_id, a.ipo_id, i.company_name, i.open_date,
       a.demat_id, get_demat_holder_name(a.demat_id) as holder_name,
       a.bank_account_id, b.linked_user_id as funder_user_id,
       a.created_by,
       get_bank_holder_name(a.bank_account_id) as funder_name
from applications a
join ipos i on i.id = a.ipo_id
left join bank_accounts b on b.id = a.bank_account_id
where a.mandate_status is distinct from 'CANCELLED';
