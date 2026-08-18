import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Logo } from './Logo'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// A stale tab open across a deploy is the single most common cause of a
// render-time crash here — the browser still has an old index.html
// referencing a JS chunk whose filename hash no longer exists on the
// server (Vite renames every asset per build), so the dynamic import()
// for a lazily-loaded page 404s. Every browser phrases that failure
// differently, so match all three rather than one.
function isStaleDeployError(error: Error): boolean {
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(
    error.message,
  )
}

// Catches render/lifecycle errors anywhere below it so one broken page can't
// blank the whole app. Does NOT catch errors in event handlers or async code
// (React never routes those here) — those are handled per-page already via
// try/catch + inline error state.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      const staleDeploy = isStaleDeployError(this.state.error)
      return (
        <div
          className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center"
          style={{ background: 'var(--page)' }}
        >
          <Logo size={44} />
          {staleDeploy ? (
            <>
              <h1 className="text-lg font-semibold" style={{ color: 'var(--ink-primary)' }}>
                A new version is up
              </h1>
              <p className="max-w-sm text-sm" style={{ color: 'var(--ink-muted)' }}>
                This tab was still open from before an update — restart the app to pick up the new version.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold" style={{ color: 'var(--ink-primary)' }}>
                Something went wrong
              </h1>
              <p className="max-w-sm text-sm" style={{ color: 'var(--ink-muted)' }}>
                This page hit an unexpected error. Try reloading — if it keeps happening, the details are in your
                browser console.
              </p>
            </>
          )}
          <button onClick={() => window.location.reload()} className="btn-primary">
            {staleDeploy ? 'Restart app' : 'Reload'}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
