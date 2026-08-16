// The constrained set of trading platforms a demat account can be on
// (migration 0074, demat_platform enum). Single source of truth for the enum
// values, their human labels, and the account-edit dropdown options — so the
// PDF library, the account form, and the sell-reminder resolver never drift
// on spelling or which platforms exist.
import type { ComboboxOption } from '../components/Combobox'

export type DematPlatform = 'groww' | 'kite' | 'dhan' | 'paytm_money' | 'upstox' | 'other'

// Ordered — the PDF library section and any dropdown render in this order.
// 'other' last: it's the catch-all, and has no PDF slot of its own.
export const PLATFORM_LABELS: Record<DematPlatform, string> = {
  groww: 'Groww',
  kite: 'Kite (Zerodha)',
  dhan: 'Dhan',
  paytm_money: 'Paytm Money',
  upstox: 'Upstox',
  other: 'Other',
}

export const PLATFORMS = Object.keys(PLATFORM_LABELS) as DematPlatform[]

// The five real platforms that have a dedicated how-to-sell PDF slot —
// excludes 'other', which is a valid account value but never a PDF row.
export const PDF_PLATFORMS = PLATFORMS.filter((p) => p !== 'other')

export function platformLabel(platform: string | null | undefined): string {
  if (!platform) return '—'
  return PLATFORM_LABELS[platform as DematPlatform] ?? platform
}

export const PLATFORM_OPTIONS: ComboboxOption[] = PLATFORMS.map((p) => ({
  value: p,
  label: PLATFORM_LABELS[p],
}))
