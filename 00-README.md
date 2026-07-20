# IPO Ledger Portal — Documentation Set

Production-level personal portal for managing IPO applications across friends'/family demat accounts, with database (Postgres), authentication (admin + member roles), and automatic WhatsApp notifications.

**Stack:** React (Vite) on Vercel · Supabase (Postgres + RLS, Auth, Edge Functions) · WhatsApp Cloud API. Total hosting cost: ₹0; messaging cost: pennies.

| Doc | What it covers | Read when |
|---|---|---|
| `01-PRD.md` | Features, roles, user flows, scope, success criteria | First — this is the contract for what we're building |
| `02-architecture.md` | System design, security model, decision log, data flows | Before writing any code |
| `03-database-schema.sql` | Runnable Postgres migration: tables, constraints, RLS policies, seed data | Phase 1 — run it as-is |
| `04-api-and-functions.md` | The 4 Edge Functions, WhatsApp template texts, client↔DB contract | Phase 2–3 |
| `05-build-plan.md` | Phased plan with exit tests, effort estimates, risks | To schedule the work |
| `06-whatsapp-setup.md` | One-time Meta/WhatsApp Cloud API setup, step by step | Phase 0 — start this first (approvals take time) |

## The two automated moments
1. Application inserted → holder gets: *"I've applied for X IPO from your account using HDFC ••4321 — please approve the UPI mandate."*
2. Status marked ALLOTTED → holder gets: *"X IPO is allotted, listing date Y — sell on listing day."*

## Next actions
1. Skim 01 and confirm scope (anything to add/cut?).
2. Do Phase 0 from 06 (spare SIM needed for the WhatsApp number).
3. Then we build Phase 1 together — schema is ready to run.
