// Tiny pub-sub for one-off app toasts (e.g. "low GMP" warnings) that don't
// come from a Supabase realtime subscription — rendered by ToastHost
// alongside the WhatsApp-notification toasts it already shows.
export type ToastTone = 'info' | 'warning' | 'good' | 'critical'

export interface ToastMessage {
  id: string
  tone: ToastTone
  message: string
}

type Listener = (toast: ToastMessage) => void
const listeners = new Set<Listener>()

export function showToast(message: string, tone: ToastTone = 'info') {
  const toast: ToastMessage = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, tone, message }
  listeners.forEach((listen) => listen(toast))
}

export function onToast(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
