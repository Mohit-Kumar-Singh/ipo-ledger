import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
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
      return (
        <div
          className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center"
          style={{ background: 'var(--page)' }}
        >
          <h1 className="text-lg font-semibold" style={{ color: 'var(--ink-primary)' }}>
            Something went wrong
          </h1>
          <p className="max-w-sm text-sm" style={{ color: 'var(--ink-muted)' }}>
            This page hit an unexpected error. Try reloading — if it keeps happening, the details are in your
            browser console.
          </p>
          <button onClick={() => window.location.reload()} className="btn-primary">
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
