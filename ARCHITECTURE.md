# IPO Ledger — Architecture

Current-state technical reference. Docs `01`–`06` are the original planning
docs and predate several features below (IPO import/auto-scrape, bank/UPI
redesign, dark mode, the queue-then-dispatch WhatsApp flow) — this file
reflects what's actually in the code today.

## 1. What this app does

A personal portal for tracking IPO applications made across multiple
friends'/family members' demat accounts. The admin (one person) manages demat
accounts, bank/UPI accounts, IPOs, and applications; the app sends WhatsApp
notifications to account holders when an application is made and when it's
allotted. Members can log in read-only to see their own account, applications,
and messages.

## 2. Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite + TypeScript, Tailwind CSS v4 |
| Routing | react-router-dom v7, route-level code splitting via `React.lazy` |
| Backend | Supabase (Postgres + Row-Level Security, Auth, Edge Functions) |
| Edge Functions runtime | Deno (TypeScript) |
| Scheduled jobs | `pg_cron` + `pg_net` (Postgres extensions, inside Supabase) |
| Hosting | Vercel (static frontend build + one trivial serverless health-check function) |
| External data source | ipoji.com (scraped — no official API) |
| Messaging | WhatsApp Cloud API (Meta Graph API) |

**Important:** this is a Vite SPA, not Next.js. There are no Next.js API
routes. All backend logic lives in Supabase Edge Functions, which are
deployed independently of Vercel via the Supabase CLI — Vercel only builds
and serves the static frontend (plus `web/api/health.ts`, a standalone Vercel
serverless function unrelated to Supabase).

## 3. Folder structure

```
/                              repo root
├── 00-README.md .. 06-*.md    original planning docs (product/architecture/API spec/build plan/WhatsApp setup)
├── ARCHITECTURE.md            this file
├── README.md                  setup, deploy, rollback
├── .github/workflows/ci.yml   lint + typecheck + build on every push/PR
├── .claude/skills/            dev-workflow reference for AI coding agents working in this repo
│
├── web/                       the React app (Vercel's build root)
│   ├── api/health.ts          Vercel serverless function — GET /api/health
│   ├── vercel.json            SPA rewrites + security headers
│   ├── src/
│   │   ├── main.tsx, App.tsx  entry point, router, error boundary, lazy-loaded routes
│   │   ├── lib/supabase.ts    Supabase client singleton + describeFunctionError() helper
│   │   ├── types/database.ts  hand-written types mirroring the Postgres schema
│   │   ├── contexts/          AuthContext (session/profile), ThemeContext (light/dark)
│   │   ├── components/        shared UI: AppShell (sidebar+mobile nav), ErrorBoundary,
│   │   │                      PageSpinner, ThemeToggle, IpoTimeline, NotificationToastHost,
│   │   │                      ProtectedRoute, ConfigBanner
│   │   └── pages/
│   │       ├── LoginPage.tsx
│   │       ├── admin/         Dashboard, Accounts, BankAccounts, IPOs, Applications,
│   │       │                  AllotmentBoard, Notifications
│   │       └── member/        MyAccount, MyApplications, MyMessages (read-only)
│   └── package.json
│
└── supabase/
    ├── migrations/            0001..0012, applied in order (see §5)
    └── functions/
        ├── _shared/           cors.ts, http.ts (jsonResponse/jsonError/logging), ipoji.ts (scraper)
        ├── add-demat/         admin-only: encrypt PAN, insert/update demat_accounts
        ├── reveal-pan/        admin-only: decrypt PAN, log access
        ├── invite-member/     admin-only: invite a member, link to their demat account
        ├── send-whatsapp/     DB-webhook + admin-dispatch: queue then send WhatsApp messages
        ├── wa-webhook/        Meta calls this: verification handshake + delivery-status updates
        ├── import-ipos/       admin-only: on-demand ipoji.com scrape (list + detail modes)
        └── auto-import-ipos/  cron-only: scheduled ipoji.com scrape + auto-upsert
```

## 4. How the frontend talks to the backend

Two paths, deliberately kept separate:

1. **Direct Postgres access via `supabase-js`**, for all plain CRUD (reading
   IPOs, applications, accounts; inserting/updating/deleting most rows).
   Row-Level Security is the *only* authorization layer here — there is no
   custom REST API in front of Postgres. The browser only ever holds the
   public `anon` key; RLS policies (keyed off `auth.uid()` and an `is_admin()`
   helper) decide what each request can see or touch.
2. **Edge Functions**, invoked via `supabase.functions.invoke(name, { body })`,
   for anything that needs a secret the browser must never see (the PAN
   encryption key, the WhatsApp access token) or that needs to bypass RLS
   under a controlled check (service-role client + an explicit admin check
   inside the function). See §6.

The React Query-less pattern here is simple `useEffect` + `useState` per page
— no client-side cache/query library. Each page fetches what it needs on
mount (and the "New application" form re-fetches its dropdown data every time
it's opened, not just once, so newly added accounts/IPOs show up immediately).

## 5. Data model

Defined across `supabase/migrations/0001`–`0012`. Core tables:

- **`profiles`** — 1:1 with `auth.users`; `role` is `admin` or `member`.
  Auto-created on signup via a trigger (`handle_new_user`).
- **`demat_accounts`** — holder name, E.164 phone, PAN (see §7), a demat
  account number (`dp_client_id`), optional `linked_user_id` (set once a
  member is invited).
- **`bank_accounts`** — one or more per demat account: `account_holder_name`
  (optional), `upi_id`, `bank_name` (both optional — UPI-only entries are
  valid), `is_default`. Managed on its own page (`/bank-accounts`), not
  nested inside the account form, so admin can freely combine holder × bank
  when applying to different IPOs.
- **`ipos`** — company/price-band/lot-size/dates/registrar, plus
  `gmp_notes`, `issue_size` (total), `retail_issue_size` (computed from
  ipoji's per-IPO retail allocation %, not a fixed 35%).
- **`applications`** — one row per (IPO × demat account) — a unique
  constraint on `(ipo_id, demat_id)` enforces "one application per PAN per
  IPO" at the DB level. `status`: `APPLIED → ALLOTTED|NOT_ALLOTTED → SOLD`.
- **`notifications`** — one row per WhatsApp message (real or simulated).
  `status`: `QUEUED → SENT|SIMULATED|FAILED`, later updated to
  `DELIVERED`/`READ` by Meta's delivery-status webhook.
- **`registrar_links`**, **`pan_access_log`** — supporting/audit tables.
- **`v_allotment_board`** — a view joining applications+ipos+demat+bank for
  the Allotment board screen.

Every table has RLS enabled: admin policies (`using (is_admin())`) grant full
access; member policies grant `select` only, scoped to rows reachable from
their own `linked_user_id`.

## 6. Edge Functions in detail

| Function | Auth | Purpose |
|---|---|---|
| `add-demat` | admin JWT | Validates phone (10 digits) + PAN format server-side, encrypts PAN with the `PAN_KEY` secret, inserts or updates (pass `demat_id`) `demat_accounts`. |
| `reveal-pan` | admin JWT | Decrypts a PAN for the "Copy PAN" action, logs the access to `pan_access_log`. |
| `invite-member` | admin JWT | Sends a Supabase auth invite email, links the new user to a demat account. |
| `send-whatsapp` | `x-webhook-secret` (DB webhook) **or** admin JWT (manual dispatch) | Two jobs in one function: (1) webhook branch — on `applications` INSERT/UPDATE→ALLOTTED, **queues** a notification row (builds the message content, does *not* send). (2) dispatch branch — `{ notification_id }` from the UI's Send/Retry button actually calls the WhatsApp Graph API (or **simulates** if `WA_ACCESS_TOKEN`/`WA_PHONE_NUMBER_ID` aren't set yet, logging status `SIMULATED` instead of a confusing OAuth error). |
| `wa-webhook` | Meta's HMAC signature (`META_APP_SECRET`) | GET = verification handshake. POST = delivery-status updates, matched back to a `notifications` row by `wa_message_id`. |
| `import-ipos` | admin JWT | On-demand: `{mode:"list", source}` scrapes ipoji's current/upcoming listing; `{mode:"detail", detail_url}` scrapes one IPO's detail page for allotment/listing dates, registrar, and retail issue size. Read-only — never writes to the DB itself. |
| `auto-import-ipos` | `x-cron-secret` | Same scrape as above, called every 4 hours by `pg_cron` (migration 0009), and **does** write — upserts (by company name, case-insensitive) any candidate with complete required fields (open/close date, lot size); skips incomplete ones. |

**Why the queue-then-dispatch split for WhatsApp:** originally the webhook
sent immediately, but that meant every application/allotment auto-fired a
message with no review step. It now only queues; sending is an explicit
admin action from the Applications/Allotment-board/Notifications pages.

**Why `send-whatsapp`/`wa-webhook`/`auto-import-ipos` are deployed with
`--no-verify-jwt`:** none of their callers (a DB webhook, Meta, a cron job)
can supply a Supabase-issued user JWT. Each authenticates itself instead
(shared-secret header or HMAC signature), checked inside the function.

## 7. Security model

- **PAN encryption**: plaintext PAN exists only transiently inside
  `add-demat`/`reveal-pan`, using `PAN_KEY` (an Edge Function secret, never
  in Postgres config, never in git). At rest, `demat_accounts` stores only
  `pan_encrypted` (pgcrypto `pgp_sym_encrypt`), `pan_masked` (display), and
  `pan_hash` (sha256, for the uniqueness constraint without decrypting).
  The `insert_demat_encrypted`/`update_demat_encrypted`/`decrypt_pan` SQL
  functions are `security definer`, restricted to `service_role` — a client
  can only reach them through the Edge Functions above.
- **RLS** is the only authorization layer for direct CRUD (see §5) — even a
  buggy or malicious client request can't read another member's rows.
- **Secrets** live in two places only: Supabase Edge Function secrets
  (`PAN_KEY`, `DB_WEBHOOK_SECRET`, `CRON_SECRET`, WhatsApp/Meta vars) and
  Vercel's environment variables (the two `VITE_*` vars, which are public by
  design — see §8). Nothing else.
- **Migrations that needed a real secret value** (0004, 0007, 0009) keep a
  `__PLACEHOLDER__` in the committed file; the real value is substituted
  locally from `supabase/.secrets.local` (gitignored) only at the moment the
  migration is pushed, then reverted before committing.
- **CORS** is currently `*` on all Edge Functions (see README's "known
  limitations" — reasonable for a single-admin tool, worth tightening to the
  production origin once it's stable).

## 8. Environment variables

| Variable | Where it lives | Controls |
|---|---|---|
| `VITE_SUPABASE_URL` | `web/.env.local` (dev) / Vercel dashboard (prod) | Which Supabase project the frontend talks to. Public — safe to expose (RLS is the real gate). |
| `VITE_SUPABASE_ANON_KEY` | same | The anon key used by `supabase-js`. Public by design. |
| `PAN_KEY` | Supabase Edge Function secret only | Symmetric key for PAN encrypt/decrypt. Never in Vercel, never in git. |
| `DB_WEBHOOK_SECRET` | Supabase Edge Function secret only | Shared secret the `applications` DB webhook sends in `x-webhook-secret` to authenticate itself to `send-whatsapp`. |
| `CRON_SECRET` | Supabase Edge Function secret only | Shared secret `pg_cron`'s scheduled HTTP call sends in `x-cron-secret` to authenticate to `auto-import-ipos`. |
| `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID` | Supabase Edge Function secret only | WhatsApp Cloud API credentials. Unset until Meta setup (doc 06) is done — `send-whatsapp` simulates sends until then. |
| `META_APP_SECRET`, `WA_VERIFY_TOKEN` | Supabase Edge Function secret only | Verify Meta's webhook signature / handshake. |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` | Auto-provided to every Edge Function by Supabase | Service-role DB access from within functions. Never set manually, never exposed to the browser. |

## 9. Authentication/authorization flow

1. Email/password or Google OAuth via Supabase Auth (`supabase.auth.signInWithPassword` / `signInWithOAuth`).
2. On signup, a DB trigger (`handle_new_user`) creates a `profiles` row defaulting to `role = 'member'`.
3. The very first admin is promoted manually via SQL (`update profiles set role='admin' where id=...`) — there's no self-service admin signup.
4. Members are invited by the admin (`invite-member` function), which links their new `auth.users` id to an existing `demat_accounts` row via `linked_user_id`.
5. `AuthContext` holds the session + profile; `ProtectedRoute` redirects unauthenticated users to `/login`, and gates `requireAdmin` routes to `profile.role === 'admin'`.
6. From there, RLS does the real enforcement (§5/§7) — the frontend route guard is UX, not the security boundary.

## 10. Deployment flow

- **Frontend (Vercel)**: connected to the GitHub repo. Push to `master` →
  production deploy. Pull requests get their own preview deployment URL
  automatically once the repo is connected (no extra config needed — this is
  default Vercel/GitHub integration behavior).
- **CI (GitHub Actions)**: `.github/workflows/ci.yml` runs on every push and
  PR — install, lint, typecheck+build. This gates visibility into build
  health; it does not gate Vercel's deploy (Vercel builds independently).
  There is currently no automated test suite — CI verifies the build
  compiles and lints clean, not behavioral correctness.
- **Backend (Supabase)**: deployed separately, via the Supabase CLI, not
  through Vercel or GitHub Actions. Migrations: `npx supabase db push`.
  Functions: `npx supabase functions deploy <name>`. See README for the
  full command list.
- **Versioning**: git tags (`vX.Y.Z`) mark production releases; see README
  for the tagging convention and both rollback methods.

## 11. Running locally

```powershell
cd web
npm install
cp .env.example .env.local   # fill in your Supabase project's URL + anon key
npm run dev                   # http://localhost:5173
```

Supabase-side local dev (migrations, functions) goes through the Supabase
CLI against your actual hosted project — see README §"Local development" and
`.claude/skills/ipo-ledger-dev/SKILL.md` for the exact command sequence and
the secret-placeholder pattern used when a migration needs a real value.
