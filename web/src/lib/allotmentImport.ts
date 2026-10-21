// Turns ipoji allotment results (see ipojiAllotmentScript.ts) into portal
// status updates. Pure planning only - the caller resolves IPO / account
// matches and fetches the applications, then applies the plan.

export type AllotmentResult = 'ALLOTTED' | 'NOT_ALLOTTED' | 'NO_RECORD' | 'PENDING' | 'UNKNOWN'

export interface AllotmentRow {
  kind: 'allotment'
  ipo: string
  applicant: string
  panNumber: string
  status: string
  result: AllotmentResult
  shares?: number | null
}

export interface AppRef {
  id: string
  ipo_id: string
  demat_id: string
  status: string
  category: string
  mandate_status: string | null
}

export type AllotmentAction =
  | 'update' // set the application's status
  | 'already' // portal already says this
  | 'final' // application already moved past APPLIED differently (allotted/sold...) - left alone
  | 'ignore' // no record / not decided yet
  | 'unmatched-ipo'
  | 'unmatched-account'
  | 'no-application' // ipoji has a result but the portal has no live application for it
  | 'ambiguous' // account has more than one live application on this IPO - not guessed

export interface AllotmentItem {
  row: AllotmentRow
  ipoId: string | null
  dematId: string | null
  holderName: string | null
  action: AllotmentAction
  applicationId?: string
  newStatus?: 'ALLOTTED' | 'NOT_ALLOTTED'
}

export function isAllotmentPaste(rows: unknown[]): rows is AllotmentRow[] {
  return rows.length > 0 && rows.every((r) => !!r && typeof r === 'object' && (r as { kind?: unknown }).kind === 'allotment')
}

export function planAllotment(
  rows: AllotmentRow[],
  resolve: (row: AllotmentRow) => { ipoId: string | null; dematId: string | null; holderName: string | null },
  apps: AppRef[],
): AllotmentItem[] {
  return rows.map((row) => {
    const { ipoId, dematId, holderName } = resolve(row)
    const base = { row, ipoId, dematId, holderName }
    if (row.result !== 'ALLOTTED' && row.result !== 'NOT_ALLOTTED') return { ...base, action: 'ignore' as const }
    const newStatus = row.result
    if (!ipoId) return { ...base, action: 'unmatched-ipo' as const }
    if (!dematId) return { ...base, action: 'unmatched-account' as const }

    // A cancelled mandate never reached the registrar - not a live application.
    const live = apps.filter((a) => a.ipo_id === ipoId && a.demat_id === dematId && a.mandate_status !== 'CANCELLED')
    if (live.length === 0) return { ...base, action: 'no-application' as const }
    if (live.length > 1) return { ...base, action: 'ambiguous' as const }

    const app = live[0]
    if (app.status === newStatus) return { ...base, action: 'already' as const, applicationId: app.id }
    // Only ever move forward from APPLIED: never overwrite a status someone
    // (or a sale) already moved on.
    if (app.status !== 'APPLIED') return { ...base, action: 'final' as const, applicationId: app.id }
    return { ...base, action: 'update' as const, applicationId: app.id, newStatus }
  })
}

// Anything here needs a person's look before the results are applied.
export function allotmentIssues(items: AllotmentItem[]): AllotmentItem[] {
  return items.filter(
    (i) =>
      i.action === 'unmatched-ipo' ||
      i.action === 'unmatched-account' ||
      i.action === 'no-application' ||
      i.action === 'ambiguous' ||
      i.row.result === 'UNKNOWN' ||
      // ipoji had not finished checking this account - the run was cut short.
      i.row.result === 'PENDING',
  )
}
