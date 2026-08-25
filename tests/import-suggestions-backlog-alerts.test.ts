/* test-registration
{
  "name": "Import suggestions backlog alerts + digest (Task #1224)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1224 regression tests: import-suggestions backlog alert + digest.
 *
 * Covers the same cooldown-vs-growth interaction as the queue-drain backlog
 * alert (Task #998), plus the digest's idempotency (already-sent key) and
 * cadence-hour gating.
 *
 * Stubs the dispatcher so no Slack call is made; uses the real DB for
 * `import_entity_suggestions` reads.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { storage } from "../server/storage";

const MARKER = `t1224_${process.pid}_${Date.now()}`;
const CLIENT_ID = `${MARKER}_client`;
const SURFACE_A = `${MARKER}_surface_a`;
const SURFACE_B = `${MARKER}_surface_b`;

const SETTING_KEYS = [
  "import_suggestions_backlog_alert_enabled",
  "import_suggestions_backlog_alert_threshold",
  "import_suggestions_backlog_alert_growth_threshold",
  "import_suggestions_backlog_alert_cooldown_minutes",
  "import_suggestions_digest.enabled",
  "import_suggestions_digest.cadence",
  "import_suggestions_digest.hour_utc",
  "import_suggestions_digest.weekday_utc",
  "import_suggestions_digest.last_sent_key",
] as const;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.execute(sql`DELETE FROM import_entity_suggestions WHERE client_id = ${CLIENT_ID}`);
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`);
  for (const k of SETTING_KEYS) {
    try {
      await storage.deleteSystemSetting(k);
    } catch {}
  }
}

async function seedClient(): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO clients (id, firm_name, is_demo, is_archived)
    VALUES (${CLIENT_ID}, ${`Probe Firm ${MARKER}`}, false, false)
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertPending(surface: string, count: number): Promise<void> {
  const db = getDb();
  for (let i = 0; i < count; i++) {
    await db.execute(sql`
      INSERT INTO import_entity_suggestions (client_id, entity_kind, surface, candidate, status)
      VALUES (${CLIENT_ID}, 'client_contact', ${surface}, '{}'::jsonb, 'pending')
    `);
  }
}

interface DispatchCall {
  id: string;
  text: string;
}

async function installDispatcherStub(
  calls: DispatchCall[],
  outcome: { delivered: boolean; status?: string; skipReason?: string } = { delivered: true },
) {
  const mod = await import("../server/services/importSuggestionsBacklogAlerts");
  mod.__testHelpers.setDispatcherForTests(async (id, payload) => {
    calls.push({ id, text: payload.text });
    return {
      delivered: outcome.delivered,
      status: outcome.status ?? (outcome.delivered ? "sent" : "failed"),
      skipReason: outcome.skipReason,
    };
  });
  return () => mod.__testHelpers.setDispatcherForTests(null);
}

async function run(): Promise<void> {
  await cleanup();
  await seedClient();

  // `loadBacklogSnapshot()` counts ALL pending rows globally, not just
  // this test's. The dev DB normally has a background pool of pending
  // import suggestions from real ingest. We measure that baseline and
  // anchor the alert/growth thresholds relative to it so the regression
  // intent (below=7, above=12, growth=+5) survives any baseline drift.
  const baselinePending = await (async () => {
    const r = await getDb().execute(
      sql`SELECT COUNT(*)::int AS c FROM import_entity_suggestions WHERE status = 'pending'`,
    );
    return Number((r.rows[0] as { c: number } | undefined)?.c ?? 0);
  })();
  const BELOW = baselinePending + 7;
  const THRESHOLD = baselinePending + 10;

  // Configure thresholds: total >= THRESHOLD, +5 growth, 60min cooldown.
  await storage.setSystemSetting("import_suggestions_backlog_alert_enabled", "true", "system");
  await storage.setSystemSetting(
    "import_suggestions_backlog_alert_threshold",
    String(THRESHOLD),
    "system",
  );
  await storage.setSystemSetting("import_suggestions_backlog_alert_growth_threshold", "5", "system");
  await storage.setSystemSetting("import_suggestions_backlog_alert_cooldown_minutes", "60", "system");

  const watcher = await import("../server/services/importSuggestionsBacklogAlerts");
  watcher.__testHelpers.resetLastAlertCache();

  // ── Below-threshold: no alert ──────────────────────────────────────
  await insertPending(SURFACE_A, 3);
  await insertPending(SURFACE_B, 4); // marker total = 7 (baseline + 7 < baseline + 10)
  void BELOW;
  {
    const calls: DispatchCall[] = [];
    const restore = await installDispatcherStub(calls);
    const r = await watcher.checkImportSuggestionsBacklog();
    assert.equal(r.decision, "skipped_below_threshold", `got ${r.decision} (${r.skipReason})`);
    assert.equal(calls.length, 0, "must not dispatch when below threshold");
    restore();
  }

  // ── First alert when over threshold ────────────────────────────────
  await insertPending(SURFACE_A, 5); // total = 12 >= 10
  {
    const calls: DispatchCall[] = [];
    const restore = await installDispatcherStub(calls);
    const r = await watcher.checkImportSuggestionsBacklog();
    assert.equal(r.decision, "alerted", `expected alerted, got ${r.decision}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, "queue.import_suggestions.backlog");
    assert.match(calls[0]!.text, /pending/i);
    assert.match(calls[0]!.text, new RegExp(SURFACE_A));
    restore();
  }

  // ── Cooldown suppression (no growth) ───────────────────────────────
  {
    const calls: DispatchCall[] = [];
    const restore = await installDispatcherStub(calls);
    const r = await watcher.checkImportSuggestionsBacklog();
    assert.ok(
      r.decision === "skipped_no_growth_since_last_alert" || r.decision === "skipped_cooldown",
      `expected cooldown skip, got ${r.decision}`,
    );
    assert.equal(calls.length, 0, "must not re-alert within cooldown without growth");
    restore();
  }

  // ── Re-alert when growth crosses growth_threshold within cooldown ──
  await insertPending(SURFACE_B, 5); // +5 since last alert
  {
    const calls: DispatchCall[] = [];
    const restore = await installDispatcherStub(calls);
    const r = await watcher.checkImportSuggestionsBacklog();
    assert.equal(r.decision, "alerted", `expected alerted, got ${r.decision} (${r.skipReason})`);
    assert.equal(calls.length, 1);
    restore();
  }

  // ── Disabled flag short-circuits ───────────────────────────────────
  await storage.setSystemSetting("import_suggestions_backlog_alert_enabled", "false", "system");
  {
    const calls: DispatchCall[] = [];
    const restore = await installDispatcherStub(calls);
    const r = await watcher.checkImportSuggestionsBacklog();
    assert.equal(r.decision, "skipped_disabled");
    assert.equal(calls.length, 0);
    restore();
  }
  await storage.setSystemSetting("import_suggestions_backlog_alert_enabled", "true", "system");

  // ── Digest: disabled → no send ─────────────────────────────────────
  {
    const calls: DispatchCall[] = [];
    const restore = await installDispatcherStub(calls);
    const r = await watcher.checkImportSuggestionsDigest();
    assert.equal(r.sent, false);
    assert.equal(r.shouldSend, false);
    assert.equal(calls.length, 0);
    restore();
  }

  // ── Digest: hour gating ───────────────────────────────────────────
  await storage.setSystemSetting("import_suggestions_digest.enabled", "true", "system");
  await storage.setSystemSetting("import_suggestions_digest.cadence", "daily", "system");
  const now = new Date();
  const targetHour = now.getUTCHours();
  const offHour = (targetHour + 12) % 24;
  await storage.setSystemSetting(
    "import_suggestions_digest.hour_utc",
    String(offHour),
    "system",
  );
  {
    const calls: DispatchCall[] = [];
    const restore = await installDispatcherStub(calls);
    const r = await watcher.checkImportSuggestionsDigest(now.getTime());
    assert.equal(r.sent, false);
    assert.match(r.reason, /not at digest hour/);
    assert.equal(calls.length, 0);
    restore();
  }

  // ── Digest: at-hour → sends + persists last_sent_key ──────────────
  await storage.setSystemSetting(
    "import_suggestions_digest.hour_utc",
    String(targetHour),
    "system",
  );
  {
    const calls: DispatchCall[] = [];
    const restore = await installDispatcherStub(calls);
    const r = await watcher.checkImportSuggestionsDigest(now.getTime());
    assert.equal(r.sent, true, `digest must send (reason=${r.reason})`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, "queue.import_suggestions.digest");
    restore();

    const lastSentRow = await storage.getSystemSetting("import_suggestions_digest.last_sent_key");
    assert.ok(lastSentRow?.value, "last_sent_key must be persisted after a successful digest");

    // Idempotency: re-running on the same key must NOT re-send.
    const calls2: DispatchCall[] = [];
    const restore2 = await installDispatcherStub(calls2);
    const r2 = await watcher.checkImportSuggestionsDigest(now.getTime());
    assert.equal(r2.sent, false, "second run on same key must skip");
    assert.match(r2.reason, /already sent/);
    assert.equal(calls2.length, 0);
    restore2();
  }

  await cleanup();
  console.log("import-suggestions-backlog-alerts.test.ts: OK");
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch {}
    process.exitCode = 1;
  });
