/* test-registration
{
  "name": "Zoom guardrail-impact historical anchor (Task #1165)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.3s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Regression coverage for Task #1165: the historical-anchor override on the
 * Zoom guardrail-impact endpoint.
 *
 * The `/api/admin/zoom/guardrail-impact` route accepts an optional
 * `commonFirstNamesAnchorAuditId` query param. When supplied, the
 * `ZOOM_COMMON_FIRST_NAMES` per-key anchor must be the audit row's
 * `changedAt`. When omitted, it must fall back to
 * `system_settings.zoom_common_first_names.updatedAt` (i.e. the latest
 * change). Bad / wrong-key audit IDs must respond 400.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerAgentRoutes } from "../server/routes/agents";
import {
  ensureAdminSettingAuditTable,
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `gia-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `actor-${TAG}`;
const SETTING_KEY = "zoom_common_first_names";
const SYSTEM_SETTING_KEY = "ZOOM_COMMON_FIRST_NAMES";
const OTHER_KEY = `unrelated_setting_${TAG}`;

const OLDER_AT = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
const NEWER_AT = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);  // 3 days ago

let olderAuditId = "";
let newerAuditId = "";
let otherKeyAuditId = "";

async function ensureActorUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES (${ACTOR_ID}, ${`${ACTOR_ID}@example.com`}, 'Anchor', 'Tester', 'account_manager')
    ON CONFLICT (id) DO UPDATE SET role = 'account_manager'
  `);
}

async function seedAuditRow(settingKey: string, changedAt: Date): Promise<string> {
  const res: any = await db.execute(sql`
    INSERT INTO admin_setting_audit (setting_key, scope, changed_by, old_values, new_values, changed_at)
    VALUES (${settingKey}, NULL, ${ACTOR_ID}, ${'{"v":1}'}::jsonb, ${'{"v":2}'}::jsonb, ${changedAt})
    RETURNING id
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  const id = rows[0]?.id;
  if (!id) throw new Error("seedAuditRow: failed to obtain id");
  return String(id);
}

async function cleanup(): Promise<void> {
  for (const id of [olderAuditId, newerAuditId, otherKeyAuditId]) {
    if (!id) continue;
    try {
      await db.execute(sql`DELETE FROM admin_setting_audit WHERE id = ${id}`);
    } catch {}
  }
  try {
    await deleteSystemSetting(SYSTEM_SETTING_KEY);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`);
  } catch {}
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`);
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await ensureAdminSettingAuditTable();
  await ensureActorUser();

  // Seed system_settings row with updatedAt == NEWER_AT so the no-anchor
  // fallback is deterministic. The raw UPDATE pins `updated_at` to a
  // specific past timestamp — there's no public setter that takes a
  // timestamp, and `setSystemSetting` always stamps NOW(). Task #1855
  // out-of-scope: this raw SQL adjusts metadata only (not the value),
  // and the immediately-preceding `setSystemSetting` already
  // invalidated the cache, so the first cached read after this UPDATE
  // is a cache miss that reads NEWER_AT fresh from the DB.
  await setSystemSetting(SYSTEM_SETTING_KEY, JSON.stringify(["alex", "sam"]), ACTOR_ID);
  await db.execute(sql`
    UPDATE system_settings SET updated_at = ${NEWER_AT} WHERE key = ${SYSTEM_SETTING_KEY}
  `);

  olderAuditId = await seedAuditRow(SETTING_KEY, OLDER_AT);
  newerAuditId = await seedAuditRow(SETTING_KEY, NEWER_AT);
  otherKeyAuditId = await seedAuditRow(OTHER_KEY, OLDER_AT);

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = ACTOR_ID;
    next();
  });
  await registerAgentRoutes(app as any);
  const { server, baseUrl } = await listen(app);

  try {
    // (1) With ?commonFirstNamesAnchorAuditId=<older>, anchor matches OLDER_AT.
    const overridden = await getJson(
      baseUrl,
      `/api/admin/zoom/guardrail-impact?commonFirstNamesAnchorAuditId=${olderAuditId}`,
    );
    assert(overridden.status === 200,
      `override request expected 200, got ${overridden.status} body=${JSON.stringify(overridden.body)}`);
    const overriddenAnchor = overridden.body?.perKey?.ZOOM_COMMON_FIRST_NAMES?.anchor;
    assert(overriddenAnchor === OLDER_AT.toISOString(),
      `expected anchor=${OLDER_AT.toISOString()} when overriding to older audit, got ${overriddenAnchor}`);

    // (2) Omitting the param falls back to system_settings.updatedAt (NEWER_AT).
    const fallback = await getJson(baseUrl, `/api/admin/zoom/guardrail-impact`);
    assert(fallback.status === 200,
      `fallback request expected 200, got ${fallback.status} body=${JSON.stringify(fallback.body)}`);
    const fallbackAnchor = fallback.body?.perKey?.ZOOM_COMMON_FIRST_NAMES?.anchor;
    assert(fallbackAnchor === NEWER_AT.toISOString(),
      `expected fallback anchor=${NEWER_AT.toISOString()} (system_settings.updatedAt), got ${fallbackAnchor}`);
    assert(fallbackAnchor !== OLDER_AT.toISOString(),
      `fallback anchor must differ from the older audit row's changedAt`);

    // (3) Unknown / malformed audit id → 400.
    const bogus = await getJson(
      baseUrl,
      `/api/admin/zoom/guardrail-impact?commonFirstNamesAnchorAuditId=00000000-0000-0000-0000-000000000000`,
    );
    assert(bogus.status === 400,
      `unknown audit id expected 400, got ${bogus.status} body=${JSON.stringify(bogus.body)}`);

    // (4) Audit id pointing at a different settingKey → 400.
    const wrongKey = await getJson(
      baseUrl,
      `/api/admin/zoom/guardrail-impact?commonFirstNamesAnchorAuditId=${otherKeyAuditId}`,
    );
    assert(wrongKey.status === 400,
      `wrong-key audit id expected 400, got ${wrongKey.status} body=${JSON.stringify(wrongKey.body)}`);

    console.log("zoom-guardrail-impact-anchor: PASSED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup().catch(() => undefined);
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().then(() => {}).catch(async (err) => {
  console.error("zoom-guardrail-impact-anchor: FAILED", err);
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
