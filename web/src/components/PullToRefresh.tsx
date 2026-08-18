import { useRef, useState, type ReactNode, type TouchEvent as ReactTouchEvent } from 'react'
import { LogoMark } from './Logo'

const TRIGGER_DISTANCE = 64
// Rubber-band feel — the further someone drags, the less additional travel
// they get per pixel of finger movement, same idea as iOS's own overscroll.
const RESISTANCE = 0.45
const MAX_PULL = 90

// Wraps AppShell's scrollable route content — the whole app scrolls the
// window/body (no inner overflow container, see AppShell's <main>), so this
// tracks window.scrollY rather than the wrapper's own scrollTop. Default
// onRefresh (a full reload) is deliberate: pages fetch their own data via
// independent per-page effects/realtime channels, not a shared store one
// gesture could re-trigger — a reload is the one refresh action guaranteed
// correct for every page without wiring a refetch hook into each of them.
export function PullToRefresh({ children, onRefresh }: { children: ReactNode; onRefresh?: () => Promise<void> | void }) {
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef<number | null>(null)
  const touchOnly = useRef(typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches)

  function onTouchStart(e: ReactTouchEvent) {
    if (!touchOnly.current || refreshing) return
    // Only arms the gesture when already at the very top — otherwise an
    // ordinary downward scroll mid-page would get hijacked into a pull.
    if (window.scrollY > 0) return
    startY.current = e.touches[0].clientY
  }

  function onTouchMove(e: ReactTouchEvent) {
    if (startY.current == null || refreshing) return
    const delta = e.touches[0].clientY - startY.current
    if (delta <= 0) {
      setPull(0)
      return
    }
    setPull(Math.min(MAX_PULL, delta * RESISTANCE))
  }

  async function onTouchEnd() {
    if (startY.current == null || refreshing) {
      startY.current = null
      return
    }
    startY.current = null
    if (pull >= TRIGGER_DISTANCE * RESISTANCE) {
      setRefreshing(true)
      setPull(TRIGGER_DISTANCE * RESISTANCE)
      try {
        if (onRefresh) await onRefresh()
        else window.location.reload()
      } finally {
        setRefreshing(false)
        setPull(0)
      }
    } else {
      setPull(0)
    }
  }

  const progress = Math.min(1, pull / (TRIGGER_DISTANCE * RESISTANCE))

  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      {/* Height-driven, not absolutely positioned — pushes the content down
          as it grows so the reveal reads as "the page itself stretching,"
          not an overlay floating on top of unmoved content. */}
      <div
        className="flex items-center justify-center overflow-hidden"
        style={{
          height: pull,
          opacity: progress,
          transition: pull === 0 || refreshing ? 'height 0.25s cubic-bezier(0.16,1,0.3,1), opacity 0.2s' : 'none',
        }}
      >
        <div
          style={{
            transform: `scale(${0.6 + progress * 0.4}) rotate(${refreshing ? 0 : progress * 180}deg)`,
            transition: refreshing ? 'none' : 'transform 0.1s linear',
          }}
        >
          <LogoMark size={28} animated={refreshing} />
        </div>
      </div>
      {children}
    </div>
  )
}
