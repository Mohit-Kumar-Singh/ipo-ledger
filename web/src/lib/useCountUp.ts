import { useEffect, useState } from 'react'

// Counts up from 0 to `target` on mount/change instead of snapping straight
// to the number — small nod to the animated-figures feel of consumer
// investing apps (Groww etc.), shared by the Dashboard stat tiles and the
// IPO progress gauge so both read as the same motion system.
export function useCountUp(target: number, duration = 500) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (target === 0) {
      setValue(0)
      return
    }
    let raf: number
    const start = performance.now()
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(target * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return value
}
