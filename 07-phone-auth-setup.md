# Phone OTP login via MSG91 — Setup Guide (one-time)

The app's frontend and backend code for phone sign-in is already built and
deployed (`LoginPage.tsx`'s Phone tab, `supabase/functions/sms-hook/`). What's
left is entirely external account/dashboard setup. Screens move around —
verify against msg91.com and supabase.com/dashboard when you do this.

## Read this first: DLT registration is the real blocker, not MSG91

Sending OTP SMS to Indian (+91) numbers legally requires **DLT registration**
with an Indian telecom operator — a TRAI regulation that applies to *every*
SMS provider (Twilio, MSG91, all of them), not something MSG91-specific.
Standard DLT registration asks for a **GST certificate**, which a personal/
hobby project like this one won't have. Practical ways through that for an
individual:
- Some DLT portals accept a **personal PAN as a "sole proprietor" / "individual
  consumer" entity type** instead of GST — MSG91 support (chat on their
  dashboard) can tell you same-day whether that's available on the operator
  they route you to.
- If it isn't in practice, **phone OTP login may not be realistically doable
  without a registered business** — in that case, Email + Google sign-in
  (already fully working) are reasonable primary methods, and phone can stay
  parked. Don't sink hours into DLT paperwork before confirming with MSG91
  support that individual registration is actually accepted.

## What you need before starting
- A phone number to test with (receiving the OTP).
- An MSG91 account (msg91.com → Sign up).

## Steps

1. **Sign up at MSG91** and get your **Auth Key**: Dashboard → API → Configure
   (or Dashboard home, top-right). Save it — this becomes the `MSG91_AUTH_KEY`
   secret.

2. **DLT entity registration** — MSG91 Dashboard → DLT (or the guided banner
   they show new accounts) → register as an entity on the operator they
   route you to. See the caveat above; ask MSG91 support if unsure whether
   your registration type applies to an individual.

3. **Create an OTP template ("Flow")** — MSG91 Dashboard → Flow → Create Flow
   (or "SendOTP" → Add Template depending on current UI):
   - Content must match what DLT approves, containing exactly one variable
     for the code, e.g.: `Your IPO Ledger login code is ##OTP##. Do not
     share this code with anyone.`
   - Submit for DLT approval (can take from minutes to ~1 business day).
   - Once approved, note the **Template ID** (Flow → your template → copy
     ID) — this becomes `MSG91_TEMPLATE_ID`. The variable name used in the
     function (`OTP`) must match the variable name in your template exactly
     — check it in the Flow editor and adjust `supabase/functions/sms-hook/
     index.ts`'s `recipients: [{ mobiles: ..., OTP: sms.otp }]` line if your
     template names it differently.

4. **Enable the Send SMS Hook in Supabase** — Dashboard → your project →
   Authentication → Hooks → **Send SMS hook** → Enable → type **HTTPS** →
   Endpoint URL:
   ```
   https://nzflndquzlzafrbyivyz.supabase.co/functions/v1/sms-hook
   ```
   Save — Supabase generates a **Secret** in the form `v1,whsec_...`. Copy it;
   this becomes `SEND_SMS_HOOK_SECRET`.

5. **Enable Phone as a sign-in provider** — Authentication → Providers →
   Phone → toggle **Enable Phone provider** on. (The SMS-provider dropdown
   underneath it doesn't matter once the Send SMS hook above is on — the hook
   takes over delivery.)

6. **Set the three secrets and deploy:**
   ```powershell
   npx --prefix web supabase secrets set MSG91_AUTH_KEY="<from step 1>"
   npx --prefix web supabase secrets set MSG91_TEMPLATE_ID="<from step 3>"
   npx --prefix web supabase secrets set SEND_SMS_HOOK_SECRET="v1,whsec_...<from step 4>"
   npx --prefix web supabase functions deploy sms-hook --no-verify-jwt
   ```
   (`--no-verify-jwt` because this function is called by Supabase Auth itself
   with a Standard-Webhooks-signed request, not a user JWT — same reason
   `send-whatsapp`, `wa-webhook`, and `auto-import-ipos` use it.)

7. **Test** — on the deployed app, Login page → Phone tab → enter a real
   +91 number → Send code. Check the `sms-hook` function's Logs tab in the
   Supabase dashboard if nothing arrives; a 401 there means the webhook
   secret is wrong, a 502 means MSG91 rejected the send (check its error body
   in the log — usually a DLT template mismatch).

## Common failure modes
| Symptom | Likely cause |
|---|---|
| No code arrives, function logs show nothing | Send SMS hook not enabled, or endpoint URL wrong |
| Function logs `invalid signature` (401) | `SEND_SMS_HOOK_SECRET` doesn't match the Dashboard's current hook secret (re-copy it — it regenerates if you disable/re-enable the hook) |
| Function logs `sms provider error` (502) | Check the logged MSG91 response — almost always a DLT template ID/variable-name mismatch, or template not yet approved |
| MSG91 send succeeds but SMS never arrives | Number not eligible for the DLT-registered header/route, or entity/template still pending approval — check MSG91 dashboard delivery report |
