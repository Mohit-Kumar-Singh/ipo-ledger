// Shared response + structured-logging helpers for Edge Functions. Supabase
// surfaces console output in each function's Logs tab in the dashboard — JSON
// lines keep that greppable/filterable instead of free-text.
import { corsHeaders } from './cors.ts'

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status)
}

export function logRequest(fn: string, req: Request) {
  console.log(JSON.stringify({ level: 'info', fn, method: req.method, url: req.url, ts: new Date().toISOString() }))
}

export function logError(fn: string, err: unknown) {
  console.error(
    JSON.stringify({
      level: 'error',
      fn,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      ts: new Date().toISOString(),
    }),
  )
}
