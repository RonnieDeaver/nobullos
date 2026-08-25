/* test-registration
{
  "name": "Feedback submitter name after Clerk cutover (Task #4777)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4777: pins the POST /api/feedback display-name snapshot to the authenticated users row (first+last → email → 'Unknown') through the real route + requireAuth Clerk seam, and the repair_feedback_unknown_submitter_names prod action's rename predicate (system: sentinel exclusion, deleted/ghost users left-and-reported, already-named no-op, CAS idempotence). A regression here silently refiles every human feedback as 'Unknown' across the Slack relay, admin bell pings, and the admin console — exactly the 2026-08-13 cutover incident this task repairs. Fast, deterministic, hermetic-DB only.",
  "tier": "small"
}
test-registration */
/**
 * Task #4777 — regression coverage for the feedback submitter-name snapshot.
 *
 * The Clerk cutover (2026-08-13) reduced the legacy-compat req.user.claims to
 * { sub, role }, so POST /api/feedback — which read the retired
 * claims.first_name/claims.email fields — filed every submission with
 * user_name = 'Unknown'. Pinned behavior:
 *
 *   1. Route write path (REAL registerFeedbackRoutes + requireAuth via the
 *      __test_clerkUserId seam, real hermetic DB):
 *        - a user with first+last name files as "First Last";
 *        - a user with only an email files as that email;
 *        - user_id derivation is untouched (still the auth sub);
 *        - anonymous callers still 401.
 *   2. deriveFeedbackSubmitterName unit pins: name beats email, email beats
 *      "Unknown", "Unknown" ONLY when the row carries neither (so a future
 *      auth-shape change that stops populating req.dbUser fails loudly here).
 *   3. repair_feedback_unknown_submitter_names prod action:
 *        - registered, converging, humanGate drain declaration;
 *        - status() pending while renameable rows exist, detail surfaces the
 *          left-alone (unmatched) rows;
 *        - apply() renames ONLY non-system 'Unknown' rows matching a live
 *          users row (name, else email) — system: sentinel rows, already-named
 *          rows, ghost-user rows, and deleted-user rows are untouched;
 *        - second press converges to not-needed (CAS idempotence).
 *
 * No Slack egress: the hermetic DB stores no slack_bot_token, so the relay
 * probe short-circuits to not_connected without a network call, and every
 * directly-seeded row carries a terminal slack_status + the synthetic marker
 * so no retry scheduler could ever pick it up.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  registerFeedbackRoutes,
  deriveFeedbackSubmitterName,
} from "../server/routes/feedback";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import { SYNTHETIC_FEEDBACK_TEST_MARKER } from "../server/services/feedbackSlackRetry";

const RUN = `task-4777-${Date.now()}-${randomBytes(3).toString("hex")}`;

const NAMED_ID = `${RUN}-named`;
const NAMED_EMAIL = `${RUN}-talente@nobullmarketing.test`;
const EMAILONLY_ID = `${RUN}-emailonly`;
const EMAILONLY_EMAIL = `${RUN}-jdavis@nobullmarketing.test`;
const DELETED_ID = `${RUN}-deleted`;
const GHOST_ID = `${RUN}-ghost`;
const SYSTEM_ID = `system:${RUN}-sweep`;

// Terminal slack_status + synthetic marker on every directly-seeded row so
// the feedback→Slack retry scheduler can never treat one as a real
// undelivered candidate (Task #2783 convention).
const SYNTHETIC_SLACK_REASON = `${SYNTHETIC_FEEDBACK_TEST_MARKER} (${RUN}) — never send to Slack`;

let failures = 0;
const trackedFeedbackIds: number[] = [];

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

// ── Schema + fixtures ───────────────────────────────────────────────────────
// user_feedback is boot-created raw SQL (registerFeedbackRoutes), not part of
// the drizzle schema, so the hermetic per-run DB may not have it yet — ensure
// it exists before the route's own detached DDL chain races the first request.
async function ensureFeedbackTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id serial PRIMARY KEY,
      user_id varchar NOT NULL,
      user_name varchar NOT NULL,
      topic varchar NOT NULL DEFAULT 'OTHER',
      feedback_text text NOT NULL,
      current_page varchar,
      screenshots text DEFAULT '[]',
      status varchar NOT NULL DEFAULT 'pending',
      slack_status varchar NOT NULL DEFAULT 'pending',
      slack_reason text,
      slack_updated_at timestamp,
      slack_attempts integer NOT NULL DEFAULT 0,
      created_at timestamp DEFAULT now()
    )
  `);
}

async function ensureUsers(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES (${NAMED_ID}, ${NAMED_EMAIL}, 'Talente', 'Ngcobo', 'account_manager')
    ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email, first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name, role = EXCLUDED.role, deleted_at = NULL
  `);
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES (${EMAILONLY_ID}, ${EMAILONLY_EMAIL}, NULL, NULL, 'account_manager')
    ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email, first_name = NULL,
          last_name = NULL, role = EXCLUDED.role, deleted_at = NULL
  `);
  // Soft-deleted user — the repair action must NEVER adopt this row's name.
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, deleted_at)
    VALUES (${DELETED_ID}, ${`${RUN}-gone@nobullmarketing.test`}, 'Gone', 'User', 'account_manager', NOW())
    ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email, first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name, role = EXCLUDED.role, deleted_at = NOW()
  `);
}

// SIGKILL-safe: the RUN tag is timestamp-suffixed, so a prior run's finally
// may never have executed. Prune any leftovers from earlier runs at startup
// (same prune-to-baseline pattern as tests/feedback-video-upload-processing).
async function pruneLeftoverSyntheticRows(): Promise<void> {
  await db
    .execute(sql`
      DELETE FROM user_feedback
      WHERE user_id LIKE 'task-4777-%' OR user_id LIKE 'system:task-4777-%'
    `)
    .catch(() => {});
  await db.execute(sql`DELETE FROM users WHERE id LIKE 'task-4777-%'`).catch(() => {});
}

async function seedFeedbackRow(
  userId: string,
  userName: string,
): Promise<number> {
  const rows = await db.execute(sql`
    INSERT INTO user_feedback (user_id, user_name, topic, feedback_text, slack_status, slack_reason)
    VALUES (${userId}, ${userName}, 'OTHER', ${`${RUN} repair fixture`}, 'undeliverable', ${SYNTHETIC_SLACK_REASON})
    RETURNING id
  `);
  const id = Number((rows as any).rows[0].id);
  trackedFeedbackIds.push(id);
  return id;
}

async function readFeedbackRow(
  id: number,
): Promise<{ user_id: string; user_name: string } | null> {
  const rows = await db.execute(
    sql`SELECT user_id, user_name FROM user_feedback WHERE id = ${id}`,
  );
  const row = (rows as any).rows[0];
  return row ? { user_id: String(row.user_id), user_name: String(row.user_name) } : null;
}

async function cleanup(): Promise<void> {
  // Best-effort bell-row cleanup: the POST route fans a notifyUser ping out
  // to responsible admins; scope the delete to THIS run's feedback ids.
  for (const id of trackedFeedbackIds) {
    await db
      .execute(
        sql`DELETE FROM user_notifications WHERE metadata->>'feedbackId' = ${String(id)}`,
      )
      .catch(() => {});
  }
  await db
    .execute(sql`
      DELETE FROM user_feedback
      WHERE user_id LIKE 'task-4777-%' OR user_id LIKE 'system:task-4777-%'
    `)
    .catch(() => {});
  await db.execute(sql`DELETE FROM users WHERE id LIKE 'task-4777-%'`).catch(() => {});
}

// ── Harness: REAL feedback routes + requireAuth Clerk seam ─────────────────
let actingUserId: string | null = null;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated.
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerFeedbackRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postFeedback(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

async function submittedRowByText(
  feedbackText: string,
): Promise<{ id: number; user_id: string; user_name: string }> {
  const rows = await db.execute(sql`
    SELECT id, user_id, user_name FROM user_feedback
    WHERE feedback_text = ${feedbackText}
    ORDER BY id DESC
  `);
  const row = (rows as any).rows[0];
  assert(row, `submitted feedback row not found for text: ${feedbackText}`);
  const id = Number(row.id);
  trackedFeedbackIds.push(id);
  return { id, user_id: String(row.user_id), user_name: String(row.user_name) };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("Feedback submitter name after Clerk cutover (Task #4777)");

  await ensureFeedbackTable();
  await pruneLeftoverSyntheticRows();
  await ensureUsers();

  const { server, baseUrl } = await listen(buildApp());

  try {
    // ── (1) Route write path ────────────────────────────────────────────
    await step("route: named user files as 'First Last' with user_id untouched", async () => {
      actingUserId = NAMED_ID;
      const text = `${RUN} route submission (named)`;
      const r = await postFeedback(baseUrl, { topic: "OTHER", text });
      assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.success, true, "success flag");
      const row = await submittedRowByText(text);
      assert.equal(row.user_name, "Talente Ngcobo", "user_name = first + last from the users row");
      assert.equal(row.user_id, NAMED_ID, "user_id derivation untouched (auth sub)");
    });

    await step("route: email-only user falls back to the email", async () => {
      actingUserId = EMAILONLY_ID;
      const text = `${RUN} route submission (email-only)`;
      const r = await postFeedback(baseUrl, { topic: "BUG_REPORT", text });
      assert.equal(r.status, 200, `expected 200, got ${r.status}`);
      const row = await submittedRowByText(text);
      assert.equal(row.user_name, EMAILONLY_EMAIL, "user_name = email when no name is set");
      assert.equal(row.user_id, EMAILONLY_ID, "user_id untouched");
    });

    await step("route: anonymous callers still 401 (auth gate untouched)", async () => {
      actingUserId = null;
      const r = await postFeedback(baseUrl, { topic: "OTHER", text: `${RUN} anon` });
      assert.equal(r.status, 401, `expected 401, got ${r.status}`);
    });

    // ── (2) Unit pins for the fallback chain ────────────────────────────
    await step("unit: deriveFeedbackSubmitterName fallback chain", async () => {
      assert.equal(
        deriveFeedbackSubmitterName({ firstName: "Talente", lastName: "Ngcobo", email: "t@x.co" }),
        "Talente Ngcobo",
        "name beats email",
      );
      assert.equal(
        deriveFeedbackSubmitterName({ firstName: "Jane", lastName: null, email: "j@x.co" }),
        "Jane",
        "first name alone is a name",
      );
      assert.equal(
        deriveFeedbackSubmitterName({ firstName: "  ", lastName: "", email: " j@x.co " }),
        "j@x.co",
        "whitespace-only names fall through to trimmed email",
      );
      assert.equal(
        deriveFeedbackSubmitterName({ firstName: null, lastName: null, email: null }),
        "Unknown",
        "'Unknown' only when the row carries neither name nor email",
      );
      assert.equal(deriveFeedbackSubmitterName(undefined), "Unknown", "missing dbUser → 'Unknown'");
      assert.equal(deriveFeedbackSubmitterName(null), "Unknown", "null dbUser → 'Unknown'");
    });

    // ── (3) Repair prod action ──────────────────────────────────────────
    const action = PROD_ACTIONS.find(
      (a) => a.id === "repair_feedback_unknown_submitter_names",
    );

    await step("action: registered as converging with a humanGate drain declaration", async () => {
      assert(action, "repair_feedback_unknown_submitter_names must be registered");
      assert.equal(action!.convergence.kind, "converging", "converging taxonomy");
      assert(
        typeof action!.humanGate?.reason === "string" && action!.humanGate.reason.length > 0,
        "humanGate reason declared (operator-reviewed one-shot repair)",
      );
      assert.equal(action!.selfHeal, undefined, "never auto-fired via self-heal");
      assert.equal(action!.manualLever, undefined, "ordinary converging action, not a lever");
    });

    // Fixtures spanning every predicate branch.
    const fixNamed = await seedFeedbackRow(NAMED_ID, "Unknown");
    const fixEmail = await seedFeedbackRow(EMAILONLY_ID, "Unknown");
    const fixSystem = await seedFeedbackRow(SYSTEM_ID, "Unknown");
    const fixAlready = await seedFeedbackRow(NAMED_ID, "Already Named");
    const fixGhost = await seedFeedbackRow(GHOST_ID, "Unknown");
    const fixDeleted = await seedFeedbackRow(DELETED_ID, "Unknown");

    await step("action: status() pending + left-alone rows surfaced", async () => {
      const s = await action!.status();
      assert.equal(s.state, "pending", `expected pending, got ${s.state} (${s.detail})`);
      assert.match(s.detail, /left alone/i, "detail surfaces the unmatched left-alone rows");
    });

    await step("action: apply() renames exactly the matching non-system 'Unknown' rows", async () => {
      const outcome = await action!.apply();
      assert.equal(outcome.state, "applied", `expected applied, got ${outcome.state} (${outcome.detail})`);
      assert(
        (outcome as any).rowsAffected >= 2,
        `rowsAffected must cover both renameable fixtures, got ${(outcome as any).rowsAffected}`,
      );

      assert.equal(
        (await readFeedbackRow(fixNamed))?.user_name,
        "Talente Ngcobo",
        "matched user with a name → renamed to first + last (same derivation as the route)",
      );
      assert.equal(
        (await readFeedbackRow(fixEmail))?.user_name,
        EMAILONLY_EMAIL,
        "matched user with only an email → renamed to the email",
      );
      assert.equal(
        (await readFeedbackRow(fixSystem))?.user_name,
        "Unknown",
        "system: sentinel rows are excluded — sweep/canary items own their user_name",
      );
      assert.equal(
        (await readFeedbackRow(fixAlready))?.user_name,
        "Already Named",
        "already-named rows are a no-op (CAS guard: WHERE user_name = 'Unknown')",
      );
      assert.equal(
        (await readFeedbackRow(fixGhost))?.user_name,
        "Unknown",
        "rows with no matching users row are left alone",
      );
      assert.equal(
        (await readFeedbackRow(fixDeleted))?.user_name,
        "Unknown",
        "rows whose only match is a soft-deleted users row are left alone",
      );
      assert.match(
        outcome.detail,
        /left alone/i,
        "applied detail reports the deliberately-untouched rows",
      );
    });

    await step("action: second press converges to not-needed (idempotent)", async () => {
      const s = await action!.status();
      assert.equal(s.state, "not-needed", `expected not-needed, got ${s.state} (${s.detail})`);
      const outcome = await action!.apply();
      assert.equal(outcome.state, "not-needed", `second apply must be not-needed, got ${outcome.state}`);
    });
  } finally {
    server.close();
    await cleanup();
  }

  if (failures > 0) {
    console.error(`feedback-submitter-name: ${failures} step(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("feedback-submitter-name: all steps passed");
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit(),
// so a leaked handle surfaces as a real hang instead of being masked.
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
