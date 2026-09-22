-- Data repair, not a schema change: three applications have
-- applications.demat_cut_paid = true with NO corresponding settlement_payments
-- row, because they were marked paid through one of two raw
-- `applications.update({ demat_cut_paid: true })` write paths (Allotment
-- board's own "Mark paid" button, and Payouts' legacy Outstanding/Paid
-- section) that predate the settlement_payments ledger (0078) and were never
-- updated to write through it — both fixed in this same release
-- (lib/settlementActions.ts is now the one write path either page uses).
--
-- Until this backfill, every ledger-based view (Payouts "You need to
-- receive", Settlement — by IPO, Dashboard, FunderPayoutsPage) kept netting
-- against zero logged payments and showed the FULL amount still outstanding
-- forever, even though the flag said settled — this is the exact discrepancy
-- reported live for Charu's Karamtara Engineering application (admin portal
-- showing money owed that the flag already claimed was received).
--
-- Amounts are each application's full amountFromHolder (totalSoldAmount −
-- the holder's cut, computed with the same formula settlement.ts uses:
-- computeProfitSplit against the app's own bid_amount/sell_price/lot_size/
-- profit_share_percent), verified by hand against the live row data before
-- writing this migration. All three are holder_to_admin (the holder's own
-- side) — no funder-side drift was found in the same audit.
--
-- created_at is backdated to each application's own status_changed_at (when
-- it was marked SOLD, the closest available proxy for when it was actually
-- marked paid — demat_cut_paid has no timestamp of its own) rather than
-- now(), so this repair doesn't inflate a payout-analytics date range that
-- didn't actually see this money move.
insert into settlement_payments (application_id, kind, amount, note, created_by, created_at)
select v.application_id, v.kind, v.amount, v.note,
       (select id from profiles where role = 'admin' limit 1),
       v.created_at
from (
  values
    ('75cbf8af-0b1f-47ae-8bd1-b3d2165176be'::uuid, 'holder_to_admin'::settlement_payment_kind, 17461.8725::numeric,
     'Backfilled: demat_cut_paid was already true with no ledger entry (pre-fix data repair, migration 0102)',
     '2026-09-17 04:58:17.190643+00'::timestamptz),
    ('7a75ec2e-e6a7-43a2-b75b-10b23325ca42'::uuid, 'holder_to_admin'::settlement_payment_kind, 19353.9175::numeric,
     'Backfilled: demat_cut_paid was already true with no ledger entry (pre-fix data repair, migration 0102)',
     '2026-09-18 17:50:28.669723+00'::timestamptz),
    ('d44aef7b-af31-42a7-8267-2d6fdf13a0d4'::uuid, 'holder_to_admin'::settlement_payment_kind, 16137.3175::numeric,
     'Backfilled: demat_cut_paid was already true with no ledger entry (pre-fix data repair, migration 0102)',
     '2026-09-16 04:54:41.221286+00'::timestamptz)
) as v(application_id, kind, amount, note, created_at)
where not exists (
  select 1 from settlement_payments sp where sp.application_id = v.application_id
);
