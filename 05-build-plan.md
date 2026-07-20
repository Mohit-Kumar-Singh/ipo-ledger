# IPO Ledger Portal — Build Plan

**Version:** 1.0. Estimates assume evenings/weekends alongside your Accenture work. Each phase ends in something usable.

---

## Phase 0 — Accounts & approvals (Week 1, mostly waiting time)
- Create GitHub repo, Supabase project, Vercel project (all free signups).
- **Start Meta setup immediately — it has the only real lead time:** Meta Business Portfolio → verify business (personal-use tip: business verification is only mandatory to go past 250 conversations/day; the unverified tier is fine for your volume, display name approval still needed) → add WhatsApp product → register a phone number (needs a number NOT already on a WhatsApp app; a spare SIM works) → create System User + permanent token → submit the 3 UTILITY templates from doc 04.
- Deliverable: dev environment ready, templates approved.

## Phase 1 — Data layer + auth (Week 1–2)
- Run `03-database-schema.sql` as migration; verify RLS with two test users (admin + member) using Supabase SQL editor impersonation.
- Scaffold React app (Vite + TS + Tailwind + supabase-js), login/signup pages, role-based routing (admin layout vs member layout).
- Seed your own user as admin.
- Exit test: member test-user can only see rows linked to them — verified from the browser network tab.

## Phase 2 — Core CRUD UI (Week 2–3)
- Accounts screen (add/edit holder, banks, PAN via `insert_demat` RPC, masked display).
- IPO screen (add/edit, derived status chips, registrar link).
- Applications: create form with auto bid-amount, duplicate-PAN error handling, status timeline.
- Allotment board: Copy PAN (via `reveal-pan`), open-registrar button, one-tap Allotted/Not-allotted, bulk not-allotted.
- Dashboard v1 (counts + action lists).
- Exit test: full apply→allot flow works with WhatsApp sending still stubbed (console.log).

## Phase 3 — WhatsApp integration (Week 3–4)
- Implement `send-whatsapp` + `wa-webhook` Edge Functions; wire DB webhooks; set secrets.
- Point Meta webhook URL at `wa-webhook`; verify handshake; send test template to your own number.
- Notifications log UI + failed-send retry button.
- Exit test: creating a real application sends a real WhatsApp to a test contact; delivery status flips to `DELIVERED` in the log.
- **Go-live:** add real accounts (after telling each friend and getting their OK to store PAN + phone), deploy `main` to Vercel, add PWA manifest so it installs on your phone.

## Phase 4 — Member portal & polish (Week 4–5)
- `invite-member` function + invite UI; member screens (my account, my applications, my messages).
- Listing-day sell price capture → per-holder P&L.
- Optional: scheduled Edge Function (Supabase cron) sends `ipo_sell_reminder` on listing-day morning; also serves as the weekly keep-alive ping.

## Phase 5 — Hardening (ongoing)
- `pan_access_log` migration; error monitoring (Supabase logs + Vercel); DB backup export monthly (free tier has no PITR); template re-approval if wording changes.

---

## Effort summary

| Phase | Focus | Rough effort |
|---|---|---|
| 0 | Signups + Meta approvals | 2–3 hrs active |
| 1 | Schema + auth | 6–8 hrs |
| 2 | CRUD UI | 12–16 hrs |
| 3 | WhatsApp | 6–8 hrs |
| 4 | Members + P&L | 8–10 hrs |

## Risks & mitigations
- **Template rejection** → keep wording transactional (doc 04 drafts are written to pass UTILITY review); resubmit with tweaks.
- **Registrar URLs change** → they're data (`registrar_links` table), not code; edit in UI/SQL.
- **Free-tier project pause** → weekly cron function (phase 4) or normal usage prevents it.
- **Token expiry mid-flow** → use System User *permanent* token, never the 24-hour test token, and store only in function secrets.
- **Compliance note** → applying on others' PANs is common practice but each application must be genuinely authorized by the holder and funded per exchange/SEBI rules; the consent + WhatsApp trail this portal creates is itself your protection. Keep it.

## Definition of done (MVP)
One real IPO cycle completed end-to-end through the portal: applications logged, every holder got the applied message automatically, allotment marked from the board, allotted holders got the sell message automatically, member login verified by at least one friend.
