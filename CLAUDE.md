# CLAUDE.md

Working notes for Claude Code in this repo. Read `ARCHITECTURE.md` for the
full system design — this file is the shorter, load-bearing complement:
conventions and hard-won gotchas that aren't visible just from reading code.

## Docs freshness

`ARCHITECTURE.md` describes itself as "current-state" but drifts every time a
feature ships without a doc update — it does not yet mention the demat/bank
link-request-and-approve flow, funder-side application visibility, self-service
unlink, or the Combobox component (all shipped v1.29.0–v1.33.3). `01`–`06` are
explicitly the original planning docs and are further behind. Neither yet
mentions the constrained `demat_accounts.platform` enum (0074, replaced the
free-text "which app" field) or the admin-managed `sell_instruction_pdfs`
library + `sell-instructions` private Storage bucket + listing-day
SELL_REMINDER send flow (0075, v1.134.0). Treat both as
directional, not authoritative — for current behavior, prefer `git log
--oneline` and the actual migrations/code over trusting these docs blindly.

## RLS is the only authorization layer — and it's row-level, not column-level

Every page does `supabase.from(table).select(...)` with no server beyond
Postgres and no client-side admin gating on reads — RLS policies are the
entire access-control boundary (see `ARCHITECTURE.md` §7). Two consequences
that have already caused real bugs (v1.32.0 → hotfixed across v1.32.1,
v1.33.2, v1.33.3):

1. **A `for select using (...)` policy grants the whole row**, not the columns
   you had in mind. Adding funder visibility onto `applications` in 0032 also
   meant adding a matching grant on `demat_accounts` — and the first version
   of that grant leaked `phone_e164`/`dp_client_id`/`profit_share_percent`/
   `notes` to anyone who merely funded an application, not just `holder_name`
   (fixed in 0034). If a new viewer relationship should only see *a name*, use
   a narrow `security definer` resolver function instead of a row-level grant
   — see `resolve_profile_names`, `resolve_demat_holder_names`,
   `get_demat_holder_name`. Same logic applies to `notifications` (0036) and
   any other table with a sensitive column sitting next to a benign one.

2. **Cross-table policies can form an RLS cycle.** 0032 added a policy on
   `demat_accounts` that reads `applications`+`bank_accounts`, and a policy on
   `applications` that reads `bank_accounts` — combined with an existing
   `bank_accounts` policy that reads `demat_accounts`+`applications`, Postgres
   couldn't even plan a query against any of the three ("infinite recursion
   detected in policy for relation X", 42P17) — and the frontend swallowed the
   error silently (checked `data`, not `error`), so it just looked like empty
   tables, not a crash. Fixed in 0033 by routing the new cross-table checks
   through `stable security definer` helper functions, which bypass RLS on the
   tables *they* read internally, breaking the cycle. **Before adding any
   policy that reads a second RLS-enabled table, check whether that table's
   existing policies read back into the first one.**

3. **Verify by running a query, not by reading SQL.** All three bugs above
   were caught after the migration was already pushed, not before — reading a
   policy and reasoning about it is not the same as evaluating it. After
   writing or changing an RLS policy, actually run a scoped query as the
   affected role (e.g. via `supabase db push` then a manual `select` in the
   SQL editor, or a quick Edge Function/RPC round-trip) before considering the
   migration done.

## User-facing messages: plain language, never raw errors

Everything a person reads in this app — toasts, form errors, banners, empty
and failure states, confirmation dialogs — must be understandable by someone
non-technical, and say what to do next when there's something to do. A user
once hit `update or delete on table "bank_accounts" violates foreign key
constraint "applications_bank_account_id_fkey"` on a plain Delete click; that
must never reach a screen again.

- **Never show** `error.message`, table/column/constraint names, error codes,
  HTTP statuses, "Load failed", "non-2xx", stack text, or JSON. Route every
  error through `friendlyError(err, fallback?)` (`web/src/lib/friendlyError.ts`)
  — including `describeFunctionError`, and any `{ error: string }` a helper
  returns to a page. Pass a context-specific `fallback` ("Couldn't save that
  application.") so the unknown case still reads naturally.
- `showToast()` also runs its message through `plainMessage()` as a safety net,
  but don't rely on it: call `friendlyError` explicitly so wording fits the
  action.
- **Prevent, don't just explain.** If a delete/save is going to be rejected for
  a predictable reason (still in use, duplicate, missing required data), check
  first and say so in human terms — see `deleteBank` in `BankAccountsPage.tsx`
  (counts dependent applications, points at the unused duplicate) — instead of
  firing the request and translating the failure.
- Teach `friendlyError` new cases (add the table to `TABLE_NOUNS`, add a
  pattern + a case in `friendlyError.test.ts`) when a new kind of failure
  appears, rather than special-casing it at the call site.
- Applies to new UI from the design stage: write the failure copy while
  designing the feature, not after the first bug report. No developer jargon,
  no blame ("You entered…"), short sentences, sentence case.

## Conventions

- **Migrations**: `supabase/migrations/NNNN_description.sql`, sequential,
  never edit one already applied — write a new migration to fix or undo.
  `npx --prefix web supabase migration list` to check local-vs-remote status,
  `db push` to apply. See `.claude/skills/ipo-ledger-dev/SKILL.md` for the
  exact commands and the secret-placeholder pattern for migrations needing a
  real secret value.
- **No client-side admin gating on reads** — every list page fetches with
  `select('*')`-style calls and trusts RLS to scope the result; don't add
  `if (isAdmin)` branches around a fetch as if that were the security
  boundary, and don't assume a UI element being hidden means the underlying
  action is blocked (write actions still need their own RLS check).
- **iOS glass design system** (v1.238–1.241) — one material across the app:
  frosted translucent surfaces, hairline edges, soft depth, iOS system colors
  for tone (`--ios-blue/green/orange/red/purple/gray`), spring press
  feedback. Use the shared classes instead of styling from scratch: `.card`
  (glass panel), `.glass-card` + `.glass-tile` + `.glass-icon` (dashboard
  tiles), `.icon-badge-<tone>` (gradient app-icon tile, white glyph),
  `.icon-btn` (round glass header action), `.page-title` (iOS large title —
  every page `<h1>`), `.section-label` (small-caps group header),
  `.segmented`, `.input`, `.btn-primary/secondary/danger`, `.ios-alert`,
  `.glass-tabbar`, `.ios-toast`. Numbers use `.font-mono-ipo`, which is now
  system sans with tabular figures. Borders default to the `--separator`
  hairline, so `divide-y` needs no color. A glass field/panel blurs whatever
  is BEHIND it — an icon overlaid on an `.input` needs `z-10` or it gets
  blurred away. Never fade a glass surface with ancestor `opacity` (Chrome
  drops the blur mid-fade) — animate `transform` only. `prefers-reduced-
  transparency` falls back to solid fills automatically.
- **No UI component library** — hand-rolled Tailwind v4 classes (`.card`,
  `.btn-primary`, `.badge`, `.input`) plus CSS custom properties for
  light/dark theming (`--ink-primary`, `--accent`, `--border`, etc., see
  `web/src/index.css`). `@radix-ui/react-popover` + `cmdk` were added for the
  searchable Combobox (`web/src/components/Combobox.tsx`) — style new uses of
  either with the existing classes/variables, don't introduce a second design
  language.
- **Version bump on every user-visible push** — bump `web/package.json` +
  `git tag vX.Y.Z`, even for a small fix; classify patch/minor/major honestly
  rather than defaulting to minor.
- **Realtime**: only tables explicitly added to the `supabase_realtime`
  publication push live updates (`notifications`, `applications`,
  `demat_link_requests`, `bank_link_requests` so far) — adding a new
  `.channel().on('postgres_changes', ...)` subscription against a table that
  isn't in the publication will silently never fire.
