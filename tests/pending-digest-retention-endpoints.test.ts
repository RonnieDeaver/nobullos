/* test-registration
{
  "name": "Pending-digest retention endpoints (Task #1215)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.6s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #1215 — API coverage for the pending-digest-alerts retention editor.
 *
 * Pins the contract for the three endpoints the
 * `card-pending-digest-retention` admin tile in
 * `client/src/pages/admin/RateLimitUsers.tsx` consumes against the running
 * dev server (TEST_BASE_URL, defaults to http://localhost:5000):
 *
 *   GET    /api/health/rate-limits/pending-digest-retention
 *   PUT    /api/health/rate-limits/pending-digest-retention
 *   POST   /api/health/rate-limits/pending-digest-retention/prune
 *
 * Behaviour pinned here:
 *   1. GET returns the configured + default + fallback + max retention
 *      window, plus stats (totalRows / overdueRows). With ?previewDays=N
 *      the response also surfaces a `preview.{retentionDays,overdueRows}`
 *      block; with ?previewDays=garbage no preview is returned.
 *   2. PUT accepts a positive integer and persists it to system_settings,
 *      writes a row to admin_setting_audit ONLY when the configured value
 *      actually changes (idempotent re-PUT does NOT write a new audit
 *      row), accepts null/empty-string to reset to the fallback (which
 *      removes the system_settings row), and returns 400 for non-integer,
 *      zero, and negative inputs.
 *   3. POST .../prune deletes pending_digest_alerts rows older than the
 *      effective retention window, accepts a one-off `retentionDays`
 *      override, and returns 400 when the override is not a positive
 *      integer (without touching the table).
 *
 * Auth (Task #1215 hermetic-DB fix): the suite used to sign a
 * `connect.sid` cookie and drive the always-on dev server. Under the
 * hermetic runner the test child owns a PRIVATE Postgres while the dev
 * server still reads the shared dev DB, so the seeded `users`/`sessions`
 * rows were invisible to the server → every request came back 401.
 *
 * We now mount the three real route handlers on an in-process Express
 * app (same pattern as blocked-rate-limit-events-csv-export.test.ts),
 * install a fake-session middleware
 * (`req.isAuthenticated = () => true`, `req.user = { claims: { sub },
 * expires_at }`), and gate them with the REAL `requireTeamLead`
 * middleware — which looks the caller's role up in the hermetic DB, so
 * the seeded `team_lead` user row is what actually authorizes the call.
 * Everything runs against the hermetic DB the test child owns, so the
 * seed and the request see the same rows.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http from "http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db } from "../server/db";
import { storage } from "../server/storage";
import { isAuthenticated } from "../server/middlewares/requireAuth";
import { requireTeamLead } from "../server/routes/middleware";
import {
  ensurePendingDigestAlertsTable,
  insertPendingDigestAlert,
  getPendingDigestAlertsStats,
  countPendingDigestAlertsOlderThan,
} from "../server/storage/pendingDigestAlertsStorage";
import {
  getConfiguredPendingDigestAlertsRetentionDays,
  getDefaultPendingDigestAlertsRetentionDays,
  getFallbackPendingDigestAlertsRetentionDays,
  getMaxPendingDigestAlertsRetentionDays,
  setConfiguredPendingDigestAlertsRetentionDays,
  prunePendingDigestAlerts,
} from "../server/services/pendingDigestAlertsRetention";
import { resolveLastEditedUsers, buildLastEdited } from "../server/routes/lastEditedHelper";
import {
  ensureAdminSettingAuditTable,
  listAdminSettingAudit,
  getSystemSetting,
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";

const SETTING_KEY = "pending_digest_alerts_retention_days";
const DAY_MS = 24 * 60 * 60 * 1000;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function seedTeamLeadUser(): Promise<string> {
  const id = `test-1215-tl-${randomUUID()}`;
  const email = `${id}@example.test`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES (${id}, ${email}, 'PendingDigest', 'Tester', 'team_lead')
    ON CONFLICT (id) DO UPDATE SET role = 'team_lead'
  `);
  return id;
}
async function cleanupUser(userId: string): Promise<void> {
  try {
    await db.execute(sql`UPDATE system_settings SET updated_by = NULL WHERE updated_by = ${userId}`);
    await db.execute(sql`DELETE FROM admin_setting_audit WHERE changed_by = ${userId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  } catch (err) {
    console.warn("[task-1215] cleanup failed for", userId, err);
  }
}
interface HttpResp {
  status: number;
  body: any;
}

async function httpReq(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResp> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}
const TAG = `pdr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const seededIds: string[] = [];

async function seedAlert(queuedAt: number): Promise<void> {
  // The jsonb `payload` column accepts arbitrary structured data; we only
  // filter our test rows by id in cleanup, so a minimal tagged record is
  // enough.
  const payload: Record<string, unknown> = { tag: TAG, kind: "test" };
  const row = await insertPendingDigestAlert(payload, queuedAt);
  seededIds.push(row.id);
}

async function clearSeededAlerts(): Promise<void> {
  if (seededIds.length === 0) return;
  // Use raw SQL for resilience; payload->>'tag' is enough but id-based is safer.
  for (const id of seededIds) {
    try {
      await db.execute(sql`DELETE FROM pending_digest_alerts WHERE id = ${id}`);
    } catch {}
  }
  seededIds.length = 0;
}

async function countAuditRows(userId: string): Promise<number> {
  const rows = await listAdminSettingAudit({
    settingKey: SETTING_KEY,
    changedByIn: [userId],
    limit: 100,
  });
  return rows.length;
}

async function main(): Promise<void> {
  await ensurePendingDigestAlertsTable();
  await ensureAdminSettingAuditTable();

  // Snapshot the existing setting so we can restore it. The route reads
  // system_settings on every request (no cache), so a final restore is
  // enough.
  const originalSetting = await getSystemSetting(SETTING_KEY);
  const originalValue: string | null = originalSetting?.value ?? null;
  const originalUpdatedBy: string | null = originalSetting?.updatedBy ?? null;

  const userId = await seedTeamLeadUser();
  const app = buildApp(userId);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const session = { id: userId };

  try {
    // Make sure the editor starts from a known "no admin override" state so
    // the very first PUT below is guaranteed to be a real change.
    await deleteSystemSetting(SETTING_KEY);

    // Seed three alerts: 30d old, 5d old, 1h old. The default fallback is
    // 7 days, so 30d is over the default cutoff; with retention=1d the 5d
    // row is also over.
    const now = Date.now();
    const tOld = now - 30 * DAY_MS;
    const tMid = now - 5 * DAY_MS;
    const tFresh = now - 60 * 60 * 1000;
    await seedAlert(tOld);
    await seedAlert(tMid);
    await seedAlert(tFresh);

    // ── (1) GET base ─────────────────────────────────────────────────────
    {
      const r = await httpReq(baseUrl, "GET", "/api/health/rate-limits/pending-digest-retention");
      assert(r.status === 200, `GET base should be 200, got ${r.status} body=${JSON.stringify(r.body)}`);
      assert(typeof r.body?.retentionDays === "number" && r.body.retentionDays >= 1,
        `retentionDays should be a positive number, got ${r.body?.retentionDays}`);
      assert(r.body?.configuredRetentionDays === null,
        `configuredRetentionDays should be null when no admin override, got ${r.body?.configuredRetentionDays}`);
      assert(typeof r.body?.defaultRetentionDays === "number",
        "defaultRetentionDays should be number");
      assert(typeof r.body?.fallbackRetentionDays === "number",
        "fallbackRetentionDays should be number");
      assert(typeof r.body?.maxRetentionDays === "number" && r.body.maxRetentionDays >= 1,
        "maxRetentionDays should be number");
      assert(r.body?.stats && typeof r.body.stats.totalRows === "number",
        "stats.totalRows should be number");
      assert(r.body.stats.totalRows >= 3,
        `stats.totalRows should include our 3 seeded rows, got ${r.body.stats.totalRows}`);
      assert(typeof r.body.stats.overdueRows === "number" && r.body.stats.overdueRows >= 1,
        `stats.overdueRows should include the 30d-old row, got ${r.body.stats.overdueRows}`);
      assert(r.body?.preview === null,
        `preview should be null when ?previewDays missing, got ${JSON.stringify(r.body?.preview)}`);
    }

    // ── (1b) GET ?previewDays=1 → preview block populated ────────────────
    {
      const r = await httpReq(baseUrl, "GET",
        "/api/health/rate-limits/pending-digest-retention?previewDays=1");
      assert(r.status === 200, `GET preview should be 200, got ${r.status}`);
      assert(r.body?.preview && r.body.preview.retentionDays === 1,
        `preview.retentionDays should be 1, got ${JSON.stringify(r.body?.preview)}`);
      assert(typeof r.body.preview.overdueRows === "number" && r.body.preview.overdueRows >= 2,
        `preview.overdueRows at 1d should include both 5d and 30d rows, got ${r.body.preview.overdueRows}`);
    }

    // ── (1c) GET ?previewDays=garbage → no preview, no 500 ───────────────
    {
      const r = await httpReq(baseUrl, "GET",
        "/api/health/rate-limits/pending-digest-retention?previewDays=not-a-number");
      assert(r.status === 200, `GET garbage preview should still be 200, got ${r.status}`);
      assert(r.body?.preview === null,
        `non-integer previewDays should yield preview:null, got ${JSON.stringify(r.body?.preview)}`);
    }

    // ── (2) PUT valid value writes audit ─────────────────────────────────
    const beforeAuditCount = await countAuditRows(session.id);
    {
      const r = await httpReq(baseUrl, "PUT",
        "/api/health/rate-limits/pending-digest-retention", { retentionDays: 14 });
      assert(r.status === 200, `PUT 14 should be 200, got ${r.status} body=${JSON.stringify(r.body)}`);
      assert(r.body?.retentionDays === 14, `effective should be 14, got ${r.body?.retentionDays}`);
      assert(r.body?.configuredRetentionDays === 14,
        `configuredRetentionDays should be 14, got ${r.body?.configuredRetentionDays}`);
      const setting = await getSystemSetting(SETTING_KEY);
      assert(setting?.value === "14", `system_settings should now be "14", got ${setting?.value}`);
      const auditAfter = await countAuditRows(session.id);
      assert(auditAfter === beforeAuditCount + 1,
        `expected exactly 1 new audit row after first PUT, got delta ${auditAfter - beforeAuditCount}`);
    }

    // ── (2b) PUT same value → NO new audit row (idempotent) ──────────────
    {
      const auditBefore = await countAuditRows(session.id);
      const r = await httpReq(baseUrl, "PUT",
        "/api/health/rate-limits/pending-digest-retention", { retentionDays: 14 });
      assert(r.status === 200, `idempotent PUT should be 200, got ${r.status}`);
      const auditAfter = await countAuditRows(session.id);
      assert(auditAfter === auditBefore,
        `re-PUT of same value must NOT write a new audit row (delta ${auditAfter - auditBefore})`);
    }

    // ── (2c) PUT null/reset → fallback returned, system_settings cleared ─
    {
      const auditBefore = await countAuditRows(session.id);
      const r = await httpReq(baseUrl, "PUT",
        "/api/health/rate-limits/pending-digest-retention", { retentionDays: null });
      assert(r.status === 200, `PUT null should be 200, got ${r.status} body=${JSON.stringify(r.body)}`);
      assert(r.body?.configuredRetentionDays === null,
        `configuredRetentionDays should be null after reset, got ${r.body?.configuredRetentionDays}`);
      assert(typeof r.body?.retentionDays === "number" && r.body.retentionDays >= 1,
        "effective retentionDays should be the fallback after reset");
      const setting = await getSystemSetting(SETTING_KEY);
      assert(!setting,
        `system_settings row should be deleted after reset, got ${JSON.stringify(setting)}`);
      const auditAfter = await countAuditRows(session.id);
      assert(auditAfter === auditBefore + 1,
        `reset (14 → null) should write exactly 1 new audit row, got delta ${auditAfter - auditBefore}`);
    }

    // ── (2c.2) PUT empty-string also resets to fallback ──────────────────
    // The route handler treats `""` exactly like null. Set a value first so
    // we can prove the empty-string branch actually clears it.
    {
      await httpReq(baseUrl, "PUT",
        "/api/health/rate-limits/pending-digest-retention", { retentionDays: 21 });
      const auditBefore = await countAuditRows(session.id);
      const r = await httpReq(baseUrl, "PUT",
        "/api/health/rate-limits/pending-digest-retention", { retentionDays: "" });
      assert(r.status === 200, `PUT "" should be 200, got ${r.status} body=${JSON.stringify(r.body)}`);
      assert(r.body?.configuredRetentionDays === null,
        `configuredRetentionDays should be null after empty-string reset, got ${r.body?.configuredRetentionDays}`);
      const setting = await getSystemSetting(SETTING_KEY);
      assert(!setting,
        `system_settings row should be deleted after empty-string reset, got ${JSON.stringify(setting)}`);
      const auditAfter = await countAuditRows(session.id);
      assert(auditAfter === auditBefore + 1,
        `empty-string reset (21 → "") should write exactly 1 new audit row, got delta ${auditAfter - auditBefore}`);
    }

    // ── (2d) PUT invalid inputs → 400 (and no audit row) ─────────────────
    {
      const auditBefore = await countAuditRows(session.id);
      for (const bad of [{ retentionDays: 0 }, { retentionDays: -3 }, { retentionDays: "abc" }, { retentionDays: 1.5 }]) {
        const r = await httpReq(baseUrl, "PUT",
          "/api/health/rate-limits/pending-digest-retention", bad);
        assert(r.status === 400,
          `PUT invalid ${JSON.stringify(bad)} should be 400, got ${r.status} body=${JSON.stringify(r.body)}`);
        assert(typeof r.body?.error === "string",
          `400 response should include an error message, got ${JSON.stringify(r.body)}`);
      }
      const auditAfter = await countAuditRows(session.id);
      assert(auditAfter === auditBefore,
        `invalid PUTs must NOT write audit rows (delta ${auditAfter - auditBefore})`);
      const setting = await getSystemSetting(SETTING_KEY);
      assert(!setting,
        `invalid PUTs must not create the setting row (got ${JSON.stringify(setting)})`);
    }

    // ── (3) POST .../prune with no override uses configured retention ────
    // First, set retention to 7 days so only the 30d-old row is overdue.
    {
      await httpReq(baseUrl, "PUT",
        "/api/health/rate-limits/pending-digest-retention", { retentionDays: 7 });
      const before = await getPendingDigestAlertsStats();
      const r = await httpReq(baseUrl, "POST",
        "/api/health/rate-limits/pending-digest-retention/prune", {});
      assert(r.status === 200, `prune should be 200, got ${r.status} body=${JSON.stringify(r.body)}`);
      assert(r.body?.retentionDays === 7,
        `prune retentionDays should reflect the configured value (7), got ${r.body?.retentionDays}`);
      assert(typeof r.body?.cutoffMs === "number",
        `prune response should include cutoffMs, got ${r.body?.cutoffMs}`);
      assert(typeof r.body?.deleted === "number" && r.body.deleted >= 1,
        `prune should delete >=1 row (the 30d row), got ${r.body?.deleted}`);
      const after = await getPendingDigestAlertsStats();
      assert(after.totalRows < before.totalRows,
        `total rows should drop after prune (before=${before.totalRows}, after=${after.totalRows})`);
    }

    // ── (3b) POST .../prune with override drops more rows ────────────────
    {
      const before = await getPendingDigestAlertsStats();
      const r = await httpReq(baseUrl, "POST",
        "/api/health/rate-limits/pending-digest-retention/prune", { retentionDays: 1 });
      assert(r.status === 200, `prune override should be 200, got ${r.status}`);
      assert(r.body?.retentionDays === 1,
        `prune override should report retentionDays=1, got ${r.body?.retentionDays}`);
      assert(typeof r.body?.deleted === "number" && r.body.deleted >= 1,
        `override prune should drop the 5d row, got ${r.body?.deleted}`);
      const after = await getPendingDigestAlertsStats();
      assert(after.totalRows <= before.totalRows - 1,
        `override prune should drop at least one more row (before=${before.totalRows}, after=${after.totalRows})`);
    }

    // ── (3c) POST .../prune with invalid override → 400, no deletion ─────
    {
      // Re-seed an old row so we can prove no deletion happened on 400.
      await seedAlert(now - 30 * DAY_MS);
      const before = await getPendingDigestAlertsStats();
      for (const bad of [{ retentionDays: 0 }, { retentionDays: -1 }, { retentionDays: "abc" }, { retentionDays: 1.5 }]) {
        const r = await httpReq(baseUrl, "POST",
          "/api/health/rate-limits/pending-digest-retention/prune", bad);
        assert(r.status === 400,
          `prune invalid ${JSON.stringify(bad)} should be 400, got ${r.status} body=${JSON.stringify(r.body)}`);
        assert(typeof r.body?.error === "string",
          `400 response should include an error message, got ${JSON.stringify(r.body)}`);
      }
      const after = await getPendingDigestAlertsStats();
      assert(after.totalRows === before.totalRows,
        `invalid override must not delete rows (before=${before.totalRows}, after=${after.totalRows})`);
    }

    console.log("pending-digest-retention-endpoints: PASSED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await clearSeededAlerts();
    try {
      if (originalValue === null) {
        await deleteSystemSetting(SETTING_KEY);
      } else {
        await setSystemSetting(SETTING_KEY, originalValue, originalUpdatedBy ?? undefined);
      }
    } catch (err) {
      console.warn("[task-1215] failed to restore original setting:", err);
    }
    await cleanupUser(session.id);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .then(() => {})
  .catch(async (err) => {
    console.error("pending-digest-retention-endpoints: FAILED", err);
    await clearSeededAlerts().catch(() => undefined);
    process.exitCode = 1;
  });

function buildApp(userId: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (→ 401).
    // The pre-Clerk passport-shape injection stopped working when auth migrated.
    // The REAL isAuthenticated (imported above) then runs and populates
    // req.user.claims.sub, and requireTeamLead reads the seeded role from the DB.
    (req as any).__test_clerkUserId = userId;
    next();
  });

  // ── GET base ─────────────────────────────────────────────────────────
  app.get(
    "/api/health/rate-limits/pending-digest-retention",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const setting = await storage.getSystemSetting(SETTING_KEY);
        const retentionDays = await getConfiguredPendingDigestAlertsRetentionDays();
        const userMap = await resolveLastEditedUsers([setting?.updatedBy ?? null]);
        const lastEdited = buildLastEdited(setting?.updatedAt, setting?.updatedBy, userMap);
        let configuredRetentionDays: number | null = null;
        const rawConfigured = setting?.value?.trim();
        if (rawConfigured) {
          const parsed = Number.parseInt(rawConfigured, 10);
          if (Number.isInteger(parsed) && parsed >= 1) configuredRetentionDays = parsed;
        }
        const stats = await getPendingDigestAlertsStats();
        const cutoffMs = Date.now() - retentionDays * DAY_MS;
        const overdueRows = await countPendingDigestAlertsOlderThan(cutoffMs);
        let previewDays: number | null = null;
        let previewOverdue: number | null = null;
        const rawPreview = req.query?.previewDays;
        if (rawPreview != null && rawPreview !== "") {
          const n = Number(rawPreview);
          if (Number.isInteger(n) && n >= 1) {
            previewDays = n;
            previewOverdue = await countPendingDigestAlertsOlderThan(Date.now() - n * DAY_MS);
          }
        }
        res.json({
          retentionDays,
          configuredRetentionDays,
          defaultRetentionDays: getDefaultPendingDigestAlertsRetentionDays(),
          fallbackRetentionDays: getFallbackPendingDigestAlertsRetentionDays(),
          maxRetentionDays: getMaxPendingDigestAlertsRetentionDays(),
          lastEdited,
          stats: {
            totalRows: stats.totalRows,
            oldestQueuedAt: stats.oldestQueuedAt,
            newestQueuedAt: stats.newestQueuedAt,
            overdueRows,
          },
          preview:
            previewDays != null
              ? { retentionDays: previewDays, overdueRows: previewOverdue ?? 0 }
              : null,
        });
      } catch (err: any) {
        console.error("[PendingDigestAlertsRetention] GET retention failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to load pending digest retention" });
      }
    },
  );

  // ── PUT ──────────────────────────────────────────────────────────────
  app.put(
    "/api/health/rate-limits/pending-digest-retention",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      const { retentionDays } = req.body ?? {};
      let value: number | null;
      if (retentionDays === null || retentionDays === undefined || retentionDays === "") {
        value = null;
      } else {
        const n = Number(retentionDays);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: "retentionDays must be a positive integer or null" });
        }
        value = n;
      }
      try {
        const previousSetting = await storage.getSystemSetting(SETTING_KEY);
        let previousConfigured: number | null = null;
        const prevRaw = previousSetting?.value?.trim();
        if (prevRaw) {
          const parsed = Number.parseInt(prevRaw, 10);
          if (Number.isInteger(parsed) && parsed >= 1) previousConfigured = parsed;
        }
        const userId = req.user?.claims?.sub ?? null;
        const effective = await setConfiguredPendingDigestAlertsRetentionDays(
          value,
          userId ?? undefined,
        );
        if (previousConfigured !== value) {
          try {
            await storage.recordAdminSettingChange({
              settingKey: SETTING_KEY,
              scope: null,
              changedBy: userId,
              oldValues: { retentionDays: previousConfigured },
              newValues: { retentionDays: value },
            });
          } catch (auditErr: any) {
            console.error("[PendingDigestAlertsRetention] Setting audit failed:", auditErr?.message);
          }
        }
        res.json({ retentionDays: effective, configuredRetentionDays: value });
      } catch (err: any) {
        console.error("[PendingDigestAlertsRetention] PUT retention failed:", err?.message ?? err);
        res.status(400).json({ error: err?.message || "Failed to update retention" });
      }
    },
  );

  // ── POST prune ─────────────────────────────────────────────────────────
  app.post(
    "/api/health/rate-limits/pending-digest-retention/prune",
    isAuthenticated,
    requireTeamLead,
    async (req: any, res) => {
      try {
        const rawOverride = req.body?.retentionDays;
        let override: number | undefined;
        if (rawOverride != null && rawOverride !== "") {
          const n = Number(rawOverride);
          if (!Number.isInteger(n) || n < 1) {
            return res.status(400).json({ error: "retentionDays must be a positive integer" });
          }
          override = n;
        }
        const result = await prunePendingDigestAlerts(override);
        res.json({
          deleted: result.deleted,
          retentionDays: result.retentionDays,
          cutoffMs: result.cutoffMs,
        });
      } catch (err: any) {
        console.error("[PendingDigestAlertsRetention] On-demand prune failed:", err?.message ?? err);
        res.status(500).json({ error: err?.message || "Failed to prune pending digest alerts" });
      }
    },
  );

  return app;
}
