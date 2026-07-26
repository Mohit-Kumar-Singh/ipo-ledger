# Google sign-in — Setup Guide (one-time)

Frontend code is already built and deployed — the "Continue with Google"
button on the Login page (`web/src/pages/LoginPage.tsx`) already calls
`supabase.auth.signInWithOAuth({ provider: 'google' })`. What's left is
entirely Google Cloud + Supabase Dashboard configuration — no code changes
needed, no cost either way. Screens move around — verify against
console.cloud.google.com and your Supabase dashboard when you do this.

## Steps

1. **Create/pick a Google Cloud project** — console.cloud.google.com →
   project picker (top bar) → New Project (any name, e.g. "IPO Ledger") →
   Create.

2. **Get your Supabase callback URL first** — open
   https://supabase.com/dashboard/project/nzflndquzlzafrbyivyz/auth/providers?provider=Google
   and copy the **Callback URL (for OAuth)** shown there. It should be:
   ```
   https://nzflndquzlzafrbyivyz.supabase.co/auth/v1/callback
   ```
   (Use whatever the dashboard actually shows, in case this changes.)

3. **Configure the OAuth consent screen** — console.cloud.google.com/auth/overview
   (same project) →
   - **User type**: External (unless you have a Google Workspace org — not the
     case here).
   - **App name**: "IPO Ledger" (or similar), your email as support/contact.
   - **Scopes**: add `openid` — `.../auth/userinfo.email` and
     `.../auth/userinfo.profile` are included by default.
   - Since this app is only for ~20 known people, you don't need to submit
     for Google's verification review — an unverified app works fine as long
     as everyone who signs in is added under **Audience → Test users** (see
     step 5), or you leave it in "Testing" publishing status.

4. **Create OAuth client credentials** — console.cloud.google.com/auth/clients
   → Create Client → **Application type: Web application** →
   - **Authorized JavaScript origins**: add both
     `https://mohit-kumar-singh-ipo-ledger.vercel.app` and
     `http://localhost:5173` (for local dev).
   - **Authorized redirect URIs**: paste the Supabase callback URL from
     step 2.
   - Create → copy the **Client ID** and **Client secret** shown.

5. **Add test users (only if consent screen is still "Testing")** —
   Audience tab → Test users → Add users → the Gmail addresses of everyone
   who'll sign in (yourself + friends/family). Skip this if you published the
   app (not required for a private ~20-person tool).

6. **Paste into Supabase** — same provider page as step 2 → toggle
   **Enable Sign in with Google** on → paste **Client ID** and **Client
   Secret** → Save.

7. **Test** — on the deployed app (or `localhost:5173`), Login page →
   "Continue with Google" → pick/sign in with a Google account → should
   redirect back in, signed in. New Google sign-ins land as `role='member'`
   with no linked demat account until an admin links one (Accounts page →
   "Link to registered member"), same as email/phone sign-ups.

## Common failure modes
| Symptom | Likely cause |
|---|---|
| `redirect_uri_mismatch` error from Google | The redirect URI pasted in step 4 doesn't exactly match Supabase's callback URL (trailing slash, http vs https, wrong project ref) |
| "Access blocked: this app's request is invalid" | Consent screen not configured, or app is in Testing and the Google account isn't in the Test users list |
| Redirects back to the app but not signed in | Client ID/Secret in Supabase don't match the Google Cloud client, or the toggle isn't saved on |
