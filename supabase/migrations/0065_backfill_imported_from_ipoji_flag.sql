-- Before v1.98.0, the sync's "existing row matched" update path only ever
-- touched mandate_status / ipoji_app_number / ipoji_status_text — it never
-- set imported_from_ipoji, so a manually-created application that a sync
-- had already confirmed against ipoji (sometimes long ago) kept showing the
-- "added manually" badge forever, and now also wrongly appears under the
-- new "Not on ipoji" review filter (v1.98.0) even though it plainly *is* on
-- ipoji. Having an ipoji app number, an ipoji status text, or a mandate
-- ipoji itself marked is definitive proof of a real ipoji match regardless
-- of when it happened — correct every such row now that the sync's own
-- update path is fixed to keep this flag right going forward.
update applications
set imported_from_ipoji = true
where imported_from_ipoji = false
  and (ipoji_app_number is not null or ipoji_status_text is not null or mandate_marked_by_ipoji = true);
