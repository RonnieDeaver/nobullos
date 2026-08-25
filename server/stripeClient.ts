import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { auditOutboundCall } from "./services/externalCallAudit";

const STRIPE_SETTINGS_KEY = "stripe_secret_key";

// Task #1590 (audit B-001) — pin the Stripe API version explicitly so
// behavior can't float with the Stripe account's dashboard default.
// This is the exact version the installed `stripe` SDK (v22) was
// generated against (`Stripe.API_VERSION`); the SDK's `StripeConfig`
// types only accept this literal, so `npm run check` fails loudly if a
// future SDK upgrade changes the supported version — update this
// constant in the same change.
//
// Shared by BOTH sides of the integration:
//   1. every direct `new Stripe(...)` construction in this module, and
//   2. `stripe-replit-sync`'s internal client via its `stripeApiVersion`
//      config (server/stripeSync.ts) — the sync library resolves the
//      same installed `stripe` package (peer dep), so the two clients
//      cannot skew.
// Note: webhook *event payload* shape is governed by the webhook
// endpoint's configured version in the Stripe dashboard, not by this
// client pin; signature verification is version-independent. This pin
// governs all client-initiated requests (probe/validate reads and the
// sync library's backfill/expand reads).
export const STRIPE_API_VERSION = "2026-03-25.dahlia" as const;

/** Verify a webhook from its exact raw bytes inside the Stripe SDK boundary. */
export async function constructStripeWebhookEvent(
  payload: Buffer,
  signature: string,
  webhookSecret: string,
): Promise<unknown> {
  const Stripe = (await import("stripe")).default;
  return Stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}

// In-process "last good" secret key. Task #2099: the deployed app reads
// the Stripe key from `system_settings` through a read-through Redis
// cache that falls back to a DB query. Under production DB-pool
// saturation that read can THROW (timeout / dropped connection). We must
// never let a read that *couldn't complete* be mistaken for "the operator
// removed the key" — that mis-resolution is what flapped the Integrations
// Hub Stripe card to "no secret key configured" while a valid `sk_live_…`
// row was sitting in the DB. We only overwrite this on a *definitive*
// read (a real value, or a confirmed-empty/absent row); a thrown read
// falls back to the last value we positively saw in this process.
let cachedSettingKey: string | null = null;

// Discriminated lookup result so callers can tell "confirmed no key"
// apart from "couldn't determine". Only `empty` may surface as
// `no_secret_key`; `unknown` must never downgrade the badge.
type StripeKeyResolution =
  | { status: "found"; key: string }
  | { status: "empty" }
  | { status: "unknown"; error: string };

async function resolveStripeSecretKey(): Promise<StripeKeyResolution> {
  // Env var wins and bypasses the DB/Redis path entirely — the
  // cache-and-DB-independent mitigation. When set in prod this alone
  // keeps detection correct regardless of DB health.
  const fromEnv = process.env.STRIPE_SECRET_KEY?.trim();
  if (fromEnv) return { status: "found", key: fromEnv };

  try {
    const setting = await storage.getSystemSetting(STRIPE_SETTINGS_KEY);
    const value = setting?.value?.trim() || "";
    if (value) {
      cachedSettingKey = value;
      return { status: "found", key: value };
    }
    // The lookup definitively succeeded and the row is absent/blank —
    // a real disconnect, so drop any stale last-good too.
    cachedSettingKey = null;
    return { status: "empty" };
  } catch (err: any) {
    // The settings read couldn't complete (DB timeout / dropped conn).
    // Prefer the last value we positively saw in this process; never
    // downgrade to "no key" off a failed read.
    if (cachedSettingKey) return { status: "found", key: cachedSettingKey };
    return { status: "unknown", error: err?.message ?? "settings_read_failed" };
  }
}

// Test seam (Task #2099): clear the in-process last-good so a test can
// exercise the "no last-good + read throws" path deterministically.
// Production code never calls this.
export function __resetStripeKeyCacheForTest(): void {
  cachedSettingKey = null;
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY || !!cachedSettingKey;
}

export async function isStripeConfiguredAsync(): Promise<boolean> {
  return (await resolveStripeSecretKey()).status === "found";
}

// Task #2811 — three-state configuration status for the dedicated
// /api/stripe/status route. `isStripeConfiguredAsync()` folds the
// `unknown` outcome (settings read THREW, no in-process last-good) into
// `false`, which lets a DB blip render as "not configured". Callers that
// answer a status endpoint must see the distinction; only `empty` may
// surface as not-configured (credential-detection contract, Task #2099).
export async function getStripeConfigurationStatus(): Promise<
  { status: "found" | "empty" } | { status: "unknown"; error: string }
> {
  const resolution = await resolveStripeSecretKey();
  if (resolution.status === "unknown") {
    return { status: "unknown", error: resolution.error };
  }
  return { status: resolution.status };
}

export async function getStripeSecretKey(): Promise<string | null> {
  const resolution = await resolveStripeSecretKey();
  return resolution.status === "found" ? resolution.key : null;
}

export const STRIPE_SECRET_KEY_SETTING_KEY = STRIPE_SETTINGS_KEY;

// Task #1888 — outcome-aware probe contract (matches Slack/Front).
export type StripeProbeOutcome = "connected" | "unauthorized" | "probe_failed";
export interface StripeProbeResult {
  outcome: StripeProbeOutcome;
  reason?: string;
}

// Test seam (Task #1900): allow tests to inject a fake Stripe constructor
// without monkey-patching the sealed `stripe` ESM namespace. Production
// code paths leave this null and fall back to the real SDK.
type StripeCtorLike = new (
  key: string,
  config?: { apiVersion?: string },
) => { customers: { list: (...args: any[]) => Promise<any> } };
let stripeCtorForTest: StripeCtorLike | null = null;
export function __setStripeCtorForTest(ctor: StripeCtorLike | null): void {
  stripeCtorForTest = ctor;
}

async function loadStripeCtor(): Promise<StripeCtorLike> {
  if (stripeCtorForTest) return stripeCtorForTest;
  return (await import("stripe")).default as unknown as StripeCtorLike;
}

// Task #5097 — reusable, API-version-pinned Stripe server-client accessor.
//
// This is the single place any module may construct a full Stripe client from
// a resolved secret key. It centralizes the `new Stripe(key, { apiVersion })`
// call so the version-pin invariant (Task #1590) holds everywhere and so
// `bookCheckoutStripe.ts` (and any future caller) never imports the Stripe
// constructor directly. It reuses the existing `loadStripeCtor` test seam
// (`__setStripeCtorForTest`) so injected fakes still apply.
//
// The return type is `any` on purpose: the narrow `StripeCtorLike` seam only
// models `customers.list`, but real callers need the full SDK surface
// (tax.calculations, paymentIntents, webhooks, …). Callers own their own
// typing against the SDK response shapes.
export async function createPinnedStripeClient(key: string): Promise<any> {
  const Stripe = await loadStripeCtor();
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}

export async function probeConnection(): Promise<StripeProbeResult> {
  const resolution = await resolveStripeSecretKey();
  if (resolution.status === "unknown") {
    // The key lookup itself couldn't complete (degraded DB). This is NOT
    // evidence the key is missing — surface it as a transient probe
    // failure so the route preserves the last known badge instead of
    // flipping the card to "no secret key configured". (Task #2099)
    return {
      outcome: "probe_failed",
      reason: `key_lookup_failed: ${resolution.error}`.slice(0, 120),
    };
  }
  if (resolution.status === "empty") {
    return { outcome: "unauthorized", reason: "no_secret_key" };
  }
  const key = resolution.key;
  try {
    const Stripe = await loadStripeCtor();
    const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
    await auditOutboundCall(
      {
        integration: "stripe",
        endpoint: "/v1/customers",
        method: "GET",
        dedupeParams: { op: "customers.list", limit: 1 },
        callerLabel: "stripe:probeConnection",
      },
      async () => {
        const res = await stripe.customers.list({ limit: 1 });
        return { value: res, statusCode: 200 };
      },
    );
    return { outcome: "connected" };
  } catch (err: any) {
    const msg = String(err?.message ?? "");
    const statusCode: number | undefined = err?.statusCode;
    const code: string | undefined = err?.code || err?.type;
    if (
      statusCode === 401 ||
      code === "authentication_error" ||
      /invalid api key|api key/i.test(msg)
    ) {
      return { outcome: "unauthorized", reason: code || "authentication_error" };
    }
    if (statusCode === 429 || code === "rate_limit_error") {
      return { outcome: "probe_failed", reason: "rate_limited" };
    }
    if (typeof statusCode === "number" && statusCode >= 500) {
      return { outcome: "probe_failed", reason: `http_${statusCode}` };
    }
    return {
      outcome: "probe_failed",
      reason: (msg || "probe_threw").slice(0, 120),
    };
  }
}

export async function connectStripe(apiKey: string, updatedBy?: string): Promise<{ ok: boolean }> {
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION });
  await auditOutboundCall(
    {
      integration: "stripe",
      endpoint: "/v1/customers",
      method: "GET",
      dedupeParams: { op: "customers.list", limit: 1 },
      callerLabel: "stripe:connect:validate",
    },
    async () => {
      const res = await stripe.customers.list({ limit: 1 });
      return {
        value: res,
        statusCode: 200,
        responseSizeBytes: Array.isArray((res as any)?.data) ? (res as any).data.length : undefined,
      };
    },
  );
  await storage.setSystemSetting(STRIPE_SETTINGS_KEY, apiKey, updatedBy ?? "system");
  cachedSettingKey = apiKey;
  return { ok: true };
}

export async function disconnectStripe(updatedBy?: string): Promise<void> {
  await storage.setSystemSetting(STRIPE_SETTINGS_KEY, "", updatedBy ?? "system");
  cachedSettingKey = null;
}

export interface BillingSummary {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  lifetimeValue: number;
  currency: string;
  activeSubscription: {
    id: string;
    planName: string;
    amount: number;
    currency: string;
    interval: string;
    status: string;
    currentPeriodEnd: number;
    cancelAtPeriodEnd: boolean;
  } | null;
  paymentStatus: {
    lastPaymentStatus: string | null;
    lastPaymentDate: number | null;
    lastPaymentAmount: number | null;
    hasFailedPayments: boolean;
    subscriptionStatus: string | null;
    cardBrand: string | null;
    cardLast4: string | null;
    cardExpMonth: number | null;
    cardExpYear: number | null;
    isCardExpiring: boolean;
  };
}

export async function getCustomerBillingSummary(stripeCustomerId: string): Promise<BillingSummary | null> {
  try {
    const customerResult = await db.execute(sql`
      SELECT id, name, email, deleted
      FROM stripe.customers
      WHERE id = ${stripeCustomerId}
      LIMIT 1
    `);

    if (!customerResult.rows || customerResult.rows.length === 0) return null;
    const customer = customerResult.rows[0] as any;
    if (customer.deleted) return null;

    const invoiceResult = await db.execute(sql`
      SELECT COALESCE(SUM(amount_paid), 0) as total_paid,
             COALESCE(MAX(currency), 'usd') as currency
      FROM stripe.invoices
      WHERE customer = ${stripeCustomerId}
        AND status = 'paid'
    `);

    const invoiceRow = (invoiceResult.rows?.[0] as any) || {};
    const lifetimeValue = Number(invoiceRow.total_paid) || 0;
    const currency = invoiceRow.currency || "usd";

    const subResult = await db.execute(sql`
      SELECT s.id, s.status, s.cancel_at_period_end, s.current_period_end,
             s.items
      FROM stripe.subscriptions s
      WHERE s.customer = ${stripeCustomerId}
        AND s.status IN ('active', 'trialing', 'past_due', 'unpaid')
      ORDER BY s.current_period_end DESC
      LIMIT 1
    `);

    let activeSubscription: BillingSummary["activeSubscription"] = null;
    let subscriptionStatus: string | null = null;

    if (subResult.rows && subResult.rows.length > 0) {
      const sub = subResult.rows[0] as any;
      subscriptionStatus = sub.status;

      let planName = "Subscription";
      let amount = 0;
      let subCurrency = currency;
      let interval = "month";

      const items = typeof sub.items === "string" ? JSON.parse(sub.items) : sub.items;
      const itemData = items?.data?.[0];
      if (itemData?.price) {
        amount = itemData.price.unit_amount || 0;
        subCurrency = itemData.price.currency || currency;
        interval = itemData.price.recurring?.interval || "month";

        if (itemData.price.nickname) {
          planName = itemData.price.nickname;
        } else if (typeof itemData.price.product === "string") {
          const prodResult = await db.execute(sql`
            SELECT name FROM stripe.products WHERE id = ${itemData.price.product} LIMIT 1
          `);
          if (prodResult.rows?.[0]) {
            planName = (prodResult.rows[0] as any).name || planName;
          }
        }
      }

      activeSubscription = {
        id: sub.id,
        planName,
        amount,
        currency: subCurrency,
        interval,
        status: sub.status,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end || false,
      };
    }

    const chargeResult = await db.execute(sql`
      SELECT status, created, amount
      FROM stripe.charges
      WHERE customer = ${stripeCustomerId}
      ORDER BY created DESC
      LIMIT 1
    `);

    const failedChargeResult = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM stripe.charges
      WHERE customer = ${stripeCustomerId}
        AND status = 'failed'
        AND created > EXTRACT(EPOCH FROM (NOW() - INTERVAL '30 days'))::integer
    `);

    const hasFailedPayments = Number((failedChargeResult.rows?.[0] as any)?.count) > 0;

    const pmResult = await db.execute(sql`
      SELECT card
      FROM stripe.payment_methods
      WHERE customer = ${stripeCustomerId}
        AND type = 'card'
      ORDER BY created DESC
      LIMIT 1
    `);

    let paymentStatus: BillingSummary["paymentStatus"] = {
      lastPaymentStatus: null,
      lastPaymentDate: null,
      lastPaymentAmount: null,
      hasFailedPayments,
      subscriptionStatus,
      cardBrand: null,
      cardLast4: null,
      cardExpMonth: null,
      cardExpYear: null,
      isCardExpiring: false,
    };

    if (chargeResult.rows && chargeResult.rows.length > 0) {
      const charge = chargeResult.rows[0] as any;
      paymentStatus.lastPaymentStatus = charge.status;
      paymentStatus.lastPaymentDate = charge.created;
      paymentStatus.lastPaymentAmount = charge.amount;
    }

    if (pmResult.rows && pmResult.rows.length > 0) {
      const cardData = (pmResult.rows[0] as any).card;
      const card = typeof cardData === "string" ? JSON.parse(cardData) : cardData;
      if (card) {
        paymentStatus.cardBrand = card.brand;
        paymentStatus.cardLast4 = card.last4;
        paymentStatus.cardExpMonth = card.exp_month;
        paymentStatus.cardExpYear = card.exp_year;
        const now = new Date();
        const expDate = new Date(card.exp_year, card.exp_month - 1);
        const threeMonthsFromNow = new Date(now.getFullYear(), now.getMonth() + 3);
        paymentStatus.isCardExpiring = expDate <= threeMonthsFromNow;
      }
    }

    return {
      stripeCustomerId,
      customerName: customer.name,
      customerEmail: customer.email,
      lifetimeValue,
      currency,
      activeSubscription,
      paymentStatus,
    };
  } catch (error: any) {
    console.error("[Stripe] Error fetching billing summary from synced data:", error.message);
    return null;
  }
}

export async function searchStripeCustomers(query: string): Promise<Array<{
  id: string;
  name: string | null;
  email: string | null;
}>> {
  try {
    let result;
    if (query && query.trim().length > 0) {
      const pattern = `%${query}%`;
      result = await db.execute(sql`
        SELECT id, name, email
        FROM stripe.customers
        WHERE (deleted IS NULL OR deleted = false)
          AND (name ILIKE ${pattern} OR email ILIKE ${pattern})
        ORDER BY created DESC
        LIMIT 20
      `);
    } else {
      result = await db.execute(sql`
        SELECT id, name, email
        FROM stripe.customers
        WHERE (deleted IS NULL OR deleted = false)
        ORDER BY created DESC
        LIMIT 20
      `);
    }

    return (result.rows || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      email: row.email,
    }));
  } catch (error: any) {
    console.error("[Stripe] Error searching synced customers:", error.message);
    return [];
  }
}
