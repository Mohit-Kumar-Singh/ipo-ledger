// Promise-based replacement for window.confirm — same pub-sub shape as
// toast.ts, but a single in-flight request at a time (a second call before
// the first resolves auto-resolves the first as `false`, since there's only
// one dialog surface to show it in). Native confirm() renders as the
// browser's own OS-chrome popup, which looks nothing like the rest of this
// app on a phone — this renders as a themed card via ConfirmDialogHost
// instead (mounted once in AppShell, alongside ToastHost).
export interface ConfirmRequest {
  id: string
  message: string
  confirmLabel: string
  cancelLabel: string
  tone: 'default' | 'critical'
}

type RequestListener = (req: ConfirmRequest) => void
type ResolveListener = (id: string, result: boolean) => void
const requestListeners = new Set<RequestListener>()
const resolveListeners = new Set<ResolveListener>()

export function confirmDialog(
  message: string,
  opts?: { confirmLabel?: string; cancelLabel?: string; tone?: 'default' | 'critical' },
): Promise<boolean> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const req: ConfirmRequest = {
    id,
    message,
    confirmLabel: opts?.confirmLabel ?? 'Confirm',
    cancelLabel: opts?.cancelLabel ?? 'Cancel',
    tone: opts?.tone ?? 'default',
  }
  return new Promise((resolve) => {
    const onResolve: ResolveListener = (resolvedId, result) => {
      if (resolvedId !== id) return
      resolveListeners.delete(onResolve)
      resolve(result)
    }
    resolveListeners.add(onResolve)
    requestListeners.forEach((listen) => listen(req))
  })
}

export function onConfirmRequest(listener: RequestListener): () => void {
  requestListeners.add(listener)
  return () => requestListeners.delete(listener)
}

export function resolveConfirm(id: string, result: boolean) {
  resolveListeners.forEach((listen) => listen(id, result))
}
