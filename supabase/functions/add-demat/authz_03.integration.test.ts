// Integration test for AUTHZ-03 (profit_share_percent authorization).
//
// The vulnerable/fixed logic lives entirely inside add-demat's own HTTP
// request handling (Edge Function-local isAdmin/demat_id branching), not in
// SQL — so unlike the AUTHZ-02 pgTAP test, this exercises the actual
// deployed function over HTTP against a REAL running Supabase instance
// (local `supabase start` + `supabase functions serve`, or a disposable
// staging project). There is no meaningful way to unit-test this in
// isolation without refactoring add-demat/index.ts to accept an injected
// client, which this fix deliberately does not do (minimal-change scope).
//
// Run (local — recommended):
//   npx --prefix web supabase start
//   npx --prefix web supabase functions serve add-demat --env-file supabase/.secrets.local
//   SUPABASE_URL=http://127.0.0.1:54321 \
//   SUPABASE_ANON_KEY=<from `supabase status`> \
//   SUPABASE_SERVICE_ROLE_KEY=<from `supabase status`> \
//   deno test --allow-net --allow-env supabase/functions/add-demat/authz_03.integration.test.ts
//
// NEVER point SUPABASE_URL at a production project — this creates and
// deletes real auth.users/demat_accounts rows (all cleaned up per-test, but
// still real writes against whatever project SUPABASE_URL names).
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error(
    'Set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY to a LOCAL or disposable staging project before running this test.',
  )
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function randomPan(): string {
  // Valid PAN_RE shape (5 letters, 4 digits, 1 letter) with a random middle
  // segment so concurrent/rerun test data never collides on the
  // demat_accounts.pan_hash unique constraint.
  const digits = String(Math.floor(1000 + Math.random() * 9000))
  return `ZZAT${digits}Z`
}

async function createTestUser(role: 'admin' | 'member') {
  const email = `authz03-${role}-${crypto.randomUUID()}@example.test`
  const password = crypto.randomUUID()
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createTestUser(${email}): ${error?.message}`)
  if (role === 'admin') {
    await admin.from('profiles').update({ role: 'admin' }).eq('id', data.user.id)
  }
  const anonClient = createClient(SUPABASE_URL!, ANON_KEY!)
  const { data: signIn, error: signInError } = await anonClient.auth.signInWithPassword({ email, password })
  if (signInError || !signIn.session) throw new Error(`sign-in failed for ${email}: ${signInError?.message}`)
  return { id: data.user.id, accessToken: signIn.session.access_token }
}

async function cleanupUser(userId: string) {
  await admin.from('demat_accounts').delete().eq('linked_user_id', userId)
  await admin.auth.admin.deleteUser(userId)
}

async function callAddDemat(accessToken: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/add-demat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) as { id?: string; error?: string } }
}

function testAccountPayload(overrides: Record<string, unknown> = {}) {
  return {
    holder_name: 'AuthZ03 Test Holder',
    phone_digits: '9999900002',
    pan: randomPan(),
    dp_client_id: 'test-authz03',
    profit_share_percent: 25,
    ...overrides,
  }
}

async function getStoredProfitShare(dematId: string): Promise<number> {
  const { data, error } = await admin.from('demat_accounts').select('profit_share_percent').eq('id', dematId).single()
  if (error) throw error
  return Number(data.profit_share_percent)
}

Deno.test('AUTHZ-03: admin can create an account with a custom profit_share_percent', async () => {
  const adminUser = await createTestUser('admin')
  try {
    const { status, body } = await callAddDemat(adminUser.accessToken, testAccountPayload({ profit_share_percent: 40 }))
    assertEquals(status, 200)
    assertEquals(await getStoredProfitShare(body.id!), 40)
  } finally {
    await cleanupUser(adminUser.id)
  }
})

Deno.test("AUTHZ-03: admin can edit an existing account's profit_share_percent", async () => {
  const adminUser = await createTestUser('admin')
  try {
    const create = await callAddDemat(adminUser.accessToken, testAccountPayload({ profit_share_percent: 25 }))
    const dematId = create.body.id!
    const edit = await callAddDemat(adminUser.accessToken, testAccountPayload({ demat_id: dematId, profit_share_percent: 60 }))
    assertEquals(edit.status, 200)
    assertEquals(await getStoredProfitShare(dematId), 60)
  } finally {
    await cleanupUser(adminUser.id)
  }
})

Deno.test('AUTHZ-03 (core regression): non-admin CANNOT change profit_share_percent on their own existing account', async () => {
  const member = await createTestUser('member')
  try {
    // Legitimate self-service creation first.
    const create = await callAddDemat(member.accessToken, testAccountPayload({ profit_share_percent: 25 }))
    assertEquals(create.status, 200)
    const dematId = create.body.id!
    assertEquals(await getStoredProfitShare(dematId), 25)

    // The exact class of attack from the audit: resubmit the same edit with
    // profit_share_percent bumped to 100.
    const attack = await callAddDemat(member.accessToken, testAccountPayload({ demat_id: dematId, profit_share_percent: 100 }))
    assertEquals(attack.status, 200, 'the rest of the edit (holder name, phone, PAN) must still succeed')
    assertEquals(
      await getStoredProfitShare(dematId),
      25,
      'profit_share_percent must remain unchanged for a non-admin editing their own account',
    )
  } finally {
    await cleanupUser(member.id)
  }
})

Deno.test("AUTHZ-03: non-admin cannot edit another user's account at all (ownership check unchanged)", async () => {
  const owner = await createTestUser('member')
  const attacker = await createTestUser('member')
  try {
    const create = await callAddDemat(owner.accessToken, testAccountPayload({ profit_share_percent: 25 }))
    const dematId = create.body.id!

    const attack = await callAddDemat(attacker.accessToken, testAccountPayload({ demat_id: dematId, profit_share_percent: 100 }))
    assertEquals(attack.status, 403)
    assertEquals(await getStoredProfitShare(dematId), 25)
  } finally {
    await cleanupUser(owner.id)
    await cleanupUser(attacker.id)
  }
})

Deno.test('AUTHZ-03: non-admin creating a brand-new account may still choose its initial profit_share_percent', async () => {
  const member = await createTestUser('member')
  try {
    const create = await callAddDemat(member.accessToken, testAccountPayload({ profit_share_percent: 40 }))
    assertEquals(create.status, 200)
    assertEquals(await getStoredProfitShare(create.body.id!), 40, 'creation-time self-service choice is preserved unchanged')
  } finally {
    await cleanupUser(member.id)
  }
})
