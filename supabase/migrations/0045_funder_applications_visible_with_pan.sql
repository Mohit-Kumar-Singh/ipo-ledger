-- ============================================================
-- 0032 gave a funder real SELECT visibility on applications they funded,
-- and 0034 added resolve_demat_holder_names() as the narrow (holder_name
-- only, not the full row) way for the frontend to render those rows. But
-- nothing ever actually called resolve_demat_holder_names() — ApplicationsPage
-- fetches demat_accounts via an embedded join, which RLS blocks for a
-- funder-only row (no matching demat_accounts policy since 0034 dropped the
-- row-level grant), and the frontend then drops any row where that embed
-- came back null. Net effect: a funder could fund 16 applications and see
-- zero of them on their own Applications page — the DB-side feature was
-- real but never reachable.
--
-- Also: the user wants a funder able to see PAN (to self-check allotment
-- status on the registrar's site) but explicitly NOT phone_e164 or
-- dp_client_id. Extend the narrow resolver to include pan_masked — still
-- nothing else — rather than opening the row back up.
-- ============================================================

drop function if exists resolve_demat_holder_names(uuid[]);

create function resolve_demat_holder_names(p_ids uuid[])
returns table(id uuid, holder_name text, pan_masked text)
language sql security definer set search_path = public as $$
  select id, holder_name, pan_masked from demat_accounts where id = any(p_ids);
$$;
revoke execute on function resolve_demat_holder_names(uuid[]) from public, anon;
grant execute on function resolve_demat_holder_names(uuid[]) to authenticated;
