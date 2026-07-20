// Vercel serverless function (zero-config: any file under /api becomes one).
// Not typechecked by our tsc build (tsconfig.app.json only includes src/) —
// Vercel transpiles this independently at deploy time.
//
// This only confirms the Vercel deployment itself is up. It does NOT check
// Supabase, since the actual backend (Postgres + the 5 Edge Functions) is a
// separate service outside this deployment — Supabase's own project page
// shows its status independently.
export default function handler(req: { method?: string }, res: {
  status: (code: number) => { json: (body: unknown) => void }
  setHeader: (name: string, value: string) => void
}) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    status: 'ok',
    service: 'ipo-ledger-web',
    time: new Date().toISOString(),
  })
}
