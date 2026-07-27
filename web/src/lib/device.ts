// Best-effort mobile-device check (userAgent sniffing) — good enough for
// deciding UX affordances like "open the WhatsApp app" vs. relying on a
// desktop-only flow; not used for anything security-sensitive.
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(navigator.userAgent)
}
