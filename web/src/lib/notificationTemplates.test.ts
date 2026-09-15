import { describe, expect, it } from 'vitest'
import { renderMessageBody } from './notificationTemplates'

describe('renderMessageBody - ipo_allotted_funder', () => {
  it('includes GMP and expected-profit lines when both are supplied', () => {
    const body = renderMessageBody('ipo_allotted_funder', [
      'Mohit',
      'Kanohar Electricals',
      'Knnu Harit',
      '16 Sep, Wednesday',
      '25%',
      '1,405',
    ])
    expect(body).toContain('Hi Mohit, good news!')
    expect(body).toContain("*Knnu Harit's* `Kanohar Electricals IPO`, funded through your account, has been ALLOTTED")
    expect(body).toContain('`Listing date: 16 Sep, Wednesday`')
    expect(body).toContain('`GMP:- 25%`')
    expect(body).toContain('`Expected profit :- 1,405`')
    expect(body).toContain('> For Details Visit :')
  })

  it('omits the GMP/expected-profit lines when there is nothing to show', () => {
    const body = renderMessageBody('ipo_allotted_funder', [
      'Mohit',
      'Kanohar Electricals',
      'Knnu Harit',
      '16 Sep, Wednesday',
      '',
      '',
    ])
    expect(body).not.toContain('GMP')
    expect(body).not.toContain('Expected profit')
    expect(body).toContain('`Listing date: 16 Sep, Wednesday`')
  })
})
