# Task #1051 — Findings: Investigate Low Inbound Communication Volume

Investigation date: 2026-05-13.

## Summary

Inbound volume is genuinely low **and** there are two real, identifiable upstream gaps still active in production. Webhook receivers themselves are not silently dropping events — every observed failure path produces an explicit log line and metric. The deeper issues sit one layer in.

## Production state (queried via prod read replica)

Counts as of investigation time:

| table | last 24h | last 7d |
|---|---|---|
| `raw_communication_records` | 7 | 102 |
| `front_sync_emails` | 0 | 0 |
| `twilio_calls` | 0 | 3 |
| `twilio_messages` | 0 | 4 |

`raw_communication_records` 7d by source: `zoom=86`, `front_email=9`, `twilio_sms=4`, `twilio_call=3`. Last `front_email` row: 2026-05-12 03:12. Last twilio row: 2026-05-08.

`source_event_log` 7d, `source_system='front'`:
- `conversation_ingested` (webhook path): 9 received, all on 2026-05-08 → 2026-05-12 03:12. Only 4 in the last 48h, all 2026-05-12.
- `historical_recovery` (backfill path): 7305 `received` (2026-05-11 21:26 → 2026-05-13 02:01) + 2141 `ready_to_apply` (2-hour burst on 2026-05-11). **Zero applied.**

`twilio_calls` archive_status (30d): 1 `done`, 4 `pending`.

## Findings

### 1. Front webhook receiver path is healthy
- Receiver at `server/routes/integrations.ts:646` validates signature (`verifyFrontSignature`) and returns 500 with `[FrontWebhook] Error:` on any throw — no silent 200s except the documented `feature_disabled` gate.
- Deployment logs confirm `event_received source=front_webhook_apply` and successful `applied source=front_webhook_normalize` entries throughout 2026-05-13. Receive→normalize stage is fine.

### 2. Front apply step is still dead-lettering with `e.toISOString is not a function`
- Repeated `[Pipeline] failed source=front_webhook_apply error="e.toISOString is not a function"` from 16:48 → 19:29 UTC on 2026-05-13, three attempts then `dead_lettered`.
- Task #1045's `toSafeDate(normalized.timestamp)` fix **is present** in `server/services/frontWebhookIngestion.ts:389`, and `shared/utils/safeDate.ts` exists. The fact that the error persists means either (a) the fix is not yet live in the deployed build, or (b) the failing date is on a different field — `recordApplyOutcome` (`pipelineProcessor.ts:127`) only writes `new Date()` values so it isn't the source; the most likely remaining culprit is a downstream writer downstream of `applyFrontWebhookResult` (e.g. participant/last-message timestamp coercion in `createRawCommunication`/related upserts) that still passes a raw string into a Drizzle Date column.
- Net effect: **webhook events arrive but never reach `raw_communication_records`.** This fully explains the near-zero `front_email` inflow.

### 3. Front backfill (historical_recovery) is stalled
- 7305 `received` historical_recovery events backed up since 2026-05-11. Only 2141 ever reached `ready_to_apply`, and 0 reached `applied`. Same `toISOString` failure shape.
- This is a separate, observable backlog and explains `front_sync_emails = 0 / 7d`.

### 4. Twilio: zero inbound traffic actually reaching us
- Searches for `POST /api/twilio/webhooks`, `recording-status`, `x-twilio-signature`, `inbound`, `validateTwilioWebhook` rejections — all returned no hits in the deployment log window. Only admin UI traffic and the periodic call-archive sweeper are present.
- `validateTwilioWebhook` (`server/routes/twilio.ts:22`) returns 503 in prod when no auth token is configured and 403 on invalid signature, both with explicit logs. No such logs exist → **Twilio is not delivering to our endpoint at all** in this window.
- `system_settings` confirms `twilio_account_sid` and `twilio_auth_token` are set. Nothing on our side rejects silently.
- Cause is upstream of our service: either truly no inbound SMS/calls in the window (plausible for a small business), or the Twilio Console webhook URL on the phone number(s) is misconfigured. Cannot be confirmed from server logs alone — needs a Twilio Console check + a live test SMS/call.

### 5. Twilio archive backlog (separate from #1046)
- 4 of 5 `twilio_calls` in the last 30 days are `archive_status='pending'`. Only one made it to `done`. Consistent with the gating dependency (#1046 archive scheduler).

## Webhook silent-failure audit (per spec step 2)

| endpoint | silent path? | how it logs |
|---|---|---|
| `POST /api/integrations/front/webhook` | No | 200 only on success or `feature_disabled`; otherwise 500 with `[FrontWebhook] Error:` |
| `POST /api/twilio/webhooks/*` | No | 503 (no token) / 403 (bad sig) with explicit logs; success path logs via pipeline |
| pre-queue handlers | No | `applyFrontWebhookResult` writes to `raw_communication_records` directly via `createRawCommunication` and emits pipeline events; failures surface as `job_failed`/`dead_lettered` |

No silent-drop path was found. The visibility issue is that dead-lettered apply jobs are noisy in logs but their root cause (a still-live `toISOString` crash) hasn't been fully closed by #1045.

## Live smoke (spec step 4) — gated, handed off

**Not performed, by design.** The task spec itself states: *"This depends on the Front webhook apply fix and the Twilio archive scheduler fix being merged first — otherwise the noise from those failures masks any real upstream issue."* and Step 4: *"After Front apply and Twilio archive fixes are deployed, send one live test event…"*.

State of the gating dependencies as of this investigation:

- **#1045 (Front apply fix)** — code-level fix is present in source (`shared/utils/safeDate.ts`, `frontWebhookIngestion.ts:389`) but the deployed runtime is still emitting `e.toISOString is not a function` on every Front apply attempt as recently as 2026-05-13 19:29 UTC. The fix is therefore **not yet effectively deployed**. A smoke event sent right now would dead-letter alongside the existing failures and prove nothing.
- **#1046 (Twilio archive scheduler)** — 4 of 5 calls in the last 30 days are `archive_status='pending'`, consistent with that scheduler still being unhealthy.

Live smoke is therefore handed off to follow-up **#1059** (Front; smoke runs after the apply crash is truly closed) and follow-up **#1060** (Twilio; smoke runs after the Twilio Console webhook URL is confirmed and an inbound test is delivered). Both follow-ups carry the live-smoke acceptance criterion explicitly.

## Twilio provider-side evidence — requires Twilio Console

Comparing Twilio-side delivery logs to our ingestion counts requires read access to the Twilio Console (Monitor → Logs → Errors / Calls / Messaging) for the configured account SID. The investigating environment has the SID/auth token in `system_settings` but does not have a human Console session, and the REST API does not expose webhook delivery attempt logs. This handoff is captured in **#1060**, which calls for verifying each provisioned phone number's Voice Request URL and SMS URL in the Twilio Console and then issuing a live test SMS + inbound call.

What we *can* assert from our side: the Twilio request validator (`server/routes/twilio.ts:22`) is correctly wired and logs every rejection with status code; over the inspected window there are zero such log entries, which means Twilio is not even attempting delivery to our endpoint (vs. attempting and being rejected). Provider-side confirmation is the next step.

## Follow-up tickets filed

- **#1059** — Stop Front email events from getting stuck and silently lost (closes the residual `toISOString` crash; carries the Front live-smoke acceptance).
- **#1060** — Verify Twilio is actually configured to call us, with a live test (Twilio Console URL audit + live inbound SMS/call smoke).
- **#1061** — Alert us when webhook ingestion stalls instead of finding out days later (so the next regression is caught in minutes, not days).

## Conclusion

- The "low volume" signal is **real**, not measurement error.
- Front: events are arriving but the apply step is still crashing → events do not become `raw_communication_records`. Task #1045's code-level fix is in place but the production behaviour shows the bug is not fully closed (either not deployed yet or there is a second `toISOString` source on the apply path). **Real gap → follow-up filed.**
- Twilio: nothing is reaching us. No webhook hits at all. Most likely upstream-config or genuinely no traffic. **Needs a Twilio-Console verification + live smoke → follow-up filed.**
- Front historical recovery backlog of 7305 received events is stuck behind the same Front apply failure → follow-up filed (resolves automatically once apply is fixed, but worth confirming drain).

No webhook receiver requires changes; receivers correctly log every failure mode.
