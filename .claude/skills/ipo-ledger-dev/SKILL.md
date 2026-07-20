---
name: ipo-ledger-dev
description: Use when running, building, or deploying this IPO Ledger app — starting the dev server, deploying Supabase Edge Functions, pushing migrations that contain secrets, or looking up test accounts / architecture facts specific to this repo.
---

# IPO Ledger — dev workflow

Monorepo: `/web` (React + Vite + TS + Tailwind v4) and `/supabase` (migrations,
Edge Functions). Linked Supabase project ref: `nzflndquzlzafrbyivyz`. Full docs
in `00-README.md` through `06-whatsapp-setup.md` at the repo root.

## Dev server

```powershell
cd web
npm run dev        # http://localhost:5173/
npm run build       # tsc -b && vite build — run before every commit
```

`node`/`npm`/`git` PATH is not inherited automatically in a fresh PowerShell
process on this machine — refresh it first if commands aren't found:
```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
```

## Supabase CLI (installed as a `web` devDependency, invoke via `npx --prefix web`)

Run from the repo root, not `web/` — `supabase/` lives at the root:
```powershell
npx --prefix web supabase functions deploy <name>              # default: verify_jwt on
npx --prefix web supabase functions deploy <name> --no-verify-jwt  # for functions that authenticate themselves (see below)
npx --prefix web supabase db push                                # apply pending migrations
npx --prefix web supabase migration list                         # check local vs remote status
```

`--no-verify-jwt` is used for `send-whatsapp`, `wa-webhook`, `auto-import-ipos`
— all three authenticate via their own shared-secret header rather than a
Supabase-issued user JWT, since they're called by a DB webhook / Meta / cron,
none of which have a user session.

## Secrets: the placeholder pattern

**Never commit a real secret value into a tracked migration file.** Several
migrations (0004 DB_WEBHOOK_SECRET, 0007 PAN_KEY, 0009 CRON_SECRET) need a
real secret value to run but keep a placeholder (`__DB_WEBHOOK_SECRET__` etc.)
in the version that's committed. The real values live in
`supabase/.secrets.local` (gitignored, `*.local` pattern in root `.gitignore`).

To run one of these migrations (or write a new one needing a secret):
1. Read the real value from `supabase/.secrets.local`.
2. Edit the migration file, substituting the real value for the placeholder.
3. `npx --prefix web supabase db push`.
4. Immediately edit the file back to the placeholder before committing.

If 0001–0003-style migrations were ever applied by hand via the SQL Editor
(bypassing the CLI), the remote migration history won't know about them and
`db push` will try to rerun them and fail on "already exists." Fix with:
```powershell
npx --prefix web supabase migration repair --status applied <version> [<version>...]
```

Function secrets (`PAN_KEY`, `DB_WEBHOOK_SECRET`, `CRON_SECRET`, plus the
WhatsApp ones once Meta setup is done) are set via
`npx --prefix web supabase secrets set "KEY=value"`.

## Architecture facts worth knowing before changing things

- **PAN encryption**: plaintext PAN only ever exists inside the `add-demat` /
  `reveal-pan` Edge Functions, briefly, using the `PAN_KEY` secret passed into
  `insert_demat_encrypted` / `update_demat_encrypted` / `decrypt_pan` SQL
  functions (service_role-only, `search_path = public, extensions` since
  pgcrypto lives in the `extensions` schema on Supabase, not `public`).
- **WhatsApp send flow is queue-then-dispatch, not immediate**: the DB webhook
  on `applications` INSERT/UPDATE only queues a `notifications` row (status
  `QUEUED`) via `send-whatsapp`'s webhook branch. Nothing sends until an admin
  clicks Send/Retry in the UI, which calls the same function with
  `{ notification_id }`. While `WA_ACCESS_TOKEN`/`WA_PHONE_NUMBER_ID` are
  unset (no Meta setup done yet), dispatch simulates instead of calling the
  real Graph API (status `SIMULATED`) — flips to real sending automatically
  the moment those secrets are set, no code change needed.
- **ipoji.com scraping** lives in `supabase/functions/_shared/ipoji.ts`
  (`fetchListCandidates`, `fetchDetail`) — shared by `import-ipos` (admin,
  on-demand) and `auto-import-ipos` (cron, every 4h via `pg_cron`+`pg_net`,
  scheduled in migration 0009). No official ipoji API; this is HTML scraping
  via `deno-dom` against verified real selectors (`.ipo-card`, `.facts-row
  .fact-item`, etc.) — if ipoji redesigns their site, both functions break the
  same way and need re-inspecting the live HTML (fetch with a browser
  `User-Agent` and grep for `ipo-card`/`facts-row`).
- **IPO upsert is by company name** (case-insensitive exact match via
  `.ilike`), not a DB unique constraint — re-importing the same IPO updates
  the existing row rather than duplicating it.
- **Test accounts**: 4 fictional demat accounts seeded in migration 0007
  (Ramesh Kumar, Priya Sharma, Amit Verma, Sneha Iyer) — safe to delete
  anytime from the Accounts page.
