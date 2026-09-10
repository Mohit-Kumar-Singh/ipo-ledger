// iOS Safari (especially in Low Power Mode, or on a weak/handoff-ing
// connection) intermittently rejects a `fetch` with a bare
// `TypeError: Load failed` — the request never reaches the server. supabase-js
// surfaces that through its normal error channel as `{ error: { message:
// 'TypeError: Load failed' } }` with NO Postgres `code`. The ipoji sync
// panel fires a burst of writes with `Promise.all` and no retry, so one
// unlucky request there failed a whole row ("Imported 0 … 5 failed,
// TypeError: Load failed").
//
// This retries ONLY that transient class — a thrown TypeError, or a
// supabase-style result whose `error` has no `.code` and reads like a
// transport failure. A real Postgres/RLS error (has a `code`, or a
// recognisable message) is returned immediately, never retried.

const TRANSIENT_MESSAGE = /load failed|failed to fetch|networkerror|network error|the network connection was lost|timed out|timeout|connection (was )?(lost|closed|reset)|ERR_NETWORK|ERR_CONNECTION/i

function looksTransient(err: unknown): boolean {
  if (err instanceof TypeError) return true
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown; name?: unknown }
  // A PostgREST / Postgres error always carries a string code (e.g. '23505',
  // '42501', 'PGRST116'). If there's a code, it's a real server response —
  // don't retry it.
  if (typeof e.code === 'string' && e.code.length > 0) return false
  if (e.name === 'TypeError') return true
  return typeof e.message === 'string' && TRANSIENT_MESSAGE.test(e.message)
}

export interface RetryOptions {
  retries?: number
  baseDelayMs?: number
  label?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Runs `fn` and, if it throws OR resolves to a supabase `{ error }` that
// looks like a dropped connection, waits and tries again (exponential
// backoff + jitter). Returns whatever `fn` returns on the first
// non-transient outcome (success or a real error), or the last transient
// result once retries are exhausted.
//
// `fn` returns a PromiseLike, not necessarily a real Promise — supabase-js's
// query builders are thenable but not Promise instances, and calling them
// through here shouldn't require an extra `await`/wrapper at the call site.
export async function withRetry<T>(fn: () => PromiseLike<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3
  const base = opts.baseDelayMs ?? 500
  let lastResult: T | undefined
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn()
      const maybeError = (result as { error?: unknown } | null)?.error
      if (maybeError && looksTransient(maybeError) && attempt < retries) {
        lastResult = result
        await sleep(base * 2 ** attempt + Math.random() * 250)
        continue
      }
      return result
    } catch (err) {
      if (looksTransient(err) && attempt < retries) {
        await sleep(base * 2 ** attempt + Math.random() * 250)
        continue
      }
      throw err
    }
  }
  // Exhausted — hand back the last transient result so the caller reports a
  // real (if unhelpful) message rather than hanging.
  return lastResult as T
}

// True when a supabase result's `error` is the "connection never landed"
// kind — lets a caller show "check your connection and retry" instead of a
// raw "TypeError: Load failed", and know that nothing was written.
export function isTransientNetworkError(err: unknown): boolean {
  return looksTransient(err)
}
