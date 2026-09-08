-- Reconstructed into the repo from the remote migration history
-- (supabase_migrations.schema_migrations version 0093) — it was applied to
-- the linked project out of band and never committed here, which left every
-- `supabase migration list` showing local/remote drift. Content is the exact
-- `statements` array recorded remotely.
--
-- Adds the two "money flowed the other way" settlement kinds: a funder
-- refunding the admin, and the admin paying the holder directly.
alter type settlement_payment_kind add value if not exists 'funder_to_admin';
alter type settlement_payment_kind add value if not exists 'admin_to_holder';
