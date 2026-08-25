# Twilio API / Webhook / TwiML / Signature Compliance Audit

**Task:** #859
**Date:** 2026-04-30
**Repository:** `rest-express`
**Twilio SDK:** `twilio@^5.13.1` (no upgrade — out of scope)
**References:**
- `.agents/skills/twilio-reference/SKILL.md`
- [Twilio REST API](https://www.twilio.com/docs/usage/api)
- [Webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [TwiML voice reference](https://www.twilio.com/docs/voice/twiml)
- [Messaging webhook request](https://www.twilio.com/docs/messaging/guides/webhook-request)
- [Call resource](https://www.twilio.com/docs/voice/api/call-resource)
- [Message resource](https://www.twilio.com/docs/messaging/api/message-resource)

---

## Executive summary

Top-to-bottom audit of every Twilio touchpoint — outbound SMS/voice creation, hangup, signature verification, every webhook handler, every TwiML emission, persistence (`twilio_calls`, `twilio_messages`, `twilio_conversations`, `raw_communication_records`), call-routing tier escalation, and the admin config write path.

**Result:** every touchpoint matches the documented contract. Three behavior fixes were merged surgically:

| Severity | Area | Fix |
|---|---|---|
| **P1 — security** | Webhook signature middleware | In production, refuse webhook traffic with 503 when `twilio_auth_token` is missing instead of silently passing through. |
| P2 — admin UX | `PUT /api/twilio/config` | Reject non-E.164 phone numbers before they hit the Twilio SDK. |
| P3 — debuggability | All SDK call sites | Surface `RestException.status` / `code` / `moreInfo` in the error string so failed sends are diagnosable from logs and the UI. |

Plus one infra catch-up: bootstrap migration for the Task #849 dedupe columns/indexes that some pre-#849 dev DBs were missing — this restored the existing `twilio-direct-thread-dedupe.test.ts`.

No misspelled status enums, no malformed TwiML, no missing XML escaping, no TwiML verb attrs out of spec.

---

## 1. Outbound API call sites

| # | Touchpoint | File:Line | Twilio doc | Verdict |
|---|---|---|---|---|
| 1.1 | Outbound SMS — `client.messages.create({ from, to, body })` | `server/services/twilioService.ts:57` | [Message resource: create](https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource) | ⚠ Fixed (better error surface) |
| 1.2 | Outbound voice call — `client.calls.create({ from, to, url, statusCallback, statusCallbackEvent })` | `server/services/twilioService.ts:140` | [Call resource: create](https://www.twilio.com/docs/voice/api/call-resource#create-a-call-resource) | ⚠ Fixed (better error surface) |
| 1.3 | `statusCallbackEvent` array | `server/services/twilioService.ts:145` | [Call status callbacks](https://www.twilio.com/docs/voice/api/call-resource#statuscallback) | ✅ Pass — exactly `["initiated","ringing","answered","completed"]` |
| 1.4 | Hang-up — `calls(sid).update({ status: "completed" })` | `server/routes/twilio.ts:906` | [Call resource: update](https://www.twilio.com/docs/voice/api/call-resource#update-a-call-resource) | ⚠ Fixed (better error surface) |
| 1.5 | Outbound voice TwiML URL | `server/services/twilioService.ts:143` | [Setting webhook URLs](https://www.twilio.com/docs/usage/webhooks#configure-your-webhook-url) | ✅ Pass — full HTTPS URL, served by `voice-twiml-outbound` route |

### Fix details (1.1, 1.2, 1.4 — error surfacing)

Twilio's `RestException` (see `node_modules/twilio/lib/base/RestException.d.ts`) carries three diagnostic fields beyond `.message`:

- `status` — HTTP status (e.g. `400`)
- `code` — Twilio numeric code (e.g. `21211` → ["Invalid 'To' Phone Number"](https://www.twilio.com/docs/api/errors/21211))
- `moreInfo` — canonical doc URL for that code

We were discarding all three. New helper `describeTwilioError(err)` (in `server/services/twilioErrors.ts`, re-exported from `twilioService.ts`) renders them as a stable string:

```
[HTTP 400 / Twilio code 21211] Invalid 'To' Phone Number (https://www.twilio.com/docs/errors/21211)
```

Wraps every SDK call site. Defensive against non-Twilio errors (falls through to `.message`) and nullish input (returns `"Unknown error"`). Standalone module so it's unit-testable without bootstrapping the DB.

---

## 2. Webhook signature verification

| # | Touchpoint | File:Line | Twilio doc | Verdict |
|---|---|---|---|---|
| 2.1 | `validateTwilioWebhook` middleware | `server/routes/twilio.ts:25-83` | [Validating signatures](https://www.twilio.com/docs/usage/webhooks/webhooks-security#validating-signatures-from-twilio) | ⚠ Fixed (fail-closed in prod) |
| 2.2 | Header read — `req.headers["x-twilio-signature"]` | `server/routes/twilio.ts:42` | [X-Twilio-Signature](https://www.twilio.com/docs/usage/webhooks/webhooks-security#x-twilio-signature) | ✅ Pass — Express lower-cases all headers |
| 2.3 | URL reconstruction | `server/routes/twilio.ts:60-63` | [Manually validate the request](https://www.twilio.com/docs/usage/webhooks/webhooks-security#manually-validate-the-request) | ✅ Pass — uses `x-forwarded-proto` (default `https`) + `host` + `originalUrl` |
| 2.4 | Body inclusion | `server/routes/twilio.ts:64` | [Manually validate the request](https://www.twilio.com/docs/usage/webhooks/webhooks-security#manually-validate-the-request) | ✅ Pass — passes the entire parsed `req.body` to `validateRequest` |
| 2.5 | SDK helper resolution | `server/routes/twilio.ts:46-58` | n/a | ✅ Pass — defensive lookup of `validateRequest` on default export and namespace; refuses (500) if helper is missing |

### Fix detail (2.1 — fail-closed in production)

**Before.** When `system_settings.twilio_auth_token` was missing, the middleware logged a warning and **passed the webhook through unverified in every environment**. Correct in dev/test, but a spoofing risk in production: anyone who knew the URL could forge an inbound SMS or call status.

**After.**
- `NODE_ENV === "production"` + no token → `503` + empty `<Response/>` (handler not invoked)
- All other environments → warn-and-pass (preserves local-dev workflow without Twilio creds)

URL reconstruction was already correct: `${proto}://${host}${originalUrl}`, with `proto` defaulting to `https` when `x-forwarded-proto` is absent. Verified end-to-end by an integration test that posts a Twilio-SDK-signed body for `https://public.example.com/webhook` while hitting a local socket — signature still verifies.

---

## 3. Webhook handlers

| # | Endpoint | File:Line | Twilio doc | Verdict |
|---|---|---|---|---|
| 3.1 | `POST /api/twilio/webhooks/sms` | `server/routes/twilio.ts:202` | [Receive an SMS message](https://www.twilio.com/docs/messaging/guides/webhook-request) | ✅ Pass |
| 3.2 | `POST /api/twilio/webhooks/voice-twiml` | `server/routes/twilio.ts:255` | [Receive an inbound call](https://www.twilio.com/docs/voice/twiml#twilios-request-to-your-application) | ✅ Pass |
| 3.3 | `POST /api/twilio/webhooks/voice` (root inbound) | `server/routes/twilio.ts:185` | [Receive an inbound call](https://www.twilio.com/docs/voice/twiml#twilios-request-to-your-application) | ✅ Pass |
| 3.4 | `POST /api/twilio/webhooks/voice-routing-callback` | `server/routes/twilio.ts:317` | [Dial action](https://www.twilio.com/docs/voice/twiml/dial#attributes-action) | ✅ Pass |
| 3.5 | `POST /api/twilio/webhooks/call-status` | `server/routes/twilio.ts:231` | [statusCallback parameters](https://www.twilio.com/docs/voice/api/call-resource#statuscallback-parameters) | ✅ Pass |
| 3.6 | `POST /api/twilio/webhooks/voice-twiml-outbound` | `server/routes/twilio.ts:413` | [Url attribute](https://www.twilio.com/docs/voice/api/call-resource#create-a-call-resource) | ✅ Pass |

All consume `application/x-www-form-urlencoded` (Twilio's documented encoding) via Express `urlencoded` middleware and read canonical Twilio parameter names (`From`, `To`, `Body`, `MessageSid`, `CallSid`, `CallStatus`, `CallDuration`, `Direction`, `Digits`, `NumMedia`). All are protected by `validateTwilioWebhook` middleware **before** any side effect runs (storage write, downstream service call). All return TwiML with `Content-Type: text/xml`, even error/empty paths.

---

## 4. TwiML emissions

| # | Site | File:Line | Verb / shape | Twilio doc | Verdict |
|---|---|---|---|---|---|
| 4.1 | Inbound voice fallback IVR | `server/routes/twilio.ts:185` | `<Response><Gather action numDigits><Say/></Gather><Say/></Response>` | [`<Gather>`](https://www.twilio.com/docs/voice/twiml/gather) | ✅ Pass |
| 4.2 | Voice routing — primary tier dial | `server/routes/twilio.ts:294-301` | `<Response><Dial timeout="25" action callerId><Number/></Dial></Response>` | [`<Dial>`](https://www.twilio.com/docs/voice/twiml/dial) / [`<Number>`](https://www.twilio.com/docs/voice/twiml/number) | ✅ Pass |
| 4.3 | Voice routing — fallback to IVR | `server/routes/twilio.ts:305` | `<Response><Say/></Response>` (error path) | [`<Say>`](https://www.twilio.com/docs/voice/twiml/say) | ✅ Pass |
| 4.4 | Voice routing — escalation tier | `server/routes/twilio.ts:361-367` | Same `<Dial>` shape, escalates to next tier | [`<Dial>` action](https://www.twilio.com/docs/voice/twiml/dial#attributes-action) | ✅ Pass |
| 4.5 | IVR keypress dispatch | `server/routes/twilio.ts:389-397` | `<Response><Say/><Dial><Number/></Dial></Response>` (or invalid-selection `<Say>`) | [`<Dial>`](https://www.twilio.com/docs/voice/twiml/dial) | ✅ Pass |
| 4.6 | Outbound voice — connect message | `server/routes/twilio.ts:413-418` | `<Response><Say>Connecting your call now.</Say></Response>` | [`<Say>`](https://www.twilio.com/docs/voice/twiml/say) | ✅ Pass |
| 4.7 | Empty/ack TwiML responses | `server/routes/twilio.ts:33,42,56,68,72,78,217,220,228,245,344,415` | `<Response></Response>` or self-close | [TwiML basics](https://www.twilio.com/docs/voice/twiml) | ✅ Pass |
| 4.8 | XML prolog `<?xml version="1.0" encoding="UTF-8"?>` | `server/routes/twilio.ts:344, 377, 409` | TwiML basics | ✅ Pass — recommended, not required |
| 4.9 | XML escaping of dynamic content | All `${greeting}`, `${selected.label}` interpolations go through `escapeXml(...)` (file:182) | [TwiML — special characters](https://www.twilio.com/docs/voice/twiml#special-characters) | ✅ Pass |
| 4.10 | `Content-Type: text/xml` | All TwiML responders use `.type("text/xml")` (23 sites) | [TwiML response format](https://www.twilio.com/docs/voice/twiml#response-format) | ✅ Pass |

A static-shape test (in `tests/twilio-api-compliance.test.ts`, section 5) asserts `<Response>` and `<Say>` open/close balance, `<Gather>` carries `action=` and `numDigits=`, `<Dial><Number>` exists, every `${…}` inside `<Say>` passes through `escapeXml`, and at least 5 TwiML sites set `text/xml`. Currently 22 `<Response>` opens / 22 closes / 8 `<Say>` open+close / 23 `text/xml` sets — all balanced.

---

## 5. Status enum compliance

Twilio canonical voice statuses ([Call status values](https://www.twilio.com/docs/voice/api/call-resource#call-status-values)): `queued`, `ringing`, `in-progress`, `completed`, `busy`, `failed`, `no-answer`, `canceled`. Twilio canonical message statuses ([Message status values](https://www.twilio.com/docs/messaging/api/message-resource#message-status-values)): `accepted`, `queued`, `sending`, `sent`, `delivered`, `undelivered`, `failed`, `read`, `received`, `scheduled`, `canceled`.

| # | Where | Verdict |
|---|---|---|
| 5.1 | `twilio_calls.status` writes (`server/services/twilioService.ts`, `server/routes/twilio.ts`) | ✅ Uses canonical strings — `ringing`, `in-progress`, `completed`, `no-answer`, `canceled`, `failed` |
| 5.2 | `twilio_messages.status` writes | ✅ Uses canonical strings — `sent`, `delivered`, `failed`, `received` |
| 5.3 | No misspelling — `cancelled` vs `canceled` | ✅ Static check in compliance test confirms no `cancelled` literal in the routes/services |
| 5.4 | No misspelling — `noanswer` vs `no-answer` | ✅ Static check |
| 5.5 | No misspelling — `in_progress` vs `in-progress` | ✅ Static check |
| 5.6 | No leakage of `answeredby` / `AnsweredBy` (we don't call AMD) | ✅ Static check |

---

## 6. Phone-number handling

| # | Touchpoint | File:Line | Twilio doc | Verdict |
|---|---|---|---|---|
| 6.1 | Storage canonical form | `server/services/phoneNormalization.ts` | [E.164 format](https://www.twilio.com/docs/glossary/what-e164) | ✅ Stores `+E164`, derives `national10` for matching |
| 6.2 | Inbound webhook normalization | `server/routes/twilio.ts:11` (`normalizePhone`) | E.164 | ✅ Coerces 10-digit → `+1<10>` and 11-digit `1xxx` → `+1xxx`; passes through any number that already starts with `+` |
| 6.3 | Direct-thread dedupe match key | `server/services/phoneNormalization.ts::getDirectConversationKey` | n/a (project-specific dedupe) | ✅ Last-10-digit canonical key; covered by `tests/twilio-direct-thread-dedupe.test.ts` (72 assertions pass) |
| 6.4 | `PUT /api/twilio/config` `phoneNumbers` | `server/routes/twilio.ts:131-141` | [E.164 format](https://www.twilio.com/docs/glossary/what-e164) | ⚠ Fixed — now `^\+[1-9]\d{1,14}$` |
| 6.5 | `PATCH /api/twilio/me` `callRoutingPhone` | `server/routes/twilio.ts:149-156` | n/a (user-friendly input) | ✅ Pass — accepts liberal input then normalizes; not used as Twilio `from` |

### Fix detail (6.4 — E.164 enforcement)

**Before.** `phoneNumbers: z.array(z.string())` accepted anything. A typo at config time would later surface as Twilio `21212` (Invalid 'From' Number) on every outbound send.

**After.**

```ts
const e164Regex = /^\+[1-9]\d{1,14}$/;
phoneNumbers: z.array(
  z.string().trim().regex(e164Regex, "Phone numbers must be E.164 (e.g. +15551234567)")
).optional(),
```

Matches the [E.164 spec](https://www.twilio.com/docs/glossary/what-e164): leading `+`, first significant digit 1–9, total length ≤ 15. 11 unit assertions cover positive cases (US/UK/AU), rejection of bare 10-digit, hyphenated, alphabetic, leading-zero, and >15-digit inputs, whitespace trimming, and array-level rejection.

---

## 7. Persistence integrity

| # | Sink | File:Line | Verdict |
|---|---|---|---|
| 7.1 | `raw_communication_records` for inbound SMS | `server/services/twilioService.ts::handleInboundSms` | ✅ One row per `MessageSid`; `externalSourceId = MessageSid` enables idempotent dedupe; `matchMethod`/`matchConfidence`/`matchStatus` populated per audit columns |
| 7.2 | `twilio_messages` insert for inbound SMS | `server/services/twilioService.ts::handleInboundSms` | ✅ Unique index on `twilio_sid` prevents duplicate rows on Twilio retry (line 705 comment confirms) |
| 7.3 | `raw_communication_records` for inbound call | `server/routes/twilio.ts:265-274` | ✅ One row per `CallSid` |
| 7.4 | `twilio_calls` insert for inbound | `server/routes/twilio.ts:276-285` | ✅ Status `ringing` on initial insert; later updated by `call-status` webhook to canonical Twilio status |
| 7.5 | `twilio_conversations` direct-thread dedupe | `shared/models/communications.ts:358-381` + `server/services/phoneNormalization.ts` | ✅ Task #849; dev DB columns/indexes added to bootstrap migration |
| 7.6 | Call status updates | `server/services/twilioService.ts::handleCallStatus` | ✅ Writes the canonical Twilio enum unmodified to `twilio_calls.status`; updates `routedToUserId` / `routingTier` / `answeredAt` on tier-resolution callback |

---

## 8. Call-routing pipeline

| # | Touchpoint | File:Line | Verdict |
|---|---|---|---|
| 8.1 | Tier resolution | `server/services/callRoutingService.ts::resolveRoutingChain` | ✅ Tier 1 = most recent contact owner from voice/SMS; Tier 2 = client account manager; Tier 3 = system fallback. Dedupes Tier 2 against Tier 1 user. |
| 8.2 | TwiML `<Dial action>` callback | `server/routes/twilio.ts:294-301` | ✅ Uses `action=` + `timeout="25"` + `callerId=To`; URL-encodes `routingData` JSON; XML-escapes `&` → `&amp;` in query string per [TwiML special characters](https://www.twilio.com/docs/voice/twiml#special-characters) |
| 8.3 | Tier escalation on no-answer/busy | `server/routes/twilio.ts:317-369` | ✅ Reads `DialCallStatus` from action callback, advances to next tier in chain, emits new `<Dial>` with the next target. Falls back to IVR when chain exhausted. |
| 8.4 | Routing callback `tier` query param parsing | `server/routes/twilio.ts:317` | ✅ `parseInt(req.query.tier as string) || 1` — defaults safely on garbage input |

---

## 9. Admin / config write paths

| # | Touchpoint | File:Line | Verdict |
|---|---|---|---|
| 9.1 | `GET /api/twilio/config` | `server/routes/twilio.ts` | ✅ Auth-gated by `isAuthenticated` + `requireTwilioAccess` |
| 9.2 | `PUT /api/twilio/config` | `server/routes/twilio.ts:131-141` | ⚠ Fixed — E.164 enforcement on `phoneNumbers` |
| 9.3 | `GET /api/twilio/me` | `server/routes/twilio.ts:503` | ✅ Auth-gated; reads from `users` table |
| 9.4 | `PATCH /api/twilio/me` | `server/routes/twilio.ts:617-670` | ✅ Auth-gated; phone field validated 10–15 digits |
| 9.5 | IVR menu config write | `server/routes/twilio.ts:116-120` (`ivrMenuOptionSchema`) | ✅ `digit` 1 char, `label` ≤100, `phone` ≤20; max 9 menu options |

---

## 10. Bootstrap-migration catch-up (Task #849 columns)

`shared/models/communications.ts:358-381` declares `contact_phone_normalized`, `twilio_phone_number_normalized`, `direct_thread_key` plus three regular indexes and a partial-unique index. Some pre-#849 dev DBs were missing those columns/indexes, which made `tests/twilio-direct-thread-dedupe.test.ts` fail with `column "contact_phone_normalized" of relation "twilio_conversations" does not exist`.

Added to `server/index.ts` Twilio bootstrap (lines 198-207):

```sql
ALTER TABLE twilio_conversations ADD COLUMN IF NOT EXISTS contact_phone_normalized       varchar;
ALTER TABLE twilio_conversations ADD COLUMN IF NOT EXISTS twilio_phone_number_normalized varchar;
ALTER TABLE twilio_conversations ADD COLUMN IF NOT EXISTS direct_thread_key              varchar;
CREATE INDEX        IF NOT EXISTS twilio_conv_contact_normalized_idx  ON twilio_conversations(contact_phone_normalized);
CREATE INDEX        IF NOT EXISTS twilio_conv_twilio_normalized_idx   ON twilio_conversations(twilio_phone_number_normalized);
CREATE INDEX        IF NOT EXISTS twilio_conv_direct_thread_key_idx   ON twilio_conversations(direct_thread_key);
CREATE UNIQUE INDEX IF NOT EXISTS twilio_conv_direct_active_uniq      ON twilio_conversations(direct_thread_key) WHERE direct_thread_key IS NOT NULL AND status = 'active';
```

After restart, `[Bootstrap] Twilio columns ensured` confirmed; dedupe test passes 72/72.

---

## 11. Verification matrix

The following scenarios were verified end-to-end. ✅ = passing as of this audit. Behavior fixes in this task are tagged **#fix**.

| # | Scenario | Verification | Outcome |
|---|---|---|---|
| V1 | Outbound SMS happy path | `tests/twilio-direct-thread-dedupe.test.ts` §9 (existing-thread match still sends) — calls `sendSms`, asserts the message lands on the correct thread, no duplicate thread, body preserved | ✅ Passes |
| V2 | Duplicate Twilio retry on inbound SMS (dedupe) | `tests/twilio-direct-thread-dedupe.test.ts` §3-§8 — inserts two messages with the same `MessageSid`, asserts only one `twilio_messages` row is created via the unique-index path | ✅ Passes (72/72) |
| V3 | Outbound voice initiate with `statusCallback` | `tests/twilio-api-compliance.test.ts` §5 (static check) — confirms `statusCallbackEvent` array uses the canonical four event names and outbound voice URL is wired to `voice-twiml-outbound`. **Cannot be live-tested** — see "Evidence levels" §15. | ✅ Static check |
| V4 | Inbound voice → tier 1 dial | TwiML emission inspected in `server/routes/twilio.ts:294-301`; static check confirms `<Dial timeout="25" action callerId><Number>…</Number></Dial>` shape. **Cannot be live-tested** — see §15. | ✅ Static check |
| V5 | Tier escalation on no-answer/busy | Code path `voice-routing-callback` (`server/routes/twilio.ts:317-369`) reads `DialCallStatus`, advances tier, re-emits `<Dial>`. Verified against [Dial action callback](https://www.twilio.com/docs/voice/twiml/dial#attributes-action) — `DialCallStatus` enum includes `completed`, `busy`, `no-answer`, `canceled`, `failed`. **Cannot be live-tested** — see §15. | ✅ Code-review |
| V6 | IVR keypress (DTMF) → dial | `server/routes/twilio.ts:185-189` emits `<Gather action numDigits>`; keypress handler (`/api/twilio/webhooks/voice-keypress`) emits `<Dial><Number>` for the matched menu option. `numDigits` matches Twilio Gather contract. **Cannot be live-tested** — see §15. | ✅ Code-review |
| V7 | Hang-up call API | `server/routes/twilio.ts:893-911` — calls `client.calls(sid).update({status:"completed"})` per Twilio docs. **#fix:** error path now returns the formatted Twilio code/status/moreInfo. | ⚠ Fixed |
| V8 | Webhook signature: missing header | `tests/twilio-api-compliance.test.ts` §3(a) — POSTs to a live mounted middleware without `X-Twilio-Signature` | ✅ 403 |
| V9 | Webhook signature: valid signature | `tests/twilio-api-compliance.test.ts` §3(b) — uses `twilio.getExpectedTwilioSignature()` to sign a body, asserts middleware passes through | ✅ 200 |
| V10 | Webhook signature: tampered body | `tests/twilio-api-compliance.test.ts` §3(c) — signs original body, sends modified body, asserts rejection | ✅ 403 |
| V11 | Webhook signature: garbage signature | `tests/twilio-api-compliance.test.ts` §3(d) — sends a constant fake signature, asserts rejection | ✅ 403 |
| V12 | Webhook signature: proxy URL reconstruction | `tests/twilio-api-compliance.test.ts` §3(e) — signs `https://public.example.com/webhook` and sends with `x-forwarded-proto=https` + `Host: public.example.com` to a local socket; middleware must reconstruct the public URL to verify | ✅ 200 — **confirms `x-forwarded-proto`/`Host` reconstruction works behind a proxy** |
| V13 | Webhook signature: no token, NODE_ENV=test | `tests/twilio-api-compliance.test.ts` §4(a) | ✅ 200 (passthrough with warning) |
| V14 | Webhook signature: no token, NODE_ENV=production | `tests/twilio-api-compliance.test.ts` §4(b) — **#fix** | ✅ 503 (fail-closed) |
| V15 | DB persistence — inbound SMS writes `raw_communication_records` + `twilio_messages`; retry is a clean no-op | `tests/twilio-api-compliance.test.ts` §6 — calls `handleInboundSms()` inside `runInTxSandbox`, asserts row counts, status `received`, body/from/to preserved, and that a second call with the same `MessageSid` produces no extra rows | ✅ Live persistence (12 assertions) |
| V16 | DB persistence — `handleCallStatus` mutates `twilio_calls.status` with the canonical enum; missed-call audit-trail rule holds | `tests/twilio-api-compliance.test.ts` §7 — seeds a call, drives `ringing → in-progress → completed` (asserting each transition), then asserts a settled `no-answer` call is **not** silently overwritten by a late `completed` callback while still recording duration | ✅ Live persistence (6 assertions) |
| V17 | E.164 validation rejects bad config | `tests/twilio-api-compliance.test.ts` §2 — 11 cases (US/UK/AU positive; bare/hyphenated/alphabetic/leading-zero/>15-digit/whitespace/mixed-array) | ✅ All 11 pass |
| V18 | TwiML response Content-Type | Static check counts 23 `.type("text/xml")` sites — every TwiML emission, including error/empty paths | ✅ Pass |
| V19 | TwiML XML escaping for dynamic content | Static check confirms every `${…}` inside `<Say>` is wrapped in `escapeXml(...)` | ✅ Pass |
| V20 | TwiML status enum spelling | Static check rejects `cancelled`, `noanswer`, `in_progress`, `answeredby` literals in routes/services | ✅ Pass |

---

## 12. Out of scope (per task contract)

- **SDK upgrade** — `twilio@^5.13.1` retained.
- **Env-var migration** — `REPLIT_DEV_DOMAIN` / `REPL_SLUG` / `REPL_OWNER` fallback chain left as-is at three call sites; flagged as a follow-up tech-debt task.
- **Routing redesign** — `callRoutingService.ts` left untouched; only audited.
- **Frontend redesign** — no `client/` changes.
- **New Twilio products** — no Conversations API, Verify, Lookup, or Messaging Service adoption.

---

## 13. Tests

- `tests/twilio-direct-thread-dedupe.test.ts` — **72/72 pass** (after bootstrap migration catch-up unblocked it).
- `tests/twilio-api-compliance.test.ts` — **new, 64/64 pass.** Covers:
  - `describeTwilioError` shape across Twilio / non-Twilio / null / number / empty-object inputs (11 assertions)
  - E.164 phone validation (11 assertions)
  - Live `validateTwilioWebhook` middleware against real HTTP — missing/valid/tampered/garbage signature, proxy URL reconstruction (8 assertions)
  - Live no-token env-gating — dev passthrough vs prod 503 (4 assertions)
  - TwiML responder static-shape compliance — `<Response>`/`<Say>` balance, `<Gather>`/`<Dial>` attrs, status-enum spelling, XML escaping, `text/xml` count (12 assertions)
  - **Live persistence:** `handleInboundSms` writes `raw_communication_records` + `twilio_messages`; Twilio retry is a clean no-op (12 assertions, V15)
  - **Live persistence:** `handleCallStatus` drives `ringing → in-progress → completed` and respects the missed-call audit-trail rule (6 assertions, V16)
- Both registered in `tests/run-all.ts`.

---

## 14. Files touched

| File | Change |
|---|---|
| `server/services/twilioErrors.ts` | **New** — standalone `describeTwilioError` helper |
| `server/services/twilioService.ts` | Re-export `describeTwilioError`; wrap SDK call sites |
| `server/routes/twilio.ts` | Fail-closed signature middleware in prod; export middleware for tests; switch its DB read to `getDb()`; E.164 regex on config; describe Twilio errors on hangup; remove `any` casts on the dynamic `twilio` import in favor of the SDK's published types |
| `server/index.ts` | Bootstrap migration for Task #849 dedupe columns/indexes |
| `tests/twilio-api-compliance.test.ts` | **New** — 64-assertion compliance test |
| `tests/run-all.ts` | Register the new test |
| `docs/twilio-audit.md` | **New** — this audit |

---

## 15. Evidence levels — what can and cannot be live-verified here

This audit was performed by an automated agent in a sandboxed dev environment with **no real Twilio account, no real phone numbers, and no human at a handset**. That dictates the evidence level applicable to each row of §11:

**Live-verified ("✅ 200 / ✅ Passes / ✅ Live persistence"):** anything that does not require Twilio's network or a physical handset. This covers:
- Signature-verification middleware against real HTTP traffic (V8–V14) — uses the official Twilio SDK's own `getExpectedTwilioSignature` helper to sign realistic payloads, then exercises the **exported** middleware mounted on a live `express` app.
- DB persistence and idempotency on inbound SMS and call-status flows (V2, V15, V16) — calls the real handlers (`handleInboundSms`, `handleCallStatus`) inside a transaction sandbox and asserts the resulting rows in `twilio_messages`, `twilio_calls`, and `raw_communication_records`.
- The whole §3 dedupe regression (V1, V2) — 72 assertions exercising the real conversation/message/raw paths.
- TwiML and status-enum static-shape compliance (V3, V4, V18, V19, V20) — verified against the actual emitted strings in `server/routes/twilio.ts`.

**Static check / Code-review only:** anything that requires Twilio to originate a real network call or for a person to press a key on a real phone:
- V3 outbound voice **initiation against the live Twilio API** — sending a real `client.calls.create()` would burn a phone-call charge and ring an actual number. The wiring (URL, `statusCallbackEvent` array, `from`/`to` shape) is statically verified against the SDK type signatures and Twilio's published spec.
- V4 inbound voice → tier-1 dial behavior **end-to-end through Twilio** — requires Twilio to POST to our webhook for a real ringing call. The TwiML we *emit* in response is statically verified.
- V5 tier escalation on `no-answer` — requires Twilio to actually attempt the dial, time out at 25s, and POST `DialCallStatus=no-answer` back. Same constraint.
- V6 IVR keypress — requires a person to press `1` on a real phone.

These four scenarios cannot be exercised from an automated agent without (a) a live Twilio account with billing, (b) at least two real phone numbers we control, and (c) a human in the loop. They are explicitly listed as a follow-up task (#862, manual smoke-test checklist for the human operator before the next release).
