/* test-registration
{
  "name": "Zoom S2S cutover + legacy retirement prod actions (Task #4019)",
  "regression": true,
  "sweepOnlyReason": "Task #4019 — imports server/storage and the prod-actions registry (warms DB pools), writes prod_action_runs rows for the rollback-guard case, and mounts the full integrations router for the webhook-evidence case; consistent with the other zoom suites, not a DB-free gate candidate",
  "tier": "small"
}
test-registration */
/**
 * Task #4019 — the two CEO-panel prod actions that finish the Zoom S2S
 * switchover, plus the webhook-evidence stamp that gates retirement.
 *
 * Cutover action (`zoom_s2s_auth_mode_cutover`):
 *   1. status(): blocked without S2S creds; pending with creds; applied in
 *      s2s mode.
 *   2. apply() with a NOT-ready preflight (missing scope) → blocked, and the
 *      mode is untouched (no auth-mode write, no audit row).
 *   3. apply() with a ready preflight → applied; zoom_auth_mode=s2s,
 *      zoom_s2s_cutover_at stamped (fresh ISO), audit row recorded, and the
 *      auto-sync kick fires (via the test seam — the real starter would
 *      launch the durable pipeline in-process). Re-apply → not-needed.
 *   4. Rollback guard: a real prod_action_runs "applied" row + mode oauth →
 *      status AND apply refuse (not-needed) instead of auto-re-flipping.
 *
 * Retirement action (`retire_legacy_zoom_oauth_tokens`) — gate matrix:
 *   5. oauth mode → blocked; s2s without cutover stamp → blocked; soak <72h
 *      → blocked (countdown detail); no webhook evidence → blocked; stale
 *      (>7d) evidence → blocked; all gates green → pending; apply deletes
 *      exactly the three legacy rows (values never appear in any detail),
 *      audits key names only, then status → applied.
 *   6. retireLegacyZoomOauthTokens() hard-refuses outside s2s mode.
 *
 * Webhook evidence stamp:
 *   7. verifyZoomWebhookSignatureDetailed labels legacy/s2s/junk signatures;
 *      recordZoomS2sWebhookVerified throttles (one write per 5 min), retries
 *      after a failed write, and the test-reset helper re-arms it.
 *   8. Route level (real router + real signatures): an S2S-signed event
 *      stamps zoom_s2s_webhook_last_verified_at; a legacy-signed event and
 *      an S2S-signed CRC do NOT.
 *
 * Pure in-memory settings (Map-backed storage patches incl. delete) + fetch
 * interception for the Zoom hosts; the rollback-guard case uses the real
 * per-run test DB (prod_action_runs) and cleans up its rows in finally.
 */
import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "test_zoom_client_id";
process.env.ZOOM_CLIENT_SECRET =
  process.env.ZOOM_CLIENT_SECRET || "test_zoom_client_secret";

const TEST_LEGACY_WEBHOOK_SECRET = `zm_4019_legacy_${process.pid}_${Date.now().toString(36)}`;
const TEST_S2S_WEBHOOK_SECRET = `zm_4019_s2s_${process.pid}_${Date.now().toString(36)}`;
const PREV_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
const PREV_S2S_WEBHOOK_SECRET = process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN;
const PREV_S2S_ACCOUNT_ID = process.env.ZOOM_S2S_ACCOUNT_ID;
const PREV_S2S_CLIENT_ID = process.env.ZOOM_S2S_CLIENT_ID;
const PREV_S2S_CLIENT_SECRET = process.env.ZOOM_S2S_CLIENT_SECRET;
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = TEST_LEGACY_WEBHOOK_SECRET;
process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN = TEST_S2S_WEBHOOK_SECRET;

import { storage } from "../server/storage";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { __resetOAuthRefreshSingleFlightForTest } from "../server/services/oauthRefresh";
import {
  getZoomAuthMode,
  getRequiredZoomS2sScopes,
  retireLegacyZoomOauthTokens,
  verifyZoomWebhookSignatureDetailed,
  recordZoomS2sWebhookVerified,
  clearZoomPermanentFailure,
  clearZoomValidationBreaker,
  __clearZoomS2sTokenCacheForTest,
  __disableZoomAuthSelfHealForTest,
  __clearPersistedZoomAuthGateForTest,
  __resetZoomS2sWebhookVerifiedStampForTest,
  __setZoomAutoSyncKickForTest,
  ZOOM_AUTH_MODE_SETTING,
  ZOOM_S2S_CUTOVER_AT_SETTING,
  ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING,
  ZOOM_LEGACY_TOKEN_SETTING_KEYS,
} from "../server/services/zoomIntegration";
import { PROD_ACTIONS, applyOneProdAction } from "../server/services/prodActionsRegistry";
import { registerProdActionsRoutes } from "../server/routes/prodActions";
import {
  ensureProdActionRunsTable,
  recordProdActionRun,
} from "../server/storage/prodActionRuns";
import { runWithWorkerDb, getDb } from "../server/db";
import { sql } from "drizzle-orm";

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const ZOOM_API_BASE = "https://api.zoom.us/v2";
const CUTOVER_ACTION_ID = "zoom_s2s_auth_mode_cutover";
const RETIRE_ACTION_ID = "retire_legacy_zoom_oauth_tokens";
const ROLLBACK_ACTION_ID = "zoom_s2s_rollback_to_oauth";
const HOUR_MS = 60 * 60 * 1000;

const cutoverAction = PROD_ACTIONS.find((a) => a.id === CUTOVER_ACTION_ID);
const retireAction = PROD_ACTIONS.find((a) => a.id === RETIRE_ACTION_ID);
const rollbackAction = PROD_ACTIONS.find((a) => a.id === ROLLBACK_ACTION_ID);

const originalFetch = globalThis.fetch;
const originalGet = (storage as any).getSystemSetting;
const originalGetFresh = (storage as any).getSystemSettingFresh;
const originalSet = (storage as any).setSystemSetting;
const originalDelete = (storage as any).deleteSystemSetting;
const originalRecord = (storage as any).recordAdminSettingChange;

let tokenCalls = 0;
let apiCalls: Array<{ url: string; init: any }> = [];
let settingWrites: string[] = [];
let settingWriteActors: Array<{ key: string; updatedBy: string | undefined }> = [];
let settingDeletes: string[] = [];
let auditCalls: any[] = [];

const okTokenResponse = (scope: string): Response =>
  new Response(
    JSON.stringify({ access_token: "s2s-token-4019", token_type: "bearer", expires_in: 3600, scope }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

const okUsersList = (): Response =>
  new Response(JSON.stringify({ users: [{ id: "u-1", email: "a@b.c" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function installStubs(
  map: Map<string, string>,
  handlers: { token?: () => Response; api?: (url: string, init: any) => Response },
): void {
  tokenCalls = 0;
  apiCalls = [];
  settingWrites = [];
  settingWriteActors = [];
  settingDeletes = [];
  auditCalls = [];
  const read = async (key: string) => {
    const value = map.get(key);
    return value === undefined ? undefined : { key, value };
  };
  (storage as any).getSystemSetting = read;
  (storage as any).getSystemSettingFresh = read;
  (storage as any).setSystemSetting = async (key: string, value: string, updatedBy?: string) => {
    settingWrites.push(key);
    settingWriteActors.push({ key, updatedBy });
    map.set(key, value);
    return { key, value };
  };
  (storage as any).deleteSystemSetting = async (key: string) => {
    settingDeletes.push(key);
    map.delete(key);
  };
  (storage as any).recordAdminSettingChange = async (row: any) => {
    auditCalls.push(row);
    return undefined;
  };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.startsWith(ZOOM_TOKEN_URL)) {
      tokenCalls++;
      if (!handlers.token) throw new Error(`unexpected token POST in this case: ${url}`);
      return handlers.token();
    }
    if (url.startsWith(ZOOM_API_BASE)) {
      apiCalls.push({ url, init });
      if (!handlers.api) throw new Error(`unexpected Zoom API call in this case: ${url}`);
      return handlers.api(url, init);
    }
    return originalFetch(input, init);
  }) as any;
}

function restoreAll(): void {
  globalThis.fetch = originalFetch;
  (storage as any).getSystemSetting = originalGet;
  (storage as any).getSystemSettingFresh = originalGetFresh;
  (storage as any).setSystemSetting = originalSet;
  (storage as any).deleteSystemSetting = originalDelete;
  (storage as any).recordAdminSettingChange = originalRecord;
}

async function resetZoomState(): Promise<void> {
  __resetOAuthRefreshSingleFlightForTest();
  __disableZoomAuthSelfHealForTest(true);
  await __clearPersistedZoomAuthGateForTest();
  clearZoomPermanentFailure();
  clearZoomValidationBreaker();
  __clearZoomS2sTokenCacheForTest();
  __resetZoomS2sWebhookVerifiedStampForTest();
}

function setS2sCreds(): void {
  process.env.ZOOM_S2S_ACCOUNT_ID = "acct-4019";
  process.env.ZOOM_S2S_CLIENT_ID = "s2s-client-4019";
  process.env.ZOOM_S2S_CLIENT_SECRET = "s2s-secret-4019";
}

function clearS2sCreds(): void {
  delete process.env.ZOOM_S2S_ACCOUNT_ID;
  delete process.env.ZOOM_S2S_CLIENT_ID;
  delete process.env.ZOOM_S2S_CLIENT_SECRET;
}

const fullScopeString = () => getRequiredZoomS2sScopes().join(" ");

async function deleteCutoverRunRows(): Promise<void> {
  await runWithWorkerDb(async () => {
    await getDb().execute(
      sql`DELETE FROM prod_action_runs WHERE action_id = ${CUTOVER_ACTION_ID}`,
    );
  });
}

// 1. Cutover status matrix: creds-blocked / pending / applied.
async function testCutoverStatusMatrix(): Promise<void> {
  const map = new Map<string, string>();
  installStubs(map, {});
  try {
    await resetZoomState();
    clearS2sCreds();
    let s = await cutoverAction!.status();
    assert.equal(s.state, "blocked", "no S2S creds → blocked");
    assert.match(s.detail ?? "", /ZOOM_S2S_ACCOUNT_ID/, "blocked detail names the secrets");

    setS2sCreds();
    s = await cutoverAction!.status();
    assert.equal(s.state, "pending", "creds + oauth mode + no prior run → pending");
    assert.equal(tokenCalls, 0, "status() must never run the preflight (no mint)");
    assert.equal(apiCalls.length, 0, "status() must never call the Zoom API");

    map.set(ZOOM_AUTH_MODE_SETTING, "s2s");
    s = await cutoverAction!.status();
    assert.equal(s.state, "applied", "s2s mode → applied");
    assert.match(s.detail ?? "", /retirement/i, "applied detail points at the retirement stage");
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 2. apply() with a not-ready preflight → blocked, mode untouched.
async function testCutoverApplyPreflightNotReady(): Promise<void> {
  const map = new Map<string, string>();
  const scopes = getRequiredZoomS2sScopes();
  const missingOne = scopes.slice(0, scopes.length - 1).join(" ");
  installStubs(map, { token: () => okTokenResponse(missingOne), api: () => okUsersList() });
  try {
    await resetZoomState();
    setS2sCreds();
    const r = await cutoverAction!.apply("user-ceo");
    assert.equal(r.state, "blocked", "not-ready preflight → blocked");
    assert.match(r.detail ?? "", /missingScopes=\[/, "blocked detail lists the missing scopes");
    assert.equal(map.has(ZOOM_AUTH_MODE_SETTING), false, "auth mode must NOT be written");
    assert.equal(map.has(ZOOM_S2S_CUTOVER_AT_SETTING), false, "no soak stamp on a refused flip");
    assert.equal(auditCalls.length, 0, "no audit row on a refused flip");
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 3. apply() with a ready preflight → applied + stamps + audit + kick;
//    re-apply → not-needed.
async function testCutoverApplySuccess(): Promise<void> {
  const map = new Map<string, string>();
  installStubs(map, { token: () => okTokenResponse(fullScopeString()), api: () => okUsersList() });
  let kicks = 0;
  __setZoomAutoSyncKickForTest(async () => {
    kicks++;
  });
  try {
    await resetZoomState();
    setS2sCreds();
    const before = Date.now();
    const r = await cutoverAction!.apply("user-ceo");
    assert.equal(r.state, "applied", `ready preflight → applied (got: ${r.detail})`);
    assert.equal(map.get(ZOOM_AUTH_MODE_SETTING), "s2s", "mode written to s2s");
    const stamp = map.get(ZOOM_S2S_CUTOVER_AT_SETTING);
    assert.ok(stamp, "zoom_s2s_cutover_at stamped");
    const stampMs = new Date(stamp!).getTime();
    assert.ok(
      Number.isFinite(stampMs) && stampMs >= before - 1000 && stampMs <= Date.now() + 1000,
      `cutover stamp is a fresh ISO timestamp (got ${stamp})`,
    );
    assert.ok(auditCalls.length >= 1, "auth-mode change audited");
    // The fire-and-forget kick lands on a microtask; give it a tick.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(kicks, 1, "auto-sync kick fired exactly once");

    const again = await cutoverAction!.apply("user-ceo");
    assert.equal(again.state, "not-needed", "second apply in s2s mode is a no-op");
    assert.equal(kicks, 1, "no second kick on a no-op apply");
  } finally {
    __setZoomAutoSyncKickForTest(null);
    restoreAll();
    clearS2sCreds();
  }
}

// 4. Rollback guard: prior applied run + oauth mode → parked (status & apply).
async function testCutoverRollbackGuard(): Promise<void> {
  const map = new Map<string, string>(); // no auth-mode row → oauth
  installStubs(map, {});
  try {
    await resetZoomState();
    setS2sCreds();
    await runWithWorkerDb(async () => {
      await ensureProdActionRunsTable();
    });
    await deleteCutoverRunRows(); // start clean even after a crashed prior run
    await runWithWorkerDb(async () => {
      await recordProdActionRun({
        actionId: CUTOVER_ACTION_ID,
        actionTitle: "Flip Zoom to Server-to-Server auth (Task #4019)",
        actorUserId: null,
        outcomeState: "applied",
        detail: "test fixture — task 4019 rollback-guard case",
      } as any);
    });

    const s = await cutoverAction!.status();
    assert.equal(s.state, "not-needed", "prior applied run + oauth mode → parked");
    assert.match(s.detail ?? "", /rolled back/i, "detail explains the operator rollback");

    const r = await cutoverAction!.apply("user-ceo");
    assert.equal(r.state, "not-needed", "apply also refuses after a rollback");
    assert.equal(map.has(ZOOM_AUTH_MODE_SETTING), false, "mode untouched by the refusal");
    assert.equal(tokenCalls, 0, "no preflight mint attempted when parked");
  } finally {
    await deleteCutoverRunRows().catch(() => {});
    restoreAll();
    clearS2sCreds();
  }
}

// 5. Retirement gate matrix + successful clear.
async function testRetirementGatesAndClear(): Promise<void> {
  const secretValues = {
    access: "legacy-access-value-4019",
    refresh: "legacy-refresh-value-4019",
    expires: String(Math.floor(Date.now() / 1000) + 1000),
  };
  const seedLegacyRows = (map: Map<string, string>) => {
    map.set("zoom_access_token", secretValues.access);
    map.set("zoom_refresh_token", secretValues.refresh);
    map.set("zoom_token_expires_at", secretValues.expires);
  };
  const map = new Map<string, string>();
  installStubs(map, {});
  try {
    await resetZoomState();
    setS2sCreds();

    // Gate 1: oauth mode.
    seedLegacyRows(map);
    let s = await retireAction!.status();
    assert.equal(s.state, "blocked", "oauth mode → blocked");
    assert.match(s.detail ?? "", /zoom_auth_mode is oauth/);

    // Gate 2: s2s but no cutover stamp.
    map.set(ZOOM_AUTH_MODE_SETTING, "s2s");
    s = await retireAction!.status();
    assert.equal(s.state, "blocked", "no cutover stamp → blocked");
    assert.match(s.detail ?? "", /zoom_s2s_cutover_at/);

    // Gate 3: soak too short (10h of 72h).
    map.set(ZOOM_S2S_CUTOVER_AT_SETTING, new Date(Date.now() - 10 * HOUR_MS).toISOString());
    s = await retireAction!.status();
    assert.equal(s.state, "blocked", "10h soak → blocked");
    assert.match(s.detail ?? "", /10h of 72h/, "countdown detail shows elapsed/required");

    // Gate 4: soaked but no webhook evidence.
    map.set(ZOOM_S2S_CUTOVER_AT_SETTING, new Date(Date.now() - 100 * HOUR_MS).toISOString());
    s = await retireAction!.status();
    assert.equal(s.state, "blocked", "no S2S webhook evidence → blocked");
    assert.match(s.detail ?? "", /zoom_s2s_webhook_last_verified_at unset/);

    // Gate 5: evidence too old (8 days).
    map.set(
      ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING,
      new Date(Date.now() - 8 * 24 * HOUR_MS).toISOString(),
    );
    s = await retireAction!.status();
    assert.equal(s.state, "blocked", "stale evidence → blocked");
    assert.match(s.detail ?? "", /old/, "stale-evidence detail mentions the age");

    // All gates green → pending, apply clears exactly the three rows.
    map.set(
      ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING,
      new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    );
    s = await retireAction!.status();
    assert.equal(s.state, "pending", "all gates green → pending");
    assert.match(s.detail ?? "", /zoom_access_token/, "pending detail lists the rows");

    const r = await retireAction!.apply("user-ceo");
    assert.equal(r.state, "applied", `apply clears the rows (got: ${r.detail})`);
    assert.equal((r as any).rowsAffected, 3, "three rows cleared");
    assert.deepEqual(
      [...settingDeletes].sort(),
      [...ZOOM_LEGACY_TOKEN_SETTING_KEYS].sort(),
      "exactly the three legacy keys deleted",
    );
    for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) {
      assert.equal(map.has(key), false, `${key} removed`);
    }
    // Token VALUES must never leak into details or audit rows.
    const audit = auditCalls.find((c) => c?.scope === "zoom_legacy_token_retirement");
    assert.ok(audit, "retirement audited");
    const auditText = JSON.stringify(audit);
    const detailText = `${r.detail ?? ""}${s.detail ?? ""}`;
    for (const v of Object.values(secretValues)) {
      assert.ok(!auditText.includes(v), "audit row contains key names only, never values");
      assert.ok(!detailText.includes(v), "details never contain token values");
    }

    // Post-clear: status applied (single-app steady state), re-apply no-op.
    s = await retireAction!.status();
    assert.equal(s.state, "applied", "rows absent + s2s mode → applied");
    assert.match(s.detail ?? "", /manual/i, "applied detail lists the manual remainder");
    const again = await retireAction!.apply("user-ceo");
    assert.equal(again.state, "not-needed", "re-apply with rows absent is a no-op");

    // Anomaly surface: rows absent but mode oauth → blocked, not applied.
    map.delete(ZOOM_AUTH_MODE_SETTING);
    s = await retireAction!.status();
    assert.equal(s.state, "blocked", "rows absent + oauth mode → anomalous, blocked");
  } finally {
    restoreAll();
    clearS2sCreds();
  }
}

// 6. Direct helper hard-guard.
async function testRetireHelperRefusesInOauthMode(): Promise<void> {
  const map = new Map<string, string>([["zoom_access_token", "v"]]);
  installStubs(map, {});
  try {
    await resetZoomState();
    await assert.rejects(
      () => retireLegacyZoomOauthTokens("user-ceo"),
      /zoom_auth_mode != s2s/,
      "helper refuses outside s2s mode",
    );
    assert.equal(map.has("zoom_access_token"), true, "row untouched by the refusal");
  } finally {
    restoreAll();
  }
}

// 7. Signature labeling + stamp throttle/retry semantics.
async function testSignatureLabelingAndStampThrottle(): Promise<void> {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ event: "meeting.started", payload: { object: { id: "x" } } });
  const sign = (secret: string) =>
    `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

  let v = verifyZoomWebhookSignatureDetailed(body, ts, sign(TEST_LEGACY_WEBHOOK_SECRET));
  assert.deepEqual({ valid: v.valid, src: v.matchedSource }, { valid: true, src: "legacy" });
  v = verifyZoomWebhookSignatureDetailed(body, ts, sign(TEST_S2S_WEBHOOK_SECRET));
  assert.deepEqual({ valid: v.valid, src: v.matchedSource }, { valid: true, src: "s2s" });
  v = verifyZoomWebhookSignatureDetailed(body, ts, "v0=deadbeef");
  assert.deepEqual({ valid: v.valid, src: v.matchedSource }, { valid: false, src: null });

  const map = new Map<string, string>();
  installStubs(map, {});
  try {
    __resetZoomS2sWebhookVerifiedStampForTest();
    const t0 = Date.now();
    await recordZoomS2sWebhookVerified(t0);
    assert.equal(
      settingWrites.filter((k) => k === ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING).length,
      1,
      "first call writes the stamp",
    );
    assert.deepEqual(
      settingWriteActors.filter((write) => write.key === ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING),
      [{ key: ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING, updatedBy: undefined }],
      "background webhook evidence write has no fabricated user attribution",
    );
    await recordZoomS2sWebhookVerified(t0 + 60 * 1000);
    assert.equal(
      settingWrites.filter((k) => k === ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING).length,
      1,
      "call inside the 5-min throttle window is skipped",
    );
    await recordZoomS2sWebhookVerified(t0 + 6 * 60 * 1000);
    assert.equal(
      settingWrites.filter((k) => k === ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING).length,
      2,
      "call after the throttle window writes again",
    );

    // A failed write never throws outward and does NOT advance the throttle.
    __resetZoomS2sWebhookVerifiedStampForTest();
    map.delete(ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING); // clear the earlier sub-case's stamp
    let failNext = true;
    (storage as any).setSystemSetting = async (key: string, value: string) => {
      if (failNext) {
        failNext = false;
        throw new Error("settings store down");
      }
      settingWrites.push(key);
      map.set(key, value);
      return { key, value };
    };
    const t1 = Date.now();
    await recordZoomS2sWebhookVerified(t1); // swallowed failure
    assert.equal(map.has(ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING), false, "failed write left no stamp");
    await recordZoomS2sWebhookVerified(t1 + 1000); // still inside 5 min — but throttle did not advance
    assert.equal(
      map.has(ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING),
      true,
      "retry succeeds immediately because a failed write does not advance the throttle",
    );
  } finally {
    restoreAll();
  }
}

// 8. Route level: S2S-signed event stamps evidence; legacy-signed and CRC don't.
async function testRouteLevelEvidenceStamp(): Promise<void> {
  const { registerIntegrationRoutes } = await import("../server/routes/integrations");
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) }));
  registerIntegrationRoutes(app);
  const server: Server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const map = new Map<string, string>();
  installStubs(map, {});
  const post = async (bodyObj: unknown, secret: string) => {
    const raw = JSON.stringify(bodyObj);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;
    const r = await fetch(`${baseUrl}/api/integrations/zoom/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-zm-request-timestamp": ts,
        "x-zm-signature": sig,
      },
      body: raw,
    });
    return r.status;
  };
  const benign = () => ({ event: "meeting.started", payload: { object: { id: `t4019_${Date.now()}` } } });
  const waitForStamp = async (): Promise<boolean> => {
    for (let i = 0; i < 50; i++) {
      if (map.has(ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING)) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };

  try {
    __resetZoomS2sWebhookVerifiedStampForTest();
    // S2S-signed live event → stamps.
    let status = await post(benign(), TEST_S2S_WEBHOOK_SECRET);
    assert.equal(status, 200, "s2s-signed benign event accepted");
    assert.equal(await waitForStamp(), true, "S2S-verified delivery stamps the evidence setting");

    // Legacy-signed event → no stamp.
    map.delete(ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING);
    __resetZoomS2sWebhookVerifiedStampForTest();
    status = await post(benign(), TEST_LEGACY_WEBHOOK_SECRET);
    assert.equal(status, 200, "legacy-signed benign event accepted");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      map.has(ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING),
      false,
      "legacy-signed delivery must NOT stamp S2S evidence",
    );

    // S2S-signed CRC → no stamp (endpoint config proof, not live event flow).
    __resetZoomS2sWebhookVerifiedStampForTest();
    status = await post(
      { event: "endpoint.url_validation", payload: { plainToken: `crc_${Date.now().toString(36)}` } },
      TEST_S2S_WEBHOOK_SECRET,
    );
    assert.equal(status, 200, "s2s-signed CRC answered");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      map.has(ZOOM_S2S_WEBHOOK_LAST_VERIFIED_SETTING),
      false,
      "CRC validation must NOT count as retirement evidence",
    );
  } finally {
    server.close();
    restoreAll();
  }
}

// 9. Rollback lever definition + status matrix (Task #4019 follow-up).
async function testRollbackLeverStatusMatrix(): Promise<void> {
  assert.equal(rollbackAction!.manualLever, true, "rollback is a manual lever");
  assert.ok(!rollbackAction!.selfHeal, "rollback is never self-heal-eligible");

  const map = new Map<string, string>(); // no auth-mode row → oauth
  installStubs(map, {});
  try {
    await resetZoomState();

    // oauth mode: nothing to roll back; apply is a no-op that leaves the map alone.
    let s = await rollbackAction!.status();
    assert.equal(s.state, "not-needed", "oauth mode → not-needed");
    assert.match(s.detail ?? "", /nothing to roll back/i);
    const noop = await rollbackAction!.apply("user-ceo");
    assert.equal(noop.state, "not-needed", "apply in oauth mode is a no-op");
    assert.equal(map.has(ZOOM_AUTH_MODE_SETTING), false, "no mode row written by the no-op");

    // s2s mode + legacy tokens present: lever armed, reconnect merely expected.
    map.set(ZOOM_AUTH_MODE_SETTING, "s2s");
    for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) map.set(key, `val-${key}`);
    s = await rollbackAction!.status();
    assert.equal(s.state, "not-needed", "lever never inflates the pending badge (s2s)");
    assert.match(s.detail ?? "", /excluded from Apply-all/i, "detail explains the lever lane");
    assert.ok(!/REQUIRED/.test(s.detail ?? ""), "reconnect not REQUIRED while tokens exist");

    // s2s mode + tokens retired: the reconnect warning escalates to REQUIRED.
    for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) map.delete(key);
    s = await rollbackAction!.status();
    assert.equal(s.state, "not-needed");
    assert.match(s.detail ?? "", /REQUIRED/, "tokens retired → reconnect REQUIRED warning");
  } finally {
    restoreAll();
  }
}

// 10. Rollback lever apply: flips s2s → oauth, kicks auto-sync, audits.
async function testRollbackLeverApply(): Promise<void> {
  const map = new Map<string, string>();
  installStubs(map, {});
  let kicks = 0;
  __setZoomAutoSyncKickForTest(async () => {
    kicks++;
  });
  try {
    await resetZoomState();
    map.set(ZOOM_AUTH_MODE_SETTING, "s2s");
    for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) map.set(key, `val-${key}`);

    const r = await rollbackAction!.apply("user-ceo");
    assert.equal(r.state, "applied", `s2s → oauth flip applied (got: ${r.detail})`);
    assert.equal(map.get(ZOOM_AUTH_MODE_SETTING), "oauth", "mode written back to oauth");
    assert.match(r.detail ?? "", /reconnect/i, "detail tells the operator about the reconnect");
    assert.match(r.detail ?? "", /route-only/i, "detail explains re-cutover stays route-only");
    assert.ok(!/REQUIRED/.test(r.detail ?? ""), "tokens present → reconnect not REQUIRED");
    assert.ok(auditCalls.length >= 1, "auth-mode change audited");
    assert.equal(tokenCalls, 0, "NO preflight mint on the rollback direction");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(kicks, 1, "auto-sync kick fired exactly once");

    // Tokens-retired variant: detail escalates to REQUIRED.
    map.set(ZOOM_AUTH_MODE_SETTING, "s2s");
    for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) map.delete(key);
    const r2 = await rollbackAction!.apply("user-ceo");
    assert.equal(r2.state, "applied");
    assert.match(r2.detail ?? "", /REQUIRED/, "tokens retired → REQUIRED reconnect in apply detail");
  } finally {
    __setZoomAutoSyncKickForTest(null);
    restoreAll();
  }
}

// 11. Manual-lever endpoint: CEO-gated route fires exactly one lever;
//     non-lever actions get 400, unknown ids 404; the lever press writes a
//     real prod_action_runs audit row.
async function testManualLeverRoute(): Promise<void> {
  const map = new Map<string, string>();
  installStubs(map, {});
  const originalGetUser = (storage as any).getUser;
  let kicks = 0;
  __setZoomAutoSyncKickForTest(async () => {
    kicks++;
  });
  const CEO_ID = `ceo-4019-lever-${process.pid}`;
  (storage as any).getUser = async (id: string) =>
    id === CEO_ID ? { id, role: "ceo", authorityLevel: "ceo" } : undefined;

  // requireAuth resolves the acting identity via its own ambient `db` lookup
  // (not the stubbed storage.getUser). Pre-register the CEO profile so it
  // admits the request without JIT-provisioning a public users row.
  __test_markUserReconciled(CEO_ID, { id: CEO_ID, role: "ceo" });

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    req.__test_clerkUserId = CEO_ID;
    next();
  });
  registerProdActionsRoutes(app);
  const server: Server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string) => {
    const res = await fetch(`${base}${p}`, { method: "POST" });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    await resetZoomState();
    await runWithWorkerDb(async () => {
      await ensureProdActionRunsTable();
      await getDb().execute(
        sql`DELETE FROM prod_action_runs WHERE action_id = ${ROLLBACK_ACTION_ID}`,
      );
    });
    map.set(ZOOM_AUTH_MODE_SETTING, "s2s");
    for (const key of ZOOM_LEGACY_TOKEN_SETTING_KEYS) map.set(key, `val-${key}`);

    // Unit-level gates of applyOneProdAction (no audit rows written).
    assert.deepEqual(await applyOneProdAction("nope_never_registered", CEO_ID), { kind: "not_found" });
    assert.deepEqual(await applyOneProdAction(CUTOVER_ACTION_ID, CEO_ID), { kind: "not_manual_lever" });

    const missing = await post("/api/admin/prod-actions/nope_never_registered/apply");
    assert.equal(missing.status, 404, "unknown action id → 404");
    const nonLever = await post(`/api/admin/prod-actions/${CUTOVER_ACTION_ID}/apply`);
    assert.equal(nonLever.status, 400, "non-lever action → 400 (stays Apply-all-only)");
    assert.equal(map.get(ZOOM_AUTH_MODE_SETTING), "s2s", "mode untouched by refused requests");

    const fired = await post(`/api/admin/prod-actions/${ROLLBACK_ACTION_ID}/apply`);
    assert.equal(fired.status, 200, `lever press → 200 (got ${fired.status}: ${JSON.stringify(fired.body)})`);
    assert.equal(fired.body?.result?.outcome?.state, "applied", "lever outcome applied");
    assert.equal(map.get(ZOOM_AUTH_MODE_SETTING), "oauth", "route press flipped the mode");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(kicks, 1, "route press kicked auto-sync once");

    const rows = await runWithWorkerDb(async () =>
      getDb().execute(
        sql`SELECT actor_user_id, outcome_state FROM prod_action_runs WHERE action_id = ${ROLLBACK_ACTION_ID}`,
      ),
    );
    assert.equal((rows as any).rows.length, 1, "exactly one audit row for the lever press");
    assert.equal((rows as any).rows[0].outcome_state, "applied");
    assert.equal((rows as any).rows[0].actor_user_id, CEO_ID, "CEO actor recorded");
  } finally {
    await runWithWorkerDb(async () => {
      await getDb().execute(
        sql`DELETE FROM prod_action_runs WHERE action_id = ${ROLLBACK_ACTION_ID}`,
      );
    }).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (storage as any).getUser = originalGetUser;
    __test_resetReconciledUsers();
    __setZoomAutoSyncKickForTest(null);
    restoreAll();
  }
}

async function main(): Promise<void> {
  assert.ok(cutoverAction, "zoom_s2s_auth_mode_cutover action registered");
  assert.ok(retireAction, "retire_legacy_zoom_oauth_tokens action registered");
  assert.ok(rollbackAction, "zoom_s2s_rollback_to_oauth action registered");
  assert.ok(
    !cutoverAction!.selfHeal,
    "cutover is manual-only (no selfHeal — the sweep must never flip auth modes)",
  );
  // Task #4762 enrolled the retirement delete in self-heal: the triple gate
  // (s2s mode + ≥72h soak + webhook-verified ≤7d) lives inside BOTH status()
  // and apply(), so a scheduler press before the gates pass settles blocked
  // without deleting anything. The sweep still can never flip auth modes —
  // only the gate-protected delete is enrolled.
  assert.ok(
    retireAction!.selfHeal,
    "retirement delete is self-heal enrolled (Task #4762; triple gate inside status+apply)",
  );

  const cases: Array<[string, () => Promise<void>]> = [
    ["cutover status matrix (blocked/pending/applied), no preflight in status", testCutoverStatusMatrix],
    ["cutover apply: not-ready preflight → blocked, mode untouched", testCutoverApplyPreflightNotReady],
    ["cutover apply: ready preflight → applied + stamps + audit + kick", testCutoverApplySuccess],
    ["cutover rollback guard parks after a prior applied run", testCutoverRollbackGuard],
    ["retirement gate matrix + clear + value-leak guard", testRetirementGatesAndClear],
    ["retireLegacyZoomOauthTokens refuses in oauth mode", testRetireHelperRefusesInOauthMode],
    ["signature labeling + stamp throttle/retry", testSignatureLabelingAndStampThrottle],
    ["route-level evidence stamp: s2s yes, legacy/CRC no", testRouteLevelEvidenceStamp],
    ["rollback lever: manualLever flag + status matrix", testRollbackLeverStatusMatrix],
    ["rollback lever: apply flips mode + kick + audit", testRollbackLeverApply],
    ["manual-lever route: 404/400 gates + CEO press + audit row", testManualLeverRoute],
  ];
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      console.error(`  ✗ ${name}: ${err?.stack ?? err?.message ?? err}`);
      process.exitCode = 1;
    }
  }
  __disableZoomAuthSelfHealForTest(false);
  if (PREV_WEBHOOK_SECRET === undefined) delete process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  else process.env.ZOOM_WEBHOOK_SECRET_TOKEN = PREV_WEBHOOK_SECRET;
  if (PREV_S2S_WEBHOOK_SECRET === undefined) delete process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN;
  else process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN = PREV_S2S_WEBHOOK_SECRET;
  if (PREV_S2S_ACCOUNT_ID === undefined) delete process.env.ZOOM_S2S_ACCOUNT_ID;
  else process.env.ZOOM_S2S_ACCOUNT_ID = PREV_S2S_ACCOUNT_ID;
  if (PREV_S2S_CLIENT_ID === undefined) delete process.env.ZOOM_S2S_CLIENT_ID;
  else process.env.ZOOM_S2S_CLIENT_ID = PREV_S2S_CLIENT_ID;
  if (PREV_S2S_CLIENT_SECRET === undefined) delete process.env.ZOOM_S2S_CLIENT_SECRET;
  else process.env.ZOOM_S2S_CLIENT_SECRET = PREV_S2S_CLIENT_SECRET;
  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("prod-actions-zoom-s2s-cutover test cases failed");
  }
  console.log("prod-actions-zoom-s2s-cutover: OK");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
