-- ============================================================
-- Dummy test accounts (fictional data, not real people) for exercising
-- the Applications / Allotment board / notification flows during
-- development. Safe to delete anytime from the Accounts page.
--
-- Before running in the SQL Editor, replace __PAN_KEY__ below with the
-- actual value (see supabase/.secrets.local, gitignored) — this file
-- intentionally keeps a placeholder.
-- ============================================================
select insert_demat_encrypted(
  p_name => 'Ramesh Kumar', p_phone => '+919876543210', p_pan => 'ABCPK1234E',
  p_key => '__PAN_KEY__', p_dp_client_id => '1203000011111'
);
select insert_demat_encrypted(
  p_name => 'Priya Sharma', p_phone => '+918765432109', p_pan => 'BCDPS2345F',
  p_key => '__PAN_KEY__', p_dp_client_id => '1203000022222'
);
select insert_demat_encrypted(
  p_name => 'Amit Verma', p_phone => '+917654321098', p_pan => 'CDEPV3456G',
  p_key => '__PAN_KEY__', p_dp_client_id => '1203000033333'
);
select insert_demat_encrypted(
  p_name => 'Sneha Iyer', p_phone => '+916543210987', p_pan => 'DEFPI4567H',
  p_key => '__PAN_KEY__', p_dp_client_id => '1203000044444'
);
