import type { ReactNode } from 'react'

// Sale entry supports two equivalent ways in: a per-share price (with share
// count/invested amount shown as reference) or the total payout received —
// whichever's easier to type in from the broker's contract note. Both funnel
// into the same stored per-share sell_price. Shared between the Allotment
// board's "Mark sold" flow and the Applications form's sell-price field so
// both look and behave identically.
export type SaleEntryMode = 'total' | 'perShare'

export function sellPricePerShareFromEntry(
  mode: SaleEntryMode,
  sellPrice: string,
  totalPayout: string,
  shares: number,
): number {
  if (mode === 'perShare') return Number(sellPrice || 0)
  return shares > 0 ? Number(totalPayout || 0) / shares : 0
}

export function SaleAmountField({
  mode,
  onModeChange,
  sellPrice,
  onSellPriceChange,
  totalPayout,
  onTotalPayoutChange,
  shares,
  invested,
  extra,
}: {
  mode: SaleEntryMode
  onModeChange: (mode: SaleEntryMode) => void
  sellPrice: string
  onSellPriceChange: (value: string) => void
  totalPayout: string
  onTotalPayoutChange: (value: string) => void
  shares: number
  invested: number
  extra?: ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-lg p-0.5 text-xs font-medium" style={{ background: 'var(--page)' }}>
        {(['total', 'perShare'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              if (m === mode) return
              // Carry the equivalent value across so switching modes never
              // presents a blank field the admin has to refill from memory.
              const perShare = sellPricePerShareFromEntry(mode, sellPrice, totalPayout, shares)
              if (m === 'perShare') {
                onSellPriceChange(perShare > 0 ? String(Math.round(perShare * 100) / 100) : '')
              } else {
                const total = perShare * shares
                onTotalPayoutChange(total > 0 ? String(Math.round(total)) : '')
              }
              onModeChange(m)
            }}
            className="rounded-md px-3 py-1.5 transition-colors"
            style={
              mode === m
                ? { background: 'var(--surface)', color: 'var(--ink-primary)', boxShadow: 'var(--shadow-sm)' }
                : { color: 'var(--ink-muted)' }
            }
          >
            {m === 'total' ? 'Total payout' : 'Sell price per share'}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {mode === 'total' ? (
          <label className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            Total payout received
            <input
              type="number"
              min={0}
              step="1"
              value={totalPayout}
              onChange={(e) => onTotalPayoutChange(e.target.value)}
              className="input mt-1 block w-40"
            />
          </label>
        ) : (
          <div>
            <label className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              Sell price per share
              <input
                type="number"
                min={0}
                step="1"
                value={sellPrice}
                onChange={(e) => onSellPriceChange(e.target.value)}
                className="input mt-1 block w-36"
              />
            </label>
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
              {shares.toLocaleString('en-IN')} shares · ₹{invested.toLocaleString('en-IN')} invested
            </p>
          </div>
        )}
        {extra}
      </div>
    </div>
  )
}
