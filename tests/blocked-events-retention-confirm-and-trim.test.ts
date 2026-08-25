/* test-registration
{
  "name": "Blocked-events retention confirm + trim notification (Task #781)",
  "tier": "medium"
}
test-registration */
/**
 * Regression coverage for the new retention-confirmation + per-IP trim
 * notification flows added to the rate-limit admin tools.
 *
 * Three behaviors are pinned here, hitting the **real** route handlers
 * registered by `registerBlockedEventsRetentionAdminRoutes` (the same
 * registration `server/routes.ts` uses in production):
 *
 *   1. PUT /api/health/rate-limits/blocked-events-retention
 *        - Shortening retention without `confirm:true` returns 409 with
 *          `error:"confirmation_required"`, `requiresConfirm:true`, and an
 *          `affectedRows` row-count preview.
 *        - Re-submitting with `confirm:true` returns 200 and persists the
 *          new value.
 *   2. The blocked_ip per-IP audit prune writes a `blocked_ip_audit_trimmed`
 *      row per affected IP (scope=ip, newValues.trimmedCount, newValues.cap)
 *      whenever it deletes excess rows. (Service-level assertion against
 *      `pruneBlockedIpAuditNow`.)
 *   3. GET /api/health/blocked-ips/:ip/history merges `blocked_ip` and
 *      `blocked_ip_audit_trimmed` entries for the requested scope, sorted
 *      by `changedAt` descending.
 *
 * Auth: requireTeamLead reads the acting user's role from the `users`
 * table, so the test seeds the probe user as `role='team_lead'` and sets
 * the Clerk per-request test seam (__test_clerkUserId) before the router
 * registers requireAuth (same pattern as tests/booking-am-overrides.test.ts).
 *
 * Process state: the test temporarily flips
 * `BLOCKED_IP_AUDIT_MAX_PER_IP_KEY` and `BLOCKED_EVENTS_RETENTION_MS`.
 * Both are snapshotted at startup and restored in `finally` so we leave
 * the dev server's in-memory caches and the system_settings row exactly
 * how we found them.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type Request, type Response, type NextFunction } from "express";
import type { AddressInfo } from "net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  ensureBlockedRateLimitEventsTable,
  insertBlockedRateLimitEvent,
} from "../server/storage/blockedRateLimitEventsStorage";
import {
  getBlockedEventsRetentionMs,
  setBlockedEventsRetentionMs,
} from "../server/services/rateLimitMonitor";
import {
  BLOCKED_IP_AUDIT_KEY,
  BLOCKED_IP_AUDIT_TRIMMED_KEY,
  BLOCKED_IP_AUDIT_MAX_PER_IP_KEY,
  pruneBlockedIpAuditNow,
} from "../server/services/auditRetention";
import {
  ensureAdminSettingAuditTable,
  recordAdminSettingChange,
  listAdminSettingAudit,
  setSystemSetting,
  getSystemSetting,
} from "../server/storage/settingsStorage";
import { registerBlockedEventsRetentionAdminRoutes } from "../server/routes/blockedEventsRetentionAdmin";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `bert-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `actor-${TAG}`;
const TEST_IP = `203.0.113.${(Math.floor(Math.random() * 200) + 10)}`;
const OTHER_IP = `203.0.113.${(Math.floor(Math.random() * 200) + 210) % 254}`;
const EVENT_CATEGORY = `cat-${TAG}`;

let baseUrl = "";
let server: import("node:http").Server | null = null;

async function ensureUser(): Promise<void> {
  // requireTeamLead pulls the user row and checks role >= team_lead.
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES (${ACTOR_ID}, ${`${ACTOR_ID}@example.com`}, 'Retention', 'Tester', 'team_lead')
    ON CONFLICT (id) DO UPDATE SET role = 'team_lead'
  `);
}

async function cleanup(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  try {
    await db.execute(sql`
      DELETE FROM admin_setting_audit
      WHERE setting_key IN (${BLOCKED_IP_AUDIT_KEY}, ${BLOCKED_IP_AUDIT_TRIMMED_KEY})
        AND scope IN (${TEST_IP}, ${OTHER_IP})
    `);
    await db.execute(sql`
      DELETE FROM admin_setting_audit WHERE changed_by = ${ACTOR_ID}
    `);
    await db.execute(sql`
      DELETE FROM blocked_rate_limit_events WHERE category = ${EVENT_CATEGORY}
    `);
    await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`);
  } catch {}
}

function buildTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Clerk test seam (server/middlewares/requireAuth.ts): authenticate as the
  // seeded committed public-schema `users` row; requireTeamLead then looks up
  // the role from that row.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).__test_clerkUserId = ACTOR_ID;
    next();
  });
  registerBlockedEventsRetentionAdminRoutes(app);
  return app;
}

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await ensureBlockedRateLimitEventsTable();
  await ensureAdminSettingAuditTable();
  await ensureUser();
  await cleanup();
  await ensureUser();

  // Snapshot process-wide state we will mutate so we restore it in
  // `finally`. The cap setting is loaded by every queue / route that
  // imports auditRetention; leaving it flipped would silently break
  // any other test (or the dev server itself) that runs afterwards.
  const originalRetentionMs = getBlockedEventsRetentionMs();
  const originalCapSetting = await getSystemSetting(BLOCKED_IP_AUDIT_MAX_PER_IP_KEY);
  const originalCapValue: string | null = originalCapSetting?.value ?? null;

  try {
    const app = buildTestApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // ── (1) PUT confirmation flow ────────────────────────────────────────
    const HIGH_MS = 30 * 24 * 60 * 60 * 1000;
    const LOW_MS = 1 * 24 * 60 * 60 * 1000;
    await setBlockedEventsRetentionMs(HIGH_MS, ACTOR_ID);
    assert(getBlockedEventsRetentionMs() === HIGH_MS, "retention should be set to 30d for the test");

    // Seed two old blocked events that fall outside the 1d window.
    const now = Date.now();
    const TWO_DAYS_AGO = now - 2 * 24 * 60 * 60 * 1000;
    const FIVE_DAYS_AGO = now - 5 * 24 * 60 * 60 * 1000;
    for (const t of [TWO_DAYS_AGO, FIVE_DAYS_AGO]) {
      await insertBlockedRateLimitEvent({
        timestamp: t, category: EVENT_CATEGORY,
        method: "GET", path: `/test/${TAG}`, ip: TEST_IP, userId: null,
      });
    }

    // Without confirm → 409 with affectedRows preview.
    const without = await http("PUT", "/api/health/rate-limits/blocked-events-retention", {
      retentionMs: LOW_MS,
    });
    assert(without.status === 409,
      `shortening without confirm should be 409, got ${without.status} body=${JSON.stringify(without.body)}`);
    assert(without.body?.error === "confirmation_required",
      `expected error="confirmation_required", got ${without.body?.error}`);
    assert(without.body?.requiresConfirm === true, "expected requiresConfirm:true");
    assert(typeof without.body?.affectedRows === "number" && without.body.affectedRows >= 2,
      `affectedRows should include our two seeded old rows, got ${without.body?.affectedRows}`);
    assert(without.body?.currentRetentionMs === HIGH_MS, "currentRetentionMs should echo old value");
    assert(without.body?.retentionMs === LOW_MS, "retentionMs should echo requested value");
    assert(getBlockedEventsRetentionMs() === HIGH_MS,
      "retention must not change when confirm is omitted");

    // With confirm:true → 200 and the value is applied.
    const withConfirm = await http("PUT", "/api/health/rate-limits/blocked-events-retention", {
      retentionMs: LOW_MS, confirm: true,
    });
    assert(withConfirm.status === 200,
      `shortening with confirm:true should be 200, got ${withConfirm.status} body=${JSON.stringify(withConfirm.body)}`);
    assert(withConfirm.body?.retentionMs === LOW_MS,
      `body.retentionMs should be ${LOW_MS}, got ${withConfirm.body?.retentionMs}`);
    assert(getBlockedEventsRetentionMs() === LOW_MS,
      "retention should now be the shortened value");

    // ── (2) Per-IP trim audit rows ───────────────────────────────────────
    await setSystemSetting(BLOCKED_IP_AUDIT_MAX_PER_IP_KEY, "2", ACTOR_ID);
    for (let i = 0; i < 4; i++) {
      await recordAdminSettingChange({
        settingKey: BLOCKED_IP_AUDIT_KEY, scope: TEST_IP,
        changedBy: ACTOR_ID, oldValues: null, newValues: { i, kind: "block" },
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    // Other IP stays UNDER cap → must NOT generate a trim row.
    for (let i = 0; i < 1; i++) {
      await recordAdminSettingChange({
        settingKey: BLOCKED_IP_AUDIT_KEY, scope: OTHER_IP,
        changedBy: ACTOR_ID, oldValues: null, newValues: { i, kind: "block" },
      });
    }

    // Wipe any pre-existing trim entries from prior runs scoped to TEST_IP.
    await db.execute(sql`
      DELETE FROM admin_setting_audit
      WHERE setting_key = ${BLOCKED_IP_AUDIT_TRIMMED_KEY} AND scope = ${TEST_IP}
    `);

    const prunedCount = await pruneBlockedIpAuditNow();
    assert(prunedCount >= 2,
      `expected >=2 blocked_ip rows to be pruned for TEST_IP (4 seeded, cap 2), got ${prunedCount}`);

    const trimRows = await listAdminSettingAudit({
      settingKey: BLOCKED_IP_AUDIT_TRIMMED_KEY,
      scope: TEST_IP,
      limit: 10,
    });
    assert(trimRows.length === 1,
      `expected exactly one blocked_ip_audit_trimmed row for TEST_IP, got ${trimRows.length}`);
    const trim = trimRows[0];
    assert(trim.settingKey === BLOCKED_IP_AUDIT_TRIMMED_KEY, "trim row settingKey mismatch");
    assert(trim.scope === TEST_IP, `trim row scope should equal TEST_IP, got ${trim.scope}`);
    const newVals = trim.newValues as any;
    assert(newVals && typeof newVals.trimmedCount === "number" && newVals.trimmedCount >= 2,
      `trim row newValues.trimmedCount should be >=2, got ${JSON.stringify(newVals)}`);
    assert(newVals.cap === 2, `trim row newValues.cap should be 2, got ${newVals.cap}`);

    const otherTrimRows = await listAdminSettingAudit({
      settingKey: BLOCKED_IP_AUDIT_TRIMMED_KEY,
      scope: OTHER_IP,
      limit: 10,
    });
    assert(otherTrimRows.length === 0,
      `OTHER_IP was under cap; should have no trim rows, got ${otherTrimRows.length}`);

    // ── (3) Merged blocked-IP history is changedAt-desc ──────────────────
    const r = await http("GET", `/api/health/blocked-ips/${TEST_IP}/history?limit=25`);
    assert(r.status === 200, `history endpoint should be 200, got ${r.status}`);
    const history = r.body?.history;
    assert(Array.isArray(history), "history should be an array");
    const mine = history.filter((h: any) => h.scope === TEST_IP);
    assert(mine.length >= 3,
      `expected at least 3 merged entries (2 blocked_ip + 1 trim) scoped to TEST_IP, got ${mine.length}`);

    const kinds = new Set(mine.map((h: any) => h.settingKey));
    assert(kinds.has(BLOCKED_IP_AUDIT_KEY),
      `merged history should include ${BLOCKED_IP_AUDIT_KEY} entries`);
    assert(kinds.has(BLOCKED_IP_AUDIT_TRIMMED_KEY),
      `merged history should include ${BLOCKED_IP_AUDIT_TRIMMED_KEY} entries`);

    for (let i = 1; i < mine.length; i++) {
      const prev = new Date(mine[i - 1].changedAt as any).getTime();
      const cur = new Date(mine[i].changedAt as any).getTime();
      assert(prev >= cur,
        `merged history must be changedAt-desc; index ${i - 1}=${prev} < ${i}=${cur}`);
    }

    // The trim row was inserted AFTER the surviving blocked_ip rows
    // (the prune ran last), so it must appear at or near the top.
    const trimEntryIdx = mine.findIndex((h: any) => h.settingKey === BLOCKED_IP_AUDIT_TRIMMED_KEY);
    const firstBlockedIdx = mine.findIndex((h: any) => h.settingKey === BLOCKED_IP_AUDIT_KEY);
    assert(trimEntryIdx >= 0 && firstBlockedIdx >= 0,
      "should find both kinds of entries in merged history");
    assert(trimEntryIdx <= firstBlockedIdx,
      `trim entry (idx ${trimEntryIdx}) should be sorted before/with surviving blocked_ip entry (idx ${firstBlockedIdx})`);

    // Bonus: the response also surfaces the retention block (cap, source,
    // truncated, etc.) — make sure the real router populated it. The
    // assertions stay loose so unrelated changes to the block shape
    // don't tip this test over.
    const retention = r.body?.retention;
    assert(retention && typeof retention === "object",
      "history response should include a `retention` block");
    assert(retention.cap === 2, `retention.cap should reflect the active cap (2), got ${retention.cap}`);
    assert(retention.trimmedConfirmed === true,
      "retention.trimmedConfirmed should be true after a trim row is recorded");
    assert(retention.truncated === true,
      "retention.truncated should be true once trim is confirmed");

    console.log("blocked-events-retention-confirm-and-trim: PASSED");
  } finally {
    // Restore process-wide state so we leave the dev server exactly as
    // we found it. Order matters: restore cap first (via the same
    // setSystemSetting helper the route would use, or a direct DELETE
    // when the row didn't exist before), then retention.
    try {
      if (originalCapValue === null) {
        await deleteSystemSetting(BLOCKED_IP_AUDIT_MAX_PER_IP_KEY);
      } else {
        await setSystemSetting(BLOCKED_IP_AUDIT_MAX_PER_IP_KEY, originalCapValue, ACTOR_ID);
      }
    } catch {}
    try { await setBlockedEventsRetentionMs(originalRetentionMs, ACTOR_ID); } catch {}
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("blocked-events-retention-confirm-and-trim: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
