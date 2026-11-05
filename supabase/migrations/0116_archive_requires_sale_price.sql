-- ============================================================
-- A SOLD application with no sale price entered isn't finished: its profit,
-- holder cut and funder share can't be worked out. The archive rule (0115)
-- now also requires sell_price for SOLD, so the IPO stays active (on
-- Applications / Allotment board / Dashboard) until the price is in — even
-- if the payouts were already marked paid.
-- ============================================================

create or replace function sync_ipo_archive(p_ipo uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_all_resolved boolean;
begin
  select bool_and(
           status = 'NOT_ALLOTTED'
           or (status = 'SOLD' and sell_price is not null and demat_cut_paid and funder_share_paid)
         )
    into v_all_resolved
  from applications
  where ipo_id = p_ipo;

  if v_all_resolved is null then
    return;
  end if;

  update ipos
     set is_archived = v_all_resolved
   where id = p_ipo
     and is_archived is distinct from v_all_resolved
     and not (v_all_resolved and keep_unarchived);
end;
$$;
revoke execute on function sync_ipo_archive(uuid) from public, anon, authenticated;

-- sell_price is part of the rule now, so a change to it must re-run it.
drop trigger trg_applications_sync_ipo_archive on applications;
create trigger trg_applications_sync_ipo_archive
  after insert or delete or update of status, sell_price, demat_cut_paid, funder_share_paid, ipo_id
  on applications
  for each row execute function trg_applications_sync_ipo_archive();

select cron.schedule(
  'archive-listed-ipos-daily',
  '0 2 * * *',
  $$
  update ipos set is_archived = true
  where not is_archived
    and not keep_unarchived
    and close_date < current_date
    and not exists (select 1 from applications a where a.ipo_id = ipos.id);

  update ipos set is_archived = true
  where not is_archived
    and not keep_unarchived
    and exists (select 1 from applications a where a.ipo_id = ipos.id)
    and not exists (
      select 1 from applications a
      where a.ipo_id = ipos.id
        and not (a.status = 'NOT_ALLOTTED'
                 or (a.status = 'SOLD' and a.sell_price is not null and a.demat_cut_paid and a.funder_share_paid))
    );
  $$
);

-- Catch-up: bring back any archived IPO that has a sold application with no
-- sale price.
update ipos set is_archived = false
where is_archived
  and exists (
    select 1 from applications a
    where a.ipo_id = ipos.id
      and not (a.status = 'NOT_ALLOTTED'
               or (a.status = 'SOLD' and a.sell_price is not null and a.demat_cut_paid and a.funder_share_paid))
  );
