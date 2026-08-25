# Stripe

## Overview
Stripe is the system of record for client billing — subscriptions, invoices, charges, payment methods, and lifetime value. NoBull OS does not call Stripe live for every request: it uses the `stripe-replit-sync` library to mirror Stripe into a local `stripe` Postgres schema, then reads from that mirror. Webhooks keep the mirror current.

## Architecture

### Files
| File | Purpose |
| --- | --- |
| `server/stripeClient.ts` | SDK wrapper. Reads the API key from env first, then `system_settings.stripe_secret_key`. Exposes helpers like `getCustomerBillingSummary`, `searchStripeCustomers`. |
| `server/stripeSync.ts` | Initializes `StripeSync`, runs schema migrations for the local `stripe` schema, performs the initial backfill, and processes webhooks. |
| `server/routes/billing.ts` | `/api/stripe/status`, `/api/clients/:id/billing`, `/api/clients/:id/stripe-link`, `/api/stripe/webhook`. |

### Local mirror
- The `stripe-replit-sync` library owns the `stripe` schema and reconciles: customers, subscriptions, invoices, charges, payment intents, payment methods, products, prices.
- Customers are joined to NoBull OS clients via `clients.stripeCustomerId`.
- Backfill runs once at startup; webhooks drive incremental updates.

### Webhook flow
1. Stripe → `POST /api/stripe/webhook` with the raw body and `stripe-signature` header.
2. `processStripeWebhook` passes the raw payload + signature to `sync.processWebhook(payload, signature)` — `stripe-replit-sync` verifies the signature against `STRIPE_WEBHOOK_SECRET` and applies the event to the local schema.

## Settings, env vars, and kill switches

| Name | Type | Default | Purpose | Notes |
|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | env (secret) | — | Stripe REST credential. | Preferred over the DB-backed setting. |
| `STRIPE_WEBHOOK_SECRET` | env (secret) | — | Webhook signature verification. | Required. |
| `stripe_secret_key` | `system_settings` (secret) | — | Fallback for `STRIPE_SECRET_KEY`. | Lets ops swap keys without redeploy. |

No kill switch — disconnecting Stripe means clearing the key, which causes `/api/stripe/status` to report disconnected and billing reads to short-circuit.

## Operational workflows

### Credential rotation
1. Generate a new restricted key in Stripe.
2. Update `STRIPE_SECRET_KEY` (preferred) or `system_settings.stripe_secret_key`.
3. Call the admin re-initialize path in `server/routes/agents.ts` if you want the sync to restart immediately, otherwise wait for the next pod restart.
4. Confirm `GET /api/stripe/status` returns `connected: true`.

### Webhook secret rotation
1. Add a new endpoint secret in Stripe and update `STRIPE_WEBHOOK_SECRET`.
2. Send a Stripe test event; confirm the webhook handler returns 200.
3. Remove the old endpoint secret from Stripe.

### Replay / backfill
- `stripe-replit-sync` exposes a backfill on startup. To force a re-backfill, re-initialize via the admin path and let it walk every entity type again.
- For one-off reconciliation of a specific customer, use `searchStripeCustomers` + `getCustomerBillingSummary` to inspect the local mirror vs Stripe directly.

### Recovery from common failures
- **Webhook signature mismatch** → almost always a stale `STRIPE_WEBHOOK_SECRET`. Rotate.
- **Mirror drift** (local row missing an update) → trigger a re-initialize; webhooks are idempotent.
- **`stripeCustomerId` missing on a client** → use `PATCH /api/clients/:id/stripe-link` to link.

## Alerts and observability
- `GET /api/stripe/status` exposes connection health.
- Webhook 4xx/5xx rates show up in standard request logs.
- No dedicated Slack/email alert is wired today — failures surface via the billing surfaces returning stale data.

## Verification
- `curl /api/stripe/status` → `{ connected: true }`.
- For a known client, `GET /api/clients/:id/billing` returns a populated summary (active subscriptions, LTV, last invoice).
- Trigger a Stripe test webhook (`stripe trigger invoice.paid`) and confirm the corresponding row updates in the local `stripe` schema.

### Paid book funnel

Stripe connection alone does not make the book offer purchasable. The book
funnel uses the cache-only Stripe health snapshot plus the policy, tax, refund,
asset, delivery, support, environment, and test-evidence gates documented in
[BOOK_FUNNEL_LAUNCH.md](./BOOK_FUNNEL_LAUNCH.md). Checkout readiness never
starts a Stripe probe, and all provider calls remain outside database
transactions.

The 2026-08-21 integrated launch pass re-executed the hermetic checkout,
verified-event, access, refund/revocation, and replay contracts. Those contracts
passed, but no real Stripe test-mode purchase or signed delivery reached a
deployed receiver in this pass. `BOOK_COMMERCE_STRIPE_CONFIGURATION_APPROVED`
and the Digital verification-evidence version must therefore remain unset until
the live, restart-safe checklist in `BOOK_FUNNEL_LAUNCH.md` is captured.

## Related runbooks
- Back to [RUNBOOKS.md](./RUNBOOKS.md) Runbook Index.

## Related Task # history
- See `server/stripeClient.ts` and `server/stripeSync.ts` headers for change history.
