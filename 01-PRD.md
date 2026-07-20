# IPO Ledger Portal — Product Requirements Document (PRD)

**Version:** 1.0 · **Owner:** Jigyansh · **Date:** 20 Jul 2026
**Status:** Draft for build

---

## 1. Problem statement

Jigyansh applies for Indian IPOs from multiple friends'/family members' demat accounts to maximise allotment chances. Today this is tracked informally, which creates three recurring problems: account holders don't know an application was made from their account (and miss the UPI/ASBA mandate approval), allotment status must be checked manually per PAN on registrar websites, and after allotment the holder must be chased to sell on listing day.

## 2. Goal

A free, browser-based portal (works on mobile and desktop) that acts as the single source of truth for demat accounts, IPO applications, and allotment outcomes — and automatically sends WhatsApp messages to account holders at the two moments that matter: **when an application is made** and **when an allotment is confirmed**.

## 3. Users and roles

| Role | Who | Can do |
|---|---|---|
| **Admin** | Jigyansh (and any future co-admin) | Everything: manage accounts, IPOs, applications, trigger/see all messages, invite members |
| **Member** | A friend/family member whose demat account is in the system | Log in and view **only their own** demat account(s), the applications made from them, allotment status, and messages sent to them. Read-only. |

Members are invited by the admin (email invite). A member's login is linked to their demat account record(s). Members never see other members' PANs, banks, or applications.

## 4. Core features (MVP — Phase 1–3)

### 4.1 Authentication
- Email + password and Google sign-in (Supabase Auth).
- Admin role assigned manually to your user id; everyone else defaults to member.
- Member invite flow: admin enters friend's email → invite link → on first login the account is auto-linked to their demat record.

### 4.2 Demat account registry
- Fields: holder name, mobile (WhatsApp number, E.164 format), PAN, broker (Zerodha/Groww/Angel/…), DP/Client ID, linked bank accounts (bank name, last-4 digits, UPI ID), notes.
- PAN stored encrypted, displayed masked (`ABCPXXXXXX`) with a reveal + copy action for admin only.
- One holder can have multiple bank accounts.

### 4.3 IPO master
- Fields: company name, symbol, exchange (NSE/BSE/both), price band (low/high), lot size, open date, close date, allotment date, listing date, registrar (MUFG Intime / KFintech / Bigshare / Cameo / Skyline / Maashitla / other), registrar allotment-check URL, GMP notes (optional free text).
- Status derived from dates: Upcoming → Open → Closed → Allotment out → Listed.

### 4.4 Applications
- Create: pick IPO + demat account + bank account used + lots + category (Retail/HNI/Shareholder/Employee) → bid amount auto-calculated (lots × lot size × cut-off price).
- Lifecycle: `APPLIED → ALLOTTED | NOT_ALLOTTED → SOLD` (SOLD only from ALLOTTED).
- On creation → **auto WhatsApp "applied" message** to the account holder (includes IPO name, bank used, amount blocked, mandate-approval reminder).
- On status → ALLOTTED → **auto WhatsApp "allotted" message** (includes listing date and instruction to sell on listing day).
- Guard: one application per (IPO × PAN) — the portal blocks duplicates, because multiple applications on one PAN get rejected by the exchange.

### 4.5 Allotment workday view
- For a chosen IPO, list every application with: holder, masked PAN, **Copy PAN** button, **Open registrar page** button (deep link), and Allotted / Not-allotted quick-mark buttons.
- Registrar pages are captcha-protected with no public API, so status marking is manual — this view makes it a 10-second job per account.
- Bulk action: "Mark selected as Not allotted".

### 4.6 Notifications log
- Every WhatsApp message stored: recipient, template used, variables, WhatsApp message id, delivery status (sent/delivered/read/failed) updated via webhook.
- Failed sends surface on the dashboard with a retry button.

### 4.7 Dashboard (admin)
- Open IPOs closing soon; applications with mandate possibly pending (applied < 24h ago); IPOs past allotment date with unchecked applications; allotted-but-not-sold list with listing dates; message failures.

### 4.8 Member view
- "Your account" (own demat + banks, masked PAN), "Your applications" with status timeline, "Messages sent to you".

## 5. Nice-to-have (Phase 4+, not MVP)
- Listing-day P&L capture (sell price → gain per application, cumulative per holder).
- Auto-import IPO calendar from a data source instead of manual entry.
- Sell-reminder message auto-sent on listing-day morning (scheduled function).
- Settlement ledger: who owes whom (if you fund applications from your money).

## 6. Non-functional requirements
- **Cost:** ₹0 hosting (Supabase free tier + Vercel free tier); WhatsApp utility messages ≈ ₹0.10–0.12 each (verify current Meta rate card).
- **Access:** responsive web, installable as PWA on phone home screen.
- **Security/privacy:** PAN + phone are sensitive PII. Postgres row-level security on every table; PAN encrypted at rest; HTTPS everywhere; no PII in logs; India DPDP Act basics — collect consent from friends before storing their PAN/phone, delete on request.
- **Auditability:** every status change and message stored with timestamp + acting user.

## 7. Key user flows

**Flow A — Apply day:** Admin opens IPO → "New application" → selects account + bank + lots → Save → system sends WhatsApp to holder → holder approves UPI mandate.

**Flow B — Allotment day:** Admin opens Allotment view → per row: Copy PAN → Open registrar → sees result → taps Allotted/Not → on Allotted, system sends "sell on listing date" WhatsApp.

**Flow C — Member checks:** Friend logs in → sees own application: "Tata Capital — ALLOTTED — listing 28 Jul — please sell on listing day".

## 8. Out of scope
- Placing/selling orders via broker APIs (each holder sells from their own broker app).
- Auto-scraping registrar allotment status (captcha; brittle and against ToS).
- Storing full bank account numbers (last-4 + bank name only — enough to identify which account was used).

## 9. Success criteria
- Zero missed mandate approvals after go-live.
- Allotment status for all accounts of an IPO recorded within 15 minutes of registrar publish.
- Every allotted holder receives the sell message the same day, automatically.
