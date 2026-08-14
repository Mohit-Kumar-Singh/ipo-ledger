-- The ipoji sync's is_backdated logic was wrong from the start (see
-- IpojiSyncPanel.tsx's insert payload, now fixed to always false): it set
-- is_backdated based on whether the IPO's bidding window was closed AT
-- SYNC TIME, not whether the underlying bid was actually placed late. A
-- sync can run any time after the real bid (even days later, well after
-- the IPO closed), so this flagged nearly every ipoji-imported application
-- as "backdated" even though every one of them was, by construction,
-- placed while bidding was genuinely still open — ipoji itself refuses
-- bids after its own cutoff, so nothing it shows at all can legitimately
-- be backdated. The client-side "gate on hasBiddingClosed(a.ipos)" workaround
-- shipped earlier only masked this for already-open IPOs; for closed ones
-- (the common case by the time anyone looks) it kept showing the wrong
-- badge. Real fix: correct the data at the source.
update applications
set is_backdated = false
where imported_from_ipoji = true and is_backdated = true;
