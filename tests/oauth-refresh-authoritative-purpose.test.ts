/* test-registration
{
  "name": "OAuth refresh authoritative-purpose classifier (Task #2267)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2267 — unit coverage for `isAuthoritativeRefreshPurpose` /
 * `NON_AUTHORITATIVE_REFRESH_PURPOSES` in
 * `server/services/oauthRefresh.ts`.
 *
 * Background: a background health-check probe or a pre-expiry proactive
 * top-up that loses an OAuth refresh-token rotation race 4xx's on a
 * captured-but-already-consumed token. SEMrush (Task #2265) and now
 * Front / Zoom / Google Ads (Task #2267) gate every terminal
 * disconnect / token-wipe / breaker-trip / auth-gate-engage on this
 * predicate so an observational refresh can NEVER commit a durable
 * disconnect. This is the single classifier all four integrations share,
 * so its contract is pinned here independent of any one integration.
 *
 * Pure function — no DB, no network.
 */
import { strict as assert } from "node:assert";
import {
  NON_AUTHORITATIVE_REFRESH_PURPOSES,
  isAuthoritativeRefreshPurpose,
} from "../server/services/oauthRefresh";

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
  }
}

function main(): void {
  console.log("oauth-refresh authoritative-purpose classifier (Task #2267)");

  check("unset / empty purpose is authoritative (safe default)", () => {
    assert.equal(isAuthoritativeRefreshPurpose(undefined), true);
    assert.equal(isAuthoritativeRefreshPurpose(""), true);
  });

  check("base non-authoritative purposes are recognized", () => {
    assert.equal(isAuthoritativeRefreshPurpose("probe"), false);
    assert.equal(isAuthoritativeRefreshPurpose("proactive"), false);
    // The canonical set the predicate falls back to.
    assert.equal(NON_AUTHORITATIVE_REFRESH_PURPOSES.has("probe"), true);
    assert.equal(NON_AUTHORITATIVE_REFRESH_PURPOSES.has("proactive"), true);
  });

  check("integration-prefixed probe purposes are non-authoritative", () => {
    // The four integrations name their probe refreshes distinctly; the
    // predicate must classify all of them WITHOUT each caller re-deriving
    // the set.
    assert.equal(isAuthoritativeRefreshPurpose("front_probe"), false);
    assert.equal(isAuthoritativeRefreshPurpose("zoom_probe"), false);
    assert.equal(isAuthoritativeRefreshPurpose("google_ads_probe"), false);
    assert.equal(isAuthoritativeRefreshPurpose("semrush-probe"), false);
    assert.equal(isAuthoritativeRefreshPurpose("daily_proactive_topup"), false);
  });

  check("real on-demand refresh purposes stay authoritative", () => {
    // A real API call needs a token, a 401 recovery, an operator-forced
    // refresh — all authoritative and allowed to commit a disconnect.
    assert.equal(isAuthoritativeRefreshPurpose("expiry"), true);
    assert.equal(isAuthoritativeRefreshPurpose("expiry_or_401"), true);
    assert.equal(isAuthoritativeRefreshPurpose("401_retry"), true);
    assert.equal(isAuthoritativeRefreshPurpose("forced"), true);
    assert.equal(isAuthoritativeRefreshPurpose("test"), true);
  });

  check("substring 'probe'/'proactive' inside an unrelated word stays authoritative", () => {
    // The word-boundary regex must not mis-classify a purpose that merely
    // contains the letters (e.g. a hypothetical "approbе"-style token) when
    // it isn't a probe/proactive segment.
    assert.equal(isAuthoritativeRefreshPurpose("approbation"), true);
    assert.equal(isAuthoritativeRefreshPurpose("reactive"), true);
  });

  if (failures > 0) {
    throw new Error(`${failures} oauth-refresh purpose case(s) failed`);
  }
  console.log("oauth-refresh-authoritative-purpose: OK");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
