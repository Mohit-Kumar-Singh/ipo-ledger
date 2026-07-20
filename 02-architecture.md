# IPO Ledger Portal — Architecture Design

**Version:** 1.0 · **Stack decision:** Supabase + React (zero-cost production)

---

## 1. High-level architecture

```
 ┌──────────────────────────────┐
 │  React SPA (Vite + Tailwind) │  ← hosted free on Vercel, PWA-enabled
 │  claude → you & members       │
 └──────────────┬───────────────┘
                │ supabase-js (HTTPS)
 ┌──────────────▼───────────────────────────────────────────┐
 │                    SUPABASE (free tier)                   │
 │  ┌────────────┐ ┌──────────────────┐ ┌────────────────┐  │
 │  │ Auth        │ │ Postgres + RLS   │ │ Edge Functions │  │
 │  │ email/OAuth │ │ (all app data)   │ │ (Deno/TS)      │  │
 │  └────────────┘ └───────┬──────────┘ └───────┬────────┘  │
 │                         │ DB webhook          │           │
 │                         │ (on insert/update)  │           │
 └─────────────────────────┴─────────────────────┼───────────┘
                                                 │ HTTPS
                                    ┌────────────▼─────────────┐
                                    │  WhatsApp Cloud API      │
                                    │  (Meta Graph API v21+)   │
                                    └────────────┬─────────────┘
                                                 │ status webhook
                                    (back to Edge Function `wa-webhook`)
```

## 2. Component responsibilities

**React SPA** — all UI (dashboard, accounts, IPOs, applications, allotment view, member view). Talks to Postgres directly through supabase-js; RLS is the authorization layer, so the client never needs a custom API for CRUD. Sensitive operations (send WhatsApp, decrypt PAN, invite member) go through Edge Functions only.

**Postgres (with RLS)** — single source of truth. Row-level security enforces admin-vs-member visibility at the database layer, meaning even a buggy or malicious client cannot read another member's rows.

**Edge Functions** (server-side, secrets live here — never in the SPA):
1. `send-whatsapp` — invoked by a database webhook when an application is inserted (→ "applied" template) or its status changes to ALLOTTED (→ "allotted" template). Reads recipient + variables, calls the Cloud API, writes a row to `notifications`.
2. `wa-webhook` — Meta calls this. Handles the GET verification challenge and POST delivery-status updates (sent/delivered/read/failed) → updates `notifications.status`.
3. `reveal-pan` — admin-only; decrypts and returns a PAN (used by the Copy PAN button). Keeps the encryption key out of the browser.
4. `invite-member` — admin-only; creates the auth invite and links the new user id to a demat account record.

**WhatsApp Cloud API** — Meta-hosted; no server of yours runs WhatsApp. You register a business phone number, create message templates, get a permanent access token. Business-initiated messages MUST use pre-approved templates (see 06-whatsapp-setup.md).

## 3. Why this shape (decision log)

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Backend | Supabase | Free tier covers DB+auth+functions; zero servers to manage; RLS solves multi-tenant visibility natively | Spring Boot: free framework but no free always-on JVM hosting without ops burden (Oracle VPS) or cold starts (Render) |
| DB | Postgres | Relational fits ledger data (FKs, constraints, one-application-per-PAN unique index); portable to Spring Boot later | MongoDB: no gain here, weaker constraints |
| API layer | supabase-js + RLS (no custom REST for CRUD) | Less code, auth enforced in DB | Custom Express/Spring API: more code, same result |
| WhatsApp | Cloud API direct | Official, free to integrate, per-message cost trivial | Twilio: same API resold with markup; wa.me links: manual taps |
| Messaging trigger | DB webhook → Edge Function | Message sending is a side-effect of data change; guarantees a log row per attempt | Client calls API directly: token in browser = leak risk |
| Frontend hosting | Vercel | Free, git-push deploys, custom domain possible | GitHub Pages: no problem either, Vercel nicer previews |

## 4. Security design

- **Secrets** (WhatsApp token, PAN encryption key, service-role key) exist only as Supabase Edge Function secrets. The SPA ships only the public anon key, which is safe because RLS gates every row.
- **PAN encryption**: `pgp_sym_encrypt` (pgcrypto) with a key held in function secrets; table stores ciphertext + a masked column for display. Decryption only via `reveal-pan` (admin JWT required).
- **RLS model**: `profiles.role ∈ {admin, member}`. Admin policies: `USING (is_admin())`. Member policies: rows reachable from `demat_accounts.linked_user_id = auth.uid()`. Members get SELECT only; INSERT/UPDATE/DELETE policies exist for admin alone.
- **Webhook auth**: `wa-webhook` validates Meta's `X-Hub-Signature-256` (HMAC of body with app secret); `send-whatsapp` validates the Supabase webhook secret header.
- **Duplicate-PAN guard** is a DB unique index, not client logic, so it cannot be bypassed.
- **Phone format**: store E.164 (`+91XXXXXXXXXX`); validated at insert with a CHECK constraint.

## 5. Data flow — the two golden paths

**Application created**
1. Admin submits form → `INSERT INTO applications` (RLS: admin only).
2. Postgres webhook (INSERT on applications) fires → `send-whatsapp`.
3. Function loads holder phone + template vars → POST `graph.facebook.com/v21.0/{phone_id}/messages`.
4. Insert `notifications` row with `wa_message_id`, status `sent`.
5. Meta later POSTs delivery status → `wa-webhook` → status updated to `delivered`/`read`/`failed`.
6. Dashboard shows failures for retry.

**Allotment marked**
1. Admin taps "Allotted" → `UPDATE applications SET status='ALLOTTED'`.
2. Webhook (UPDATE, old.status≠new.status) → `send-whatsapp` with the allotted template (includes listing date).
3. Same logging path as above.

## 6. Environments & repos

- Single monorepo: `/web` (React), `/supabase` (migrations, functions, seed). One Supabase project (free tier allows 2 — use the second as dev if wanted). Vercel preview deploys per PR.
- Local dev: `supabase start` (local Postgres in Docker) + `npm run dev`.

## 7. Free-tier limits sanity check (verify current numbers at signup)

- Supabase free: ~500 MB DB, 50k monthly active users, 500k Edge Function invocations/mo, project pauses after ~7 days inactivity (restore from dashboard; a weekly cron ping or just normal usage avoids it).
- Vercel free: 100 GB bandwidth/mo — orders of magnitude above need.
- Scale reality: ~20 accounts × ~60 IPOs/yr × a few messages each ⇒ a few thousand rows/year. Free tier is permanent headroom.

## 8. Migration path to Spring Boot (if ever wanted)

Schema is plain Postgres — point Spring Data JPA at it, re-implement the 4 Edge Functions as services, replace supabase-js calls with your REST API, swap Supabase Auth for Spring Security + JWT. Nothing in the data model is Supabase-proprietary except RLS policies (which become service-layer checks).
