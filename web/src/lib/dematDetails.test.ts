import { describe, expect, it } from 'vitest'
import { dematDetailsText, type DematDetailsSource } from './dematDetails'

const account: DematDetailsSource = {
  holder_name: 'Harsh Harit',
  pan_masked: 'ABCDE****F',
  dp_client_id: '1208160012345678',
  platform: null,
  application_name: 'Groww',
  login_email: 'harsh@example.com',
  login_password: 'pw',
  app_password: null,
  t_pin: '1234',
}

describe('dematDetailsText', () => {
  it('labels the DP client id as BO ID and keeps the Accounts page order', () => {
    expect(dematDetailsText(account, 'ABCDE1234F')).toBe(
      [
        'Name: Harsh Harit',
        'PAN: ABCDE1234F',
        'BO ID: 1208160012345678',
        'App: Groww',
        'Login ID: harsh@example.com',
        'Password: pw',
        'T-PIN: 1234',
      ].join('\n'),
    )
  })

  it('falls back to the masked PAN when the reveal fails', () => {
    expect(dematDetailsText({ ...account, dp_client_id: null }, null)).toMatch(/^Name: Harsh Harit\nPAN: ABCDE\*\*\*\*F\nApp:/)
  })
})
