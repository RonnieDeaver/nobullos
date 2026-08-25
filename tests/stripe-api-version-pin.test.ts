/* test-registration
{
  "name": "Stripe API version pin — shared constant matches installed SDK (Task #1590)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #1590 (audit B-001): both direct Stripe clients and stripe-replit-sync's internal client must be pinned to one shared apiVersion so vendor dashboard-default rolls can't skew webhook ingestion vs app code. This suite pins (1) STRIPE_API_VERSION === the installed SDK's generated Stripe.API_VERSION, and (2) source-scans that every `new Stripe(` construction passes the constant and the sync config sets stripeApiVersion — a future call site added without the pin fails here instead of silently floating on the account default.",
  "scanPaths": [
    "server/stripeClient.ts",
    "server/stripeSync.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1590 — Pin the Stripe API version (audit finding B-001).
 *
 * Two layers of protection:
 *  1. Runtime: `STRIPE_API_VERSION` must equal the installed `stripe`
 *     SDK's own generated version (`Stripe.API_VERSION`). The SDK types
 *     already enforce this at typecheck for direct constructions, but
 *     `stripe-replit-sync`'s `stripeApiVersion` config is a plain
 *     string — this assert closes that gap and fails loudly on an SDK
 *     upgrade so the constant is updated in the same change.
 *  2. Source scan: every `new Stripe(`-style construction in the two
 *     Stripe modules must pass an explicit apiVersion, and the sync
 *     config must set `stripeApiVersion` — so a future call site can't
 *     be added unpinned.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function main() {
  const { STRIPE_API_VERSION } = await import("../server/stripeClient");
  const Stripe = (await import("stripe")).default as any;

  // 1. Constant matches the installed SDK's generated API version.
  assert.equal(
    STRIPE_API_VERSION,
    Stripe.API_VERSION,
    `STRIPE_API_VERSION (${STRIPE_API_VERSION}) must match the installed stripe SDK's Stripe.API_VERSION (${Stripe.API_VERSION}) — update the shared constant in server/stripeClient.ts in the same change as any SDK upgrade`,
  );
  assert.ok(
    /^\d{4}-\d{2}-\d{2}/.test(STRIPE_API_VERSION),
    `STRIPE_API_VERSION should look like a Stripe date-based version, got: ${STRIPE_API_VERSION}`,
  );

  // 2. Source scan: no unpinned client constructions.
  // Strip comments so prose mentions of `new Stripe(...)` don't trip the scan.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const clientSrc = stripComments(readFileSync("server/stripeClient.ts", "utf8"));
  const syncSrc = stripComments(readFileSync("server/stripeSync.ts", "utf8"));

  const ctorRe = /new Stripe\s*\(([^)]*)\)/g;
  const ctors = [...clientSrc.matchAll(ctorRe)];
  assert.ok(ctors.length >= 2, `expected at least 2 Stripe constructions in stripeClient.ts, found ${ctors.length}`);
  for (const m of ctors) {
    assert.ok(
      /apiVersion/.test(m[1]),
      `unpinned Stripe client construction in server/stripeClient.ts: new Stripe(${m[1].trim()}) — pass { apiVersion: STRIPE_API_VERSION }`,
    );
  }

  assert.ok(
    /new StripeSync\s*\(\{[\s\S]*?stripeApiVersion:\s*STRIPE_API_VERSION/.test(syncSrc),
    "server/stripeSync.ts StripeSync config must set stripeApiVersion: STRIPE_API_VERSION",
  );

  console.log("stripe-api-version-pin: all assertions passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
