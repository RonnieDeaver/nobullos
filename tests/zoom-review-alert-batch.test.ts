/* test-registration
{
  "name": "Zoom review alert batched read (Task #836 P5)",
  "tier": "small"
}
test-registration */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import {
  getZoomReviewAlertSettings,
  parseLastClearedAt,
} from "../server/services/zoomReviewQueueAlerts";

async function run() {
  // 1. parseLastClearedAt is the defensive parser introduced for the
  //    "lastClearedAt was a JSON-stringified payload" production
  //    incident. It must fail soft on any unparseable shape.
  assert.equal(parseLastClearedAt(undefined), null);
  assert.equal(parseLastClearedAt(""), null);
  assert.equal(parseLastClearedAt("   "), null);
  assert.equal(
    parseLastClearedAt('{"value":"2025-01-01T00:00:00.000Z"}'),
    null,
    "JSON object payload must be rejected",
  );
  assert.equal(
    parseLastClearedAt('["2025-01-01T00:00:00.000Z"]'),
    null,
    "JSON array payload must be rejected",
  );
  assert.equal(parseLastClearedAt("not-a-timestamp"), null);

  const okIso = "2025-12-31T23:59:59.000Z";
  assert.equal(
    parseLastClearedAt(okIso),
    okIso,
    "ISO timestamp must round-trip",
  );
  assert.equal(
    parseLastClearedAt("2025-06-15"),
    "2025-06-15",
    "Date-only ISO must round-trip",
  );

  // 2. getZoomReviewAlertSettings must collapse the previous 11
  //    parallel `getSystemSetting` calls into a single batched
  //    `getSystemSettings(keys[])` call.
  const original = storage.getSystemSettings.bind(storage);
  const calls: string[][] = [];
  let perKeyCalls = 0;
  const originalSingle = storage.getSystemSetting.bind(storage);
  (storage as any).getSystemSettings = async (keys: string[]) => {
    calls.push([...keys]);
    return {};
  };
  (storage as any).getSystemSetting = async (key: string) => {
    perKeyCalls++;
    return originalSingle(key);
  };
  try {
    const settings = await getZoomReviewAlertSettings();
    assert.equal(calls.length, 1, "must batch into one DB read");
    assert.ok(calls[0].length >= 8, "must request the full key set in one shot");
    assert.equal(
      perKeyCalls,
      0,
      "must NOT fall back to per-key getSystemSetting",
    );

    // The settings object should still have sensible defaults when the
    // batched read returns no rows (fresh deployment / empty table).
    assert.equal(typeof settings.enabled, "boolean");
    assert.equal(typeof settings.countThreshold, "number");
    assert.equal(typeof settings.ageHoursThreshold, "number");
    assert.equal(typeof settings.cooldownMinutes, "number");
    assert.equal(settings.lastClearedAt, null);
  } finally {
    (storage as any).getSystemSettings = original;
    (storage as any).getSystemSetting = originalSingle;
  }

  console.log("zoom-review-alert-batch.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run().then(() => {}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
