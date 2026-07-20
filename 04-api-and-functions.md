# IPO Ledger Portal — Edge Functions & Integration Spec

**Version:** 1.0. CRUD needs no custom API (supabase-js + RLS). Only side-effects and secret-touching operations are server functions.

---

## 1. `send-whatsapp`

**Trigger:** Supabase Database Webhook →
- `INSERT` on `applications` → template `ipo_applied`
- `UPDATE` on `applications` where `old.status <> new.status AND new.status = 'ALLOTTED'` → template `ipo_allotted`

**Auth:** validate `x-webhook-secret` header equals function secret `DB_WEBHOOK_SECRET`. Reject otherwise (401).

**Logic:**
1. Parse webhook payload → `application_id`, event kind.
2. Query (service-role client): application + ipo + demat holder (`phone_e164`, `holder_name`) + bank (`bank_name`, `last4`).
3. Build template variables (see §4).
4. `POST https://graph.facebook.com/v21.0/{WA_PHONE_NUMBER_ID}/messages`
   ```json
   {
     "messaging_product": "whatsapp",
     "to": "+919XXXXXXXXX",
     "type": "template",
     "template": {
       "name": "ipo_applied",
       "language": { "code": "en" },
       "components": [{ "type": "body", "parameters": [
         {"type":"text","text":"Ramesh"},
         {"type":"text","text":"Tata Capital"},
         {"type":"text","text":"HDFC ••4321"},
         {"type":"text","text":"1 lot / ₹14,950"}
       ]}]
     }
   }
   ```
   Header: `Authorization: Bearer ${WA_ACCESS_TOKEN}`.
5. Insert `notifications` row: `wa_message_id` from response, status `SENT`; on HTTP error, status `FAILED` + `error_detail`.
6. Idempotency: skip if a notification of the same `type` for this `application_id` already exists with status ≠ FAILED (webhooks can re-deliver).

**Errors to expect:** 131047 (24h window — not applicable to templates), 132000/132001 (template name/param mismatch), 131026 (recipient not on WhatsApp), 190 (token expired — use a System User permanent token, see setup doc).

---

## 2. `wa-webhook`

**Called by:** Meta.

- **GET** — verification handshake: if `hub.verify_token == WA_VERIFY_TOKEN` return `hub.challenge` (200, plain text).
- **POST** — status updates. Validate `X-Hub-Signature-256` = HMAC-SHA256(raw body, `META_APP_SECRET`). Payload contains `entry[].changes[].value.statuses[]` with `{id, status, errors?}` → `UPDATE notifications SET status = upper($status), error_detail = ..., updated_at = now() WHERE wa_message_id = $id`. Always respond 200 quickly.

---

## 3. `reveal-pan`  (admin only)

**Request:** `POST /reveal-pan { "demat_id": "<uuid>" }` with user JWT.
**Logic:** verify caller's JWT → check `profiles.role = 'admin'` → `select pgp_sym_decrypt(pan_encrypted, $PAN_KEY) from demat_accounts where id = $1` → return `{ "pan": "ABCPK1234F" }`. Log access (who/when) to a `pan_access_log` table (add in migration 2). Never cache in client beyond the copy action.

Companion RPC for inserts, so plaintext PAN never rests in the DB:
```sql
create or replace function insert_demat(p_name text, p_phone text, p_pan text, ...)
returns uuid security definer ...
-- inside: pan_encrypted = pgp_sym_encrypt(p_pan, current_setting('app.pan_key')),
--         pan_masked = left(p_pan,5) || '****' || right(p_pan,1),
--         pan_hash = encode(digest(upper(p_pan),'sha256'),'hex')
```
(Alternatively do encrypt-in-function inside an `add-demat` Edge Function — pick one, don't do both.)

---

## 4. WhatsApp message templates (submit for approval in Meta Business Manager, category: UTILITY)

**`ipo_applied`** (en)
> Hi {{1}}, I've applied for the *{{2}}* IPO from your account using {{3}} — {{4}}. You may get a UPI/ASBA mandate request from your bank; please *approve it today* so the application goes through. The amount stays blocked in your account until allotment. — Jigyansh

**`ipo_allotted`** (en)
> Hi {{1}}, good news! The *{{2}}* IPO applied from your account has been *ALLOTTED* 🎉 ({{3}}). Listing date: *{{4}}*. Plan: sell on listing day — I'll message you that morning. Shares will be visible in your demat by listing. — Jigyansh

**`ipo_sell_reminder`** (en, phase 4)
> Hi {{1}}, today is listing day for *{{2}}*. Please sell the allotted shares ({{3}}) from your broker app after listing, or call me and I'll guide you. — Jigyansh

Notes: UTILITY templates about a transaction the user is party to are normally approved within minutes-to-hours. Avoid promotional wording ("earn", "profit guaranteed") — that reclassifies to MARKETING (costlier, stricter). `{{n}}` params must match exactly what `send-whatsapp` sends, or error 132000.

---

## 5. `invite-member` (admin only)

**Request:** `POST { "email": "...", "demat_id": "<uuid>" }`.
**Logic:** service-role `auth.admin.inviteUserByEmail(email)` → on success create `profiles` row (role `member`) if absent → `update demat_accounts set linked_user_id = <new user id> where id = demat_id`. Return invite status.

---

## 6. Client → DB contract (main supabase-js calls)

| Screen | Call |
|---|---|
| Accounts list | `from('demat_accounts').select('*, bank_accounts(*)')` |
| Add account | `rpc('insert_demat', {...})` |
| IPO list | `from('ipos').select().order('open_date', desc)` |
| New application | `from('applications').insert({...})` → duplicate PAN surfaces as unique-violation → show "Already applied from this PAN" |
| Allotment board | `from('v_allotment_board').select().eq('ipo_id', id)` |
| Mark allotted | `from('applications').update({status:'ALLOTTED'}).eq('id', id)` |
| Member: my data | same selects — RLS auto-filters |
| Copy PAN | `functions.invoke('reveal-pan', {demat_id})` |

## 7. Function secrets (Supabase → Edge Functions → Secrets)

`WA_ACCESS_TOKEN` (permanent System User token), `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` (any random string), `META_APP_SECRET`, `PAN_KEY` (32+ random chars), `DB_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` (auto-provided).
