-- Admin-managed library of platform-specific "how to verify with T-PIN + how
-- to sell" PDFs, one per trading platform, reused across every IPO's sell
-- reminders (not re-uploaded per IPO). The files live in a private Storage
-- bucket; this table is just the platform -> file pointer + audit stamp.
--
-- platform is the primary key: exactly one current PDF per platform, and an
-- upsert on (platform) is how "replace" works. A platform with no row here is
-- a valid state — the sell-reminder send path just sends text-only for
-- holders on that platform.
create table sell_instruction_pdfs (
  platform      demat_platform primary key,
  storage_path  text not null,
  uploaded_by   uuid references profiles(id),
  updated_at    timestamptz not null default now()
);

alter table sell_instruction_pdfs enable row level security;

-- Admin-only, full stop. This is the ENTIRE authorization surface for the
-- table (RLS is the boundary, per repo convention). No member policy exists
-- on purpose: the sell-reminder flow resolves each PDF to a short-lived
-- signed URL admin-side at send time (createSignedUrl, which the admin's own
-- Storage SELECT policy below permits), and that signed URL — not any table
-- access — is what a holder ultimately opens. So there is no member read
-- path to leak, and nothing here reads a second RLS table, so no policy
-- cycle (the 0032/0033 gotcha class does not apply).
create policy p_sell_pdf_admin on sell_instruction_pdfs for all
  using (is_admin()) with check (is_admin());

-- Private bucket for the actual PDF files. public = false: the files are only
-- ever reachable through a signed URL, never a bare public URL.
insert into storage.buckets (id, name, public)
values ('sell-instructions', 'sell-instructions', false)
on conflict (id) do nothing;

-- Storage RLS (storage.objects already has RLS enabled by Supabase). Admin is
-- the only role that can list/upload/replace/remove files in this bucket, and
-- also the only one that can mint signed URLs for them (createSignedUrl needs
-- SELECT under storage RLS). is_admin() is stable security definer, so this
-- doesn't recurse into any app table's own policies.
create policy p_sell_pdf_storage_admin on storage.objects for all to authenticated
  using (bucket_id = 'sell-instructions' and is_admin())
  with check (bucket_id = 'sell-instructions' and is_admin());
