# Twilio — Voice & SMS

Operator runbook for the core Twilio integration: SMS messaging, inbound/outbound voice, and call-recording compliance. Voicemail, the recording-archive pipeline, and call-analysis failure classification have their own runbooks linked from the Runbook Index in [RUNBOOKS.md](./RUNBOOKS.md).

## Overview

Twilio powers SMS messaging and voice calling for client communications. Outbound voice supports two per-user modes:

- **Browser audio** (default) — places calls in-tab via the Twilio Voice JS SDK against a TwiML App.
- **Forward to my phone** — bridges via the user's mobile.

## Configuration

Admin configures the following in `system_settings`:

- **SMS / REST**: `twilio_account_sid`, `twilio_auth_token`.
- **Browser audio**: `twilio_api_key_sid`, `twilio_api_key_secret`, `twilio_twiml_app_sid`. The TwiML App's Voice Request URL must point at `/api/twilio/webhooks/voice-twiml-browser`.
- **IVR / routing**: `twilio_ivr_greeting`, `twilio_ivr_menu_options`, `twilio_phone_numbers`.
- **Per-user**: `callerIdName`, `smsSignOff`, `callRoutingPhone` (configured in User Management).

See `.agents/skills/twilio-reference/SKILL.md` for the full configuration table and webhook endpoint list. The canonical Env Var / System Setting / Kill Switch Index lives in `audits/G-docs-findings.md` § 4.

## Call recording compliance

Every call (inbound, browser-outbound, forward-outbound — matched and unmatched) is auto-recorded dual-channel via `<Dial record="record-from-answer-dual">`.

- **Inbound** callers hear a generic disclosure greeting before the call routes.
- **Outbound** called parties hear the same disclosure as a `<Number url="…/voice-whisper">` whisper before the audio bridges.
- Disclosure wording lives in `system_settings.twilio_recording_disclosure`.

Recording metadata is persisted to `twilio_calls` by the `/api/twilio/webhooks/recording-status` callback (parent CallSid lookup). The Conversation Hub timeline renders an inline `<audio>` player streamed via the authenticated proxy `GET /api/twilio/calls/:id/recording` (Twilio basic-auth + SSRF host-allowlist).

After the call lands, the recording is auto-archived, transcribed, and delivered into the client's in-app files — see [TWILIO_RECORDING_ARCHIVE.md](./TWILIO_RECORDING_ARCHIVE.md).

## Related runbooks

- [TWILIO_VOICEMAIL.md](./TWILIO_VOICEMAIL.md) — inbound voicemail capture, playback, transcription, listened-state.
- [TWILIO_RECORDING_ARCHIVE.md](./TWILIO_RECORDING_ARCHIVE.md) — recording archive pipeline (object storage + Drive mirror + Twilio purge).
- [CALL_ANALYSIS.md](./CALL_ANALYSIS.md) — call-analysis failure classification + backfill.

## All-time failure audit (Task #1618)

- Read-only audit: `tsx scripts/audit-twilio-failures.ts` — dumps the failure inventory across SMS, calls, call-analysis, archive, and voicemail. Output committed at [`audits/twilio-failure-audit.md`](./audits/twilio-failure-audit.md).
- Idempotent remediation: `tsx scripts/remediate-twilio-failures.ts` — dry-run by default; per-surface flags (`--sms`, `--calls`, `--call-analysis`, `--archive`, `--voicemail`); bounded by `--batch-size=N` (default 50, max 500); refuses to write when `system_settings.twilio_remediation_kill_switch` is truthy. Reconciles our DB with Twilio's resources — never resends SMS, never re-places calls.

## Outbound dispatch reliability (audit B-003 / B-004, Task #3896)

Outbound REST creates (`sendSms` → `messages.create`, `initiateForwardCall` → `calls.create` — the only two REST create paths; browser-mode calls go through the Voice SDK TwiML webhook, no REST create) are idempotent per logical operation and rate-limit tolerant:

- **Durable operation identity + dispatch claim (B-003).** The `twilio_messages` / `twilio_calls` row is inserted BEFORE the Twilio create (`twilio_sid` NULL) and claimed via `dispatch_claim_token` + `dispatch_claimed_at`. State machine: claim (mint / insert / reclaim) → create → ownership-checked **finalize** (persists SID, releases claim) or **fail** (records `failed` + error fields on SMS, releases claim). A row that already has a SID short-circuits (`already_sent`) — the same operation id can never create a second Twilio resource; a fresh claim rejects concurrent duplicates (`in_progress`); claims older than `TWILIO_DISPATCH_STALE_CLAIM_MS` (5 min, comfortably above the ~121.4 s worst-case create window) are re-claimable for crash recovery. Callers that pass no `operationId` mint a fresh row per call — exactly the pre-#3896 per-call semantics.
- **HTTP idempotency-key contract.** All four outbound routes (`POST /api/twilio/send-sms`, `POST /api/twilio/initiate-call`, `POST /api/twilio/conversations`, `POST /api/twilio/conversations/:id/messages`) accept an optional `clientOperationId` (UUID). The Conversation Hub mints ONE `crypto.randomUUID()` per logical submission and reuses it across its automatic network retries; a human **Retry** click mints a fresh key = a new logical operation. The route derives the durable row id server-side (`deriveOutboundOperationId`: SHA-256 over user id, route tag, client key, recipient, optional scope, formatted as a version-8 UUID), so a client can never inject a foreign row id and multi-recipient sends fan out to independent per-recipient operations under one key. Duplicate POSTs converge on the same rows: a repeat after success returns the stored result; a concurrent duplicate gets **409** on the standalone send-sms/initiate-call routes (409 is deliberately not in the browser's transient-retry set) or a per-recipient `in_progress` error entry on the fan-out routes; a group retry with the same key re-dispatches only recipients that actually failed. Requests without the key keep the legacy fresh-operation-per-call behavior (cross-request dedupe requires the client to supply the key).
- **429-only bounded retry (B-004).** The client is constructed with the SDK's official mechanism: `autoRetry: true`, `maxRetries: TWILIO_HTTP_MAX_429_RETRIES` (3), `maxRetryDelay: 3000 ms`. It retries ONLY HTTP 429 responses, with full-jitter exponential backoff (`floor(min(3000, 100·2ⁿ)·random)` → worst-case added delay 1.4 s; no `Retry-After` parsing — the SDK does not implement it). 400/401/403/404, generic 5xx, timeouts, and connection resets are NEVER auto-retried. This is the ONLY retry layer: **max 4 HTTP attempts per logical operation**; the service adds no loop, and the browser send-retry treats a server-tagged `[HTTP 429 …]` as permanent (`client/src/lib/sendRetry.ts`).
- **No automatic re-dispatch.** Every create failure — including ambiguous outcomes (timeout / connection reset, where Twilio may or may not have created the resource) — leaves an explicit investigable `failed` row with the claim released. Only a fresh human retry of the same operation re-claims and re-dispatches, which for ambiguous cases can duplicate at Twilio: no provider-side idempotency mechanism exists for the Message/Call create endpoints (verified against twilio-node 5.13.1 sources + current official docs, 2026-08; the `I-Twilio-Idempotency-Token` header identifies *webhook* retries, not outbound creates).
- **Operator reading**: `twilio_sid IS NULL` + `dispatch_claimed_at` older than 5 min = a dispatch that died between claim and finalize; investigate (the SMS may exist at Twilio) before re-sending. Re-running the operation re-claims the row.
- **Dispatch logs**: `[Twilio][dispatch] op=<row id> table=<…> outcome=claimed|already_sent|rejected_in_progress|create_failed|finalized|lost_ownership_…` with numeric-only error classes (`err=http_<status>_code_<code>`) — never phone numbers, bodies, or credentials.
- **Rollback**: the claim columns are additive + nullable and invisible to pre-#3896 code; reverting the commit restores the old create-then-insert flow with no data migration in either direction.
- Tests: `tests/twilio-outbound-idempotency-sms.test.ts`, `tests/twilio-outbound-idempotency-call.test.ts`, `tests/twilio-429-retry.test.ts`, `tests/twilio-outbound-route-idempotency.test.ts` (route-level: key threading, concurrent/replayed POSTs, group partial-failure retry).

## Related Task # history

- **Task #852** — voicemail playback and transcription in the inbox.
- **Task #1049** — call-analysis slow lane and dynamic ffmpeg timeouts.
- **Task #1058** — backfill failure reasons for older failed call-analysis jobs.

## Conversation Hub thread read state (Task #1685)

Per-thread manual mark-read / mark-unread toggle in the inbox row's
overflow menu, persisted in `thread_read_states` keyed by the same
unified thread key as `thread_assignments` so it covers SMS, call-only,
voicemail, and missed-call threads.

Stored **globally** (not per-user) to stay aligned with the existing
global `twilio_conversations.unread_count` source of truth — see the
route handler in `server/routes/twilio.ts` for the rationale. Manual
unread survives the existing auto-mark-read-on-open behavior because
the two flags live in separate tables.

Assign-thread control already existed
(`PATCH /api/twilio/threads/:key/assignment`); Task #1685 adds
`GET /api/twilio/threads/assignees` to expose the eligible-assignees
list.

## GHL buyer lifecycle — SMS consent cross-reference

GHL-originated SMS steps in the book-buyer lifecycle workflows (Workflows A, C,
and D) must honour the same consent model enforced by `sendAutomatedSms()` in
`server/services/smsSendGate.ts`. The NoBull OS `sms_consent_ledger` is the
system of record; the GHL contact field `sms_marketing_status` is a mirror
updated by NoBull OS after every consent state change.

Specific rules that apply to GHL workflow SMS steps:

- **Marketing SMS** (Workflow A abandonment SMS — sent only after a recoverable
  checkout contact is captured, never on a bare checkout-start; Workflow C Buyer
  SMS 1): Send only when `sms_marketing_status = opted_in`. The `unknown` state
  is not sendable. GHL workflow branches must evaluate this field before
  executing any marketing SMS action.
- **Appointment-logistics SMS** (Workflow D 30-minute reminder): Non-promotional.
  Must still be blocked when `sms_marketing_status = opted_out`.
- **Human SMS** (Workflow D +5 min join reminder, Workflow E no-show check-in):
  Operator-initiated. The operator must verify consent state in NoBull OS before
  sending.
- **Inbound DND from GHL**: Any DND or STOP signal GHL receives on its connected
  SMS number is forwarded to NoBull OS via the signed `X-GHL-Signature` webhook.
  NoBull OS records an opt-out with source `ghl_dnd` in `sms_consent_events`
  and sets `sms_consent_ledger.state = opted_out`. More-restrictive state always
  wins.
- **Cap**: Maximum one non-transactional SMS per 24 hours per contact across all
  active GHL workflows; enforced in GHL workflow logic via conditional branches
  on `sms_marketing_status` and last-SMS timestamp fields.
- **Quiet hours**: 9:00 AM – 8:00 PM recipient-local time; GHL workflow timing
  must respect the recipient timezone stored in `sms_consent_ledger` or derived
  from area code.
- **Identification and opt-out language**: Every automated marketing SMS must
  identify NoBull Marketing and include "Reply STOP to opt out." Blueprint-
  approved copy in GHL.md §11 (Workflows A–C) includes this language verbatim.
- **A2P 10DLC**: The GHL sub-account's connected SMS number must be registered
  per blueprint §14.1 before any automated campaign message is sent. This is
  separate from the NoBull OS Twilio toll-free number registration.
- **No double-reply**: GHL's connected number and the NoBull OS Twilio number
  are separate. Do not configure both to reply to the same STOP keyword from
  the same recipient on the same thread.

Full lifecycle SMS rules: [GHL.md §14 SMS consent and DND rules](./GHL.md#14-sms-consent-and-dnd-rules).

## SMS consent & opt-out (Task #4336)

Compliance floor required before any automated or marketing SMS ever ships.
Nothing automated sends today — this section documents the ledger, keyword
handling, and the send gate that future automated senders MUST use.

**Division of labor — Twilio edge vs. app.** Our toll-free number has
Twilio's **number-level default opt-out handling** (toll-free numbers cannot
disable it). Twilio itself:
- auto-replies to STOP-family keywords with its own opt-out confirmation and
  blocks all further outbound from our number to that recipient;
- auto-replies to START-family keywords with its own re-subscribe
  confirmation and unblocks;
- auto-replies to HELP;
- still forwards every such inbound to our webhook (with an optional
  `OptOutType` hint parameter);
- fails any outbound to an opted-out number with **error 21610**.

Because Twilio already replies, the app **never sends its own keyword
replies** — it only *records*. Double-replying is the failure mode this
design avoids (task text assumed Messaging Service Advanced Opt-Out; the
prod account actually uses a bare toll-free number, same effect at the
number level).

**Consent ledger.** `sms_consent_ledger` (one row per E.164 number:
state `opted_in`/`opted_out`/`unknown`, source, human-readable evidence,
optional recipient-timezone override, opt-in/out timestamps) plus
append-only `sms_consent_events` (keyword receipts, manual changes, Twilio
21610 blocks, backfill markers; unique on `message_sid` for replay safety).
Writers live in `server/services/smsConsent.ts` +
`server/storage/smsConsentStorage.ts`.

**Inbound keyword recording.** `handleInboundSms` classifies single-word
STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT (opt-out),
START/UNSTOP/SUBSCRIBE/YES (opt-in), HELP/INFO (event only) via
`server/services/smsConsentKeywords.ts` after the message-SID dedupe gate,
so webhook replays never double-record. Opt-outs feed the opt-out-storm
alert (`infra.twilio_webhook.sms_optout_spike`).

**21610 reconciliation.** If a human console send fails with Twilio error
21610 (recipient blocked us earlier than our ledger knew), the send path
records an opt-out with source `twilio_block_21610` so the ledger converges
on Twilio's own state. The durable outbound SMS operation-row ID is stored as
`twilio:21610:<operationId>` in the consent event's `message_sid`; repeat
handling of the same failed operation is therefore an atomic no-op and cannot
enqueue duplicate GHL suppression mirrors.

**Automated-send gate.** `sendAutomatedSms()` in
`server/services/smsSendGate.ts` is the single sanctioned entry point for
any future automated SMS. Order: kill switch (default OFF —
`sms_send_gate_config` setting) → strict consent (`opted_in` only; `unknown`
is NOT sendable) → recipient-local quiet hours (area-code→timezone map with
a conservative all-continental-US-zones fallback; ledger timezone override
wins; default window 8:00–21:00 local). Every evaluation — allowed or
blocked — is audited in `sms_send_gate_audit`. There is no SMS queue today;
consent is re-checked at send time, which is why "queued messages are
dropped on opt-out" reduces to the gate re-check.

**Human 1:1 sends bypass the gate** (deliberate: operators reply to
inbound support texts) but every comms surface shows the recipient's
consent state (Conversation Hub header/composer, client contacts), and the
composer warns on opted-out numbers.

**Ops.** Admin console at `/admin/sms-consent` (ledger, events, gate audit,
settings incl. storm-alert knobs). Backfill prod-action
`sms_consent_backfill` seeds `unknown` rows for every known number
(contacts, clients, conversations, inbound history) and applies historical
keyword messages chronologically (never clobbers an existing expressed
state). Read APIs: `GET /api/sms-consent/status`,
`POST /api/sms-consent/status-batch`.
