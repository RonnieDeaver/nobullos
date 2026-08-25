/* test-registration
{
  "name": "Blocked-IP history retention truncated flag (Task #1236)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for the `retention` block on
 * GET /api/health/blocked-ips/:ip/history.
 *
 * Task #781 pinned the merge ordering of `blocked_ip` and
 * `blocked_ip_audit_trimmed` rows. The truncation-flag math on the
 * same endpoint — `cap`, `shownBlockedIpEntries`, `totalBlockedIpEntries`,
 * `trimmedTotal`, `trimmedConfirmed`, `atCap`, and `truncated` — drives
 * the "history was trimmed" banner in the admin UI and was previously
 * uncovered. This test pins it from two angles so a regression that
 * hides the banner can't slip through:
 *
 *   1. A scope seeded beyond the cap (and then pruned) reports
 *      `atCap:true`, `truncated:true`, `trimmedConfirmed:true`, and a
 *      non-zero `trimmedTotal`.
 *   2. A scope seeded under the cap (no prune fires for it) reports
 *      `atCap:false`, `truncated:false`, `trimmedConfirmed:false`, and
 *      `trimmedTotal === 0`.
 *
 * Auth follows the same Clerk per-request test seam used by
 * tests/blocked-events-retention-confirm-and-trim.test.ts so the
 * `requireTeamLead` middleware reads the seeded user's role.
 *
 * Process state: `BLOCKED_IP_AUDIT_MAX_PER_IP_KEY` is snapshotted at
 * startup and restored in `finally` so we don't leak the small cap into
 * the dev server's in-memory caches.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type Request, type Response, type NextFunction } from "express";
import type { AddressInfo } from "net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  BLOCKED_IP_AUDIT_KEY,
  BLOCKED_IP_AUDIT_TRIMMED_KEY,
  BLOCKED_IP_AUDIT_MAX_PER_IP_KEY,
  pruneBlockedIpAuditNow,
} from "../server/services/auditRetention";
import {
  ensureAdminSettingAuditTable,
  recordAdminSettingChange,
  setSystemSetting,
  getSystemSetting,
} from "../server/storage/settingsStorage";
import { registerBlockedEventsRetentionAdminRoutes } from "../server/routes/blockedEventsRetentionAdmin";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `bihr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `actor-${TAG}`;
// Two distinct IPs in the documentation/test-net block.
const FULL_IP = `198.51.100.${(Math.floor(Math.random() * 200) + 10)}`;
const UNDER_IP = `198.51.100.${(Math.floor(Math.random() * 40) + 215)}`;

let baseUrl = "";
let server: import("node:http").Server | null = null;

async function ensureUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES (${ACTOR_ID}, ${`${ACTOR_ID}@example.com`}, 'Truncated', 'Tester', 'team_lead')
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
        AND scope IN (${FULL_IP}, ${UNDER_IP})
    `);
    await db.execute(sql`
      DELETE FROM admin_setting_audit WHERE changed_by = ${ACTOR_ID}
    `);
    await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`);
  } catch {}
}

function buildTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam: authenticate as the seeded committed public-schema
    // `users` row; requireTeamLead reads the role from it.
    (req as any).__test_clerkUserId = ACTOR_ID;
    next();
  });
  registerBlockedEventsRetentionAdminRoutes(app);
  return app;
}

async function http(method: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, { method });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await ensureAdminSettingAuditTable();
  await ensureUser();
  await cleanup();
  await ensureUser();

  const originalCapSetting = await getSystemSetting(BLOCKED_IP_AUDIT_MAX_PER_IP_KEY);
  const originalCapValue: string | null = originalCapSetting?.value ?? null;

  try {
    const app = buildTestApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const CAP = 2;
    await setSystemSetting(BLOCKED_IP_AUDIT_MAX_PER_IP_KEY, String(CAP), ACTOR_ID);

    // ── Scope A: seed beyond the cap, prune to trigger trim row ─────────
    for (let i = 0; i < 4; i++) {
      await recordAdminSettingChange({
        settingKey: BLOCKED_IP_AUDIT_KEY, scope: FULL_IP,
        changedBy: ACTOR_ID, oldValues: null, newValues: { i, kind: "block" },
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    // ── Scope B: seed UNDER the cap (1 row) — no prune, no trim ─────────
    await recordAdminSettingChange({
      settingKey: BLOCKED_IP_AUDIT_KEY, scope: UNDER_IP,
      changedBy: ACTOR_ID, oldValues: null, newValues: { i: 0, kind: "block" },
    });

    // Wipe any stale trim rows from prior runs scoped to FULL_IP so the
    // trim-event counter starts at 0 for this run.
    await db.execute(sql`
      DELETE FROM admin_setting_audit
      WHERE setting_key = ${BLOCKED_IP_AUDIT_TRIMMED_KEY} AND scope = ${FULL_IP}
    `);

    const prunedCount = await pruneBlockedIpAuditNow();
    assert(prunedCount >= 2,
      `prune should remove >=2 rows for FULL_IP (4 seeded, cap ${CAP}), got ${prunedCount}`);

    // ── (1) Beyond-cap scope: truncated=true, atCap=true, trimmedTotal>0 ─
    const full = await http("GET", `/api/health/blocked-ips/${FULL_IP}/history?limit=25`);
    assert(full.status === 200,
      `FULL_IP history should be 200, got ${full.status} body=${JSON.stringify(full.body)}`);
    const fullRet = full.body?.retention;
    assert(fullRet && typeof fullRet === "object",
      "FULL_IP response must include a `retention` block");
    assert(fullRet.cap === CAP,
      `FULL_IP retention.cap should equal ${CAP}, got ${fullRet.cap}`);
    assert(fullRet.totalBlockedIpEntries === CAP,
      `FULL_IP retention.totalBlockedIpEntries should equal cap (${CAP}) after prune, got ${fullRet.totalBlockedIpEntries}`);
    assert(fullRet.atCap === true,
      `FULL_IP retention.atCap should be true (total ${fullRet.totalBlockedIpEntries} >= cap ${CAP})`);
    assert(fullRet.trimmedConfirmed === true,
      "FULL_IP retention.trimmedConfirmed should be true after a trim row is recorded");
    assert(typeof fullRet.trimmedTotal === "number" && fullRet.trimmedTotal >= 2,
      `FULL_IP retention.trimmedTotal should be >=2 (4 seeded - cap ${CAP}), got ${fullRet.trimmedTotal}`);
    assert(fullRet.truncated === true,
      "FULL_IP retention.truncated should be true once trim is confirmed");
    assert(typeof fullRet.shownBlockedIpEntries === "number" && fullRet.shownBlockedIpEntries <= CAP,
      `FULL_IP retention.shownBlockedIpEntries should be <= cap, got ${fullRet.shownBlockedIpEntries}`);

    // ── (2) Under-cap scope: truncated=false, atCap=false, trim*=0/false ─
    const under = await http("GET", `/api/health/blocked-ips/${UNDER_IP}/history?limit=25`);
    assert(under.status === 200,
      `UNDER_IP history should be 200, got ${under.status} body=${JSON.stringify(under.body)}`);
    const underRet = under.body?.retention;
    assert(underRet && typeof underRet === "object",
      "UNDER_IP response must include a `retention` block");
    assert(underRet.cap === CAP,
      `UNDER_IP retention.cap should equal ${CAP}, got ${underRet.cap}`);
    assert(underRet.totalBlockedIpEntries === 1,
      `UNDER_IP retention.totalBlockedIpEntries should equal 1 (under cap), got ${underRet.totalBlockedIpEntries}`);
    assert(underRet.atCap === false,
      `UNDER_IP retention.atCap should be false (total 1 < cap ${CAP}), got ${underRet.atCap}`);
    assert(underRet.trimmedConfirmed === false,
      `UNDER_IP retention.trimmedConfirmed should be false (no trim rows), got ${underRet.trimmedConfirmed}`);
    assert(underRet.trimmedTotal === 0,
      `UNDER_IP retention.trimmedTotal should be 0, got ${underRet.trimmedTotal}`);
    assert(underRet.truncated === false,
      `UNDER_IP retention.truncated should be false when neither atCap nor trimmedConfirmed is set, got ${underRet.truncated}`);

    console.log("blocked-ip-history-retention-truncated-flag: PASSED");
  } finally {
    try {
      if (originalCapValue === null) {
        await deleteSystemSetting(BLOCKED_IP_AUDIT_MAX_PER_IP_KEY);
      } else {
        await setSystemSetting(BLOCKED_IP_AUDIT_MAX_PER_IP_KEY, originalCapValue, ACTOR_ID);
      }
    } catch {}
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("blocked-ip-history-retention-truncated-flag: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
