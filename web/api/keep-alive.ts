// Vercel Cron target (see vercel.json's "crons") — pings Supabase's REST API
// once a day so the project is never idle long enough to hit the free tier's
// ~7-day auto-pause. This is genuinely external traffic hitting the public
// API gateway (unlike an in-database pg_cron -> pg_net call, which we already
// had scheduled every 4h for auto-import-ipos and which evidently wasn't
// enough to prevent a pause — this is a second, independent safety net, not
// a replacement for that one).
//
// Not typechecked by our tsc build (tsconfig.app.json only includes src/) —
// Vercel transpiles this independently at deploy time.
export default async function handler(
  req: { headers: Record<string, string | string[] | undefined> },
  res: {
    status: (code: number) => { json: (body: unknown) => void }
    setHeader: (name: string, value: string) => void
  },
) {
  res.setHeader('Cache-Control', 'no-store')

  // Vercel signs cron-triggered requests with this header — reject anything
  // else so this endpoint can't be used to proxy arbitrary Supabase reads.
  const isVercelCron = Boolean(req.headers['x-vercel-cron'])
  if (!isVercelCron && process.env.NODE_ENV === 'production') {
    res.status(403).json({ error: 'forbidden' })
    return
  }

  const url = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    res.status(500).json({ error: 'Supabase env vars not configured on this deployment' })
    return
  }

  try {
    const start = Date.now()
    const supaRes = await fetch(`${url}/rest/v1/registrar_links?select=registrar&limit=1`, {
      headers: { apikey: anonKey },
    })
    res.status(200).json({
      status: 'ok',
      supabase_status: supaRes.status,
      ms: Date.now() - start,
      time: new Date().toISOString(),
    })
  } catch (err) {
    res.status(502).json({ error: String(err instanceof Error ? err.message : err) })
  }
}
