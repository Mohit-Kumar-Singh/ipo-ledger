import { useEffect, useState } from 'react'
import { onConfirmRequest, resolveConfirm, type ConfirmRequest } from '../lib/confirmDialog'

// Themed replacement for window.confirm — the native browser popup looks
// nothing like the rest of this app on a phone (OS chrome, not app UI).
// Mounted once in AppShell, alongside ToastHost.
export function ConfirmDialogHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null)

  useEffect(() => onConfirmRequest(setReq), [])

  useEffect(() => {
    if (!req) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') respond(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req])

  function respond(result: boolean) {
    if (!req) return
    resolveConfirm(req.id, result)
    setReq(null)
  }

  if (!req) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => respond(false)} />
      <div
        className="animate-page-in relative w-full max-w-sm space-y-4 rounded-2xl p-5"
        style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-lg)' }}
      >
        <p className="text-sm" style={{ color: 'var(--ink-primary)' }}>
          {req.message}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => respond(false)} className="btn-secondary">
            {req.cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => respond(true)}
            className={req.tone === 'critical' ? 'btn-secondary' : 'btn-primary'}
            style={
              req.tone === 'critical'
                ? { background: 'var(--critical)', color: '#ffffff', borderColor: 'var(--critical)' }
                : undefined
            }
          >
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
