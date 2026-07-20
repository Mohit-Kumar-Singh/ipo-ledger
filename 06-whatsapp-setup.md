# WhatsApp Cloud API — Setup Guide (one-time)

This is the only part of the project with external approvals, so do it first (Phase 0). Steps below reflect the Meta flow as of mid-2026 — screens move around, so verify against developers.facebook.com/docs/whatsapp/cloud-api when you do it.

## What you need before starting
- A phone number **not registered on any WhatsApp app** (a spare/secondary SIM is the usual answer — you must be able to receive one OTP SMS/call on it).
- A Facebook account and a Meta Business Portfolio (create at business.facebook.com — you can name it "Jigyansh IPO Desk"; individual/sole-proprietor style portfolios are fine).

## Steps

1. **Create the app** — developers.facebook.com → Create App → type "Business" → attach your Business Portfolio → add the **WhatsApp** product.

2. **Register your phone number** — WhatsApp → API Setup → Add phone number → verify via OTP. Note the **Phone Number ID** and **WhatsApp Business Account (WABA) ID** shown on this screen — the Phone Number ID goes into function secrets as `WA_PHONE_NUMBER_ID`.

3. **Get a PERMANENT token** (the token on the API Setup page dies in 24h — don't ship it):
   Business Settings → Users → **System Users** → Add (name: `ipo-ledger-bot`, role: Admin) → Assign Assets → your app (full control) + your WABA → **Generate Token** → select scopes `whatsapp_business_messaging`, `whatsapp_business_management` → choose "never expires" → copy once and store as `WA_ACCESS_TOKEN` secret.

4. **App secret** — App Settings → Basic → App Secret → store as `META_APP_SECRET` (used to verify webhook signatures).

5. **Submit message templates** — WhatsApp Manager (business.facebook.com/wa/manage) → Message Templates → Create:
   - Category **Utility**, language English, names exactly `ipo_applied`, `ipo_allotted`, `ipo_sell_reminder`, bodies from doc 04 §4 with `{{1}}…{{4}}` variables and sample values filled in.
   - Utility templates about the user's own transaction usually approve within minutes–hours. If one bounces, remove anything money-promissory and resubmit.

6. **Configure the webhook** (after Phase 3 deploys `wa-webhook`):
   App → WhatsApp → Configuration → Webhook → Callback URL = `https://<project-ref>.supabase.co/functions/v1/wa-webhook`, Verify token = your `WA_VERIFY_TOKEN` secret → Verify & Save → subscribe to the **messages** field (delivery statuses arrive under it).

7. **Test** — API Setup page → send the hello_world template to your own number via the provided curl, then send your `ipo_applied` template with test variables. Confirm your webhook receives the `delivered` status.

## Recipient rules you must know
- **Template messages can be sent to any WhatsApp number at any time** — this is your case (business-initiated notifications). Free-form (non-template) messages are only allowed within 24h after the person last messaged you.
- Before business verification, an app can message a **limited number of unique recipients per day (tier starts at 250)** — far above your ~20 friends, so business verification is optional for you.
- Recipients do NOT need to opt in on WhatsApp's side, but Meta policy requires *you* to have their consent — tell each friend you'll be sending these updates (you're doing this anyway when collecting their PAN).

## Cost reality (India, verify current rate card)
- Business-initiated **utility** template messages: roughly ₹0.10–0.12 each.
- Your volume: ~20 accounts × ~2 messages × a few IPOs/month ⇒ **well under ₹50/month**, billed to a card added in Business Settings → Billing. Some accounts get a monthly free utility allowance — check the current pricing page.

## Common failure codes
| Code | Meaning | Fix |
|---|---|---|
| 190 | Token expired/invalid | You used the 24h test token — switch to System User token |
| 132000 / 132001 | Template params/name mismatch or not approved | Match `{{n}}` count exactly; check approval status |
| 131026 | Recipient not a WhatsApp user | Verify the number; store E.164 with +91 |
| 131047 | Outside 24h window | Only affects free-form messages — use templates |
| 100 | Bad Phone Number ID | Re-copy `WA_PHONE_NUMBER_ID` |
