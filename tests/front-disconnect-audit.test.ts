/* test-registration
{
  "name": "Front credential-clear auditing (Task #2007)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2007 — Front credential-clear auditing.
 *
 * Task #1977 added a scoped `admin_setting_audit` breadcrumb to every
 * integration's credential clear so the credential history can tell a
 * deliberate operator disconnect apart from an automatic terminal-auth
 * self-wipe. PandaDoc and Slack already had regression coverage; this
 * locks the same invariants in for Front.
 *
 * The transient-vs-terminal refresh split (a 5xx / network blip must NOT
 * wipe the token) is already covered by tests/oauth-refresh-single-flight
 * and the Front probe-classification tests; this test focuses on the
 * disconnect audit:
 *
 *   1. Manual disconnect → tokens cleared, exactly one audit row scoped
 *      `manual_disconnect` with newValues.trigger=manual_disconnect.
 *   2. Default trigger (no options) → also `manual_disconnect`.
 *   3. Terminal-auth disconnect → tokens cleared, audit row scoped
 *      `connect_terminal_auth_error` carrying the reason.
 *
 * Task #2240 — credential isolation via in-memory override. Front stores
 * its credential in the shared `system_settings` table, which the live
 * `Start application` Front worker keeps re-writing in the `public` schema
 * while this test runs (it refreshes the real token on its own cadence).
 * Against the shared dev DB that race re-seeds the access token between the
 * disconnect call and the assertion, so "access token must be cleared on
 * disconnect" flaked whenever the full suite ran. We now drive the seeded
 * credential through `__setFrontCredentialStoreOverrideForTests`: a tiny
 * in-memory `Map` this suite owns end-to-end. `disconnect` clears that map
 * instead of `system_settings`, so the credential assertion never touches
 * a row the live worker also writes. The audit breadcrumb still goes to
 * the DB, so we keep `runInIsolatedSchema` (cloning only `users` +
 * `admin_setting_audit`) for deterministic audit counts and the Task #2031
 * FK-attribution coverage.
 */
import assert from "node:assert/strict";
import { storage } from "../server/storage";
import { getDb } from "../server/db";
import { users } from "@shared/schema";
import {
  disconnect,
  __setFrontCredentialStoreOverrideForTests,
} from "../server/services/frontIntegration";
import { runInIsolatedSchema, sql } from "./db-sandbox";

// Front stores its OAuth credential in `system_settings`; the audit
// breadcrumb is keyed on the access-token setting (stable key).
const SETTINGS_KEY_ACCESS = "front_access_token";
const SETTINGS_KEY_REFRESH = "front_refresh_token";
const SETTINGS_KEY_EXPIRES = "front_token_expires_at";

// Task #2240 — the suite-owned in-memory credential store. `disconnect`
// writes its credential clears here (never `system_settings`) once the
// override is installed.
const credStore = new Map<string, string>();

function getAccess(): string {
  return credStore.get(SETTINGS_KEY_ACCESS) ?? "";
}

function getRefresh(): string {
  return credStore.get(SETTINGS_KEY_REFRESH) ?? "";
}

function seedTokens(token: string): void {
  credStore.set(SETTINGS_KEY_ACCESS, token);
  credStore.set(SETTINGS_KEY_REFRESH, `${token}-refresh`);
  credStore.set(SETTINGS_KEY_EXPIRES, String(Date.now() + 3_600_000));
}

async function listClearAudit(scope: string) {
  return storage.listAdminSettingAudit({ settingKey: SETTINGS_KEY_ACCESS, scope, limit: 5 });
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}:`, err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  }
}

async function main(): Promise<void> {
  console.log("Front credential-clear auditing (Task #2007)");

  // Task #2240 — install the in-memory credential override for the whole
  // run so disconnect's credential clears never touch the shared
  // `system_settings` rows the live Front worker keeps re-writing.
  __setFrontCredentialStoreOverrideForTests(credStore);
  try {
    // The audit breadcrumb still goes to the DB; isolate only `users` +
    // `admin_setting_audit` so every before/after count is exact and the
    // Task #2031 FK-attribution path is genuinely enforced in-schema.
    await runInIsolatedSchema(
      async ({ db }) => {
        await step("manual disconnect → tokens cleared, audit row scoped manual_disconnect", async () => {
          seedTokens("front-manual-fake");
          assert.equal(getAccess(), "front-manual-fake");
          const before = (await listClearAudit("manual_disconnect")).length;
          await disconnect(undefined, { trigger: "manual_disconnect" });
          assert.equal(getAccess(), "", "access token must be cleared on disconnect");
          assert.equal(getRefresh(), "", "refresh token must be cleared on disconnect");
          const after = await listClearAudit("manual_disconnect");
          assert.equal(after.length, before + 1, "exactly one manual_disconnect audit row must be written");
          const nv = after[0].newValues as any;
          assert.equal(nv?.event, "disconnect");
          assert.equal(nv?.trigger, "manual_disconnect");
        });

        await step("default trigger (no options) → manual_disconnect audit row", async () => {
          seedTokens("front-default-fake");
          const before = (await listClearAudit("manual_disconnect")).length;
          await disconnect();
          assert.equal(getAccess(), "");
          const after = await listClearAudit("manual_disconnect");
          assert.equal(after.length, before + 1, "default disconnect must default to manual_disconnect");
          assert.equal((after[0].newValues as any)?.trigger, "manual_disconnect");
        });

        await step("terminal-auth disconnect → tokens cleared, audit row scoped connect_terminal_auth_error", async () => {
          seedTokens("front-terminal-fake");
          const before = (await listClearAudit("connect_terminal_auth_error")).length;
          await disconnect(undefined, {
            trigger: "connect_terminal_auth_error",
            reason: "refresh_permanent_401",
            notes: "Front refresh rejected",
          });
          assert.equal(getAccess(), "", "access token must be cleared on terminal-auth wipe");
          const after = await listClearAudit("connect_terminal_auth_error");
          assert.equal(after.length, before + 1, "exactly one terminal-auth audit row must be written");
          const nv = after[0].newValues as any;
          assert.equal(nv?.trigger, "connect_terminal_auth_error");
          assert.equal(nv?.reason, "refresh_permanent_401");
          assert.equal(nv?.notes, "Front refresh rejected");
        });

        // Task #2031 — staff identity must be recorded when a genuine
        // signed-in admin (not the system actor) performs the disconnect.
        // The original Task #2007 effort could only exercise the system /
        // null path: passing a fabricated user id violates the FK on
        // `admin_setting_audit.changed_by`. That FK is dropped by
        // `CREATE TABLE … (LIKE …)`, so we re-add it to the cloned table
        // here — making the constraint genuinely enforced in-schema — then
        // seed a real `users` row so a *real* admin id satisfies it. (The
        // credential now lives in the in-memory override, so the old
        // `system_settings.updated_by` FK re-add is no longer needed.)
        await step("manual disconnect by a real signed-in admin → audit changedBy == that user id", async () => {
          await db.execute(
            sql`ALTER TABLE admin_setting_audit ADD CONSTRAINT iso_asa_changed_by_fk FOREIGN KEY (changed_by) REFERENCES users(id)`,
          );
          const adminId = `u-2031-front-${Date.now()}`;
          await getDb().insert(users).values({ id: adminId, email: `${adminId}@test.local` });

          seedTokens("front-actor-fake");
          await disconnect(adminId, { trigger: "manual_disconnect" });
          assert.equal(getAccess(), "", "access token must be cleared on a real-admin disconnect");

          const rows = await storage.listAdminSettingAudit({
            settingKey: SETTINGS_KEY_ACCESS,
            scope: "manual_disconnect",
            changedByIn: [adminId],
            limit: 5,
          });
          assert.equal(rows.length, 1, "exactly one audit row must be attributed to the seeded admin");
          assert.equal(rows[0].changedBy, adminId, "audit changedBy must equal the signed-in admin's user id");
          assert.equal((rows[0].newValues as any)?.trigger, "manual_disconnect");
        });
      },
      { tables: ["users", "admin_setting_audit"] },
    );
  } finally {
    __setFrontCredentialStoreOverrideForTests(null);
  }

  if (failures > 0) throw new Error(`${failures} test(s) failed`);
  console.log("\nAll Front credential-clear auditing tests passed");
}

let exitCode = 0;
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main()
  .catch((err) => {
    console.error("Test runner failed:", err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
