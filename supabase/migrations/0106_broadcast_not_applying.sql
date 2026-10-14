-- Per-IPO "this person is not applying" marker for the Broadcast page: when
-- someone on the broadcast list says they won't apply for a given IPO, the
-- admin ticks them so the admin can apply on their behalf. One row per
-- (person, IPO); ticking again removes it. Owner-only, same as
-- broadcast_contacts (0105).
create table broadcast_not_applying (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references profiles(id) on delete cascade,
  contact_id uuid not null references broadcast_contacts(id) on delete cascade,
  ipo_id uuid not null references ipos(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (contact_id, ipo_id)
);

create index broadcast_not_applying_ipo_idx on broadcast_not_applying (ipo_id);

alter table broadcast_not_applying enable row level security;

create policy p_broadcast_not_applying_owner on broadcast_not_applying
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

revoke all on broadcast_not_applying from public, anon;
grant select, insert, update, delete on broadcast_not_applying to authenticated;
