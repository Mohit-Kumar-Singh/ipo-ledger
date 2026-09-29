import { describe, expect, it } from 'vitest'
import { friendlyError, friendlyErrorOrNull, isTechnicalMessage, plainMessage } from './friendlyError'

// Real messages this app has produced (or Postgres/PostgREST/supabase-js
// will), as they arrive from the API.
const RAW: Array<[string, unknown]> = [
  [
    'foreign key delete (the reported Pranjul case)',
    {
      code: '23503',
      message:
        'update or delete on table "bank_accounts" violates foreign key constraint "applications_bank_account_id_fkey" on table "applications"',
    },
  ],
  ['foreign key insert', { code: '23503', message: 'insert or update on table "applications" violates foreign key constraint "applications_ipo_id_fkey"' }],
  ['duplicate', { code: '23505', message: 'duplicate key value violates unique constraint "ipos_company_name_key"' }],
  ['not null', { code: '23502', message: 'null value in column "lot_size" of relation "ipos" violates not-null constraint' }],
  ['check', { code: '23514', message: 'new row for relation "applications" violates check constraint "applications_lots_check"' }],
  ['bad format', { code: '22P02', message: 'invalid input syntax for type uuid: "abc"' }],
  ['rls', { code: '42501', message: 'new row violates row-level security policy for table "applications"' }],
  ['rls recursion', { code: '42P17', message: 'infinite recursion detected in policy for relation "demat_accounts"' }],
  ['expired jwt', { message: 'JWT expired' }],
  ['no rows', { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }],
  ['safari offline', new TypeError('Load failed')],
  ['chrome offline', new TypeError('Failed to fetch')],
  ['function non-2xx', { message: 'Edge Function returned a non-2xx status code' }],
  ['function unreachable', { message: 'FunctionsFetchError: Failed to send a request to the Edge Function' }],
  ['timeout', { message: 'canceling statement due to statement timeout' }],
  ['bare unauthorized', 'unauthorized'],
  ['bare internal error', 'internal error'],
  ['js crash', new TypeError("Cannot read properties of undefined (reading 'id')")],
  ['http 500 with nothing else', { status: 500 }],
]

describe('friendlyError', () => {
  it.each(RAW)('never leaks technical wording: %s', (_name, err) => {
    const out = friendlyError(err)
    expect(isTechnicalMessage(out)).toBe(false)
    expect(out).not.toMatch(/[a-z]+_[a-z]+/) // no snake_case identifiers
    expect(out).not.toMatch(/\b(23503|23505|42501|PGRST\d+|500)\b/)
    expect(out.length).toBeGreaterThan(10)
  })

  it('explains a blocked delete in everyday words', () => {
    expect(friendlyError(RAW[0][1])).toBe(
      "This bank/UPI account can't be removed because applications still use it. Remove or reassign those first.",
    )
  })

  it('names the missing field for a required value', () => {
    expect(friendlyError(RAW[3][1])).toBe('Please fill in the lot size field.')
  })

  it('tells the user what to do about connection problems', () => {
    expect(friendlyError(new TypeError('Load failed'))).toMatch(/internet connection/)
  })

  it('keeps a message our own code wrote on purpose', () => {
    expect(friendlyError({ message: 'this holder already has an active application' })).toBe(
      'This holder already has an active application',
    )
  })

  it('uses the caller fallback for unknown technical failures', () => {
    expect(friendlyError(new TypeError('x is not a function'), "Couldn't save that.")).toBe("Couldn't save that.")
    expect(friendlyError(undefined, "Couldn't save that.")).toBe("Couldn't save that.")
  })
})

describe('plainMessage', () => {
  it('translates technical text and leaves plain text untouched', () => {
    expect(plainMessage('Load failed')).toMatch(/internet connection/)
    expect(plainMessage('Saved 3 applications.')).toBe('Saved 3 applications.')
  })
})

describe('friendlyErrorOrNull', () => {
  it('passes null through for "no error"', () => {
    expect(friendlyErrorOrNull(null)).toBeNull()
    expect(friendlyErrorOrNull({ code: '23505', message: 'duplicate key value' })).toMatch(/already exists/)
  })
})
