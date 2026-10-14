-- Personal broadcast list: each user keeps their own list of people (name +
-- phone) they want to message on WhatsApp from the Profile page. Rows belong
-- to the user who created them and nobody else — this is not shared across
-- admins or members, so the policy is owner-only rather than is_admin().
--
-- Sending is still manual (one wa.me tap per person, see
-- web/src/lib/dispatchWhatsapp.ts), so no notifications rows are created here.
create table broadcast_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references profiles(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  phone_e164 text not null check (phone_e164 ~ '^\+91[0-9]{10}$'),
  created_at timestamptz not null default now(),
  -- One entry per number per owner; the same person can still be on
  -- different users' lists.
  unique (owner_id, phone_e164)
);

alter table broadcast_contacts enable row level security;

create policy p_broadcast_contacts_owner on broadcast_contacts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

revoke all on broadcast_contacts from public, anon;
grant select, insert, update, delete on broadcast_contacts to authenticated;
