# Book Funnel Launch Gates

## Current launch state

Both paid offers are fail-closed. The existing privacy notice remains available
at `/privacy-policy/` and `/privacy/`, but it is recorded as a legacy,
unverified policy. No final owner/counsel-approved Terms, Shipping & Returns, or
checkout disclosure was supplied with the funnel blueprint. The application
must not invent those positions, so Digital Edition cannot be sold until the
policy manifest is updated with approved, versioned documents.

Complete Collection has an additional non-overridable blocker: the
provider-neutral physical-fulfillment boundary is inactive. No provider,
credential, SDK, endpoint, or outbound fulfillment call is configured.

## Integrated verification verdict — 2026-08-21

**NO-GO: keep Digital Edition and Complete Collection disabled.**

This pass exercised only the isolated development/test lanes. It did not send
customer data or test events to Stripe, GHL, Meta, GA4, or Google, and it did
not treat local fakes as deployed-vendor evidence.

### Evidence completed in the isolated lanes

| Area | Result | Evidence |
|---|---|---|
| Commerce, access, refund, and replay contracts | PASS | The focused book catalog, checkout adapter, checkout storage, commerce storage, delivery route, buyer-journey, and operations suites executed through the normal hermetic runner. They cover server totals, contact-before-payment, timeout-after-success convergence, duplicate webhook/event application, one-order/one-entitlement behavior, immediate access, durable delivery effects, refund/revocation, replay, token recovery, and GHL-down isolation. |
| GHL contract and lifecycle logic | PASS (hermetic only) | The signed-webhook route suite passed, and the lifecycle suite passed all 80 assertions standalone, including fail-closed config, consent/DND restrictions, tag and workflow stop ordering, appointment transitions, opportunity reconciliation, replay idempotency, and cross-instance lease claims. This does not change any live-GHL row in `GHL.md` from PENDING. |
| Attribution and event authority | PASS (hermetic only) | Attribution capture, durable attribution-event storage, campaign attribution, and funnel reconciliation suites passed. These validate local payload/storage authority and correlation contracts, not vendor-dashboard receipt. |
| Browser, accessibility, motion, and lazy loading | PASS (automated browser contract) | The book-funnel browser suite passed all 70 assertions at phone and desktop widths after correcting the mobile support-link overflow. The animation suite passed all 157 assertions. Coverage includes keyboard focus, landmarks, reduced motion, error/recovery states, no horizontal overflow, no calendar load before an approved qualified action, and no placeholder/heavy player on `/book/`. |
| Governed artifacts | PASS | Marketing output and fingerprint, route inventory/classification, endpoint contracts, test-portfolio facts, data ownership, integration reliability, and async topology were regenerated or checked with their canonical tools. The owner-reviewed public allowlist was not changed. |

### Current development readiness blockers

The local readiness evaluator returned `purchasable: false` for both packages.
Digital Edition currently reports:

- offer, Stripe configuration, transactional-delivery, tax, refund, and support
  approvals absent;
- Stripe publishable/server configuration and a fresh connected health snapshot
  absent;
- Privacy, Terms, Shipping & Returns, and checkout-disclosure manifest entries
  unapproved;
- approved tax, refund, support, verification-evidence, and target-environment
  versions absent;
- no active private `digital_book` delivery asset; and
- no immutable approved purchase-policy snapshot can therefore be built.

Complete Collection inherits every Digital blocker and additionally reports the
offer and U.S. scope unapproved, international scope undecided, shipping and
policy/evidence versions absent, audiobook and print-source assets absent, and
the provider plus all create/status/tracking/cancel/replacement capabilities
inactive.

### Required external evidence still pending

1. **Stripe:** an approved staging/test product and price; one real test-mode
   checkout; one real signed delivery to the deployed receiver; duplicate and
   delayed delivery; process restart and durable-record correlation; durable
   receipt/access email; decline, abandonment, timeout-after-success, refund,
   revocation, and token reissue evidence.
2. **GHL:** every live row in `GHL.md` §19.2 and every activation gate in §20,
   including environment-isolated IDs, a real signed callback, contact/tag/
   field sync, workflow stops, calendar and appointment mirror, DND behavior,
   stage reconciliation, replay idempotency, and restart-safe correlation.
3. **Analytics:** approved non-production destinations and captured Meta, GA4,
   and Google payloads proving no forbidden PII/tokens/private paths/card data,
   browser/server event-ID deduplication, milestone authority, and deeper-stage
   correlation. Live sending remains off until that approval exists.
4. **Deployed experience:** owner/manual visual and screen-reader acceptance and
   deployed performance measurements for LCP, CLS, and INP. Local browser
   contracts do not substitute for deployed network and device evidence.

### Operator remediation order

1. Publish owner/counsel-approved, versioned policy and checkout-disclosure
   documents; then update the manifest without weakening its approval rules.
2. Approve and configure the tax, refund, support, transactional-delivery,
   private-storage, and final Digital asset inputs in the target non-production
   environment.
3. Configure approved Stripe test products, callback, and credentials through
   the secrets flow; refresh cached health; then capture the complete signed,
   restart-safe commerce/access/refund evidence above.
4. Provision the isolated GHL sub-account and approved IDs/workflows, run the
   §19.2 checklist, and record the §20 approver and date fields.
5. Run the approved analytics and deployed experience checks, store durable
   evidence, and set the exact verification-evidence and approval-environment
   versions.
6. Enable Digital Edition only after the readiness surface returns zero
   blockers. Keep Complete Collection disabled until its separate provider,
   policy, asset, shipping, margin, and live-evidence gate also returns zero
   blockers.

## Operator evidence

Team Lead and CEO operators can inspect **Book Operations → Overview → Book
funnel launch readiness**. The response is computed from local state only:

- versioned policy-manifest approval state;
- environment-scoped approval/version settings;
- configured Stripe keys and the existing cached Stripe health snapshot;
- active private delivery assets;
- the inactive physical-fulfillment capability boundary.

The readiness read never probes Stripe or a fulfillment provider. A cold,
disconnected, or older-than-five-minutes Stripe cache is a blocker. Customers
receive only a generic unavailable response; exact blocker codes stay in the
operator surface.

## Digital Edition approval inputs

Every input below is required in the same runtime environment:

- `BOOK_COMMERCE_DIGITAL_ENABLED=true`
- `BOOK_COMMERCE_STRIPE_CONFIGURATION_APPROVED=true`
- valid Stripe server and publishable configuration plus fresh cached health
- `BOOK_COMMERCE_TAX_TREATMENT_APPROVED=true` and a versioned
  `BOOK_COMMERCE_TAX_TREATMENT_VERSION`
- `BOOK_COMMERCE_REFUND_HANDLING_APPROVED=true` and a versioned
  `BOOK_COMMERCE_REFUND_HANDLING_VERSION`
- owner/counsel-approved, published versions in the policy manifest for
  Privacy, Terms, Shipping & Returns, and the checkout disclosure
- an active private `digital_book` delivery asset and configured private object
  storage
- `BOOK_COMMERCE_TRANSACTIONAL_DELIVERY_APPROVED=true`
- `BOOK_COMMERCE_SUPPORT_PROCEDURE_APPROVED=true` and a versioned
  `BOOK_COMMERCE_SUPPORT_PROCEDURE_VERSION`
- versioned `BOOK_COMMERCE_DIGITAL_VERIFICATION_EVIDENCE_VERSION`
- `BOOK_COMMERCE_APPROVAL_ENVIRONMENT` exactly matching the current runtime

The checkout session stores the exact server-built policy/disclosure snapshot.
The verified payment path copies that snapshot unchanged to the order. Browser
payloads cannot submit or override policy versions.

## Complete Collection approval inputs

Complete inherits every Digital blocker and additionally requires explicit
offer approval, approved U.S. scope, an explicit international-scope decision,
configured shipping charges, versioned shipping-time/cancellation/return/
replacement/margin/test evidence, active final audiobook and print-source
assets, and all physical-provider capabilities.

International scope must be an explicit approved decision. `domestic_only` is
the safe supported decision while international shipping is not approved; it
is never enabled by default.

## Dormant physical-fulfillment contract

The future provider adapter must implement provider-neutral operations for:

1. create order;
2. retrieve status;
3. retrieve tracking;
4. cancel order;
5. request replacement.

Every request must carry the durable local order ID, stable order number, and a
replay-safe idempotency key. The provider order ID is a correlation value, not
local authority. Status transitions must map into the closed local fulfillment
lifecycle, and retries must converge on the same correlation. No provider call
may run inside a database transaction.

The current boundary is deliberately inactive and has every capability set to
false. Activating it requires a separately approved vendor/integration change,
real credentials through the secrets flow, verified shipping/tax/support
procedures, and production evidence. Environment flags alone cannot activate
Complete Collection.
