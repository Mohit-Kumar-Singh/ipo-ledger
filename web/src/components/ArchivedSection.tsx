import { useState, type ReactNode } from 'react'

// Collapsed by default — archived rows are still fully real (nothing here
// is ever deleted, just out of the way of the main list). Shared between
// IposPage (archived IPOs) and NotificationsPage (archived notifications)
// rather than each page keeping its own copy.
export function ArchivedSection({ children, label = 'Archived' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-sm font-medium hover:underline"
        style={{ color: 'var(--ink-muted)' }}
      >
        {open ? '▾' : '▸'} {label}
      </button>
      {open && children}
    </section>
  )
}
