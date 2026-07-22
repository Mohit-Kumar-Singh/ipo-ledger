# IPO Ledger

A personal portal for tracking IPO applications made across multiple demat
accounts, with automatic WhatsApp notifications on application and allotment.

Full technical reference: **[ARCHITECTURE.md](ARCHITECTURE.md)**. Product/build
planning docs: [00-README.md](00-README.md) through [06-whatsapp-setup.md](06-whatsapp-setup.md).

**Stack:** React (Vite) on Vercel · Supabase (Postgres + RLS, Auth, Edge Functions) · WhatsApp Cloud API.

---

## Sign-in methods — one-time Supabase dashboard setup

The Login page supports email/password, Google, and phone OTP. Email/password
works out of the box. The other two need providers enabled in **Supabase
dashboard → Authentication → Providers** before they'll actually work (the
buttons will otherwise fail with a clear "provider not enabled" error):

**Google**
1. In [Google Cloud Console](https://console.cloud.google.com), create an
   OAuth 2.0 Client ID (Web application). Authorized redirect URI:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`.
2. Supabase dashboard → Authentication → Providers → **Google** → enable, paste
   the Client ID and Client Secret.

**Phone (SMS OTP)**
1. Supabase dashboard → Authentication → Providers → **Phone** → enable.
2. Pick and configure an SMS provider (Twilio, MessageBird, Vonage, or
   TextLocal) with their API credentials — this is a separate paid account,
   billed per SMS by that provider, not by Supabase.

Registration is intentionally open (anyone can create an account via any of
these three methods) — a new account gets read-only `member` access with
nothing linked to it until an admin connects it to a demat account from the
**Accounts** page ("Link to registered member").

---

## Local development

```powershell
cd web
npm install
cp .env.example .env.local
```

Fill in `web/.env.local`:

```
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon key>
```

Both values: Supabase dashboard → your project → **Project Settings → API**.

```powershell
npm run dev       # http://localhost:5173
npm run build     # production build (also what CI and Vercel run)
npm run lint       # oxlint
```

The dev server talks directly to your real Supabase project (there's no local
Postgres in this workflow) — see `.claude/skills/ipo-ledger-dev/SKILL.md` for
the full Supabase CLI command reference (deploying functions, pushing
migrations, the secret-placeholder pattern).

---

## Deploying to Vercel

### One-time setup (manual — you need to do this in the Vercel dashboard)

1. **Import the GitHub repo** into Vercel (New Project → select
   `Mohit-Kumar-Singh/ipo-ledger`).
2. **Root Directory**: set to `web` (the repo is a monorepo — `web/` is the
   frontend, `supabase/` is deployed separately via the Supabase CLI, not by
   Vercel). Framework preset should auto-detect as **Vite**.
3. **Environment Variables** (Project Settings → Environment Variables) — add
   for **Production, Preview, and Development**:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | your Supabase project URL |
   | `VITE_SUPABASE_ANON_KEY` | your Supabase anon key |

   Nothing else goes here — every other secret (`PAN_KEY`, WhatsApp tokens,
   etc.) belongs only in Supabase's Edge Function secrets, never in Vercel.
   See [ARCHITECTURE.md §8](ARCHITECTURE.md#8-environment-variables) for the
   full list and why.
4. Deploy. Once connected, **Preview Deployments for pull requests are on by
   default** — no extra config needed; every PR gets its own preview URL
   automatically, and pushes to `master` deploy to production.

### Ongoing deploys

Just `git push` to `master`. Vercel builds and deploys automatically; GitHub
Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint +
typecheck + build on the same push so you can see build health in the PR/commit
status independent of Vercel's own build.

### Backend changes (Supabase) are a separate deploy step

Pushing to GitHub does **not** deploy database migrations or Edge Functions —
those are Supabase-side and must be deployed explicitly:

```powershell
npx --prefix web supabase db push                      # apply new migrations
npx --prefix web supabase functions deploy <name>       # deploy one function
```

Run these from the repo root before or after merging, as appropriate for what
changed. See `.claude/skills/ipo-ledger-dev/SKILL.md` for the full pattern
(including the placeholder-secret handling for migrations that need one).

---

## Versioning & rollback

### Tagging a release

Every production release gets a git tag, [semver](https://semver.org)-style,
**and `web/package.json`'s `version` field is kept in sync with it** (without
the `v` prefix — tag `v1.1.0` ↔ `"version": "1.1.0"`). This is standing
practice, not a one-off: any push that ships user-visible changes (a new
feature, a fix, a redesign) bumps both together, not just one.

```powershell
# 1. bump web/package.json's "version" to match
# 2. commit that as part of (or right after) the change itself
git tag -a v1.1.0 -m "v1.1.0: short description of what shipped"
git push origin master
git push origin v1.1.0
```

- **Patch** (`v1.0.1`): bug fixes, no behavior/schema change.
- **Minor** (`v1.1.0`): new features, backward-compatible.
- **Major** (`v2.0.0`): breaking change (e.g. a migration that isn't backward
  compatible, or a rework of core flows).

`git tag` (no args) lists all releases; `git show v1.1.0` shows what a tag points to.

### Rolling back a bad deploy

Two options — pick based on how urgent it is:

**Option A — Vercel Instant Rollback (fastest, zero-downtime, no git changes)**

Use this first if the site is actively broken for users right now.

1. Vercel dashboard → your project → **Deployments**.
2. Find the last known-good deployment (matches a previous tag/commit).
3. Click **⋯ → Instant Rollback**.

This repoints production traffic to the old build instantly, without a new
build or touching git — the fastest way to stop the bleeding. It's a
*traffic* rollback, not a code rollback: your `master` branch still has the
bad commit until you also fix it in git (do that next, not urgently).

**Option B — `git revert` (proper code rollback)**

Use this once things are stable again, or if the bad change also needs to be
undone at the source (e.g. it touched a Supabase migration/function too,
which Instant Rollback can't undo).

```powershell
git log --oneline                 # find the commit(s) to undo
git revert <bad-commit-sha>        # creates a new commit undoing it
git push origin master
```

This creates a *new* commit (history-preserving, unlike `reset --hard`), and
pushing it triggers a normal Vercel deploy of the reverted code. If the bad
release also included a Supabase migration or function change, revert/redeploy
those too via the commands in "Backend changes" above — Instant Rollback only
affects the Vercel-hosted frontend, never Supabase.

---

## Known limitations (see ARCHITECTURE.md for full detail)

- No automated test suite yet — CI currently verifies lint + typecheck +
  build, not behavior. Worth adding if the app grows.
- Edge Function CORS is `*` (open) — fine for a single-admin tool, worth
  tightening to the production origin once it's stable.
- `vercel.json`'s Content-Security-Policy allows `'unsafe-inline'` for
  scripts/styles, because the app uses inline `style={{}}` throughout and a
  small inline `<script>` (dark-mode flash prevention) in `index.html`.
  Tightening this further would mean moving those to external
  files/hashed sources — a real option later, not done here.
