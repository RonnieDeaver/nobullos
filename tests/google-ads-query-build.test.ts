/* test-registration
{
  "name": "Google Ads GAQL query build \u2014 date range / conversions_value / API version (Task #2509)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2509 — Pin the Google Ads GAQL query construction against the three
 * regression classes Task #2508 fixed, all of which reached production as silent
 * "campaigns 0, keywords 0" sync failures because nothing tested the query text:
 *
 *   1. The date clause must be an explicit `segments.date BETWEEN '<start>' AND
 *      '<end>'` range — never a `DURING LAST_*` literal. GAQL's `DURING`
 *      operator only accepts a fixed literal set (no `LAST_90_DAYS` /
 *      `LAST_N_DAYS`), so an operator-tunable lookback can ONLY be expressed as
 *      a BETWEEN range. The window is inclusive of today and the lookback is
 *      clamped to 1–365.
 *   2. The campaign query must select `metrics.conversions_value` (a DOUBLE in
 *      account currency) and NEVER `metrics.conversions_value_micros`, which
 *      does not exist in any Google Ads API version.
 *   3. The default `GOOGLE_ADS_API_VERSION` must be a currently-supported,
 *      non-sunset version so a stale default fails CI.
 *
 * Pure in-memory: drives the exported `buildSyncCustomerQueries` seam with an
 * injected fixed clock — no DB, no network, no live sync.
 */
import { strict as assert } from "node:assert";

import {
  buildSyncCustomerQueries,
  classifyGoogleAdsError,
  GOOGLE_ADS_API_VERSION,
} from "../server/services/googleAdsIntegration";

type TestFn = () => void;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

// A fixed clock so the asserted window is deterministic. Mid-day UTC avoids any
// chance of the toISOString date boundary depending on the host's wall clock.
const FIXED_NOW = new Date("2026-06-13T12:00:00.000Z");

/** Days between two YYYY-MM-DD strings, inclusive of both endpoints. */
function inclusiveDaySpan(startIso: string, endIso: string): number {
  const start = Date.UTC(
    Number(startIso.slice(0, 4)),
    Number(startIso.slice(5, 7)) - 1,
    Number(startIso.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(endIso.slice(0, 4)),
    Number(endIso.slice(5, 7)) - 1,
    Number(endIso.slice(8, 10)),
  );
  return Math.round((end - start) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// 1. Date clause: explicit BETWEEN range, never DURING; inclusive today-ending
//    window across several lookbacks; 1–365 clamp.
// ---------------------------------------------------------------------------

test("date filter is an explicit segments.date BETWEEN range, never DURING", () => {
  for (const lookback of [1, 7, 30, 90, 365]) {
    const { dateFilter, campaignQuery, keywordQuery } = buildSyncCustomerQueries(
      lookback,
      FIXED_NOW,
    );

    assert.match(
      dateFilter,
      /^segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'$/,
      `lookback ${lookback}: dateFilter must be an explicit BETWEEN range, got: ${dateFilter}`,
    );

    // No query may ever reintroduce the DURING operator (the original bug). Be
    // defensive about whitespace/casing.
    for (const q of [dateFilter, campaignQuery, keywordQuery]) {
      assert.ok(
        !/\bDURING\b/i.test(q),
        `lookback ${lookback}: GAQL must not use the DURING operator: ${q}`,
      );
      assert.ok(
        !/LAST_\d+_DAYS/i.test(q),
        `lookback ${lookback}: GAQL must not use a LAST_N_DAYS literal: ${q}`,
      );
    }
  }
});

test("window ends today (inclusive) and spans exactly `lookback` calendar days", () => {
  const expectedEnd = "2026-06-13"; // FIXED_NOW's UTC date
  for (const lookback of [1, 7, 30, 90, 365]) {
    const { startDate, endDate } = buildSyncCustomerQueries(lookback, FIXED_NOW);
    assert.equal(
      endDate,
      expectedEnd,
      `lookback ${lookback}: window must end on today (inclusive)`,
    );
    assert.equal(
      inclusiveDaySpan(startDate, endDate),
      lookback,
      `lookback ${lookback}: inclusive window must span exactly ${lookback} days`,
    );
  }
});

test("a 90-day lookback yields the expected concrete start date", () => {
  // 90 days inclusive ending 2026-06-13 → start = 2026-06-13 − 89 days.
  const { dateFilter } = buildSyncCustomerQueries(90, FIXED_NOW);
  assert.equal(
    dateFilter,
    "segments.date BETWEEN '2026-03-16' AND '2026-06-13'",
  );
});

test("lookback is clamped to the 1–365 range", () => {
  // Below the floor → clamps to 1 (single day, start === end).
  for (const tooSmall of [0, -5]) {
    const { lookback, startDate, endDate } = buildSyncCustomerQueries(
      tooSmall,
      FIXED_NOW,
    );
    assert.equal(lookback, 1, `${tooSmall} must clamp up to 1`);
    assert.equal(startDate, endDate, `${tooSmall}: a 1-day window has start === end`);
  }

  // Above the ceiling → clamps to 365.
  for (const tooBig of [366, 1000]) {
    const { lookback, startDate, endDate } = buildSyncCustomerQueries(
      tooBig,
      FIXED_NOW,
    );
    assert.equal(lookback, 365, `${tooBig} must clamp down to 365`);
    assert.equal(
      inclusiveDaySpan(startDate, endDate),
      365,
      `${tooBig}: clamped window must span exactly 365 days`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Campaign query selects metrics.conversions_value, NOT the non-existent
//    metrics.conversions_value_micros.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Task #2902 — v23 removed `campaign.start_date`/`campaign.end_date` (GAQL
// UNRECOGNIZED_FIELD, the root cause of every zero-data daily sync run since
// the v23 bump); the replacements are `start_date_time`/`end_date_time`
// (v23 release notes, 2026-01-28 breaking changes).
// ---------------------------------------------------------------------------

test("campaign query selects start_date_time/end_date_time, never removed start_date/end_date", () => {
  const { campaignQuery } = buildSyncCustomerQueries(90, FIXED_NOW);
  assert.ok(
    /\bcampaign\.start_date_time\b/.test(campaignQuery),
    "campaign query must select campaign.start_date_time (v23 replacement)",
  );
  assert.ok(
    /\bcampaign\.end_date_time\b/.test(campaignQuery),
    "campaign query must select campaign.end_date_time (v23 replacement)",
  );
  assert.ok(
    !/\bcampaign\.start_date\s*,/.test(campaignQuery) &&
      !/\bcampaign\.end_date\s*,/.test(campaignQuery),
    "campaign query must NOT select campaign.start_date / campaign.end_date — removed in v23 (UNRECOGNIZED_FIELD)",
  );
});

test("campaign query selects metrics.conversions_value, never conversions_value_micros", () => {
  const { campaignQuery } = buildSyncCustomerQueries(30, FIXED_NOW);

  assert.ok(
    /\bmetrics\.conversions_value\b/.test(campaignQuery),
    "campaign query must select metrics.conversions_value",
  );
  assert.ok(
    !/metrics\.conversions_value_micros/.test(campaignQuery),
    "campaign query must NOT select the non-existent metrics.conversions_value_micros field",
  );
});

// ---------------------------------------------------------------------------
// 3. Default API version pinned to a currently-supported, non-sunset version.
// ---------------------------------------------------------------------------

test("default GOOGLE_ADS_API_VERSION is a currently-supported, non-sunset version", () => {
  // v23 sunsets ~Jan 2027 (Task #2905 bumped the default to v24, released
  // Apr 22 2026, sunset May 2027). Treat anything at or below v23 as stale so
  // the default must be bumped before its sunset reaches CI.
  // Update this floor (and the comment) when bumping the default forward.
  const MIN_SUPPORTED_MAJOR = 24;

  const match = /^v(\d+)$/.exec(GOOGLE_ADS_API_VERSION);
  assert.ok(
    match,
    `GOOGLE_ADS_API_VERSION must look like "v<NN>", got: ${GOOGLE_ADS_API_VERSION}`,
  );
  const major = Number(match![1]);
  assert.ok(
    major >= MIN_SUPPORTED_MAJOR,
    `GOOGLE_ADS_API_VERSION ${GOOGLE_ADS_API_VERSION} is at/below the sunset floor v${MIN_SUPPORTED_MAJOR} — bump it (and this floor) off the sunsetting version. See https://developers.google.com/google-ads/api/docs/sunset-dates`,
  );
});

// ---------------------------------------------------------------------------
// Task #2902 — error classification. `authorizationError:USER_PERMISSION_DENIED`
// is a PER-CUSTOMER "no link under the login MCC" error and must classify as
// `permission_denied` (disables one customer's sync), never `unauthenticated`
// (which durably disconnects the GLOBAL connection and trips the auth breaker,
// killing the entire daily pull — the production incident this task fixed).
// ---------------------------------------------------------------------------

function adsError(status: string, errorCode: Record<string, string>) {
  return {
    error: {
      code: 403,
      status,
      message: "The caller does not have permission",
      details: [{ errors: [{ errorCode }] }],
    },
  };
}

test("authorizationError:USER_PERMISSION_DENIED classifies permission_denied, not unauthenticated", () => {
  const parsed = adsError("PERMISSION_DENIED", {
    authorizationError: "USER_PERMISSION_DENIED",
  });
  const { kind, reason } = classifyGoogleAdsError(parsed, 403);
  assert.equal(kind, "permission_denied");
  assert.equal(reason, "authorizationError:USER_PERMISSION_DENIED");
});

test("genuine credential deaths (NOT_ADS_USER / OAUTH_TOKEN_*, 401) still classify unauthenticated", () => {
  for (const errorCode of [
    { authenticationError: "NOT_ADS_USER" },
    { authenticationError: "OAUTH_TOKEN_REVOKED" },
    { authenticationError: "OAUTH_TOKEN_EXPIRED" },
  ]) {
    const { kind } = classifyGoogleAdsError(
      adsError("UNAUTHENTICATED", errorCode),
      401,
    );
    assert.equal(kind, "unauthenticated", JSON.stringify(errorCode));
  }
  // Bare 401 with no typed reason is also a credential problem.
  assert.equal(classifyGoogleAdsError({}, 401).kind, "unauthenticated");
});

test("UNRECOGNIZED_FIELD query errors never classify as unauthenticated", () => {
  const parsed = adsError("INVALID_ARGUMENT", {
    queryError: "UNRECOGNIZED_FIELD",
  });
  const { kind } = classifyGoogleAdsError(parsed, 400);
  assert.notEqual(kind, "unauthenticated");
  assert.notEqual(kind, "permission_denied");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(err instanceof Error ? err.stack : err);
  }
}

console.log(
  `\nGoogle Ads query-build tests: ${tests.length - failed}/${tests.length} passed`,
);
if (failed > 0) {
  process.exitCode = 1;
  throw new Error(`${failed} Google Ads query-build test(s) failed`);
}
