/* test-registration
{
  "name": "Front outbound gap close unreadable alert config route (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #2236 — Cover the operator's corrupt-status alert tuning route.
 *
 * Task #2197 added a proactive admin alert when the Front outbound
 * gap-close driver's saved last-run status goes corrupt, with a cooldown
 * stored in `front_outbound_gap_close:unreadable_alert_cooldown_minutes`.
 * Task #2236 lets a team_lead / CEO see and tune that cooldown (or mute
 * the alert entirely) from the Front integration panel.
 *
 * This pins both surfaces the panel relies on:
 *
 *   1. GET  /api/admin/front/analytics-coverage/outbound-gap-status
 *        now returns `config.unreadableAlert` = { cooldownMinutes, muted,
 *        defaultCooldownMinutes, minCooldownMinutes, maxCooldownMinutes }.
 *
 *   2. POST /api/admin/front/analytics-coverage/unreadable-alert-config
 *        (isAuthenticated + requireTeamLead) writes cooldownMinutes and/or
 *        muted through the system_settings keys and returns the resulting
 *        config. Out-of-bounds cooldowns and bad types are rejected 400,
 *        and an empty body is rejected 400.
 *
 * Every system setting touched is snapshotted and restored so the run is
 * hermetic on the shared dev DB.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";

import { db } from "../server/db";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
import {
  getSystemSetting,
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import {
  SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES,
  SETTING_UNREADABLE_ALERT_MUTED,
  DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES,
  MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES,
  MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES,
} from "../server/services/frontOutboundGapCloser";

const TAG = "task-2236";
const TL_ID = `${TAG}-tl`;
const AM_ID = `${TAG}-am`;

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function ensureUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${TL_ID}, 'team_lead', ${"Task2236 TL"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await db.execute(sql`
    INSERT INTO users (id, role, first_name)
    VALUES (${AM_ID}, 'account_manager', ${"Task2236 AM"})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
}

async function cleanupUsers(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM users WHERE id IN (${TL_ID}, ${AM_ID})`);
  } catch {}
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const actor = String(req.headers["x-test-actor"] ?? "");
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; empty header (null) is
    // explicit-unauthenticated → 401. (The pre-Clerk passport-shape
    // injection stopped working when auth migrated.)
    (req as any).__test_clerkUserId = actor || null;
    next();
  });
  registerIntegrationRoutes(app);
  return app;
}

async function listen(
  app: express.Express,
): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function call(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  actor: string | null,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (actor) headers["x-test-actor"] = actor;
  if (body !== undefined) headers["content-type"] = "application/json";
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

const CONFIG_PATH = "/api/admin/front/analytics-coverage/unreadable-alert-config";
const STATUS_PATH = "/api/admin/front/analytics-coverage/outbound-gap-status";

async function main(): Promise<void> {
  await ensureUsers();

  const savedCooldown =
    (await getSystemSetting(SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES))?.value ??
    null;
  const savedMuted =
    (await getSystemSetting(SETTING_UNREADABLE_ALERT_MUTED))?.value ?? null;

  // Start from a clean slate so defaults are deterministic.
  await deleteSystemSetting(SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES);
  await deleteSystemSetting(SETTING_UNREADABLE_ALERT_MUTED);

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── 1. Role gate on the write route ────────────────────────────────
    const anon = await call(baseUrl, "POST", CONFIG_PATH, null, {
      cooldownMinutes: 30,
    });
    assertEq(anon.status, 401, `anon should 401 (got ${anon.status})`);

    const am = await call(baseUrl, "POST", CONFIG_PATH, AM_ID, {
      cooldownMinutes: 30,
    });
    assertEq(
      am.status,
      403,
      `account_manager should 403 (got ${am.status} ${JSON.stringify(am.body)})`,
    );
    // Rejected callers must not have written anything.
    assertEq(
      (await getSystemSetting(SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES))
        ?.value ?? null,
      null,
      "a rejected caller never persists the cooldown",
    );

    // ── 2. Status route surfaces the default config block ──────────────
    const statusDefault = await call(baseUrl, "GET", STATUS_PATH, TL_ID);
    assertEq(statusDefault.status, 200, `status should 200 (got ${statusDefault.status})`);
    const alertDefault = statusDefault.body?.config?.unreadableAlert;
    assert.ok(
      alertDefault && typeof alertDefault === "object",
      "status config carries an unreadableAlert block",
    );
    assertEq(
      alertDefault.cooldownMinutes,
      DEFAULT_UNREADABLE_ALERT_COOLDOWN_MINUTES,
      "default cooldown surfaced",
    );
    assertEq(alertDefault.muted, false, "default muted=false");
    assertEq(
      alertDefault.minCooldownMinutes,
      MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES,
      "min bound surfaced",
    );
    assertEq(
      alertDefault.maxCooldownMinutes,
      MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES,
      "max bound surfaced",
    );

    // ── 3. Tune the cooldown via the write route ───────────────────────
    const setCooldown = await call(baseUrl, "POST", CONFIG_PATH, TL_ID, {
      cooldownMinutes: 30,
    });
    assertEq(setCooldown.status, 200, `set cooldown should 200 (got ${setCooldown.status} ${JSON.stringify(setCooldown.body)})`);
    assertEq(setCooldown.body.cooldownMinutes, 30, "response cooldown=30");
    assertEq(setCooldown.body.muted, false, "muted unchanged");
    assertEq(
      (await getSystemSetting(SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES))?.value,
      "30",
      "cooldown persisted to system_settings",
    );

    // ── 4. Mute via the write route, then read it back on the status route ──
    const mute = await call(baseUrl, "POST", CONFIG_PATH, TL_ID, {
      muted: true,
    });
    assertEq(mute.status, 200, `mute should 200 (got ${mute.status})`);
    assertEq(mute.body.muted, true, "response muted=true");
    assertEq(
      mute.body.cooldownMinutes,
      30,
      "mute toggle leaves cooldown intact",
    );

    const statusMuted = await call(baseUrl, "GET", STATUS_PATH, TL_ID);
    assertEq(
      statusMuted.body?.config?.unreadableAlert?.muted,
      true,
      "status route reflects the mute",
    );
    assertEq(
      statusMuted.body?.config?.unreadableAlert?.cooldownMinutes,
      30,
      "status route reflects the tuned cooldown",
    );

    // ── 5. Validation: bad types + out-of-bounds + empty body → 400 ─────
    const badType = await call(baseUrl, "POST", CONFIG_PATH, TL_ID, {
      cooldownMinutes: "soon",
    });
    assertEq(badType.status, 400, `non-number cooldown should 400 (got ${badType.status})`);

    const badMuted = await call(baseUrl, "POST", CONFIG_PATH, TL_ID, {
      muted: "yes",
    });
    assertEq(badMuted.status, 400, `non-boolean muted should 400 (got ${badMuted.status})`);

    const tooLow = await call(baseUrl, "POST", CONFIG_PATH, TL_ID, {
      cooldownMinutes: MIN_UNREADABLE_ALERT_COOLDOWN_MINUTES - 1,
    });
    assertEq(tooLow.status, 400, `below-floor cooldown should 400 (got ${tooLow.status})`);

    const tooHigh = await call(baseUrl, "POST", CONFIG_PATH, TL_ID, {
      cooldownMinutes: MAX_UNREADABLE_ALERT_COOLDOWN_MINUTES + 1,
    });
    assertEq(tooHigh.status, 400, `above-ceiling cooldown should 400 (got ${tooHigh.status})`);

    const empty = await call(baseUrl, "POST", CONFIG_PATH, TL_ID, {});
    assertEq(empty.status, 400, `empty body should 400 (got ${empty.status})`);

    // A rejected write must not have changed the persisted values.
    assertEq(
      (await getSystemSetting(SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES))?.value,
      "30",
      "rejected writes left the cooldown at 30",
    );
    assertEq(
      (await getSystemSetting(SETTING_UNREADABLE_ALERT_MUTED))?.value,
      "true",
      "rejected writes left muted=true",
    );

    console.log("front-outbound-gap-close-unreadable-alert-config-route.test.ts: OK");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupUsers();

    if (savedCooldown === null)
      await deleteSystemSetting(SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES);
    else
      await setSystemSetting(
        SETTING_UNREADABLE_ALERT_COOLDOWN_MINUTES,
        savedCooldown,
        "test",
      );

    if (savedMuted === null)
      await deleteSystemSetting(SETTING_UNREADABLE_ALERT_MUTED);
    else
      await setSystemSetting(SETTING_UNREADABLE_ALERT_MUTED, savedMuted, "test");
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
await main();
