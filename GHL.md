# HighLevel (GHL) Operations — Buyer Lifecycle Automation Runbook

**Runbook version:** v1 (August 2026)
**Status:** Pre-production — not yet activated in any environment. No production lifecycle automation is live.
**Authority:** NoBull OS is sole authority for checkout, Stripe payment facts, orders, refunds, entitlements/access, and SMS consent. GHL is an operational mirror only.

---

## 1. Scope and authority

HighLevel is a CRM operations mirror. It may hold contacts, approved tags and
custom fields, calendars, workflow state, sales tasks, appointments, and
opportunities. NoBull OS remains authoritative for checkout, Stripe payment
facts, orders, refunds, entitlements/access, and SMS consent.

Inbound DND or opt-out signals from GHL may only make NoBull outreach **more**
restrictive, never less. A GHL delivery must never create a payment, grant paid
access, or create consent. GHL workflow results are advisory signals; NoBull OS
does not execute refunds, entitlement changes, or consent state changes on the
basis of a GHL signal alone.

Physical fulfillment messaging (shipment notifications) remains **disabled** in
GHL. All shipment-status communication originates from NoBull OS.

---

## 2. Connect a private integration

1. In the intended HighLevel **sub-account**, create a private integration
   token with only the approved CRM/contact, calendar, opportunity, and webhook
   scopes. Do not create production tags, fields, workflow IDs, calendars, or
   pipeline IDs while connecting it.
2. In NoBull OS, open **Admin → Integrations → HighLevel** and enter the token
   and that sub-account's location ID. The token is write-only; it is never
   returned by the API, the Hub, or credential history.
3. The connection saves first, then performs a bounded authenticated location
   probe. A 401/403 clears the newly entered token as a confirmed terminal
   rejection. A timeout, rate limit, or 5xx preserves it and the cached status
   reports a degraded/unknown state until the next probe succeeds.
4. Use the credential-history control to establish who connected, disconnected,
   or had a terminal rejection. It records only event metadata—never the
   token, headers, payloads, or response bodies.

Use a different token and location ID per environment. Never copy a production
private token into development, source control, an issue, or chat.

---

## 3. Health, audit, and incident controls

- The Hub and `GET /api/integrations/ghl/status` read the shared cached status;
  they never wait for an upstream call during page rendering. A cold cache is
  **Checking**, while transient probe failures preserve the last known state.
- All GHL HTTP goes through the external-call audit wrapper. It records only
  route, method, status, timing, response size/hash, and error class when the
  global audit switch is enabled.
- `kill_switch_ghl_outbound_sync=true` pauses outbound CRM mirroring only. It
  must not pause or change the authoritative checkout, payment, refund,
  entitlement, access, or consent flows.
- To rotate a token, enter the replacement token using the same Hub control;
  save-first verification prevents a transient GHL outage from destroying a
  valid credential. Disconnecting clears the stored token and location but
  does not delete any remote CRM records.

---

## 4. Callback and recovery policy

**Inbound Marketplace webhook endpoint:**
`POST /api/integrations/ghl/marketplace-webhook`
Auth: Ed25519 (`X-GHL-Signature` over exact raw body bytes).
Public key: `GHL_MARKETPLACE_PUBLIC_KEY` env var (base64 SPKI DER). No session.
Governed by `webhookLimiter`.

Fail-closed gates (in order, before any body processing):
- `GHL_MARKETPLACE_PUBLIC_KEY` absent or blank → 503.
- Configured GHL location ID unresolvable from system settings → 503.
- Invalid, missing, or wrong-key signature → 401.
- `locationId` in payload does not match the configured location → 403.

Accepted events and their effects. `AppointmentCreate` and `AppointmentUpdate`
share ONE bootstrap path:
- **Correlation exists** (appointment already mapped):
  - Same mapped status **and** changed `startTime`/`timezone` → **reschedule**:
    the existing appointment's schedule is updated in place and the route
    returns `rescheduled`. This is NOT a status transition (no lifecycle/outbox
    row); it is scheduling metadata only.
  - Same status, no schedule change → `already_in_target_state` (no-op).
  - Different mapped status → legal `BookAppointment` state transition.
- **No correlation** (Create OR Update):
  - Requires a GHL contact correlation → local book contact.
  - RESOLVES (never fabricates) an existing audit application: first the
    deterministic key `ghl-appt:<ghlApptId>`, then the most-recent
    qualified/submitted application for the contact.
  - Missing `contactId`, missing contact correlation, or no resolvable
    application → **500 retryable** for operator reconciliation. The route
    NEVER manufactures a brand-new audit application for a signed external
    appointment, and an `AppointmentUpdate` with no correlation is never
    acknowledged with a false "GHL will retry" 200.
  - Otherwise: upsert the appointment on the resolved application (carrying the
    schedule), write the appointment correlation, then transition into the
    mapped status.
- `ContactDndUpdate` with SMS DND active / `InboundMessage` (STOP-family) →
  writes `opted_out` via the atomic deduped consent storage operation. SMS DND
  cleared or non-STOP → 200 ignored.
- `ContactDndUpdate` with `dndSettings.Email.status = "active"` → adds or
  reconfirms the address in NoBull's global `email_suppressions`, cancels active
  promotional sequence enrollment, and conditionally tightens an existing
  `book_contacts.email_marketing_status` to `unsubscribed`. It never creates a
  contact, sets `subscribed`, clears suppression, or changes SMS unless the same
  signed event separately has `dndSettings.SMS.status = "active"`.

Tighten-only consent rule: GHL may only make NoBull outreach MORE restrictive.
GHL is never accepted as affirmative consent authority — no `opted_in` write
is ever issued from this receiver.

Idempotency: appointment transitions use deterministic lifecycle/outbox keys
`(appointmentId, fromStatus, toStatus)` — replays are DB-level no-ops.
DND events derive a stable dedupe key: the GHL delivery ID
(`body.eventId` / `body.deliveryId` / `body.webhookId`), prefixed `ghl:`; when
the payload carries no delivery ID, a deterministic `ghl:sha256:<hash>` of the
exact raw body is used instead. For `ContactDndUpdate`, root `body.id` is the
GHL **contact ID**, never a delivery ID. The SMS dedupe key is written as
`message_sid` on
`sms_consent_events`. `applyDedupedConsentStateChange` runs a SINGLE
transaction: it inserts the event (`ON CONFLICT (message_sid) DO NOTHING`) and
ONLY upserts the ledger when the event was newly inserted — so a replay is a
true atomic no-op (`optedOutAt`/`evidence` untouched) and the opt-out-storm
watcher fires only when the event was inserted AND the state actually changed.

Email unsubscribe replay safety uses the existing unique normalized-email
suppression upsert. A replay cannot add a duplicate suppression, re-enroll a
marketing sequence, or relax contact state. It may refresh `lastEventAt` and
bounded GHL evidence on the existing suppression. The local contact update is a
conditional `unknown|subscribed → unsubscribed` write, so subsequent deliveries
are no-ops at the contact-state layer.

### Owner-approved GHL email-unsubscribe callback contract

**Contract approval:** owner-approved as the Task #5144 implementation contract
on 2026-08-22. This approves the field-level software contract only; production
activation still requires the real signed-delivery evidence in §19.2 and gate
G-12.

The contract is the official GHL Marketplace `ContactDndUpdate` event documented
at <https://marketplace.gohighlevel.com/docs/webhook/ContactDndUpdate>. NoBull
accepts an email unsubscribe only when all of these conditions are true:

| Field / check | Required value |
|---|---|
| Transport | Raw-body `POST /api/integrations/ghl/marketplace-webhook` |
| Signature | Valid Ed25519 `X-GHL-Signature` over the exact raw body |
| `type` | Exact string `ContactDndUpdate` |
| `locationId` | Exact configured GHL location |
| `id` | Non-empty GHL contact ID |
| `email` | Syntactically valid email address, normalized by NoBull |
| `dndSettings.Email.status` | Exact semantic state `active` (case-normalized) |
| Delivery identity | Optional `eventId`, `deliveryId`, or `webhookId`; otherwise raw-body SHA-256 |

`dndSettings.Email.status = "inactive"` or any other value is acknowledged and
ignored. An `active` signal missing `id`, `email`, or a valid address is malformed
and returns 400. A legacy-only `contactId` alias or a `contactId` that conflicts
with root `id` is also malformed. Bad signature returns 401; wrong location returns 403;
unavailable verifier/config returns 503; persistence failures return 500 so GHL
retries. Unknown event types remain 200 ignored.

The accepted event is **one-way and tighten-only**. A new canonical NoBull
suppression is written with source `ghl_event`, reason `unsubscribe`, and bounded
notes containing the GHL contact ID, stable delivery key, and correlation
result. If the address was already suppressed, the original source/reason stay
intact and the GHL evidence is refreshed in notes. Operators see those fields in
**Admin → Outbound Email → Suppressions**.
`matched`, `missing_contact_correlation`, and `correlated_email_mismatch` are the
three reconciliation outcomes; the latter two are both returned in the webhook
response and durably recorded in the suppression notes. Suppression is still
applied to the verified event email when correlation is missing or mismatched;
the inconsistent correlated contact is never modified.

NoBull does not accept an affirmative GHL email state and does not mirror
`subscribed` inbound. No NoBull→GHL resubscribe/consent callback, poller, or
background reconciliation is part of this contract.

The suppression row is written before eager promotional-enrollment
cancellation. If cancellation fails, the route returns 500: the suppression
already blocks marketing sends, and GHL retry completes cancellation plus the
secondary contact snapshot. It never acknowledges 200 while that eager
cancellation step is known to have failed.

**Opportunity status (won/lost/close):** GHL opportunity stage movement is,
per §9 and §17, a GHL-INTERNAL salesperson workflow (stages such as
`Lost / Unqualified` are set manually; automated movement is forward-only).
The official inbound Marketplace opportunity event field shape is not proven in
this codebase, so this receiver does **not** parse opportunity events as
authoritative signals. Revenue, payment, refund, and entitlement authority
remains with NoBull OS (Stripe) — GHL is never authoritative for them (§17).
Opportunity close/lost is handled by GHL-internal workflow plus the operator
reconciliation path in §17, not by inventing an inbound event contract.
An order↔opportunity correlation
(`book_provider_correlations provider=ghl type=opportunity ↔ order`) already
exists for outbound sync; if a signed official opportunity event shape is later
confirmed, it may be correlated to the local order for durable ADVISORY
evidence only — never to drive revenue/payment state.

The inbound signed-webhook receiver and durable operational mirror are
introduced with the outbound/webhook delivery stages. Before enabling any GHL
event subscription, confirm the deployed callback endpoint, signed-delivery
format, event allow-list, and recovery drill documented by that stage.

**Signed webhook format:** GHL delivers Ed25519 signatures in the
`X-GHL-Signature` header. NoBull OS verifies this signature before processing
any inbound GHL event. **Do not send unsigned workflow webhooks to NoBull OS.**
Any webhook without a valid `X-GHL-Signature` is rejected with a 401.

If GHL is degraded, keep paid delivery operating normally. Restore the GHL
credential or provider service, observe a healthy cached probe, and then let
the durable mirror retry; never replay checkout or Stripe events from GHL.

---

## 5. Book-buyer calendar and qualification policy

The post-purchase buyer journey is capability-gated and independent from paid
book access. It fails closed until both of these owner-approved system settings
are present:

- `book_buyer_qualification_policy_v1` — JSON with `version: 1`, `enabled`,
  `eligibleRoles`, `maximumImprovementTimelineDays`, explicit `thresholdMode`
  (`all` or `any`), and at least one of
  `minimumMonthlyQualifiedInquiries` or `minimumAnnualFirmRevenueUsd`.
- `book_buyer_ghl_calendar_v1` — JSON with `version: 1`, `enabled`, the exact
  `https://api.leadconnectorhq.com/widget/bookings/...` URL copied from the
  approved GHL calendar's **Share → Embed Code** flow, and a `prefillFields`
  allow-list. Supported fields are `name`, `email`, `utmSource`, `utmMedium`,
  `utmCampaign`, `utmTerm`, and `utmContent`. Only include fields the owner has
  approved for delivery to GHL.

Do not infer either setting from the GHL location, private token, current
calendar list, historical application data, or a public booking page. An
absent, malformed, disabled, or band-ambiguous policy routes the application to
manual review; it never guesses. An absent or invalid calendar setting keeps
the approved application saved but emits no GHL frame request.

The GHL iframe is created only after a qualified buyer explicitly asks to view
the calendar. GHL owns availability, booking, rescheduling, cancellation, and
appointment messaging. `/book/thanks/` shows only trusted appointment facts
already mirrored into NoBull OS; until the mirror confirms those facts it shows
a recoverable pending state and never exposes application answers. None of
these states may grant, revoke, delay, or otherwise change book access.

---

## 6. Buyer lifecycle automation — blueprint overview

The lifecycle consists of six named workflows (A–F) triggered by verified
NoBull OS events. No GHL workflow may fire before the triggering event is
confirmed by NoBull OS. The following sections document the approved event map,
contact field schema, tag names, pipeline stages, workflow trigger and stop
conditions, ownership placeholders, timing, copy references, SMS consent rules,
and operational safeguards.

---

## 7. Approved contact field names

The following contact custom field names are the canonical approved set. Do not
create fields with alternate names, abbreviations, or casing variations. All
fields are provisioned in the GHL sub-account before any workflow references
them.

| Field name | Type | Source of truth | Notes |
|---|---|---|---|
| `email` | text | NoBull OS | Standard GHL contact field |
| `first_name` | text | NoBull OS | Standard GHL contact field |
| `phone` | phone | NoBull OS | Standard GHL contact field; populated only when buyer provides it |
| `sms_marketing_status` | text | NoBull OS | `opted_in` / `opted_out` / `unknown`; mirrors `sms_consent_ledger` |
| `sms_consent_timestamp` | datetime | NoBull OS | UTC ISO-8601; set on consent, never modified by GHL |
| `sms_consent_copy_version` | text | NoBull OS | Disclosure text version identifier |
| `sms_consent_source_url` | text | NoBull OS | URL at which consent was collected |
| `email_marketing_status` | text | NoBull OS (GHL may tighten only) | `subscribed` / `unsubscribed` / `unknown`. The outbound relay does not write this field. A verified signed `ContactDndUpdate` with Email DND `active` conditionally tightens the existing NoBull contact snapshot to `unsubscribed`; GHL can never set `subscribed`. Native GHL unsubscribe/DND suppression remains mandatory. |
| `order_id` | text | NoBull OS | NoBull internal order identifier |
| `stripe_payment_intent_id` | text | NoBull OS | Provisioned for the Stripe PI id; the current relay does not write it. Do not use it for refund decisions. |
| `selected_package` | text | NoBull OS | `LFRE-DIGITAL-2026`, `LFRE-COMPLETE-2026`, or approved SKU |
| `first_touch_utm_source` | text | NoBull OS | Provisioned for original UTM source; not written by the current relay |
| `first_touch_utm_medium` | text | NoBull OS | Provisioned for original UTM medium; not written by the current relay |
| `first_touch_utm_campaign` | text | NoBull OS | Provisioned for original UTM campaign; not written by the current relay |
| `first_touch_utm_content` | text | NoBull OS | Provisioned for original UTM content; not written by the current relay |
| `first_touch_utm_term` | text | NoBull OS | Provisioned for original UTM term; not written by the current relay |
| `last_touch_utm_source` | text | NoBull OS | Provisioned for latest UTM source; not written by the current relay |
| `last_touch_utm_medium` | text | NoBull OS | Provisioned for latest UTM medium; not written by the current relay |
| `last_touch_utm_campaign` | text | NoBull OS | Provisioned for latest UTM campaign; not written by the current relay |
| `gclid` | text | NoBull OS | Provisioned for Google click ID; not written by the current relay |
| `fbclid` | text | NoBull OS | Provisioned for Meta click ID; not written by the current relay |
| `qualification_status` | text | NoBull OS | `pending` / `qualified` / `unqualified` / `manual_review` |
| `qualification_reason` | text | NoBull OS | Free text reason set by policy evaluation |
| `audit_role` | text | NoBull OS | Provisioned for the application role; not written by the current relay |
| `audit_monthly_inquiry_range` | text | NoBull OS | Provisioned for the application inquiry bracket; not written by the current relay |
| `audit_revenue_or_proxy_range` | text | NoBull OS | Provisioned for the application revenue bracket; not written by the current relay |
| `audit_improvement_timeline` | text | NoBull OS | Provisioned for the application timing selection; not written by the current relay |
| `appointment_id` | text | NoBull OS | NoBull local `book_appointments.id`, written to GHL as the durable local-side anchor. The GHL external appointment ID maps to it through `book_provider_correlations` (`provider=ghl`, entity type `appointment`); it is not stored in this field. |
| `appointment_status` | text | GHL/NoBull OS | `booked` / `attended` / `no_show` / `cancelled` |
| `appointment_attended_at` | datetime | GHL/NoBull OS | UTC; set when attendance confirmed |
| `opportunity_stage` | text | GHL | Current pipeline stage name (see §11) |
| `attributed_revenue` | number | NoBull OS | Provisioned for confirmed closed-client revenue; the automated relay does not write it because no approved signed opportunity-close callback contract exists. |

**Environment-specific identifier requirements:** Every environment (development,
staging, production) must have its own GHL sub-account, location ID, and private
token. Field IDs assigned by GHL are environment-specific and must not be
copy-pasted across environments. The field *names* listed above are
environment-agnostic and are the exact contract constants compiled into
`server/services/ghlBuyerSync.ts` (`GHL_FIELD_NAMES`); they may not be renamed
without an owner-approved code + runbook change.

The GHL internal field IDs (alphanumeric strings assigned by GHL) that map each
name → its environment ID are stored in the validated, environment-specific
`ghl_buyer_sync_config_v1` system setting (`customFields` map), never in source
code or this document. That setting is strict-parsed and disabled/fail-closed by
default (see §21). Only the GHL **private integration token** and the
**Marketplace webhook public key** remain outside that setting — the token is a
write-only credential entered via the Hub (§2) and the public key is the
`GHL_MARKETPLACE_PUBLIC_KEY` environment variable (§4).

---

## 8. Approved tag names

Tags are applied and removed by NoBull OS via the GHL Contacts API. Tag names
are case-sensitive. Do not apply tags outside this list in automated flows; new
tags require owner approval and a runbook update.

| Tag | Applied when | Removed when |
|---|---|---|
| `book_checkout_started` | Recoverable checkout contact completed in NoBull OS (a contact was captured; `checkout.recoverable` / `checkout.completed` outbox event) — never a bare "checkout start" with no recoverable contact | Purchase confirmed |
| `book_buyer` | Stripe payment confirmed by NoBull OS webhook | Refund confirmed (per §18) |
| `lfre_digital` | Order includes `LFRE-DIGITAL-2026` | Refund confirmed |
| `lfre_audio` | Order includes `LFRE-AUDIO-2026` | Refund confirmed |
| `lfre_print` | Order includes `LFRE-PRINT-2026` | Refund confirmed |
| `lfre_complete` | Order includes `LFRE-COMPLETE-2026` | Refund confirmed |
| `book_bonus_viewed` | Buyer visits `/book/bonus` | Never removed |
| `audit_applied` | Application submitted at `/book/apply` | Never removed |
| `audit_qualified` | `qualification_status` set to `qualified` by policy | Never removed |
| `audit_unqualified` | `qualification_status` set to `unqualified` | Never removed |
| `audit_manual_review` | Policy routes to manual review | Resolved by operator |
| `HIRS_booked` | GHL appointment created and mirrored to NoBull OS | Never removed |
| `HIRS_attended` | Attendance confirmed in GHL and mirrored | Never removed |
| `HIRS_no_show` | No-show status set in GHL and mirrored | Removed if rescheduled and attended |
| `HIRS_cancelled` | Appointment cancelled | Never removed |
| `workflow_a_active` | Abandonment eligibility window opens — only after a recoverable checkout contact is captured (`checkout.recoverable` / `checkout.completed`), never on a generic checkout-start with no recoverable contact | Purchase confirmed or 48 h elapsed |
| `workflow_c_active` | Purchase confirmed, buyer-to-booking sequence starts | Appointment booked |
| `workflow_d_active` | Appointment booked | Appointment attended or cancelled |
| `workflow_e_active` | No-show status set | Rescheduled and attended, or Day 7 close |
| `workflow_f_active` | Day 14 of Workflow C elapsed without booking | Manually removed by owner |
| `closed_client` | Client closed and attributed revenue confirmed | Never removed |
| `long_term_nurture` | Added to educational/CEO list after Day 60 of Workflow F | Never removed |

---

## 9. Pipeline and opportunity structure

### Pipeline name

`Book Buyer Pipeline` (exact name; provisioned in GHL sub-account before workflows reference it).

### Pipeline stage names

The following stage names are the canonical approved set. Stage IDs assigned by
GHL are environment-specific and must not be hard-coded.

| Stage name | Entered when |
|---|---|
| `Checkout Started` | `book_checkout_started` tag applied (recoverable checkout contact captured; never a bare checkout-start) |
| `Book Purchased` | `book_buyer` tag applied |
| `Applied` | `audit_applied` tag applied |
| `Qualified` | `audit_qualified` tag applied |
| `Unqualified / Manual Review` | `audit_unqualified` or `audit_manual_review` tag applied |
| `Meeting Booked` | `HIRS_booked` tag applied |
| `Meeting Attended` | `HIRS_attended` tag applied |
| `No-Show` | `HIRS_no_show` tag applied |
| `Proposal / Active Sales` | Set manually by salesperson after attended session |
| `Closed Client` | `closed_client` tag applied and attributed revenue recorded |
| `Lost / Unqualified` | Set manually by salesperson |

Movement through pipeline stages is forward-only for automated transitions.
Manual regression (e.g. re-opening a lost opportunity) requires salesperson
action in GHL and a corresponding NoBull OS note.

---

## 10. GHL event map

The following table is the canonical event map derived from the approved
blueprint (§11.6). Every event in the left column is initiated by a verified
NoBull OS action; GHL mirrors the state. GHL does not initiate payment, access,
refund, or affirmative-consent events. The sole consent exception is the
verified, tighten-only inbound Email/SMS suppression contract in §4.

| NoBull OS event (outbox event type) | GHL CRM action | Workflow effect |
|---|---|---|
| Recoverable checkout contact completed (`checkout.recoverable` / `checkout.completed`) | Upsert contact; mirror consent fields; apply `book_checkout_started` + `workflow_a_active`; set `selected_package`; move to `Checkout Started` stage | Start Workflow A abandonment eligibility. Never fires on a bare checkout-start with no recoverable contact. |
| Stripe payment confirmed (`order.payment_captured`) | Remove `workflow_a_active` + `book_checkout_started`; mirror consent fields; apply `book_buyer` + product SKU tag(s); set order/package fields; move to `Book Purchased`; create/update opportunity | Exit Workflow A; start Workflow C. Applying `book_buyer` triggers GHL onboarding + buyer-to-booking only — the canonical receipt/access delivery is NoBull-only and is never produced by GHL. |
| `/book/bonus` visited | Apply `book_bonus_viewed` | No workflow change |
| Application submitted | Write qualification fields; apply `audit_applied`; move to `Applied` | Route per qualification policy |
| Qualified | Apply `audit_qualified`; move to `Qualified`; expose calendar setting | Expose GHL calendar iframe |
| Unqualified | Apply `audit_unqualified`; move to `Unqualified / Manual Review` | No calendar exposure |
| Manual review routed | Apply `audit_manual_review`; move to `Unqualified / Manual Review` | Salesperson task created |
| GHL appointment created | Apply `HIRS_booked`; move to `Meeting Booked` | Exit Workflow C; start Workflow D |
| GHL appointment attended | Apply `HIRS_attended`; move to `Meeting Attended` | Exit Workflow D; trigger sales follow-up (Workflow post-attended) |
| GHL no-show set | Apply `HIRS_no_show`; move to `No-Show` | Exit Workflow D; start Workflow E |
| GHL appointment cancelled | Apply `HIRS_cancelled`; update stage | Exit Workflow D |
| Client closed (manual) | Apply `closed_client`; record `attributed_revenue`; move to `Closed Client` | Send offline conversion data to ad platforms. **Not automated yet:** `closed_client` / `attributed_revenue` are approved vocabulary but no outbox event/handler drives them in `ghlBuyerSync.ts` today — this stage is set manually by a salesperson. |
| Full refund or cancellation confirmed by NoBull OS (`order.refunded` / `order.cancelled`) | Remove `book_buyer` + product SKU tags + all marketing workflow tags; set `qualification_status=refunded`; move opportunity to `Lost / Unqualified` (status `lost`). Consent is unchanged. | See §18 |
| Partial refund confirmed by NoBull OS (`order.partially_refunded`) | Re-derive product tags from active NoBull entitlements and remove only tags no longer supported; keep `book_buyer`, workflow state, and opportunity state. Consent is unchanged. | See §18 |
| Canonical SMS consent changed by Twilio STOP/START, Twilio 21610, or an authorized manual edit (`consent.sms_updated`) | Reload `sms_consent_ledger`, update the existing correlated GHL contact's SMS consent fields, and on `opted_out` remove marketing workflow tags A/C/E/F while preserving appointment-logistics state | A `ghl_dnd`-originated change is not echoed back to GHL |

---

## 11. Workflow definitions

### Workflow A — Checkout abandonment

**Trigger:** `book_checkout_started` tag applied AND `workflow_a_active` tag applied. Both are applied by NoBull OS only after a **recoverable checkout contact** is captured (`checkout.recoverable` / `checkout.completed` outbox event with a resolved contact). Abandonment never begins on a bare checkout-start that produced no recoverable contact.
**Stop condition:** Purchase confirmed (`order.payment_captured`). Exit is immediate on payment. Do not send any message after payment is confirmed.
**SMS gate:** Workflow A SMS (message A1) sends only when `sms_marketing_status = opted_in`. If `opted_in` is not confirmed, skip the SMS step; do not fall back to `unknown`.
**Maximum SMS in workflow:** one total, within 48 hours of abandonment start.
**Email cadence:**

| Step | Delay from trigger | Channel | Blueprint reference |
|---|---|---|---|
| A1-email | +2 hours | Email | §13.1 Email A1 — subject "Your copy is still here" |
| A1-sms | +20–24 hours | SMS | §13.1 SMS A1 — only with confirmed marketing consent |
| A2-email | +44–48 hours | Email | §13.1 Email A2 — subject "A lead is not revenue" |

**Approved copy:** Subject lines and body copy are reproduced verbatim in §13.1
of the blueprint. Variables: `{{first_name}}`, `{{resume_checkout_url}}`,
`{{short_resume_url}}`.
**Prohibited:** discounts, fake deadlines, extensions of the abandonment window
beyond 48 hours.

---

### Workflow B — Purchase CRM actions (no messaging)

**Trigger:** Stripe payment confirmed (`order.payment_captured`); `book_buyer` tag applied.
**Stop condition:** None (runs once per verified order).
**CRM actions only:** Workflow B in GHL is **CRM actions only** — it creates/updates the opportunity record (`Book Purchased` stage) and applies product/buyer tags via `handleOrderPaymentCaptured`. It sends **no** messages of any kind.
**Canonical receipt and access are NoBull-only.** The order receipt and the book access/entitlement are produced independently by the NoBull OS order/entitlement path and are never produced, delayed, or duplicated by GHL. Applying `book_buyer` in GHL triggers onboarding + buyer-to-booking (Workflow C) only. GHL never confirms a receipt, grants access, or sends the transactional order email.
**Shipment email:** GHL **does not send** shipment notifications. Physical fulfillment messaging remains disabled in GHL (config literal `physicalFulfillmentMessagingEnabled: false`, enforced in `ghlBuyerSync.ts`). The shipment email ("Your printed book is on the way") is sent by NoBull OS when tracking data is confirmed by the fulfillment webhook; GHL receives product-SKU tags only.

---

### Workflow C — Buyer to booked session

**Trigger:** `book_buyer` tag applied (purchase confirmed).
**Stop condition:** `HIRS_booked` tag applied. Exit is immediate on booking.
**SMS gate:** Workflow C SMS (Buyer SMS 1) sends only when `sms_marketing_status = opted_in`.
**Sequence:**

| Step | Delay from trigger | Channel | Blueprint reference |
|---|---|---|---|
| C-email-1 | +60–90 minutes | Email | §13.3 Buyer Email 1 — subject "Start here: the Million-Dollar Gap" |
| C-sms-1 | Day 1 | SMS | §13.3 Buyer SMS 1 — marketing consent required |
| C-email-2 | Day 2 | Email | §13.3 Buyer Email 2 — subject "Every new opportunity enters through one of two doors" |
| C-email-3 | Day 4 | Email | §13.3 Buyer Email 3 — subject "Why Ronnie put $15,000 at risk" |
| C-email-4 | Day 7 | Email | §13.3 Buyer Email 4 — subject "What the 60-minute Intake Audit actually covers" |
| C-email-5 | Day 10 | Email | §13.3 Buyer Email 5 — subject "What happens in a High-Impact Revenue Session?" |
| C-email-6 | Day 14 | Email | §13.3 Buyer Email 6 — subject "Should we diagnose your Revenue Engine?" |

**Behavior branch (Email 6):** If buyer clicks the booking offer or reaches the
scheduler but does not book, create a same-business-day salesperson task. Send
one short email within two hours. Do not send another SMS if any marketing SMS
went out in the previous 24 hours.
**Variables:** `{{first_name}}`, `{{secure_access_url}}`, `{{booking_offer_url}}`,
`{{short_booking_offer_url}}`, `{{sales_head_first_name}}`, `{{sales_head_name}}`,
`{{specialist_name}}`.
**Ownership placeholders:** `{{sales_head_first_name}}`, `{{sales_head_name}}`,
and `{{specialist_name}}` must be resolved from the approved owner-supplied
employee registry before any message goes live. Do not invent names, titles, or
credentials. See blueprint §19.
**Prohibited:** indefinite promotional SMS nurture; SMS on Day 2 or later if
Day 1 SMS was sent and fewer than 24 hours have elapsed.

---

### Workflow D — Booked meeting and attendance

**Trigger:** `HIRS_booked` tag applied (GHL appointment created and mirrored).
**Stop condition:** `HIRS_attended` or `HIRS_cancelled` tag applied.
**GHL owns:** availability, booking confirmation (calendar invite + confirmation email), rescheduling, cancellation, and appointment-logistics messaging. NoBull OS mirrors appointment facts from GHL; it does not duplicate GHL's own appointment messages.
**NoBull OS / GHL-workflow supplemental sequence:**

| Step | Timing | Channel | Blueprint reference |
|---|---|---|---|
| D-confirm | Immediately on booking | Calendar + email | §13.4 booking confirmation — subject "You're booked — here's how to prepare" |
| D-72h | 72 hours before (only if booked >5 days out) | Email | §13.4 prep/case study |
| D-24h | 24 hours before | Email | §13.4 reconfirm — subject "Tomorrow: your High-Impact Revenue Session" |
| D-30m-sms | 30 minutes before | SMS | §13.4 SMS — appointment logistics; non-promotional |
| D-5min | +5 minutes after start if absent | Human SMS/call | §13.4 "+5 minute human SMS" — operator-initiated |

**30-minute SMS gate:** The 30-minute reminder SMS is appointment logistics per
the approved consent and messaging policy. It must still pass the SMS DND check
(see §16). It is non-promotional and does not require marketing opt-in, but it
must not send if the contact has a Twilio STOP-equivalent opt-out on record.
**Rescheduling:** When a buyer reschedules, GHL updates the appointment and the
reminder sequence re-anchors to the new time. No duplicate confirmations are
sent.
**Variables:** `{{first_name}}`, `{{host_name}}`, `{{host_title}}`,
`{{host_first_name}}`, `{{appointment_date}}`, `{{appointment_time}}`,
`{{appointment_timezone}}`, `{{meeting_url}}`, `{{reschedule_url}}`,
`{{short_reschedule_url}}`.
**Ownership placeholders:** `{{host_name}}`, `{{host_title}}`,
`{{host_first_name}}` — resolved from owner-approved employee registry before
activation. Do not invent.

---

### Workflow E — No-show recovery

**Trigger:** `HIRS_no_show` tag applied.
**Stop condition:** Rescheduled appointment attended (`HIRS_attended`) or Day 7 close email sent.
**Sequence:**

| Step | Timing | Channel | Blueprint reference |
|---|---|---|---|
| E-human-5m | +5 minutes | Human SMS/call | §13.5 "+5 minute human SMS" — operator-initiated |
| E-email-1 | +30 minutes | Email | §13.5 No-show email 1 — subject "We missed you — reschedule here" |
| E-task | Next business day | Salesperson task | Personal call/email per §13.5 |
| E-email-2 | Day 3 | Email | §13.5 No-show email 2 — subject "Two times for your Revenue Session" |
| E-email-3 | Day 7 | Email | §13.5 No-show email 3 — subject "Should I close this out?" |

**Variables:** `{{first_name}}`, `{{host_first_name}}`, `{{host_name}}`,
`{{meeting_url}}`, `{{reschedule_url}}`, `{{short_reschedule_url}}`,
`{{suggested_time_1}}`, `{{suggested_time_2}}`.
**Ownership placeholders:** `{{host_first_name}}`, `{{host_name}}` — resolved
from owner-approved employee registry before activation.

---

### Workflow F — Long-term book-buyer nurture

**Trigger:** Day 14 of Workflow C elapsed without a booking (i.e. `workflow_c_active` tag still present at Day 14 step).
**Stop condition:** Manual operator removal of `workflow_f_active` tag, or `HIRS_booked` at any point.
**Channel:** Email only. No promotional SMS in this workflow.
**Sequence:**

| Day (from purchase) | Topic | Blueprint reference |
|---|---|---|
| Day 21 | Answer Your Phone: missed calls and slow speed-to-lead | §13.6 |
| Day 28 | Why lead volume does not equal retained revenue | §13.6 |
| Day 35 | What "winging it" sounds like and why results cannot improve | §13.6 |
| Day 45 | Marketing → Intake → Sales: finding the actual constraint | §13.6 |
| Day 60 | Approved client story | §13.6 |

After Day 60, move contact to `long_term_nurture` tag and the regular
educational/CEO list. Remove `workflow_f_active`.
**Prohibited:** indefinite promotional SMS; any SMS-based nurture in this workflow.

---

### Workflow post-attended — Attended but not closed (sales follow-up)

**Trigger:** `HIRS_attended` tag applied.
**Owner:** Salesperson (not automation for the first message).

| Step | Timing | Owner | Blueprint reference |
|---|---|---|---|
| Personal recap | Within 1 hour | Salesperson | §13.7 — personal, references actual conversation |
| Case study | Day 2 | Salesperson/automation | §13.7 — closest approved case study |
| Objection answer | Day 5 | Salesperson | §13.7 — principal unresolved objection |
| Decision request | Day 7 | Salesperson | §13.7 — direct decision/next-step |
| Loop close | Day 14 | Salesperson | §13.7 — close active loop; return to nurture |

**Prohibited:** generic recap that ignores the actual conversation content.

---

## 12. Calendar ownership mapping

| Placeholder | What it represents | How to resolve |
|---|---|---|
| `[HIRS_CALENDAR_OWNER]` | GHL calendar owner (the user whose availability governs HIRS booking slots) | Owner-approved name entered into `book_buyer_ghl_calendar_v1` before activation |
| `[HIRS_CALENDAR_URL]` | Exact `https://api.leadconnectorhq.com/widget/bookings/...` URL | Copied from GHL calendar Share → Embed Code; entered into `book_buyer_ghl_calendar_v1` |
| `[HIRS_CALENDAR_ID]` | GHL internal calendar ID | Environment-specific; stored in validated `ghl_buyer_sync_config_v1.calendarId`, never in code |
| `{{host_name}}` / `{{host_first_name}}` / `{{host_title}}` | Salesperson name and title appearing in email/SMS copy | Resolved from owner-approved employee registry; see blueprint §19 |
| `{{specialist_name}}` | Senior Intake Specialist name in Email 4 | Resolved from owner-approved employee registry; see blueprint §19 |
| `{{sales_head_name}}` / `{{sales_head_first_name}}` | Head of Sales name in Emails 2–6 and Buyer SMS 1 | Resolved from owner-approved employee registry; see blueprint §19 |

These placeholders must be resolved and verified in the non-production
validation checklist (§19) before any workflow is activated.

---

## 13. Sender identities

GHL email sender identities and SMS sending numbers are environment-specific
and owner-approved. This runbook does not invent or hard-code any sender
address or phone number.

**Rules:**
- Production sender identities must be owner-approved verified addresses on
  the authenticated marketing domain (SPF/DKIM/DMARC aligned).
- Development/staging must use separate test sender identities with no
  deliverability to real recipients.
- GHL SMS sending uses the approved GHL sub-account's connected number. The
  number is provisioned and registered per blueprint §14.1 A2P 10DLC
  requirements.
- The NoBull OS Twilio number and GHL's connected SMS number are separate.
  Consent recorded in NoBull OS `sms_consent_ledger` applies to NoBull OS
  sends; GHL SMS consent is governed by the GHL sub-account's own opt-out
  handling and must be kept in sync via the `sms_marketing_status` field
  mirrored from NoBull OS.

---

## 14. SMS consent and DND rules

SMS via GHL workflows follows the same consent model as the NoBull OS
`sendAutomatedSms()` gate. The following rules apply to every GHL-originated
SMS step:

1. **Marketing SMS** (Workflows A and C; Workflow F is email-only): Only when `sms_marketing_status =
   opted_in`. The `unknown` state is not sendable for marketing messages.
   GHL workflow branches must check this field before executing an SMS step.
2. **Appointment logistics SMS** (Workflow D 30-minute reminder): Non-promotional
   content permitted under the approved consent and messaging policy. Must still
   respect a recorded STOP/opt-out. Do not send if `sms_marketing_status =
   opted_out`.
3. **Human SMS** (Workflow D +5 min, Workflow E +5 min): Operator-initiated.
   Operators must check NoBull OS consent state before sending.
4. **DND signals from GHL**: Any DND or opt-out status set in GHL must be
   treated as binding. NoBull OS is notified via the signed `X-GHL-Signature`
   webhook and updates `sms_consent_ledger` accordingly (more restrictive wins).
5. **Quiet hours**: 9:00 AM – 8:00 PM recipient-local time (conservative;
   honor stricter state rules). GHL workflow timing must account for the
   recipient's recorded timezone where available.
6. **Cap**: Maximum one non-transactional SMS per 24 hours across all active
   workflows for a given contact.
7. **Identification**: Every automated SMS must identify NoBull Marketing in
   the first message of a thread (per blueprint §14.1).
8. **Opt-out language**: Every marketing SMS must include "Reply STOP to opt
   out." Blueprint-approved copy in §13 includes this language verbatim.
9. **No double-reply**: GHL and NoBull OS must not both send opt-out keyword
   replies. Twilio number-level default opt-out handling applies to the NoBull
   OS number; GHL's connected number has its own opt-out handling. Do not
   configure both systems to reply to the same STOP on the same number.
10. **Consent is not a condition of purchase**: The SMS marketing checkbox at
    checkout is separate, unchecked by default, and not required to complete
    the order. Paid book access is never gated on SMS consent.

**Canonical NoBull → GHL suppression mirror:** Twilio STOP/START, Twilio error
21610, and authorized manual consent changes append `consent.sms_updated` to
`book_outbox` in the same database transaction as the canonical consent event.
The GHL relay reloads the ledger rather than trusting the outbox payload. An
`opted_out` result removes marketing workflow tags A/C/E/F while preserving
`workflow_d_active`, buyer, order, entitlement, and appointment state. An event
whose source is `ghl_dnd` is deliberately not re-enqueued, preventing a
GHL → NoBull → GHL loop.

Cross-reference: [TWILIO.md §SMS consent & opt-out](./TWILIO.md#sms-consent--opt-out-task-4336) for the NoBull OS consent ledger, keyword handling, `sendAutomatedSms()` gate, and audit trail.

---

## 15. Email consent and deliverability rules

1. **Transactional email** (order receipt, access links, shipment): Sent by
   NoBull OS regardless of `email_marketing_status`. These are not marketing
   messages and must not contain a sales pitch.
2. **Marketing email** (Workflows A, C, F and post-attended sequence):
   Requires `email_marketing_status ≠ unsubscribed`. GHL workflow branches
   check this field before executing email steps.
3. **GHL unsubscribe → NoBull suppression**: A valid signed
   `ContactDndUpdate` matching the exact §4 contract writes the normalized
   address to NoBull's global `email_suppressions` list with source `ghl_event`,
   cancels promotional sequence enrollment, and conditionally tightens an
   existing local contact to `unsubscribed`. This is inbound-only; it never
   accepts a resubscribe or clears suppression. Native GHL suppression remains
   mandatory and must stop GHL marketing immediately.
4. **One-click unsubscribe**: All marketing emails must carry a one-click
    unsubscribe mechanism. GHL's built-in unsubscribe link is acceptable only
    when the live signed-delivery activation check (§19.2 #24) proves it emits
    the approved callback. Custom NoBull links route through the NoBull
    suppression endpoint.
5. **Sender identity**: Approved marketing sender — distinct from the
   transactional access sender. Subject lines must be accurate; no deceptive
   "Re:" or "Fwd:" usage. Include valid postal address per CAN-SPAM.
6. **No pitch in receipts**: The Workflow B purchase confirmation must not
   contain promotional content. Keep receipts, access links, and shipment
   status separate from promotional messages.

Cross-reference: [SENDGRID.md §Client-facing outbound lane](./SENDGRID.md#client-facing-outbound-lane-task-4334) for suppression list enforcement, SendGrid fallback lane rules, and signed event webhook.

---

## 16. Idempotency, correlation, and deduplication

Every NoBull OS → GHL write operation must be idempotent:

1. **Contact upsert**: `resolveOrCreateGhlContact` first checks the durable
   correlation table, then reconciles a possibly-already-created remote contact
   by email (`/contacts/search/duplicate`) before creating, so a timed-out POST
   never duplicates. The GHL contact ID is persisted in the
   `book_provider_correlations` table (provider `ghl`, entity type `contact`) —
   **not** as a `ghl_contact_id` column on any NoBull contact row. A correlation
   conflict for the same local contact is treated as a retryable
   reconciliation.
2. **Tag operations**: Applying an already-present tag is a no-op in GHL.
   NoBull OS must not assume a tag was absent before applying it.
3. **Opportunity creation**: `ensureOpportunity` searches in order — (1) the
   stored opportunity correlation (`book_provider_correlations`, entity type
   `opportunity`, keyed by local order id), (2) a GHL search by the durable
   `order_id` custom field (reconciles a timed-out POST), (3) create + persist
   the correlation. It never duplicates across a POST timeout.
4. **Webhook replay safety**: Inbound GHL Marketplace webhooks (signed
   `X-GHL-Signature`) are deduplicated at the DB level. Appointment transitions
   use deterministic lifecycle/outbox keys `(appointmentId, fromStatus,
   toStatus)`; DND/opt-out events use the GHL event ID as the `message_sid`
   dedupe key on `sms_consent_events` (partial unique index). A replayed event
   is a DB-level no-op.
    Email unsubscribe uses the canonical normalized-email unique upsert: replay
    cannot add a duplicate and the conditional contact update cannot relax or
    repeatedly rewrite `unsubscribed`.
5. **Outbound retry** (the durable outbox relay owns retries — see §22): each
   GHL HTTP call classifies retryability in `ghlIntegration.ts` (408/409/429/5xx
   and network timeouts → retryable; 400/401/403/404 and validation → terminal),
   but the HTTP layer does **not** retry in-band. The `ghl_outbound_sync` relay
   re-dispatches a failed outbox row with bounded exponential back-off (30 s,
   2 m, 10 m, 30 m, 60 m) up to `max_attempts` (5), then dead-letters. Every
   re-dispatch re-loads state from the DB and replays the same idempotent tag /
   field / opportunity operations.
6. **Field writes**: `setFields` writes contact custom fields via **PUT** to
   `/contacts/:id` with a `customFields` array (the code uses PUT, not PATCH).
   Multiple fields for one event are written together; the operation is
   idempotent and safe to replay.
7. **Canonical consent outbox**: the consent ledger/event update and each
   `consent.sms_updated` outbox row are committed atomically. The idempotency key
   combines the immutable consent-event ID and local contact ID, so a Twilio SID
   replay or work-queue retry cannot create a second mirror event.

---

## 17. Reconciliation and repair

**Source of truth for any discrepancy:** NoBull OS is always correct for
payment facts, SKUs, entitlements, refund status, outbound-send eligibility, and
local appointment IDs. GHL may tighten email/SMS suppression through the exact
verified contracts in §4/§14, but can never provide affirmative consent. GHL is
correct for its external appointment IDs, appointment status, native
suppression, and GHL-originated workflow state. External GHL appointment IDs map
to NoBull local appointment IDs through `book_provider_correlations`; the GHL
contact custom field `appointment_id` contains the NoBull local ID.

**What the shipped code does today (automatic reconciliation):**

1. **Correlation-anchored replay**: Every outbox handler re-loads contact,
   order, package, amount, and consent from the DB and replays the same
   idempotent tag/field/opportunity operations, so a re-dispatched event
   converges GHL onto the current NoBull state. Missing correlations raise a
   retryable `GhlReconciliationNeededError` (ordering race) rather than a false
   success — the relay retries with back-off (§22).
2. **Opportunity re-anchoring**: `ensureOpportunity` reconciles a timed-out
   create by searching GHL for the durable `order_id` custom field before
   creating, then persists the correlation.
3. **No data destruction**: Automated mirroring only updates fields, tags, and
   pipeline stage. It never deletes GHL contacts, opportunities, or
   appointments. Manually-advanced stages (e.g. `Proposal / Active Sales`,
   `Lost / Unqualified` set by a salesperson) are moved only by the handlers'
   forward-only transitions, never regressed by a background sweep.
4. **Audit**: All GHL HTTP goes through the external-call audit wrapper (§3),
   which records route, method, status, timing, response size/hash, and error
   class only.
5. **Email suppression discrepancy visibility**: Every accepted GHL Email DND
   event adds/reconfirms the global suppression. Its `ghl_event` source and
   bounded notes are visible in Admin → Outbound Email → Suppressions. The notes
   identify `matched`, `missing_contact_correlation`, or
   `correlated_email_mismatch`; mismatches do not mutate the correlated contact.

**Not implemented yet (pending):**

- There is **no** operator "Reconcile Contact" admin UI / button
  (`Admin → Integrations → HighLevel → Reconcile Contact` does not exist in the
  shipped code). Manual per-contact reconciliation is a future capability; until
  it ships, repair is limited to the automatic correlation-anchored replay above
  plus the dead-letter inspection path in §22.
- There is no scheduled tag/stage drift sweep. Drift correction happens only
  when a new authoritative event for the contact is dispatched.

---

## 18. Refund handling

**Authority**: NoBull OS (Stripe webhook) is the sole trigger for refund state changes. GHL does not initiate, confirm, or deny refunds.

When a **full** refund or cancellation is confirmed by NoBull OS
(`order.refunded` / `order.cancelled`), `handleOrderRefunded` performs exactly:

1. Remove `book_buyer` and the product SKU tags for the order's package, plus
   `workflow_a_active`, `workflow_c_active`, `workflow_d_active`,
   `workflow_e_active`, and `workflow_f_active` — this exits incompatible
   workflows.
2. Set the `qualification_status` custom field to `refunded`.
3. Leave canonical SMS consent unchanged. A refund is not an SMS opt-out.
4. Move the GHL opportunity (if one exists) to `Lost / Unqualified` with status
   `lost`.
5. Never revoke the GHL contact record or delete appointment history.
6. NoBull OS independently revokes the entitlement and removes book access; GHL
   receives the tag/field/stage updates only.

For `order.partially_refunded`, `handleOrderPartiallyRefunded` reloads active
NoBull entitlements and removes only SKU tags that are no longer supported. It
does **not** remove `book_buyer`, stop workflows, move or close the opportunity,
or alter consent. There is no dedicated `order_id.refund_status` custom-field
write. A fully refunded contact who later re-purchases is handled as a fresh
`order.payment_captured` event with a new order ID.

---

## 19. Non-production validation evidence

Production activation is **explicitly pending** (§20). This section separates
what is already covered by **automated hermetic tests** (non-production,
no network) from what still requires **live GHL** evidence that cannot
exist until the sub-account is provisioned and the feature is enabled.

### 19.1 Automated evidence (hermetic tests — present today)

These suites drive the real state machines through injected seams (fake GHL API
and controlled storage dependencies) and, where atomic persistence matters, a
private per-run PostgreSQL database. They run with no external network. They are
the current, truthful evidence that the mirror logic behaves per this runbook:

- `tests/ghl-buyer-lifecycle-sync.test.ts` — drives the real
  `dispatchGhlBuyerSyncEvent` state machine. Asserts: config lockstep /
  fail-closed parsing (`ghl_buyer_sync_config_v1`: valid config parses; missing
  `approvalEvidence`, missing approved stage, missing approved custom field all
  rejected); canonical consent gating from the ledger (consent fields mirrored
  from `confirmedAt`, marketing enabled only on exact `opted_in`);
  purchase tag-removal ordering (`book_checkout_started` + `workflow_a_active`
  removed **before** `book_buyer` added); opportunity created for order;
  replay creates **no** second contact and **no** second opportunity;
  durable `order_id`-field search prevents duplicate opportunity create;
  full refund removes `book_buyer` + SKU tags, exits active workflows without
  altering consent, and moves the opportunity to `Lost / Unqualified`;
  partial refund removes only unentitled SKU tags; canonical opt-out removes
  marketing workflow tags without removing appointment logistics; appointment
  scheduled/no-show/completed tag transitions; application not-qualified →
  `audit_unqualified`; relay claim/retry/dead-letter constants.
- `tests/ghl-marketplace-webhook.test.ts` — drives the inbound
  `POST /api/integrations/ghl/marketplace-webhook` route through storage seams
  and a real transaction-backed DND replay case.
  Asserts: fail-closed 503 (no public key / no location), 401 bad signature,
  403 wrong location; `AppointmentCreate` resolves an existing application,
  upserts/correlates the appointment, and never fabricates an application;
  unknown `AppointmentUpdate` shares that bootstrap path or returns retryable
  500 when correlation/application facts are missing; reschedule updates the
  existing appointment without a duplicate lifecycle transition;
  `ContactDndUpdate` / STOP-keyword `InboundMessage` opt-out (tighten-only),
   and **no** opt-out write when DND is cleared / phone absent / non-STOP;
   strict signed Email DND parsing, one normalized `ghl_event` suppression on
   replay, conditional `unknown|subscribed → unsubscribed` contact tightening,
   combined Email/SMS tightening, durable correlation-discrepancy evidence, and
   retryable 500 after a synthetic promotional-cancellation failure while the
   primary suppression remains durable.
- `tests/sms-consent-inbound-webhook.test.ts` — proves Twilio STOP/START event
  recording and SID replay behavior against the private test database, including
  one atomic `consent.sms_updated` outbox row for a linked book contact and no
  duplicate row on replay.

The 2026-08-21 integrated launch pass re-executed the GHL marketplace-webhook
suite and the lifecycle suite through the normal hermetic runner. The lifecycle
suite passed all 80 assertions standalone. This confirms the local contract
only; it does not satisfy or change any PENDING live-GHL row in §19.2.

Run: the standard test runner selects these fast suites. These are the only
evidence artifacts that exist without a live GHL sub-account.

### 19.2 Live-GHL evidence (PENDING — cannot exist until provisioned + enabled)

Every row below requires a real GHL sub-account and a real webhook delivery. **No
live GHL screenshots, API field/tag/pipeline IDs, workflow execution logs, or
owner approvals have been captured yet — all rows are PENDING.** None may be
marked passed from hermetic tests; hermetic coverage of the same behavior is
noted where it exists but does not satisfy the live requirement.

| # | Check | Live evidence required | Pass criteria | Status |
|---|---|---|---|---|
| 1 | GHL sub-account environment isolation | Distinct location IDs + tokens per environment; distinct `ghl_buyer_sync_config_v1` per env | Credential history shows distinct location IDs per environment | PENDING |
| 2 | All contact custom fields provisioned | Field names in §7 exist in GHL sub-account; field IDs recorded in `ghl_buyer_sync_config_v1.customFields` | Live screenshot or API field list from GHL | PENDING |
| 3 | All tags configured | Tags in §8 appear in GHL tag library | Live screenshot or API tag list | PENDING |
| 4 | Pipeline and all stage names match §9 | Pipeline named `Book Buyer Pipeline`; stage names exact; stage IDs in `ghl_buyer_sync_config_v1.stages` | Live GHL pipeline configuration screenshot | PENDING |
| 5 | Signed webhook receiver operational (live) | `POST /api/integrations/ghl/marketplace-webhook` in the deployed env with real GHL Ed25519 deliveries | unsigned/bad-key → 401; valid → 200; replayed event ID → DB-level no-op (hermetic coverage exists) | PENDING |
| 6 | Contact upsert idempotency (live) | Same recoverable-checkout event twice → one GHL contact | Single contact in live GHL (hermetic coverage exists) | PENDING |
| 7 | Tag apply/remove on purchase (live) | `book_checkout_started` removed and `book_buyer` applied after real payment | Live GHL contact tag state (hermetic coverage exists) | PENDING |
| 8 | Opportunity created on purchase (live) | GHL opportunity in `Book Purchased` with `order_id` field | Live GHL opportunity screenshot (hermetic coverage exists) | PENDING |
| 9 | Workflow A SMS gate (live) | GHL workflow branch skips SMS unless `sms_marketing_status = opted_in` | Live GHL workflow execution log | PENDING |
| 10 | Workflow A email timing (live) | A1 +2 h, A2 +44–48 h per blueprint (timing unchanged) | Live GHL workflow execution log | PENDING |
| 11 | Workflow A exits on purchase (live) | Purchase during window cancels A; no A2 sent | Live GHL workflow log | PENDING |
| 12 | Workflow C exits on booking (live) | `workflow_c_active` removed / C cancelled on `HIRS_booked` | Live GHL workflow log | PENDING |
| 13 | Workflow D 30-min SMS blocked on opt-out (live) | SMS not sent when `sms_marketing_status = opted_out` | Live GHL workflow log | PENDING |
| 14 | Reschedule re-anchors reminders, not duplicates (live) | Single reminder set at new time | Live GHL workflow log | PENDING |
| 15 | No-show workflow starts correctly (live) | `HIRS_no_show` triggers E; D stopped | Live GHL workflow log | PENDING |
| 16 | Refund removes tags and exits workflows (live) | Real refund → §18 tag/field/stage state | Live GHL contact + opportunity state (hermetic coverage exists) | PENDING |
| 17 | Calendar setting validation (live) | Absent/invalid `book_buyer_ghl_calendar_v1` → no iframe; present + qualified → iframe | Live behavior capture | PENDING |
| 18 | Qualification policy validation (live) | Absent/invalid `book_buyer_qualification_policy_v1` → manual review | Live `audit_manual_review` application | PENDING |
| 19 | Physical fulfillment messaging disabled in GHL (live) | No GHL workflow/template references a shipment notification | Live audit of GHL workflow list | PENDING |
| 20 | Ownership placeholders resolved (live) | `{{host_name}}`, `{{sales_head_name}}`, `{{specialist_name}}` replaced from the approved employee registry | Live review of each GHL template; no raw placeholders | PENDING (owner approval outstanding) |
| 21 | SMS quiet hours enforced (live) | No SMS outside 9 AM–8 PM recipient-local | Live GHL workflow log | PENDING |
| 22 | 24-hour SMS cap across workflows (live) | ≤1 non-transactional SMS / 24 h / contact | Live GHL workflow log | PENDING |
| 23 | GHL degraded — paid access unaffected (live) | `kill_switch_ghl_outbound_sync=true` → checkout/access unaffected | Live test with kill switch engaged | PENDING |
| 24 | GHL Email DND signed-delivery activation | Use a controlled GHL contact to click the native unsubscribe link; capture the real `ContactDndUpdate` delivery without logging signature or full payload | Valid Ed25519 delivery has the §4 fields and `Email.status=active`; endpoint returns 200; exactly one `ghl_event` suppression is visible after replay; contact status only tightens; GHL marketing stops; receipt/access and appointment logistics remain available | PENDING |

> **Activation boundary:** hermetic tests prove the approved parser and write
> behavior, but they do not prove that the configured production GHL workflow
> emits this callback. Do not treat GHL lifecycle email as live until row #24
> has real signed-delivery evidence and G-12 records approval.

---

## 20. Activation gates

The following gates must all pass before any production lifecycle workflow is
activated. An owner or designated approver must sign off on each gate. This
document must be updated to record the approval date and approver for each gate
before the gate is considered passed.

| Gate | Requirement | Approver | Approval date |
|---|---|---|---|
| G-1 | All non-production validation checklist items (§19) pass in staging | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-2 | `book_buyer_qualification_policy_v1` system setting configured, enabled, and reviewed by owner | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-3 | `book_buyer_ghl_calendar_v1` system setting configured with approved calendar URL and enabled | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-4 | All ownership placeholders (§12) resolved from owner-approved employee registry | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-5 | GHL sender identity (email and SMS) verified on approved domain and A2P 10DLC registered | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-6 | SMS consent checkbox copy reviewed by counsel and approved | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-7 | Production GHL private token and location ID entered and probe successful | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-8 | Signed webhook endpoint `POST /api/integrations/ghl/marketplace-webhook` (`X-GHL-Signature` Ed25519) confirmed live and tested in production | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-9 | Physical fulfillment messaging confirmed disabled in production GHL sub-account (`ghl_buyer_sync_config_v1.physicalFulfillmentMessagingEnabled: false`) | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-10 | `kill_switch_ghl_outbound_sync` tested: paid access unaffected when engaged | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-11 | `ghl_buyer_sync_config_v1` populated + validated for the target env: `enabled:true`, `approved:true`, `approvalEvidence` set, `environment` matches runtime, `locationId` matches connected location, and (production) `productionActivationConfirmed:true` | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |
| G-12 | Controlled native GHL email unsubscribe produced a real signed `ContactDndUpdate` matching §4 and passed §19.2 #24 end to end | [OWNER PLACEHOLDER] | [DATE PLACEHOLDER] |

**Current status: all gates are PENDING. No production lifecycle automation is active.**

---

## 21. Environment-specific config setting (`ghl_buyer_sync_config_v1`)

The outbound mirror is driven by one strict, versioned, per-environment
`system_settings` key: **`ghl_buyer_sync_config_v1`**. It is disabled by default
and fail-closed — `loadGhlBuyerSyncConfig` in `server/services/ghlBuyerSync.ts`
returns a typed non-ok result for any of: `not_configured`, `parse_error`,
`invalid`, `disabled`, `not_approved`, `env_mismatch`, `location_unresolved`,
`location_mismatch`, or `prod_activation_unconfirmed`. The relay defers these
rows without consuming an attempt; it never marks an unmirrored authoritative
event delivered merely because activation is incomplete.

The schema (`ghlBuyerSyncConfigSchema`, `.strict()`) carries **only**
environment-specific GHL internal IDs and activation flags — never the private
token or the webhook public key:

| Field | Meaning |
|---|---|
| `version` | Literal `1`. |
| `enabled` | Master gate. No effect unless `approved` is also true. |
| `approved` | Owner approval that these IDs were provisioned against the approved sub-account. |
| `approvalEvidence` | Free-text owner + date + reference (min 3 chars). Required. |
| `environment` | `development` \| `staging` \| `production`; must match the runtime env. |
| `productionActivationConfirmed` | Required `true` to activate in production. |
| `locationId` | Connected GHL Location ID; must match the runtime-connected location. |
| `pipelineId` | `Book Buyer Pipeline` ID. |
| `stages` | Map of each **exact** approved stage name (§9) → env stage ID. All 11 required. |
| `customFields` | Map of each **exact** approved field name (below) → env field ID. All required. |
| `ownerMap.salesTaskOwner` / `ownerMap.manualReviewOwner` | Owner identities (email or GHL user ID) for task/manual-review routing. |
| `calendarId` | GHL calendar ID (mirrors `book_buyer_ghl_calendar_v1`) for reconciliation/auditing. |
| `workflowIds.workflowA` / `workflowB` / `workflowC` / `workflowD` / `workflowE` / `workflowF` / `postAttended` | Approved workflow IDs. All seven are required for reconciliation and audit. |
| `workflowVersionIds.workflowA` / `workflowB` / `workflowC` / `workflowD` / `workflowE` / `workflowF` / `postAttended` | Owner-approved GHL workflow version IDs. All seven are required. |
| `workflowStopConditions.workflowA` / `workflowB` / `workflowC` / `workflowD` / `workflowE` / `workflowF` / `postAttended` | Non-production stop-condition evidence for every workflow. All seven are required. |
| `senderApprovals.marketingEmailSenderRef` / `smsSenderRef` / `ownershipRegistryRef` | Approval references for the email sender, SMS/A2P sender, and employee ownership registry. |
| `smsConsentCopyVersion` | Disclosure copy version currently mirrored to GHL. |
| `physicalFulfillmentMessagingEnabled` | Literal `false` (must remain disabled). |

**Approved stage-name keys (`stages`)** — must match `GHL_STAGE_NAMES` exactly:
`Checkout Started`, `Book Purchased`, `Applied`, `Qualified`,
`Unqualified / Manual Review`, `Meeting Booked`, `Meeting Attended`, `No-Show`,
`Proposal / Active Sales`, `Closed Client`, `Lost / Unqualified`.

**Approved custom-field keys (`customFields`)** — must match `GHL_FIELD_NAMES`
exactly (the config-mirrored subset of §7): `sms_marketing_status`,
`sms_consent_timestamp`, `sms_consent_copy_version`, `sms_consent_source_url`,
`email_marketing_status`, `order_id`, `stripe_payment_intent_id`,
`selected_package`, `first_touch_utm_source`, `first_touch_utm_medium`,
`first_touch_utm_campaign`, `first_touch_utm_content`, `first_touch_utm_term`,
`last_touch_utm_source`, `last_touch_utm_medium`,
`last_touch_utm_campaign`, `gclid`, `fbclid`, `qualification_status`,
`qualification_reason`, `audit_role`, `audit_monthly_inquiry_range`,
`audit_revenue_or_proxy_range`, `audit_improvement_timeline`,
`appointment_id`, `appointment_status`, `appointment_attended_at`,
`opportunity_stage`, `attributed_revenue`.

The tag names in §8 are compiled constants (`GHL_TAGS`), not config; they carry
no per-environment ID. The private integration token (Hub-entered, write-only)
and the `GHL_MARKETPLACE_PUBLIC_KEY` webhook key (env var) remain outside this
setting as implemented.

---

## 22. Durable outbox relay (leasing, retry, dead-letter)

Every authoritative book-commerce producer writes a `book_outbox` row in the
same transaction as its business write, then best-effort kicks the
`ghl_outbound_sync` queue (a kick failure never fails the producer). The relay
(`server/services/ghlOutboundSync.ts`) is the sole GHL HTTP boundary for
outbound mirroring and behaves as follows:

- **Handled event types only.** The claim query filters on exactly:
  `checkout.recoverable`, `checkout.completed`, `order.payment_captured`,
  `application.submitted`, `application.qualified`, `application.not_qualified`,
  `appointment.scheduled`, `appointment.cancelled`, `appointment.completed`,
  `appointment.no_show`, `order.refunded`, `order.partially_refunded`,
  `order.cancelled`, `bonus.viewed`, `consent.sms_updated`.
  It never leases, marks, or dead-letters rows owned by other consumers.
- **Atomic per-row lease.** A single `UPDATE ... WHERE id IN (SELECT ... FOR
  UPDATE SKIP LOCKED)` claims exactly one row and, in the same statement, pushes
  its `next_retry_at` forward by the lease (`LEASE_MS` = 5 min). Claiming one
  row at a time is intentional: no later row can spend its lease waiting behind
  earlier network calls. This hides the row from every other instance until the
  lease expires. A crash mid-dispatch therefore recovers automatically
  (at-least-once), and a redelivered/replayed event is a DB-level no-op because
  every handler is idempotent (§16). Every finalize/defer/dead-letter update is
  guarded by the lease token (`next_retry_at` + `last_attempt_at`), so an expired
  worker cannot overwrite a newer worker's result.
- **Bounded retry.** A genuine dispatch failure re-arms the row as `pending`
  with exponential back-off — 30 s, 2 m, 10 m, 30 m, 60 m — recorded in
  `next_retry_at`, incrementing `attempt_count`.
- **Dead-letter.** When `attempt_count` reaches `max_attempts` (default 5,
  stored on the row at insert), the row is set to `status = dead_letter` with the
  bounded error message and `next_retry_at = NULL`. Dead-letter is the operator
  inspection surface (there is no reconcile UI — see §17).
- **Config-deferred behavior.** If `loadConfig` is not ok (disabled / not
  approved / env or location mismatch / prod activation unconfirmed / not
  configured), or the kill switch races on after claim, the relay leaves the row
  `pending`, moves `next_retry_at` forward by the bounded defer delay, and does
  **not** consume an attempt. The event remains available after activation.
  Truly unhandled event types are irrelevant to this consumer and drain as
  delivered, but the claim query normally excludes them.
- **Kill switch.** `ghl_outbound_sync` stops claiming new work; in-flight
  entries finish or stop at the next safe boundary. It never affects checkout,
  payment, entitlement, access, or consent (§3).
- **Boot catch-up.** A deployment-only one-shot at +30 s re-enqueues a bounded
  page of pending handled rows older than the catch-up floor whose post-commit
  kick was lost. It is not a periodic scheduler.

---

## 23. Related runbooks and cross-references

- [TWILIO.md](./TWILIO.md) — SMS consent ledger (`sms_consent_ledger`), `sendAutomatedSms()` gate, quiet hours, DND/opt-out keyword handling, and 21610 reconciliation. GHL SMS steps must respect the same consent model.
- [SENDGRID.md](./SENDGRID.md) — Client-facing outbound email: Front-mailbox-first routing, CEO-gated SendGrid overflow, suppression list, one-click unsubscribe, and signed event webhook. GHL email steps are supplementary to NoBull OS email; both suppression lists must be consistent.
- [LEADS.md](./LEADS.md) — Lead intake and lifecycle stages; prospect gating contract. Book-buyer opportunities in GHL are distinct from the primary NoBull OS lead pipeline.
- [STRIPE.md](./STRIPE.md) — Payment facts, refund events. NoBull OS Stripe webhooks are the authoritative trigger for purchase and refund GHL updates.
- [EXTERNAL_CALL_AUDIT.md](./EXTERNAL_CALL_AUDIT.md) — All GHL HTTP calls go through the external-call audit wrapper.
- [RUNBOOKS.md](./RUNBOOKS.md) — Runbook index.
