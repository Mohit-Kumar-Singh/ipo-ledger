-- ============================================================
-- pan_access_log — audit trail for reveal-pan Edge Function calls
-- ============================================================
create table pan_access_log (
  id          uuid primary key default gen_random_uuid(),
  demat_id    uuid not null references demat_accounts(id) on delete cascade,
  accessed_by uuid not null references profiles(id),
  accessed_at timestamptz not null default now()
);
create index on pan_access_log (demat_id);

alter table pan_access_log enable row level security;
create policy p_pan_log_admin on pan_access_log for all
  using (is_admin()) with check (is_admin());
