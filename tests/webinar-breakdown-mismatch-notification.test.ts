/* test-registration
{
  "name": "Webinar breakdown ≠ Hot Transfers save-time notification fan-out + dedupe (Task #2851)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2851: save-time mismatch notification — a marketing-section PUT that LEAVES breakdown sum > 0 and ≠ Hot Transfers must notify the saving editor + report owner (signature-keyed dedupe, deep link to the report), and a fixing/zeroing save must send nothing. Fast (~10s), notification writes isolated via a cloned user_notifications table — gate it so the proactive warning path can't silently rot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2851 — Warn operators the moment a Hot Transfers edit stops matching
 * the saved breakdown.
 *
 * The editor shows an inline mismatch warning (Task #2839) and the CEO panel
 * surfaces existing mismatches (Task #2843), but nothing proactively pings
 * anyone when a NEW mismatch is created. This test locks the third leg:
 * saving a marketing section that LEAVES breakdown sum > 0 and ≠ hotTransfers
 * triggers a de-duplicated notifyUser() notification to the saving editor and
 * the report owner, with a deep link to /reports/{id}.
 *
 * Asserted invariants:
 *  1. Mismatching save → one `system` notification each for the editor and
 *     the report owner, dedupeKey `webinar-breakdown-mismatch:<sig>`,
 *     deepLink `/reports/<id>`.
 *  2. Repeating the SAME mismatching save → no second unread row (dedupe).
 *  3. A save with DIFFERENT mismatching values → fresh signature → fresh row.
 *  4. A save that fixes the breakdown (sum == hotTransfers) → no notification.
 *  5. A save that zeroes the breakdown → no notification.
 *
 * The isolated schema clones `user_notifications` so notification writes
 * never touch the live table; report/client/user seeds fall through to
 * `public` with run-unique IDs (same pattern as webinar-lead-quality-edit)
 * and are deleted in the finally block.
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";

import { registerReportRoutes } from "../server/routes/reports";
import { computeWebinarBreakdown } from "../server/services/webinarBreakdownMismatchReview";
import { runInIsolatedSchema, sql } from "./db-sandbox";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const TAG = `task-2851-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACTOR_ID = `${TAG}-actor`;
const OWNER_ID = `${TAG}-owner`;
const CLIENT_ID = `${TAG}-client`;
const REPORT_ID = `${TAG}-report`;
const REPORT_MONTH = "2026-06";

// ── Pure predicate checks (no server, no DB) ─────────────────────────────────

function testComputeWebinarBreakdown() {
  assert.deepEqual(
    computeWebinarBreakdown({
      webinar: {
        hotTransfers: 29,
        leadQuality: { good: 20, notQuotable: 5, missedCalls: 3, noData: 1 },
      },
    }),
    { breakdownSum: 29, hotTransfers: 29 },
    "sums the four breakdown fields and reads hotTransfers",
  );
  assert.deepEqual(
    computeWebinarBreakdown({}),
    { breakdownSum: 0, hotTransfers: 0 },
    "missing webinar block counts as zeros",
  );
  assert.deepEqual(
    computeWebinarBreakdown({
      webinar: { hotTransfers: "44", leadQuality: { good: "10", noData: "x" } },
    }),
    { breakdownSum: 10, hotTransfers: 44 },
    "numeric strings coerce; non-numeric counts as 0 (mirrors the SQL COALESCE)",
  );
  console.log("  [ok] computeWebinarBreakdown mirrors the shared predicate inputs");
}

// ── Server-route tests ───────────────────────────────────────────────────────

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id. Only user_notifications is cloned into
    // the isolated schema; users fall through to the committed public schema,
    // so requireAuth's real lookup resolves them without the registry.
    (req as any).__test_clerkUserId = ACTOR_ID;
    next();
  });
  registerReportRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function marketingWith(webinar: Record<string, unknown>): Record<string, unknown> {
  return { totalLeads: 70, webinar: { registrants: 100, attendees: 60, ...webinar } };
}

async function seed(isoDb: any): Promise<void> {
  for (const [id, first] of [
    [ACTOR_ID, "Editor"],
    [OWNER_ID, "Owner"],
  ] as const) {
    await isoDb.execute(sql`
      INSERT INTO users (id, role, email, first_name, last_name)
      VALUES (${id}, 'ceo', ${`${id}@example.com`}, ${first}, 'MismatchTester')
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
    `);
  }
  await isoDb.execute(sql`
    INSERT INTO clients (id, firm_name, products)
    VALUES (${CLIENT_ID}, ${"Mismatch Notify Firm"}, ARRAY['webinar']::text[])
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO reports (id, client_id, report_month, status, created_by)
    VALUES (${REPORT_ID}, ${CLIENT_ID}, ${REPORT_MONTH}, 'draft', ${OWNER_ID})
    ON CONFLICT (id) DO NOTHING
  `);
  await isoDb.execute(sql`
    INSERT INTO report_sections (report_id, section_key, data)
    VALUES (
      ${REPORT_ID}, 'marketing',
      ${JSON.stringify(marketingWith({ hotTransfers: 44, leadQuality: { good: 44, notQuotable: 0, missedCalls: 0, noData: 0 } }))}::jsonb
    )
    ON CONFLICT (report_id, section_key) DO UPDATE SET data = EXCLUDED.data
  `);
}

async function cleanupPublicSeeds(isoDb: any): Promise<void> {
  // Seeds fell through to public.* (only user_notifications was cloned);
  // delete them in FK order. Best-effort — unique IDs make leftovers inert.
  try {
    await isoDb.execute(sql`DELETE FROM public.report_section_history WHERE report_id = ${REPORT_ID}`);
    await isoDb.execute(sql`DELETE FROM public.report_sections WHERE report_id = ${REPORT_ID}`);
    await isoDb.execute(sql`DELETE FROM public.reports WHERE id = ${REPORT_ID}`);
    await isoDb.execute(sql`DELETE FROM public.clients WHERE id = ${CLIENT_ID}`);
    await isoDb.execute(sql`DELETE FROM public.users WHERE id IN (${ACTOR_ID}, ${OWNER_ID})`);
  } catch (err: any) {
    console.warn("  [warn] public seed cleanup failed:", err?.message ?? err);
  }
}

interface NotificationRow {
  user_id: string;
  category: string;
  dedupe_key: string | null;
  deep_link: string | null;
  title: string;
}

async function fetchNotifications(isoDb: any): Promise<NotificationRow[]> {
  const res = await isoDb.execute(sql`
    SELECT user_id, category, dedupe_key, deep_link, title
    FROM user_notifications
    ORDER BY created_at, user_id
  `);
  return (res.rows ?? res) as NotificationRow[];
}

async function putMarketing(baseUrl: string, webinar: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}/api/reports/${REPORT_ID}/sections/marketing`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: marketingWith(webinar), editSource: "ui_edit" }),
  });
  assert.equal(res.status, 200, `PUT returned ${res.status}`);
}

async function testNotificationFlow() {
  await runInIsolatedSchema(
    async ({ db: isoDb }) => {
      await seed(isoDb);

      const app = buildApp();
      const { server, baseUrl } = await listen(app);

      try {
        // 1. Save that LEAVES a mismatch: HT edited 44 → 29, breakdown stays 44.
        await putMarketing(baseUrl, {
          hotTransfers: 29,
          leadQuality: { good: 44, notQuotable: 0, missedCalls: 0, noData: 0 },
        });

        let rows = await fetchNotifications(isoDb);
        const expectedKey = `webinar-breakdown-mismatch:${REPORT_ID}:29:44`;
        assert.equal(rows.length, 2, `editor + owner notified (got ${rows.length})`);
        const recipients = rows.map((r) => r.user_id).sort();
        assert.deepEqual(recipients, [ACTOR_ID, OWNER_ID].sort(), "recipients are editor + report owner");
        for (const row of rows) {
          assert.equal(row.category, "system", "category is system");
          assert.equal(row.dedupe_key, expectedKey, "dedupeKey embeds the mismatch signature");
          assert.equal(row.deep_link, `/reports/${REPORT_ID}`, "deep link points at the report");
        }
        console.log("  [ok] mismatching save notifies editor + owner with signature dedupe key");

        // 2. Identical mismatching save again → deduped while unread.
        await putMarketing(baseUrl, {
          hotTransfers: 29,
          leadQuality: { good: 44, notQuotable: 0, missedCalls: 0, noData: 0 },
        });
        rows = await fetchNotifications(isoDb);
        assert.equal(rows.length, 2, "repeat save with the SAME mismatch is deduped");
        console.log("  [ok] repeating the same mismatch does not re-notify");

        // 3. Different mismatching values → new signature → fresh notifications.
        await putMarketing(baseUrl, {
          hotTransfers: 30,
          leadQuality: { good: 44, notQuotable: 0, missedCalls: 0, noData: 0 },
        });
        rows = await fetchNotifications(isoDb);
        assert.equal(rows.length, 4, "changed mismatch values produce a fresh notification pair");
        const freshKey = `webinar-breakdown-mismatch:${REPORT_ID}:30:44`;
        assert.equal(
          rows.filter((r) => r.dedupe_key === freshKey).length,
          2,
          "fresh pair carries the new signature",
        );
        console.log("  [ok] a changed mismatch produces a fresh signature + notification");

        // 4. Fixing the breakdown (sum == hotTransfers) → nothing new.
        await putMarketing(baseUrl, {
          hotTransfers: 30,
          leadQuality: { good: 25, notQuotable: 3, missedCalls: 1, noData: 1 },
        });
        rows = await fetchNotifications(isoDb);
        assert.equal(rows.length, 4, "fixing save sends no notification");
        console.log("  [ok] a save that fixes the breakdown sends nothing");

        // 5. Zeroing the breakdown (fallback to HT × 1.6 kicks in) → nothing new.
        await putMarketing(baseUrl, {
          hotTransfers: 30,
          leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
        });
        rows = await fetchNotifications(isoDb);
        assert.equal(rows.length, 4, "zeroing save sends no notification");
        console.log("  [ok] a save that zeroes the breakdown sends nothing");
      } finally {
        await closeServer(server);
        await cleanupPublicSeeds(isoDb);
        await getGlobalDispatcher().close();
      }
    },
    { tables: ["user_notifications"] },
  );
}

async function main() {
  console.log("webinar-breakdown-mismatch-notification: save-time notifyUser fan-out (Task #2851)");

  console.log("  running pure predicate checks ...");
  testComputeWebinarBreakdown();

  console.log("  running save-time notification flow (server + isolated DB) ...");
  await testNotificationFlow();

  console.log("PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
