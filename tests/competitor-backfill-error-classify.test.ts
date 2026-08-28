/* test-registration
{
  "name": "Competitor backfill error classify (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
// Unit test for the SEMrush fetch-error classifier used by the
// competitor GBP-URL backfill. A *terminal* (deterministic, non-retryable)
// error must stamp the snapshot attempted so the backfill converges; a
// *transient* error must keep retrying. The classifier is kept narrow so
// a transient upstream regression never permanently stamps recoverable
// rows.
//
// Pure function — no DB or network. Usage: tsx tests/competitor-backfill-error-classify.test.ts
import assert from "node:assert/strict";
import { isTerminalSemrushFetchError } from "../server/services/competitorLocationBackfill";
import {
  SemrushNotFoundError,
  SemrushRateLimitError,
} from "../server/services/semrushApi";

// --- terminal (deterministic, non-retryable) ---
assert.equal(
  isTerminalSemrushFetchError(new SemrushNotFoundError("Semrush API 404: Not Found")),
  true,
  "404 NotFound is terminal",
);
assert.equal(
  isTerminalSemrushFetchError(
    new Error(
      `SEMrush API returned 400: {"meta":{"success":false,"status_code":400},"error":{"code":400,"message":"Invalid value for 'reportDate' provided","retryable":false}}`,
    ),
  ),
  true,
  "400 invalid-reportDate is terminal",
);

// --- transient (must keep retrying) ---
assert.equal(
  isTerminalSemrushFetchError(
    new Error(`SEMrush API returned 400: {"error":{"message":"some other client error"}}`),
  ),
  false,
  "unknown 400 shape stays transient",
);
assert.equal(
  isTerminalSemrushFetchError(new Error("SEMrush API returned 500: internal error")),
  false,
  "5xx stays transient",
);
assert.equal(
  isTerminalSemrushFetchError(new Error("fetch failed")),
  false,
  "network error stays transient",
);
assert.equal(
  isTerminalSemrushFetchError(
    new Error("Semrush not connected — token expired, please re-authorize via Integrations Hub"),
  ),
  false,
  "auth-missing stays transient",
);
assert.equal(
  isTerminalSemrushFetchError(new SemrushRateLimitError("rate limited")),
  false,
  "rate-limit stays transient",
);

console.log("competitor backfill error classify: all assertions passed");
// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the process
// exits on its own once the assertions settle — no manual process.exit() (Task #2084).
