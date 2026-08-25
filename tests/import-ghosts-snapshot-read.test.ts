/* test-registration
{
  "name": "Import-ghosts snapshot last-run classify reader (Task #2198)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2198 — classify-then-surface coverage for the import-ghosts
 * snapshot last-run reader (`server/services/importGhostsSnapshot.ts`).
 *
 * The snapshot's `/api/health/import-ghosts-snapshot` panel now reads via
 * `readLastImportGhostsSnapshot()`, which must tell "never ran" (no
 * persisted setting row — the normal fresh-deploy state) apart from
 * "stored value was unreadable" (a parse/read failure — a real
 * persistence regression) instead of swallowing both to null. The thin
 * back-compat wrapper `getLastImportGhostsSnapshot()` still collapses both
 * non-ok states to null.
 *
 * Deterministic, settings-only — no live integrations. Saves and restores
 * the original `import_ghosts_snapshot_last_run` value so the shared dev
 * DB is left untouched.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  setSystemSetting,
  deleteSystemSetting,
  getSystemSetting,
} from "../server/storage/settingsStorage";
import {
  readLastImportGhostsSnapshot,
  getLastImportGhostsSnapshot,
  SETTING_LAST_RUN,
} from "../server/services/importGhostsSnapshot";

let original: string | null | undefined;

test("task-2198: import-ghosts reader classifies never_run / unreadable / ok", async () => {
  const prior = await getSystemSetting(SETTING_LAST_RUN).catch(() => null);
  original = prior ? prior.value ?? null : undefined;

  try {
    // never_run — no persisted setting row.
    await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
    const neverRun = await readLastImportGhostsSnapshot();
    assert.equal(neverRun.status, "never_run");
    assert.equal(neverRun.lastRun, null);
    assert.equal(neverRun.error, undefined);

    // unreadable — stored value is not valid JSON.
    await setSystemSetting(SETTING_LAST_RUN, "{not json");
    const corruptParse = await readLastImportGhostsSnapshot();
    assert.equal(corruptParse.status, "unreadable");
    assert.equal(corruptParse.lastRun, null);
    assert.ok(
      typeof corruptParse.error === "string" && corruptParse.error.length > 0,
      "unreadable carries a plain-English error",
    );

    // unreadable — valid JSON but not an object.
    await setSystemSetting(SETTING_LAST_RUN, "42");
    const corruptShape = await readLastImportGhostsSnapshot();
    assert.equal(corruptShape.status, "unreadable");
    assert.equal(corruptShape.lastRun, null);

    // ok — a readable JSON object round-trips as the parsed summary.
    const summary = { scannedAt: "2026-06-01T00:00:00.000Z", ghosts: 3 };
    await setSystemSetting(SETTING_LAST_RUN, JSON.stringify(summary));
    const okRead = await readLastImportGhostsSnapshot();
    assert.equal(okRead.status, "ok");
    assert.equal(okRead.error, undefined);
    assert.ok(okRead.lastRun, "ok read carries the parsed summary");
    assert.equal((okRead.lastRun as any).ghosts, 3);

    // Back-compat wrapper collapses non-ok states to null but returns the
    // parsed summary on ok.
    assert.ok(await getLastImportGhostsSnapshot(), "wrapper returns ok summary");
    await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
    assert.equal(
      await getLastImportGhostsSnapshot(),
      null,
      "wrapper returns null when unset",
    );
  } finally {
    if (original === undefined) {
      await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
    } else {
      await setSystemSetting(SETTING_LAST_RUN, original ?? "");
    }
  }
});
