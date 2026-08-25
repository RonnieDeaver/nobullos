/* test-registration
{
  "name": "Schema-drift alert delivery through the real dispatcher (Task #4666)",
  "regression": true,
  "sweepOnlyReason": "Task #4666: proves a drift outcome from runSchemaDriftCheck lands as a persisted notification_deliveries row through the REAL notifyByType (registry id + dedupe key wiring), plus skipped_deduped on immediate re-run and re-alert on failureType change. The outcome→notify mapping itself is already smoke-gated in schema-drift-check.test.ts with an injected notify stub; this suite adds the one layer that cannot cover — a registry id typo or dedupe-key drift silencing the alert while unit tests stay green. DB-backed by construction: the dispatcher upserts delivery + health-state rows.",
  "tier": "small"
}
test-registration */
/**
 * Task #4666 — End-to-end delivery proof for the schema-drift alert.
 *
 * Drives runSchemaDriftCheck() with injected catalog/snapshot deps but the
 * REAL notification dispatcher (default notify/markRecovered deps), asserting:
 *  1. a drift outcome writes a `success` notification_deliveries row for
 *     infra.schema_drift.prod_only_objects with dedupeKey schema_drift:nightly;
 *  2. an immediate identical re-run records `skipped_deduped` (health-state
 *     transition dedupe, same failureType inside the reminder interval);
 *  3. a failureType change (drift → snapshot_missing) re-alerts immediately
 *     (a new `success` row despite the recent lastNotifiedAt).
 *
 * Slack itself is stubbed at global.fetch (slack.com/api answers ok) — the
 * point is the dispatcher wiring and DB evidence, not Slack's availability.
 * The bot token + notification channel are seeded so dispatch reaches the
 * send path (otherwise skipped_no_channel/skipped_slack_disconnected rows
 * never upsert health state and dedupe semantics would be untestable).
 *
 * Layer: sweep-only (DB writes; the unit mapping is already smoke-gated).
 */
import "./helpers/forceTestEnv";
import assert from "node:assert/strict";

import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { storage } from "../server/storage";
import { upsertNotificationSetting } from "../server/storage/notificationsStorage";
import {
  SCHEMA_DRIFT_DEDUPE_KEY,
  SCHEMA_DRIFT_NOTIFICATION_ID,
  __setSchemaDriftTestDeps,
  runSchemaDriftCheck,
  type Catalog,
  type DevCatalogSnapshot,
} from "../server/services/schemaDriftCheck";

const TAG = `sdad-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SLACK_CHANNEL = `C-${TAG}`;

// ── fetch stub: Slack answers ok, Upstash passthrough, rest real ──────────
const originalFetch = global.fetch;
const {
  isUpstashRedisUrl: __isUpstashRedisUrl,
  makeUpstashPassthroughResponse: __makeUpstashPassthroughResponse,
} = await import("./helpers/upstashFetchStub");

let slackPostCalls = 0;
global.fetch = (async (input: any, init?: any) => {
  if (__isUpstashRedisUrl(input)) return __makeUpstashPassthroughResponse(input, init);
  const url = typeof input === "string" ? input : input?.url ? input.url : String(input);
  if (url.includes("slack.com/api/chat.postMessage")) {
    slackPostCalls++;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("slack.com/api")) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return originalFetch(input as any, init);
}) as any;

// ── DB evidence helpers ────────────────────────────────────────────────────

interface DeliveryRow {
  status: string;
  dedupe_key: string | null;
}

async function deliveryRows(): Promise<DeliveryRow[]> {
  const db = getDb();
  const res = await db.execute(sql`
    SELECT status, dedupe_key
    FROM notification_deliveries
    WHERE notification_id = ${SCHEMA_DRIFT_NOTIFICATION_ID}
      AND dedupe_key = ${SCHEMA_DRIFT_DEDUPE_KEY}
    ORDER BY created_at ASC, id ASC
  `);
  return res.rows as unknown as DeliveryRow[];
}

async function clearHealthState(): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    DELETE FROM notification_health_state
    WHERE notification_id = ${SCHEMA_DRIFT_NOTIFICATION_ID}
      AND dedupe_key = ${SCHEMA_DRIFT_DEDUPE_KEY}
  `);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function freshSnapshot(): DevCatalogSnapshot {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    tables: ["users"],
    indexes: [{ name: "users_pkey", table: "users" }],
    constraints: [{ name: "users_pkey", table: "users" }],
    pendingDropTables: [],
    pendingDropIndexes: [],
  };
}

function driftedProdCatalog(): Catalog {
  const dev = freshSnapshot();
  return {
    tables: [...dev.tables, `stripped_tbl_${TAG.replaceAll("-", "_")}`],
    indexes: dev.indexes,
    constraints: dev.constraints,
  };
}

/** Inject catalog/snapshot deps ONLY — notify/markRecovered stay the real dispatcher. */
function injectDrift(): void {
  __setSchemaDriftTestDeps({
    loadDevSnapshot: async () => freshSnapshot(),
    captureCatalog: async () => driftedProdCatalog(),
  });
}

function injectSnapshotMissing(): void {
  __setSchemaDriftTestDeps({
    loadDevSnapshot: async () => null,
    captureCatalog: async () => driftedProdCatalog(),
  });
}

// ── Run ────────────────────────────────────────────────────────────────────

const priorToken = await storage.getSystemSetting("slack_bot_token");

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}`);
    console.error(err instanceof Error ? err.stack : err);
  }
}

try {
  // Seed a connected Slack + a configured channel so dispatch reaches the
  // send path (and therefore upserts health state for the dedupe steps).
  await storage.setSystemSetting("slack_bot_token", `xoxb-${TAG}`, "test");
  await upsertNotificationSetting({
    notificationId: SCHEMA_DRIFT_NOTIFICATION_ID,
    enabled: true,
    channelId: SLACK_CHANNEL,
    channelName: `#schema-drift-${TAG}`,
    updatedBy: null,
  });
  // Start from a clean health-state slate for the constant dedupe key.
  await clearHealthState();
  const preexisting = (await deliveryRows()).length;

  await step("drift outcome → success delivery row via the real dispatcher", async () => {
    injectDrift();
    const outcome = await runSchemaDriftCheck();
    assert.equal(outcome.kind, "drift");
    const rows = await deliveryRows();
    assert.equal(rows.length, preexisting + 1, "expected exactly one new delivery row");
    const row = rows[rows.length - 1];
    assert.equal(row.status, "success");
    assert.equal(row.dedupe_key, SCHEMA_DRIFT_DEDUPE_KEY);
    assert.ok(slackPostCalls >= 1, "expected a chat.postMessage attempt");
  });

  await step("immediate identical re-run → skipped_deduped row (no re-send)", async () => {
    injectDrift();
    const callsBefore = slackPostCalls;
    const outcome = await runSchemaDriftCheck();
    assert.equal(outcome.kind, "drift");
    const rows = await deliveryRows();
    assert.equal(rows.length, preexisting + 2, "expected a second delivery row");
    assert.equal(rows[rows.length - 1].status, "skipped_deduped");
    assert.equal(slackPostCalls, callsBefore, "deduped run must not re-post to Slack");
  });

  await step("failureType change (snapshot_missing) → immediate re-alert", async () => {
    injectSnapshotMissing();
    const outcome = await runSchemaDriftCheck();
    assert.equal(outcome.kind, "snapshot_missing");
    const rows = await deliveryRows();
    assert.equal(rows.length, preexisting + 3, "expected a third delivery row");
    assert.equal(
      rows[rows.length - 1].status,
      "success",
      "changed failureType must bypass dedupe and re-alert",
    );
  });
} finally {
  // Restore the real fetch FIRST so restoration writes don't hit the stub.
  global.fetch = originalFetch;
  try {
    await storage.setSystemSetting("slack_bot_token", priorToken?.value ?? "", "test");
  } catch (err) {
    console.warn("slack_bot_token restore failed:", err);
  }
  try {
    await clearHealthState();
  } catch (err) {
    console.warn("health-state cleanup failed:", err);
  }
  __setSchemaDriftTestDeps({}); // back to default deps
}

if (failures > 0) {
  console.error(`\n${failures} schema-drift alert delivery test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll schema-drift alert delivery tests passed.");
process.exit(0);
