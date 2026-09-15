import { useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { KebabHorizontalIcon } from '@primer/octicons-react'

export interface ActionMenuItem {
  key: string
  label: ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
  // 'muted' for a lower-emphasis action (e.g. Undo) — everything else
  // defaults to the accent color, same visual weight the old inline text
  // links all shared.
  tone?: 'default' | 'muted'
}

// Compact overflow menu for a row with more actions than are worth
// showing inline — same Radix Popover shell Combobox/HoverCard already
// use elsewhere in this app, just a small floating action list instead of
// a search box. Built for the Allotment board's per-application row,
// which used to stack up to five text-link actions vertically (Mark sold,
// Notify holder, Notify funder, Sell reminder, Undo) — a lot of vertical
// space for a row whose left side is a few lines of plain text. Picking
// an item closes the menu automatically so a second tap can't re-fire it.
export function ActionMenu({ items, label = 'More actions' }: { items: ActionMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--hover-surface)]"
          style={{ color: 'var(--ink-muted)' }}
        >
          <KebabHorizontalIcon size={15} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="card z-50 min-w-[10rem] overflow-hidden p-1"
          style={{ borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow-lg)' }}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors hover:bg-[var(--hover-surface)] disabled:opacity-50"
              style={{ color: item.tone === 'muted' ? 'var(--ink-muted)' : 'var(--accent)' }}
            >
              {item.label}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
