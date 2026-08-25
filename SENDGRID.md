# SendGrid

## Overview
SendGrid serves two strictly separated lanes:
1. **Internal alerts** (original role) — the single outbound email path for every NoBull OS operator notification. One shared mailer (`sendEmail`); new alert services route through it rather than calling SendGrid directly.
2. **Client-facing overflow fallback** (Task #4334) — client-facing outbound email sends from the assigned user's own Front mailbox channel by default; SendGrid is used **only** when a user's daily cap is exhausted **and** the CEO-gated fallback is enabled on a verified marketing domain. See "Client-facing outbound lane" below.

## Architecture

### File
`server/services/mailer.ts` — single `sendEmail` function. POSTs to `https://api.sendgrid.com/v3/mail/send`. Handles sender resolution, HTML/text bodies, 10-second timeout, and bounded retries.

### Consumers
Every alert/notification service in `server/services/`, including (non-exhaustive):
- `manualReserveAlerts.ts`
- `manualReserveDigest.ts`
- `queueDrainBacklogAlerts.ts`
- `queueStarvationAlerts.ts`
- `rateLimitAlertNotifier.ts`
- `frontRecoveryRetryAlerts.ts`
- `frontHistoricalRecoveryFatalAlerts.ts`
- `frontWebhookReceiverStalenessAlerts.ts`
- `zoomReviewQueueAlerts.ts`
- `callArchiveBacklogAlerts.ts`
- `callArchiveStuckProcessingAlerts.ts`
- `callAnalysisFailureSpikeAlerts.ts`
- `auditPruneAnomalyAlerts.ts`
- `blockedIpTrimAlerts.ts`
- `clientProductsBackfillAlerts.ts`
- `importSuggestionsBacklogAlerts.ts`
- `invalidProductsGrowthAlerts.ts`
- `matchSettingsAlerts.ts`
- `autoBaselineSkipAlerts.ts`
- `bookingSchemaReadinessAlerts.ts`
- `twilioWebhookCollisionAlerts.ts`

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose | Notes |
|---|---|---|---|---|
| `SENDGRID_API_KEY` | env (secret) | — | SendGrid REST credential. | Required. |
| `SENDGRID_FROM_EMAIL` | env | — | Default "from" address. | Must be a verified sender. |
| `ALERT_FROM_EMAIL` | env | falls back to `SENDGRID_FROM_EMAIL` | Per-alert sender override. | |
| `ZOOM_REVIEW_ALERT_EMAIL_FROM` | env | falls back to `ALERT_FROM_EMAIL` | Override specifically for Zoom review alerts. | |

No `system_settings` kill switch on the mailer itself. **Per-alert** enabled/disabled flags live in `system_settings` for each alert family (e.g. `queue_drain_backlog_alert_enabled`, `front_recovery_retry_alert_enabled`); see `audits/G-docs-findings.md` § 4.

## Operational workflows

### Credential rotation
1. Generate a new API key in SendGrid with **Mail Send** permission.
2. Update `SENDGRID_API_KEY`.
3. Trigger a test alert (e.g. flip `rate_limit_alert_last_test` to now and re-fire) and confirm delivery.

### Sender identity rotation
1. Verify the new sender domain/address in SendGrid (DNS records).
2. Update `SENDGRID_FROM_EMAIL` (and `ALERT_FROM_EMAIL` if used).
3. Confirm a fresh alert lands with the new From.

### Pause / disable
- **Globally** — unset `SENDGRID_API_KEY`. Every alert will short-circuit cleanly (logged, not thrown).
- **Per-alert** — flip the corresponding `*_alert_enabled` setting to false. This is preferred during noisy incidents.

### Recovery from common failures
- **401 Unauthorized** → API key rotated or missing Mail Send permission. Re-create with the correct scope.
- **403 / sender not verified** → re-verify the From address in SendGrid.
- **Bounces / spam complaints** → check the SendGrid dashboard; persistent bounces will eventually suppress the recipient at SendGrid's side.
- **Timeout / 5xx** → the mailer retries within its bounded window; persistent failure logs and continues. Re-fire the alert manually after recovery.

## Client-facing outbound lane (Task #4334)

One send seam for all client-facing outbound email: `server/services/outboundEmail.ts` (admin UI at `/admin/outbound-email`). Routing policy: every send defaults to the **assigned user's own Front mailbox channel** (rides real mailbox reputation; sent mail lands in Front and is auto-captured by existing sync). SendGrid enters only as **overflow fallback** when a user's daily cap is exhausted — and only if the CEO-gated switch is on.

### Transport pieces in `mailer.ts`
- `sendMarketingEmail(...)` — single-recipient client-facing send. Stamps `custom_args.send_id` for webhook correlation and RFC 8058 `List-Unsubscribe`/`List-Unsubscribe-Post` headers when an unsubscribe URL is provided. Distinguishes rejected (4xx) from unknown-outcome (5xx/timeout) results; the seam treats unknown as terminal (never auto-retried, alerted).
- `fetchSendgridDomainAuthStatus(domain)` — reads `/v3/whitelabel/domains` for the SPF/DKIM verification snapshot used by the enable ceremony.
- The internal-alerts `sendEmail` is untouched and shares nothing with this lane except the API key.

### Structural gating (enabling without verification is impossible)
`setSendgridFallbackEnabled(true, ...)` **re-verifies server-side** (SendGrid domain auth valid + SPF + DKIM + DMARC record found via DNS) and throws `SendgridEnableBlockedError` with named failures unless every check passes; the from-address must be on the marketing domain. Defense-in-depth: even a rogue `system_settings` flip of `outbound_sendgrid_fallback_enabled` cannot reach SendGrid — the per-send decision re-checks the persisted verification snapshot. Changing the domain/from-address while enabled force-disables the lane. Disable is always allowed.

### Suppression + unsubscribe
Global suppression policy (`email_suppressions`) is checked on **every transport path** at compose time and again at send time. `unsubscribe` blocks marketing while preserving paid access, receipts, shipment notices, and appointment logistics; `bounce`, `complaint`, and manual safety blocks stop both message classes. Blocked rows are visibly skipped (`status=suppressed`), never sent. The list is seeded once from historical website unsubscribe inquiries; fed by the SendGrid event webhook (bounce/dropped → `bounce`, spamreport → `complaint`, unsubscribe/group_unsubscribe → `unsubscribe`), verified GHL Email DND callbacks (`source=ghl_event`), and manual admin entries. The admin suppression table exposes source and notes, including GHL contact-correlation discrepancies. Marketing-class sends carry a per-recipient capability-token unsubscribe link on both paths (GET renders a confirm page and never suppresses — link scanners follow GETs; POST suppresses within the request).

### Signed event webhook
`POST /api/webhooks/sendgrid-events` — ECDSA P-256 over `timestamp + rawBody` (SendGrid "Signed Event Webhook"). **Fail closed**: 503 when `SENDGRID_WEBHOOK_PUBLIC_KEY` (base64 SPKI DER from the SendGrid dashboard) is unset; 401 on bad signature or timestamp outside ±10 min. Processing errors return 500 so SendGrid redelivers.

### Lane env vars & settings
| Name | Type | Purpose |
|---|---|---|
| `SENDGRID_WEBHOOK_PUBLIC_KEY` | env (secret) | Event-webhook verification key. Unset ⇒ webhook rejects all events (503) — set it when enabling the fallback lane. |
| `outbound_email_daily_cap_default` | system_settings | Default per-user daily Front-path cap (per-user override on the identity row). |
| `outbound_email_sending_paused` | system_settings | Kill switch — pauses dispatch (sends defer, never fail). |
| `outbound_sendgrid_fallback_enabled` | system_settings | CEO-gated overflow switch; only writable through the verify-then-enable ceremony. |
| `outbound_marketing_domain` / `outbound_sendgrid_from_email` | system_settings | Authenticated marketing domain + on-domain from-address for the fallback. |

Tests: `tests/outbound-email-service.test.ts`, `tests/outbound-email-routes.test.ts`, `tests/sendgrid-event-webhook.test.ts`.

## GHL buyer lifecycle — email cross-reference

GHL-originated marketing email steps in the book-buyer lifecycle workflows
(Workflows A, C, F, and the post-attended sequence) are supplementary to
NoBull OS outbound email. The following rules govern the interaction between
the two systems:

**Transactional vs. marketing separation.** Workflow B (purchase confirmation,
access link) and any shipment notification are sent by NoBull OS — not by
GHL — as transactional messages. Physical fulfillment messaging is disabled in
GHL. GHL marketing email workflows (A, C, F) must never duplicate or replace
the NoBull OS transactional receipt or access email.

**Suppression consistency (GHL → NoBull, tighten-only).** NoBull OS maintains
the global `email_suppressions` table. In addition to SendGrid
bounce/complaint/unsubscribe events and manual entries, the signed GHL
Marketplace receiver accepts only the approved `ContactDndUpdate` contract where
`dndSettings.Email.status = active`, the location matches, and contact ID +
email are valid. It adds/reconfirms one normalized suppression with
`source=ghl_event`, cancels promotional NoBull sequence enrollment, and may only
tighten an existing local contact to `unsubscribed`. Missing/mismatched GHL
contact correlation is durable in suppression notes for operators. No inbound
GHL event can subscribe, clear suppression, or alter receipts/access.

There is intentionally no NoBull → GHL resubscribe/consent sync in this
contract. GHL must continue enforcing its native suppression independently.

**One-click unsubscribe.** GHL marketing email templates must carry a working
unsubscribe mechanism. GHL's built-in link is acceptable only after the live
signed-delivery activation check in GHL.md §19.2 proves that it emits the
approved callback; custom NoBull links route through the NoBull suppression
endpoint.

**SendGrid overflow lane.** The CEO-gated SendGrid overflow lane
(`outbound_sendgrid_fallback_enabled`) applies only to NoBull OS client-facing
email, not to GHL-originated campaign email. GHL sends independently through
its own email provider. Do not route GHL workflow email through `sendMarketingEmail()`
in `mailer.ts`.

**After unsubscribe.** Transactional access email (receipt, book access link,
shipment status from NoBull OS) remains available after a marketing unsubscribe,
per blueprint §13.7 and CAN-SPAM. The GHL marketing email sequence must stop
completely on unsubscribe; `email_marketing_status = unsubscribed` is evaluated
as a workflow entry/exit condition.

**Subject line integrity.** All GHL marketing email subjects must be accurate.
No deceptive "Re:" or "Fwd:" prefixes. No fake deadlines or scarcity. Approved
subject lines are documented in [GHL.md §11](./GHL.md#11-workflow-definitions)
for each workflow step.

Full lifecycle email rules: [GHL.md §15 Email consent and deliverability rules](./GHL.md#15-email-consent-and-deliverability-rules).

## Alerts and observability
- SendGrid is the **delivery channel** for alerts, so monitoring SendGrid itself relies on the provider's dashboard.
- Per-alert services log delivery success/failure to the application log.

## Verification
- Use the rate-limit alert "Send test" path (admin UI) to deliver one email end-to-end.
- Confirm `SENDGRID_API_KEY` is non-empty and `SENDGRID_FROM_EMAIL` resolves to a verified sender.

## Related runbooks
- [MANUAL_RESERVE_RESEND_ATTRIBUTION.md](./MANUAL_RESERVE_RESEND_ATTRIBUTION.md) — manual-reserve alerts that flow through this mailer.
- [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md) — queue-backlog alerts that flow through this mailer.
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- See individual alert-service file headers for Task # citations.
