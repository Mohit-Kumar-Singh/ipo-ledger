import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { motion, useReducedMotion } from 'framer-motion'

export interface SegmentOption<T extends string> {
  value: T
  label: string
  /** Small count pill after the label (e.g. how many rows a filter would show). */
  count?: number
}

// iOS segmented control: a frosted track with a raised glass thumb that
// slides (spring) to the selected segment. Used for the Applications sort /
// filter bar, the Payouts date range and the IPO Live / Upcoming / Closed
// switch.
//
// - `fill` stretches the segments to share the full width (3-4 short options,
//   e.g. IPO status). Without it the track is as wide as its content and
//   scrolls sideways when there are more options than fit; the edge that has
//   more to reveal fades out (mask) instead of clipping a label mid-word, and
//   the selected segment is scrolled to the middle.
// - Keyboard: arrow keys / Home / End move the selection, like a native
//   radio group.
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  fill = false,
  className = '',
}: {
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  fill?: boolean
  className?: string
}) {
  const thumbId = useId()
  const reduceMotion = useReducedMotion()
  const scrollRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<T, HTMLButtonElement>())
  const [edges, setEdges] = useState({ left: false, right: false })

  const updateEdges = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const left = el.scrollLeft > 2
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  useEffect(() => {
    updateEdges()
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateEdges)
    observer.observe(el)
    return () => observer.disconnect()
  }, [updateEdges, options.length])

  // Keep the selected segment centered inside the scroller. Scrolls the
  // scroller itself, never the page (scrollIntoView would also nudge the
  // page to reveal a control that sits below the fold).
  useEffect(() => {
    const el = scrollRef.current
    const item = itemRefs.current.get(value)
    if (!el || !item) return
    el.scrollTo({
      left: item.offsetLeft - (el.clientWidth - item.offsetWidth) / 2,
      behavior: reduceMotion ? 'auto' : 'smooth',
    })
  }, [value, reduceMotion])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const index = options.findIndex((o) => o.value === value)
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % options.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = options.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(options[next].value)
    itemRefs.current.get(options[next].value)?.focus()
  }

  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? 'transparent 0, #000 22px' : '#000 0'}, ${
          edges.right ? '#000 calc(100% - 28px), transparent 100%' : '#000 100%'
        })`
      : undefined

  return (
    <div className={`${fill ? 'w-full' : 'max-w-full'} ${className}`}>
      <div
        ref={scrollRef}
        onScroll={updateEdges}
        className="scrollbar-none relative overflow-x-auto rounded-full"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        <div
          role="radiogroup"
          aria-label={ariaLabel}
          onKeyDown={onKeyDown}
          className={`segmented ${fill ? 'flex w-full' : 'inline-flex'}`}
        >
          {options.map((o) => {
            const active = o.value === value
            return (
              <button
                key={o.value}
                ref={(el) => {
                  if (el) itemRefs.current.set(o.value, el)
                  else itemRefs.current.delete(o.value)
                }}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onChange(o.value)}
                className={`segmented-item ${fill ? 'flex-1' : 'shrink-0'} ${active ? 'segmented-item-active' : ''}`}
              >
                {active && (
                  <motion.span
                    layoutId={thumbId}
                    className="segmented-thumb"
                    transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 38 }}
                  />
                )}
                <span className="relative z-10 flex items-center justify-center gap-1.5 whitespace-nowrap">
                  {o.label}
                  {o.count !== undefined && (
                    <span className={`segmented-count ${o.count === 0 ? 'segmented-count-zero' : ''}`}>{o.count}</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
