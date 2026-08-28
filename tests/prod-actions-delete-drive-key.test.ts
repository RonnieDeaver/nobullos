/* test-registration
{
  "name": "CEO prod action: delete legacy Google Drive SA key (Task #4107)",
  "regression": true,
  "sweepOnlyReason": "Task #4107 — imports prodActionsRegistry and storage (warms DB pools); fetch-stubbed for GCP IAM + Google OAuth token exchange; DB reads are idempotent (google_service_account_key setting already absent in dev). Consistent with the prod-actions-zoom-s2s-cutover pattern.",
  "scanPaths": [
    "GOOGLE_DRIVE.md"
  ],
  "tier": "small"
}
test-registration */

// Task #4107 — automated tests for deleteGoogleDriveLegacyKeyAction.
//
// Covers:
//   A. status()  — Task #4762 lever contract: a manual lever NEVER reads
//      pending. status() returns synthetic not-needed in every probe state;
//      the remaining B-008 closure facts live in the detail, and
//      servedPurpose() retires the lever ONLY on verified closure (IAM 404 +
//      DB setting cleared + env var absent — "unknown" never retires).
//   B. apply()   — full precheck → IAM DELETE → DB clear → postcheck sequence;
//      precheck failure aborts before GCP; 403 surfaces manual-console fallback;
//      404 from GCP (already gone) still succeeds.
//   C. Route     — POST /api/admin/prod-actions/:actionId/apply enforces CEO
//      auth; non-lever actions get 400; lever press fires and audits.

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import express from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { storage } from "../server/storage";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import {
  PROD_ACTIONS,
  applyOneProdAction,
} from "../server/services/prodActionsRegistry";
import type { ProdAction } from "../server/services/prodActionsRegistry";
import { __resetManualLeverAppliesForCrossInstanceTest } from "../server/services/prodActions/engine";
import { registerProdActionsRoutes } from "../server/routes/prodActions";
import { __resetDriveClosureProbeMemoForTest } from "../server/services/prodActions/platformOpsActions";
import { ensureProdActionRunsTable } from "../server/storage/prodActionRuns";
import { runWithWorkerDb, getDb } from "../server/db";
import { sql } from "drizzle-orm";
import {
  getSystemSettingFresh,
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";

// ─── constants ───────────────────────────────────────────────────────────────

const ACTION_ID = "delete_google_drive_legacy_sa_key";
const IAM_KEY_URL =
  "https://iam.googleapis.com/v1/projects/core-respect-369420/serviceAccounts/" +
  "nobull%40core-respect-369420.iam.gserviceaccount.com/keys/" +
  "43d3ab85b5596ea3e8f822b4e5c007b47b7eb8de";
const IAM_URL_PREFIX = "https://iam.googleapis.com/v1/projects/core-respect-369420";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Canned token exchange response — satisfies mintServiceAccountToken. */
function oauthTokenOk(): Response {
  return new Response(
    JSON.stringify({ access_token: "test-iam-token", token_type: "Bearer" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

type FetchControl = {
  iamGetStatus: number;
  iamDeleteStatus: number;
  /** If true the first Sheets-precheck token exchange fails (401). */
  precheckFail?: boolean;
  /** If true the post-deletion Sheets token exchange fails (401). */
  postcheckFail?: boolean;
};

let originalFetch: typeof globalThis.fetch;
let iamGetCalls = 0;
let iamDeleteCalls = 0;
let oauthCalls = 0;
let precheckTokenCall = 0; // counts oauth calls specifically

function installFetchStub(ctrl: FetchControl) {
  originalFetch = globalThis.fetch;
  iamGetCalls = 0;
  iamDeleteCalls = 0;
  oauthCalls = 0;
  precheckTokenCall = 0;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // Google OAuth token exchange (minting service-account access tokens).
    if (url === OAUTH_TOKEN_URL) {
      oauthCalls++;
      const callIndex = oauthCalls;
      // precheckFail: the FIRST token call (Sheets precheck) fails.
      if (ctrl.precheckFail && callIndex === 1) {
        return new Response(
          JSON.stringify({ error: "invalid_grant" }),
          { status: 401 },
        );
      }
      // postcheckFail: the LAST token call (post-deletion Sheets verify) fails.
      if (ctrl.postcheckFail) {
        // postcheck happens after the IAM DELETE (which itself needs a token).
        // Token order: precheck(1) → IAM-status(2) → IAM-delete(3) → postcheck(4).
        // In apply() only: precheck(1) → [IAM delete needs one more token if
        // status() isn't called first]. Simplified: the last oauth call fails.
        // We flag it after the first two calls in apply context.
        if (callIndex >= 3) {
          return new Response(
            JSON.stringify({ error: "invalid_grant" }),
            { status: 401 },
          );
        }
      }
      return oauthTokenOk();
    }

    // GCP IAM API calls.
    if (url.startsWith(IAM_URL_PREFIX)) {
      if (method === "GET") {
        iamGetCalls++;
        return new Response("", { status: ctrl.iamGetStatus });
      }
      if (method === "DELETE") {
        iamDeleteCalls++;
        if (ctrl.iamDeleteStatus === 403) {
          return new Response(
            JSON.stringify({ error: "insufficient_permissions" }),
            { status: 403 },
          );
        }
        return new Response(
          ctrl.iamDeleteStatus === 204 ? null : "",
          { status: ctrl.iamDeleteStatus },
        );
      }
    }

    // Pass through everything else (undici / local).
    return originalFetch(input as any, init);
  };
}

function restoreFetch() {
  if (originalFetch) globalThis.fetch = originalFetch;
}

// Look up the action in the registry.
function findAction() {
  const a = PROD_ACTIONS.find((x) => x.id === ACTION_ID);
  assert.ok(a, `Action ${ACTION_ID} not found in PROD_ACTIONS`);
  return a!;
}

// ─── test cases ──────────────────────────────────────────────────────────────

// A1. status() — GCP key still exists (GET 200) → not-needed (Task #4762
// lever contract: a manual lever never reads pending) with the remaining
// closure facts in the detail; servedPurpose stays false. The 30s probe memo
// makes servedPurpose reuse status()'s probe — pinned via the IAM GET count.
async function testStatusLeverNeverPendingGcpExists(): Promise<void> {
  __resetDriveClosureProbeMemoForTest();
  installFetchStub({ iamGetStatus: 200, iamDeleteStatus: 200 });
  try {
    const action = findAction();
    const s = await action.status();
    assert.equal(
      s.state,
      "not-needed",
      `Lever contract (Task #4762): status() never reads pending; got ${s.state}: ${s.detail}`,
    );
    assert.match(
      s.detail ?? "",
      /Manual lever — remaining B-008 closure state/i,
      "detail is the honest remaining-facts readout",
    );
    assert.match(s.detail ?? "", /GCP key still exists/i, "detail names the GCP key");
    assert.match(s.detail ?? "", /Fire this lever/i, "detail points the operator at the lever");
    assert.equal(iamGetCalls, 1, "exactly one IAM GET probe");
    assert.equal(iamDeleteCalls, 0, "no DELETE in status()");

    assert.ok(action.servedPurpose, "lever declares a servedPurpose probe");
    const sp = await action.servedPurpose!();
    assert.equal(sp.served, false, "lever does not retire while the GCP key exists");
    assert.equal(iamGetCalls, 1, "servedPurpose reuses the memoized probe (no second IAM GET)");
  } finally {
    restoreFetch();
  }
}

// A2. status() — GCP probe fails (network error) → still not-needed; the
// detail classifies the key state as unverified, and an unverifiable key
// state never retires the lever (closure is proven, not assumed).
async function testStatusUnknownNeverRetires(): Promise<void> {
  __resetDriveClosureProbeMemoForTest();
  originalFetch = globalThis.fetch;
  iamGetCalls = 0;
  oauthCalls = 0;
  iamDeleteCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === OAUTH_TOKEN_URL) return oauthTokenOk();
    if (url.startsWith(IAM_URL_PREFIX)) {
      iamGetCalls++;
      throw new Error("network error");
    }
    return originalFetch(input as any, init);
  };
  try {
    const action = findAction();
    const s = await action.status();
    assert.equal(
      s.state,
      "not-needed",
      `Lever contract: never pending, even when the probe throws; got ${s.state}: ${s.detail}`,
    );
    assert.match(s.detail ?? "", /IAM probe threw/i, "detail names the probe failure");
    assert.match(s.detail ?? "", /key state unverified/i, "detail classifies the key state as unverified");
    const sp = await action.servedPurpose!();
    assert.equal(sp.served, false, "unknown key state never retires the lever");
  } finally {
    restoreFetch();
  }
}

// A3. status() — GCP confirms 404 (key gone), DB setting absent, env var
// absent → not-needed with the fully-closed detail, and servedPurpose retires
// the lever to History.
async function testStatusFullyClosedRetires(): Promise<void> {
  __resetDriveClosureProbeMemoForTest();
  installFetchStub({ iamGetStatus: 404, iamDeleteStatus: 404 });
  // Pin the env-var leg of the closure probe: the fully-closed branch requires
  // GOOGLE_SERVICE_ACCOUNT_KEY absent (retired with the Drive integration).
  const savedEnvKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  try {
    const action = findAction();
    const s = await action.status();
    // DB setting is already deleted in the test DB; env var pinned absent.
    assert.equal(s.state, "not-needed", `Expected not-needed when GCP 404 + DB absent, got: ${s.detail}`);
    assert.match(s.detail ?? "", /already deleted/i, "detail confirms deletion");
    assert.match(s.detail ?? "", /B-008 fully closed/i, "detail declares B-008 closure");
    const sp = await action.servedPurpose!();
    assert.equal(sp.served, true, "verified closure retires the lever to History");
    assert.match(sp.note ?? "", /B-008 closed/i, "retirement note names B-008");
  } finally {
    if (savedEnvKey !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_KEY = savedEnvKey;
    restoreFetch();
  }
}

async function withRecoverySetting<T>(fn: () => Promise<T>): Promise<T> {
  await setSystemSetting("google_service_account_key", "recovery-fixture", undefined);
  try {
    return await fn();
  } finally {
    await deleteSystemSetting("google_service_account_key");
  }
}

// B1. apply() — success path: precheck passes, IAM DELETE 200, IAM GET
// verifies 404, DB clear is verified, and postcheck passes.
async function testApplySuccess(): Promise<void> {
  installFetchStub({ iamGetStatus: 404, iamDeleteStatus: 200 });
  try {
    await withRecoverySetting(async () => {
      const r = await findAction().apply("ceo-user");
      assert.equal(r.state, "applied", `Expected applied, got: ${r.detail}`);
      assert.match(r.detail ?? "", /IAM GET verified 404/i, "IAM absence verified");
      assert.match(r.detail ?? "", /google_service_account_key verified absent/i, "DB cleanup verified");
      assert.match(r.detail ?? "", /Sheets lane.*verified/i, "Sheets post-check confirmed");
      assert.match(r.detail ?? "", /B-008 fully closed/i, "verified closure mentioned");
      assert.equal(iamDeleteCalls, 1, "exactly one IAM DELETE");
      assert.equal(iamGetCalls, 1, "exactly one follow-up IAM GET");
      assert.ok(oauthCalls >= 3, "precheck + IAM + postcheck token calls");
      const setting = await getSystemSettingFresh("google_service_account_key");
      assert.equal(setting, undefined, "recovery setting is cleared only on verified success");
    });
  } finally {
    restoreFetch();
  }
}

// B2. apply() — Sheets precheck fails → aborts before GCP, returns error.
async function testApplyPrecheckFails(): Promise<void> {
  installFetchStub({ iamGetStatus: 200, iamDeleteStatus: 200, precheckFail: true });
  try {
    const r = await findAction().apply("ceo-user");
    assert.equal(r.state, "error", `Expected error on precheck failure, got: ${r.state}: ${r.detail}`);
    assert.match(r.detail ?? "", /Sheets lane verification FAILED before deletion/i, "abort message present");
    assert.match(r.detail ?? "", /aborting/i, "safe-abort language present");
    assert.equal(iamDeleteCalls, 0, "no IAM DELETE attempted when precheck fails");
  } finally {
    restoreFetch();
  }
}

// B3. apply() — GCP DELETE returns 403 → blocked with least-privilege
// remediation, and the recovery setting remains intact.
async function testApplyGcp403(): Promise<void> {
  installFetchStub({ iamGetStatus: 200, iamDeleteStatus: 403 });
  try {
    await withRecoverySetting(async () => {
      const r = await findAction().apply("ceo-user");
      assert.equal(r.state, "blocked", `Expected blocked on 403, got: ${r.state}`);
      assert.match(r.detail ?? "", /403 Forbidden/i, "403 surfaced in detail");
      assert.match(r.detail ?? "", /custom role/i, "custom least-privilege role named");
      assert.match(r.detail ?? "", /iam\.serviceAccountKeys\.delete/i, "delete permission named");
      assert.match(r.detail ?? "", /iam\.serviceAccountKeys\.get/i, "verification permission named");
      assert.doesNotMatch(
        r.detail ?? "",
        /roles\/iam\.serviceAccountKeyAdmin/,
        "unsafe predefined key-admin role is never recommended",
      );
      assert.match(
        r.detail ?? "",
        /Do not grant key-create permission/i,
        "remediation explicitly forbids credential creation",
      );
      assert.match(
        r.detail ?? "",
        /Revoke the resource-scoped custom grant after the lever verifies closure/i,
        "runtime remediation requires revoking the temporary grant",
      );
      assert.match(r.detail ?? "", /Google Cloud Console/i, "manual fallback instructions present");
      assert.match(r.detail ?? "", /B-008 remains OPEN/i, "does not claim closure");
      assert.equal(iamDeleteCalls, 1, "one DELETE attempt made");
      assert.equal(iamGetCalls, 0, "no verification GET after denied DELETE");
      assert.equal(
        (await getSystemSettingFresh("google_service_account_key"))?.value,
        "recovery-fixture",
        "403 preserves the recovery setting",
      );
    });

    const runbook = readFileSync("GOOGLE_DRIVE.md", "utf8");
    assert.match(runbook, /resource-scoped custom role/i);
    assert.match(runbook, /iam\.serviceAccountKeys\.delete/i);
    assert.match(runbook, /iam\.serviceAccountKeys\.get/i);
    assert.doesNotMatch(
      runbook,
      /roles\/iam\.serviceAccountKeyAdmin/,
      "runbook must never prescribe the key-creation-capable predefined role",
    );
    assert.match(
      runbook,
      /Revoke\s+the\s+custom\s+grant\s+after\s+the\s+lever\s+verifies\s+closure/i,
      "runbook requires revoking the temporary grant",
    );
  } finally {
    restoreFetch();
  }
}

// B4. apply() — GCP DELETE 404 and verification GET 404 → applied.
async function testApplyGcpAlreadyGone(): Promise<void> {
  installFetchStub({ iamGetStatus: 404, iamDeleteStatus: 404 });
  try {
    const r = await findAction().apply("ceo-user");
    assert.equal(r.state, "applied", `Expected applied for 404-already-gone, got: ${r.state}: ${r.detail}`);
    assert.match(r.detail ?? "", /already absent/i, "already-gone phrasing present");
    assert.match(r.detail ?? "", /Sheets lane.*verified/i, "Sheets post-check runs even for 404");
  } finally {
    restoreFetch();
  }
}

// B5. apply() — Sheets postcheck fails after verified GCP deletion → error.
async function testApplyPostcheckFails(): Promise<void> {
  installFetchStub({ iamGetStatus: 404, iamDeleteStatus: 200, postcheckFail: true });
  try {
    const r = await findAction().apply("ceo-user");
    assert.equal(r.state, "error", `Expected error when postcheck fails, got: ${r.state}`);
    assert.match(r.detail ?? "", /Sheets lane.*FAILED after deletion/i, "post-failure message present");
    assert.match(r.detail ?? "", /Investigate/i, "urgency language present");
  } finally {
    restoreFetch();
  }
}

// B6. DELETE success without a verifying 404 is ambiguous: do not clear the
// recovery setting and do not claim B-008 closure.
async function testApplyDeleteAcceptedButStillVisible(): Promise<void> {
  installFetchStub({ iamGetStatus: 200, iamDeleteStatus: 204 });
  try {
    await withRecoverySetting(async () => {
      const r = await findAction().apply("ceo-user");
      assert.equal(r.state, "error", `Expected error on ambiguous deletion, got: ${r.state}`);
      assert.match(r.detail ?? "", /Follow-up IAM verification returned HTTP 200/i);
      assert.match(r.detail ?? "", /B-008 remains OPEN/i);
      assert.equal(iamDeleteCalls, 1, "one DELETE attempt made");
      assert.equal(iamGetCalls, 1, "one verification GET made");
      assert.equal(
        (await getSystemSettingFresh("google_service_account_key"))?.value,
        "recovery-fixture",
        "ambiguous deletion preserves the recovery setting",
      );
    });
  } finally {
    restoreFetch();
  }
}

// B7. The direct manual-action executor uses both a local join and a
// cluster-wide advisory lock. Clearing only the local map simulates a second
// app instance: the same action is blocked by Postgres while a different
// action still runs.
async function testManualLeverSingleFlightIsPerAction(): Promise<void> {
  const firstId = `test_manual_single_flight_a_${process.pid}`;
  const secondId = `test_manual_single_flight_b_${process.pid}`;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstCalls = 0;
  let secondCalls = 0;
  const fixture = (
    id: string,
    apply: () => Promise<{ state: "applied"; detail: string }>,
  ): ProdAction => ({
    id,
    title: id,
    description: "test-only manual lever",
    change: "test-only",
    manualLever: true,
    convergence: { kind: "converging" },
    status: async () => ({ state: "not-needed", detail: "test-only" }),
    apply,
  });
  const first = fixture(firstId, async () => {
    firstCalls++;
    await firstGate;
    return { state: "applied", detail: "first settled" };
  });
  const second = fixture(secondId, async () => {
    secondCalls++;
    return { state: "applied", detail: "second settled" };
  });
  (PROD_ACTIONS as ProdAction[]).push(first, second);
  try {
    await ensureProdActionRunsTable();
    const p1 = applyOneProdAction(firstId, null);
    for (let i = 0; i < 100 && firstCalls === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(firstCalls, 1, "first instance acquired the lock and entered apply");

    // Simulate another Node process: it has no local promise to join but
    // shares the same PostgreSQL advisory-lock space.
    __resetManualLeverAppliesForCrossInstanceTest();
    const p1Duplicate = applyOneProdAction(firstId, null);
    const p2 = applyOneProdAction(secondId, null);

    const duplicateResult = await p1Duplicate;
    assert.equal(duplicateResult.kind, "applied", "duplicate receives a truthful result");
    if (duplicateResult.kind === "applied") {
      assert.equal(
        duplicateResult.result.outcome.state,
        "blocked",
        "cross-instance duplicate is reported already in progress",
      );
      assert.match(duplicateResult.result.outcome.detail ?? "", /already firing/i);
    }
    assert.equal(firstCalls, 1, "same-action concurrent call is collapsed");
    for (let i = 0; i < 100 && secondCalls === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(secondCalls, 1, "different action executes while first remains in flight");

    // The hermetic suite caps workerPool at two connections. Each advisory
    // lock pins one, so release the first before both actions perform their
    // audit writes on a third worker connection.
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([p1, p2]);
    assert.equal(firstResult.kind, "applied", "winning request settles normally");
    assert.equal(secondResult.kind, "applied", "different lever settles independently");

    const auditRows: any = await getDb().execute(sql`
      SELECT action_id, COUNT(*)::int AS count
      FROM prod_action_runs
      WHERE action_id IN (${firstId}, ${secondId})
      GROUP BY action_id
    `);
    const counts = new Map(
      (auditRows as any).rows.map((row: any) => [row.action_id, Number(row.count)]),
    );
    assert.equal(counts.get(firstId), 1, "cross-instance duplicate does not add an audit row");
    assert.equal(counts.get(secondId), 1, "independent action writes its own audit row");
  } finally {
    releaseFirst();
    (PROD_ACTIONS as ProdAction[]).splice(
      (PROD_ACTIONS as ProdAction[]).findIndex((action) => action.id === firstId),
      2,
    );
    await getDb().execute(sql`
      DELETE FROM prod_action_runs WHERE action_id IN (${firstId}, ${secondId})
    `).catch(() => {});
  }
}

// C. Route: CEO gate + manualLever enforcement + audit row.
async function testRouteAndCeoGate(): Promise<void> {
  __resetDriveClosureProbeMemoForTest();
  installFetchStub({ iamGetStatus: 404, iamDeleteStatus: 404 });
  const originalGetUser = (storage as any).getUser;
  const CEO_ID = `ceo-4107-key-${process.pid}`;
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
  const post = async (path: string) => {
    const res = await originalFetch(`${base}${path}`, { method: "POST" });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  try {
    await runWithWorkerDb(async () => {
      await ensureProdActionRunsTable();
      await getDb().execute(
        sql`DELETE FROM prod_action_runs WHERE action_id = ${ACTION_ID}`,
      );
    });

    // Unit-level gates of applyOneProdAction (no routes needed).
    assert.deepEqual(
      await applyOneProdAction("nope_never_registered", CEO_ID),
      { kind: "not_found" },
    );

    // A regular (non-lever) action must be rejected even by CEO.
    const firstNonLever = PROD_ACTIONS.find((a) => !a.manualLever);
    assert.ok(firstNonLever, "At least one non-lever action exists in registry");
    assert.deepEqual(
      await applyOneProdAction(firstNonLever!.id, CEO_ID),
      { kind: "not_manual_lever" },
    );

    // Route: unknown id → 404.
    const missing = await post("/api/admin/prod-actions/nope_never_registered/apply");
    assert.equal(missing.status, 404, "unknown action id → 404");

    // Route: non-lever action → 400 (Apply-all-only; proves our action is NOT this).
    const nonLever = await post(`/api/admin/prod-actions/${firstNonLever!.id}/apply`);
    assert.equal(nonLever.status, 400, "non-lever action → 400");
    assert.match(
      String(nonLever.body?.error ?? ""),
      /manual.lever/i,
      "400 body explains manual-lever requirement",
    );

    // Route: our manualLever action → 200 (key already gone → not-needed, still 200).
    const fired = await post(`/api/admin/prod-actions/${ACTION_ID}/apply`);
    assert.equal(
      fired.status,
      200,
      `lever press → 200 (got ${fired.status}: ${JSON.stringify(fired.body)})`,
    );
    assert.ok(
      fired.body?.result?.outcome?.state === "applied" ||
        fired.body?.result?.outcome?.state === "not-needed",
      `lever outcome must be applied or not-needed, got: ${JSON.stringify(fired.body?.result?.outcome)}`,
    );

    // Audit row written for the lever press. The engine wraps the INSERT in a
    // best-effort try/catch — poll briefly so any in-flight commit can land
    // before we assert rather than racing the write's transaction boundary.
    let rows: any;
    for (let attempt = 0; attempt < 8; attempt++) {
      rows = await runWithWorkerDb(async () =>
        getDb().execute(
          sql`SELECT actor_user_id, outcome_state FROM prod_action_runs WHERE action_id = ${ACTION_ID}`,
        ),
      );
      if ((rows as any).rows.length >= 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(
      (rows as any).rows.length,
      1,
      "exactly one audit row written for the lever press",
    );
    assert.equal((rows as any).rows[0].actor_user_id, CEO_ID, "CEO actor recorded");
  } finally {
    await runWithWorkerDb(async () => {
      await getDb().execute(
        sql`DELETE FROM prod_action_runs WHERE action_id = ${ACTION_ID}`,
      );
    }).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (storage as any).getUser = originalGetUser;
    __test_resetReconciledUsers();
    restoreFetch();
  }
}

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  await testStatusLeverNeverPendingGcpExists();
  console.log("<<< A1 ok — status() not-needed (lever never pending) when GCP key exists; servedPurpose false");

  await testStatusUnknownNeverRetires();
  console.log("<<< A2 ok — status() not-needed with unverified-key detail when probe throws; unknown never retires");

  await testStatusFullyClosedRetires();
  console.log("<<< A3 ok — status() not-needed + fully-closed detail when GCP 404 + DB absent; servedPurpose retires");

  await testApplySuccess();
  console.log("<<< B1 ok — apply() success: precheck → DELETE → DB clear → postcheck");

  await testApplyPrecheckFails();
  console.log("<<< B2 ok — apply() precheck failure aborts before GCP");

  await testApplyGcp403();
  console.log("<<< B3 ok — apply() GCP 403 surfaces manual-console fallback");

  await testApplyGcpAlreadyGone();
  console.log("<<< B4 ok — apply() GCP 404 (already gone) → applied");

  await testApplyPostcheckFails();
  console.log("<<< B5 ok — apply() postcheck failure after deletion → error");

  await testApplyDeleteAcceptedButStillVisible();
  console.log("<<< B6 ok — accepted DELETE without verified absence preserves recovery setting");

  await testManualLeverSingleFlightIsPerAction();
  console.log("<<< B7 ok — direct manual-lever single-flight is keyed per action");

  await testRouteAndCeoGate();
  console.log("<<< C ok — route: CEO gate, non-lever 400, lever press 200 + audit row");

  // Close the undici keep-alive sockets opened by testRouteAndCeoGate's
  // fetch calls to the local express server — without this the event loop
  // stays alive and the test runner scores a timeout SIGKILL even though
  // every assertion passed. See route-test-undici-drain-hang.md.
  try {
    const undici = await import("undici");
    await undici.getGlobalDispatcher().close();
  } catch { /* best-effort */ }

  // Explicit exit so the DB worker-pool idle connections don't keep the
  // process alive after all assertions pass (matching the process.exit(1)
  // in the catch path below).
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
