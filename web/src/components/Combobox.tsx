import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Command } from 'cmdk'
import { CheckIcon, UnfoldIcon } from '@primer/octicons-react'

export interface ComboboxOption {
  value: string
  label: string
  /** Options sharing a group render under one heading, in first-seen order. */
  group?: string
}

/** Searchable dropdown (Radix Popover for positioning/a11y, cmdk for the
 *  filterable list) — a drop-in replacement for a native `<select>` where
 *  the option list is long enough that scrolling beats typing to find one. */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyLabel = 'No matches.',
  disabled,
  'aria-label': ariaLabel,
}: {
  options: ComboboxOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyLabel?: string
  disabled?: boolean
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)

  const groups = new Map<string, ComboboxOption[]>()
  for (const o of options) {
    const key = o.group ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(o)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className="input flex items-center justify-between gap-2 text-left disabled:opacity-50"
        >
          <span className="truncate" style={{ color: selected ? 'var(--ink-primary)' : 'var(--ink-muted)' }}>
            {selected?.label ?? placeholder}
          </span>
          <UnfoldIcon size={14} className="shrink-0" fill="var(--ink-muted)" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="card z-50 w-[22rem] max-w-[90vw] overflow-hidden p-0"
          style={{ borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow-lg)' }}
        >
          <Command loop>
            <div className="flex items-center border-b px-3" style={{ borderColor: 'var(--border)' }}>
              <Command.Input
                autoFocus
                placeholder={searchPlaceholder}
                className="h-9 w-full bg-transparent text-sm outline-none"
                style={{ color: 'var(--ink-primary)' }}
              />
            </div>
            <Command.List className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-4 text-center text-sm" style={{ color: 'var(--ink-muted)' }}>
                {emptyLabel}
              </Command.Empty>
              {Array.from(groups.entries()).map(([group, items]) => (
                <Command.Group key={group || '_ungrouped'}>
                  {group && (
                    <div className="px-2 py-1.5 text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                      {group}
                    </div>
                  )}
                  {items.map((o) => (
                    <Command.Item
                      key={o.value}
                      // Appending the id keeps cmdk's internal value unique even
                      // when two options share a label (e.g. duplicate holder
                      // names) — filtering still matches on the visible label.
                      value={`${o.label}::${o.value}`}
                      onSelect={() => {
                        onChange(o.value)
                        setOpen(false)
                      }}
                      className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs data-[selected=true]:bg-[var(--hover-surface)]"
                      style={{ color: 'var(--ink-primary)' }}
                    >
                      {/* Smaller text + a wider popover (above) instead of
                          truncating — this list's labels are often a name +
                          bank + full UPI ID strung together, and truncating
                          was hiding the UPI ID entirely, the one field that
                          actually disambiguates near-identical entries. */}
                      <span className="break-all">{o.label}</span>
                      {o.value === value && <CheckIcon size={14} className="shrink-0" fill="var(--accent)" />}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
