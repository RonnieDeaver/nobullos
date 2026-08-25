# 944A — Outbound Voice Hop Diagnosis

Hand-off document for 944B. Combines code-level analysis with **direct
Twilio API evidence** (REST `Notifications` resource) for four real
failing browser-mode outbound CallSids in production.

---

## TL;DR

- **Failing hop (proven by Twilio):** the dial-action callback
  `POST /api/twilio/webhooks/voice-twiml-browser-dial-status`. Twilio
  fetches it after the bridged dial leg ends and gets **HTTP 404**
  (Twilio error code `11200`, "HTTP retrieval failure").
- **Same defect for forward mode:** the deprecated outbound flow
  shows the same 404 against `voice-twiml-outbound` and the
  `statusCallback=…/call-status` URL (Twilio error `15003`).
- **Failing absolute URL** (recorded by Twilio for one of the four
  CallSids): `https://90ddbcd4-c535-4e65-bfda-7f47669b25d0-00-n8o4pakcc1jy.kirk.replit.dev/api/twilio/webhooks/voice-twiml-browser-dial-status`
  — host is the **dev container's `kirk.replit.dev` URL**, not the
  production `*.replit.app` deployment URL where the routes are
  actually served.
- **Root cause:** `bad_base_url`. `resolveBaseUrl()`
  (`server/services/twilioService.ts:268-274`) returns
  `https://${process.env.REPLIT_DEV_DOMAIN}` whenever that env var is
  set; in this Replit Deployment it is set to a per-instance
  `kirk.replit.dev` dev hostname that does not serve the deployed
  Express app (so every embedded webhook URL 404s).
- **Secondary risk worth fixing in 944B:** `webhookLimiter` is a
  global, keyless 300-req / 15-min bucket
  (`server/routes/middleware.ts:324-332`) that could `rate_limit`
  `voice-whisper` mid-call once the URL is fixed.

---

## 1. Discovery map: browser-mode outbound call flow

| # | Actor | Hop | Path | Method | Auth/Mw | Limiter |
|---|-------|-----|------|--------|---------|---------|
| 0 | Browser | `Device.connect({params:{To}})` (Voice JS SDK) | n/a (WebRTC signaling to Twilio) | — | mic permission, JWT minted by `POST /api/twilio/voice-token` | `apiLimiter` + `writeLimiter` |
| 1 | Twilio edge → server | TwiML App Voice Request URL (configured manually in Twilio Console → points at the prod `*.replit.app` host) | `/api/twilio/webhooks/voice-twiml-browser` | POST | `validateTwilioWebhook` | `webhookLimiter` |
| 2 | Server → Twilio | Returns `<Dial …action="${baseUrl}/voice-twiml-browser-dial-status"><Number url="${baseUrl}/voice-whisper">…</Number></Dial>` (server/routes/twilio.ts:682-687) | (TwiML body) | — | — |
| 3 | Twilio edge → server | Whisper, fetched on the called party's leg at answer | `/api/twilio/webhooks/voice-whisper` | POST | **None** (intentional — `server/routes/twilio.ts:702-719`) | `webhookLimiter` |
| 4 | Twilio edge → server | Dial action callback when bridged dial leg ends | `/api/twilio/webhooks/voice-twiml-browser-dial-status` | POST | `validateTwilioWebhook` | `webhookLimiter` |
| 5 | Twilio edge → server | Recording-status callback once dual-channel recording finishes | `/api/twilio/webhooks/recording-status` | POST | `validateTwilioWebhook` | `webhookLimiter` |

Critical structural fact: hop 1's URL is **manually configured** in the
Twilio Console (per the Twilio section of `replit.md`), so it never
flows through `resolveBaseUrl()` — that is why hop 1 reaches the prod
deployment and hop 4 does not. Hops 3 and 4 URLs are constructed by
`resolveBaseUrl()` at hop 2 request time and embedded in the returned
TwiML body — they only work if `resolveBaseUrl()` happens to return a
host that actually serves the Express app.

## 2. Per-hop forensic table — observed for 4 production CallSids

Sources of evidence:

1. **Twilio REST API** — `GET /2010-04-01/Accounts/{Sid}/Calls/{CallSid}.json`
   and `GET /…/Calls/{CallSid}/Notifications.json` for each of the
   four failing CallSids, called from this environment using the
   production Account SID + Auth Token loaded from `system_settings`.
2. **Production database** — `twilio_calls` table read via
   `executeSql({environment: "production"})`.
3. **Production deployment logs** — `fetch_deployment_logs`.

### 2.1 Twilio's own record of each failing call

Direct excerpt from Twilio's REST API `Notifications` resource
(formatted for readability — full raw JSON in §5):

| CallSid | Twilio call status | direction | Twilio error_code | response_code | request_url Twilio fetched |
|---|---|---|---|---|---|
| `CA19703c4734238e6c699646b180bc79d7` | completed | inbound (browser-leg view) | **11200** | **404** | `https://90ddbcd4-c535-4e65-bfda-7f47669b25d0-00-n8o4pakcc1jy.kirk.replit.dev/api/twilio/webhooks/voice-twiml-browser-dial-status` |
| `CA410b2f63d124b45636af43bac53e80ee` | completed | inbound (browser-leg view) | **11200** | **404** | `https://91e63498-2c59-4a50-8012-758c51eeae28-00-2op4twhxveceq.kirk.replit.dev/api/twilio/webhooks/voice-twiml-browser-dial-status` |
| `CA3249acacb05fb4003dd6f46dd7f0107e` | completed | inbound (browser-leg view) | **11200** | **404** | `https://be0d4f76-6504-4841-b7ad-4ca94714bba2-00-1q9i7xeo3w68m.kirk.replit.dev/api/twilio/webhooks/voice-twiml-browser-dial-status` |
| `CAc53d23071cc96d36867b470aa3efaabc` | completed | outbound-api (legacy non-browser flow) | **11200** + **15003** ×4 | **404** ×5 | `…/voice-twiml-outbound` and `…/call-status` on `https://6accef02-67a2-41b8-83b3-abe82ba7c725-00-1oea51uv2zm69.kirk.replit.dev` |

(Twilio's `direction` field shows the browser-mode call as `inbound`
because the called-party leg is created via the `<Dial><Number>` TwiML
on the inbound TwiML-App leg from the browser. Application-level
direction in `twilio_calls` is `outbound` — set by
`recordBrowserOutboundCall()`.)

Two independent confirmations of the same defect:

- **Browser flow** (3 CallSids, 2026-05-05 → 2026-05-08): exactly one
  failed sub-request per call —
  `voice-twiml-browser-dial-status` → 404.
- **Legacy non-browser flow** (1 CallSid, 2026-05-01): five failed
  sub-requests per call — `voice-twiml-outbound` → 404 and four
  `statusCallback=…/call-status` → 404. Same hostname pattern.

The hostnames are different per call because each was placed against
a different deployment instance, but every one of them is the
`kirk.replit.dev` per-instance dev hostname — i.e. the value of
`process.env.REPLIT_DEV_DOMAIN` inside that deployment. Twilio's
`response_code: 404` proves the host is **reachable** (not a DNS or
connection error) but does not serve those routes.

### 2.2 Database & log corroboration

Production `twilio_calls` rows (most recent first):

| created_at | CallSid | direction | status | recording_status | recording_sid |
|---|---|---|---|---|---|
| 2026-05-08 18:30:23 | `CA19703c…` | outbound | `initiated` | (null) | (null) |
| 2026-05-08 16:12:02 | `CA410b2f…` | outbound | `initiated` | (null) | (null) |
| 2026-05-05 13:53:25 | `CA3249ac…` | outbound | `initiated` | (null) | (null) |
| 2026-05-01 14:54:47 | `CAc53d23…` | outbound | `initiated` | (null) | (null) |

Aggregate: 4 outbound rows, 0 with recording_sid. The rows exist at
all → hop 1 ran. Status frozen at `initiated` → the dial-status
callback (hop 4) never updated them. Recording NULL → recording-status
callback (hop 5) never fired.

Production deployment logs for the relevant routes
(`fetch_deployment_logs message="voice-twiml-browser-dial-status|voice-whisper|recording-status"`):
**zero hits**, consistent with Twilio's notifications: the requests
hit the `kirk.replit.dev` dev host, not the prod app, so the prod app
never sees them in its logs.

### 2.3 Per-hop interpretation

| Hop | Twilio fetched? | Server received? | Handler entered | Handler exit | HTTP status returned to Twilio | Body validity | Evidence |
|-----|-----------------|------------------|-----------------|--------------|--------------------------------|---------------|----------|
| 1. `voice-twiml-browser` | YES | YES (prod app) | yes | yes | 200 | valid TwiML | The four `twilio_calls` rows only exist because `recordBrowserOutboundCall()` (server/routes/twilio.ts:670) ran inside this handler. |
| 3. `voice-whisper` | not in the 4 CallSids' notification logs (Twilio doesn't notify on a successful 200; Twilio also doesn't fetch it if the called party never answers — see §3 note) | unknown for these particular calls | unknown | unknown | unknown | n/a | No prod log line; no Twilio notification. Same `${baseUrl}` source as hop 4 → would also 404 against the dev host. |
| 4. `voice-twiml-browser-dial-status` | YES (recorded by Twilio) | NO (prod) — request landed on the `kirk.replit.dev` dev host instead | n/a | n/a | **404** (returned by the dev host's Express app, which doesn't serve the route) | n/a | Twilio Notifications: `error_code=11200`, `response_code=404`, `request_url=https://<UUID>.kirk.replit.dev/api/twilio/webhooks/voice-twiml-browser-dial-status`. Production `twilio_calls.status` still `initiated` confirms no update from the prod handler. |
| 5. `recording-status` | NO | NO | n/a | n/a | n/a | n/a | The dial leg never completed normally (action callback 404'd), so no recording was finalized. `recording_sid`/`recording_status` NULL on all 4 rows. |

## 3. Root cause classification

**`bad_base_url` — confirmed.**

`resolveBaseUrl()` (`server/services/twilioService.ts:268-274`):

```ts
return process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}`
  : process.env.REPL_SLUG
  ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
  : "https://localhost:5000";
```

Why this is *the* defect, with no remaining ambiguity:

1. The TwiML App Voice URL is admin-configured in the Twilio Console
   to point at the production `*.replit.app` host → hop 1 reaches the
   prod app (proven: 4 DB rows written by `recordBrowserOutboundCall`).
2. The hop 2 handler embeds `${resolveBaseUrl()}/…` URLs in the TwiML
   body. In this Replit Deployment, `process.env.REPLIT_DEV_DOMAIN`
   is set to a per-instance `kirk.replit.dev` hostname (proven by
   the four URLs Twilio recorded fetching).
3. That `kirk.replit.dev` host is reachable from Twilio's edge but
   does not serve the deployed Express app's routes → returns 404
   (proven: Twilio `response_code=404`, `error_code=11200`).
4. Therefore hop 4 (and hop 3, and the legacy hop 5 statusCallback)
   all silently 404, leaving `twilio_calls.status` at `initiated` and
   `recording_sid` NULL.

Compare `server/services/zoomReviewQueueAlerts.ts:386` which correctly
prefers `APP_BASE_URL` / `PUBLIC_BASE_URL` over `REPLIT_DEV_DOMAIN`.
There is no such production-aware branch in `resolveBaseUrl()`.

**Secondary compounding causes** (not the primary failure but worth
fixing while 944B is in the file):

- **`rate_limited` on `voice-whisper`.** `webhookLimiter`
  (`server/routes/middleware.ts:324-332`) is registered as
  `300 req / 15 min` with no `keyGenerator`, so it default-keys on
  remote IP — every Twilio webhook from a single AWS region shares
  one bucket. Even after the URL fix, a webhook burst (inbound SMS +
  recording callbacks + status callbacks) can 429 the whisper
  request mid-call, returning a JSON error body instead of valid
  TwiML and reproducing the same audible "an application error has
  occurred" prompt.
- **`signature_rejected`** is *not* a candidate for hop 3 (whisper
  has no signature middleware) but `validateTwilioWebhook`
  (`server/routes/twilio.ts:42-77`) reconstructs the signed URL from
  `x-forwarded-proto` + `host` + `originalUrl`; if Replit's reverse
  proxy ever rewrites the host between Twilio's signed URL and the
  request the handler sees, hop 4 would 403 even after the base URL
  fix. Worth verifying in 944B once the URL is right.

**Excluded with evidence:**

- `endpoint_unreachable` for hop 1 — disproved by the four DB rows.
- `handler_exception` in `voice-twiml-browser` — wrapped in
  try/catch with explicit `<Say>+<Hangup/>` fallback (lines
  688-697); would yield a clean spoken error message, not Twilio's
  generic prompt.
- `invalid_twiml` on `voice-whisper` from `getRecordingDisclosure()`
  throwing — handler returns an empty `<Response/>` (line 717),
  which is valid TwiML.
- `endpoint_unreachable` (DNS / TCP) for the failing hop —
  disproved by Twilio's own `response_code=404` (it got an HTTP
  reply).

Note on hop 3: Twilio's REST `Notifications` resource only logs
*errors*, not successful sub-requests. The whisper notification's
absence in the four CallSids' logs is therefore not by itself proof
of failure; the strong inference is that whisper would 404 too if
fetched, since it is built from the same `${baseUrl}`. 944B should
confirm with a fresh test call once the env-var-aware fix is in.

## 4. Hand-off to 944B

**Failing hops (in order Twilio would have fetched them):**

1. `POST /api/twilio/webhooks/voice-whisper` — fetched on the called
   party's leg at answer. Same `${baseUrl}` source → also 404.
2. `POST /api/twilio/webhooks/voice-twiml-browser-dial-status` —
   **proven 404** against `<UUID>.kirk.replit.dev`. This is what
   leaves `twilio_calls.status` stuck at `initiated`.
3. `POST /api/twilio/webhooks/recording-status` — never reached
   because the dial leg never completed normally; once 1 + 2 are
   fixed this should self-heal.

**Failing URL pattern:** `https://${REPLIT_DEV_DOMAIN}/api/twilio/webhooks/...`,
where `REPLIT_DEV_DOMAIN` is set in the production deployment to a
per-instance `<UUID>.kirk.replit.dev` host that does not serve the
deployed app. Concrete absolute URLs Twilio fetched are listed in
§2.1.

**Where the failure lives:** TwiML *content* generated by the hop 2
handler. Handler logic and middleware are correct; the URLs handed
to Twilio are constructed against the wrong host. Same defect
applies to the identically-built `voice-twiml-forward-bridge`
(`server/routes/twilio.ts:611-625`) and the deprecated
`voice-twiml-outbound` (lines 576-587) — the §2.1 evidence for
`CAc53d23…` shows the legacy outbound flow hitting the same wall —
so the fix should flow through the shared helper.

**Confirmed root-cause category:** `bad_base_url` (primary).
Secondary risk to harden once unblocked: `rate_limited` on
`voice-whisper` due to the global, keyless `webhookLimiter` bucket.

**Scope guidance for 944B (not implementation):**

1. Make `resolveBaseUrl()` deployment-aware: prefer an explicit
   `PUBLIC_BASE_URL` / `APP_BASE_URL` env var, then the deployment
   hostname (`REPLIT_DOMAINS` / `*.replit.app`), and only fall back
   to `REPLIT_DEV_DOMAIN` when actually running in dev. In
   production, never silently return `localhost:5000` or a
   `kirk.replit.dev` host — fail loud at boot or per-request so the
   misconfiguration surfaces before a real call is placed.
2. Guarantee fallback TwiML on every hop. `voice-whisper` is
   already safe-by-fallback; confirm the same for
   `voice-twiml-browser-dial-status`.
3. Consider exempting `voice-whisper` from `webhookLimiter` (or
   raising the bucket / per-route key) so a webhook burst can never
   429 a mid-call sub-request whose failure is audible to the called
   party.
4. Verify after fix by placing a test call and inspecting the
   `Notifications` resource for the new CallSid — it should be
   empty (no `error_code=11200`) and `twilio_calls.status` should
   advance off `initiated` with `recording_sid` populated.

## 5. Evidence index (raw)

### Twilio REST API `Notifications` excerpts

`CA19703c…` (browser flow, 2026-05-08 18:30:43):

```json
{
  "log": "0",
  "error_code": "11200",
  "request_url": "https://90ddbcd4-c535-4e65-bfda-7f47669b25d0-00-n8o4pakcc1jy.kirk.replit.dev/api/twilio/webhooks/voice-twiml-browser-dial-status",
  "request_method": "POST",
  "response_code": "404",
  "message_text": "Got HTTP 404 response to https://…/voice-twiml-browser-dial-status&ErrorCode=11200&LogLevel=ERROR"
}
```

`CAc53d23…` (legacy outbound-api flow, 2026-05-01) shows the same
defect across `voice-twiml-outbound` (error 11200, code 404) and
`statusCallback=…/call-status` (error 15003, code 404).

### Production DB query

`SELECT direction, COUNT(*), COUNT(*) FILTER (WHERE recording_sid IS NOT NULL), MAX(created_at) FROM twilio_calls GROUP BY direction;`
→ `outbound | 4 | 0 | 2026-05-08 18:30:23`.

### Production deployment logs

`fetch_deployment_logs message="voice-twiml-browser-dial-status|voice-whisper|recording-status"`
→ no matches. Consistent with Twilio's evidence: the requests went
to the dev host, not the prod app.

### Code references

- `server/services/twilioService.ts:268-274` — `resolveBaseUrl()`
  fallback chain (no production branch).
- `server/routes/twilio.ts:682-687` — TwiML embedding the failing
  `${baseUrl}` URLs.
- `server/routes/twilio.ts:670` — `recordBrowserOutboundCall()`
  call site (proves hop 1 ran for the four CallSids).
- `server/routes/twilio.ts:802-833` — dial-status handler
  (`handleCallStatus`) that would have moved `status` off
  `initiated` had the request actually reached the prod app.
- `server/routes/twilio.ts:727-794` — recording-status handler
  (would have populated `recording_sid` and `recording_status`).
- `server/routes/middleware.ts:324-332` + `server/index.ts:417-420`
  — `webhookLimiter` mount (300/15min, no `keyGenerator`).
- `server/routes/twilio.ts:42-77` — `validateTwilioWebhook` URL
  reconstruction (relevant for the secondary signature check after
  the URL is fixed).
