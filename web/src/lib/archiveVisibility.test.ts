import { describe, expect, it } from 'vitest'
import { selectArchivedIpos } from './archiveVisibility'

describe('selectArchivedIpos', () => {
  it('returns every archived IPO regardless of anything else about it', () => {
    const ipos = [
      { id: '1', is_archived: true },
      { id: '2', is_archived: false },
      { id: '3', is_archived: true },
    ]
    expect(selectArchivedIpos(ipos)).toEqual([ipos[0], ipos[2]])
  })

  // The actual regression this module exists to prevent: an archived IPO
  // nobody ever applied to must still show up here — it has nowhere else
  // to be found or unarchived from.
  it('includes an archived IPO with no applications tracked against it at all', () => {
    const neverApplied = { id: 'zero-apps', is_archived: true, company_name: 'Glass Wall Systems (India)' }
    expect(selectArchivedIpos([neverApplied])).toEqual([neverApplied])
  })

  it('returns an empty array when nothing is archived', () => {
    expect(selectArchivedIpos([{ id: '1', is_archived: false }])).toEqual([])
  })
})
