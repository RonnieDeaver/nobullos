/* test-registration
{
  "name": "Prod-action feeder convergence fixes (Task #3533)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3533: feeder fixes that let four perpetually-recurring CEO prod-actions converge — webhook thread envelopes terminal at ingest, mark_legacy predicate (1h guard + email_message exclusion), competitor no-URL pre-stamp at ingest, and report-section convergence-stamp preservation on webhook re-import + section PUT.",
  "extraNodeArgs": [
    "--import",
    "./tests/helpers/parseReportPdfSetup.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #3533 — feeder fixes that let four perpetually-recurring CEO
 * prod-actions converge to "not needed" permanently. Each part proves one
 * upstream fix at its source:
 *
 *  Part 1a — `applyFrontWebhookResult` writes Front thread-envelope rows
 *            TERMINAL at ingest (`processing_status='processed'`, reason
 *            `webhook_thread_envelope_no_analysis_path`), instead of the old
 *            `pending` that fed `mark_legacy_front_email_pending_terminal`
 *            100–450 rows/day forever.
 *  Part 1b — `mark_legacy_front_email_pending_terminal`'s predicate: the
 *            30-day age floor is replaced by a 1-hour freshness guard AND
 *            `source_subtype IS DISTINCT FROM 'email_message'` (the study
 *            driver transiently flips those to pending). Old email_thread
 *            pending rows drain; fresh rows and email_message rows survive.
 *  Part 3  — `storeCompetitorData` pre-stamps `gbp_url_backfill_attempted_at`
 *            on freshly-ingested competitor rows with NO GBP URL (a later
 *            backfill re-fetch cannot do better), so the daily heatmap-scan
 *            trickle stays out of `backfill_competitor_location_labels`'
 *            candidate set. Rows WITH a URL stay NULL-stamped.
 *  Part 2/4 — report section writers preserve/stamp convergence markers:
 *            - webhook import stamps intake/sales with the Common Issues
 *              reformat stamp, and a RE-import preserves the marketing
 *              section's June-2026 lead-reparse stamps instead of wiping
 *              them (which re-armed `reparse_june_2026_report_leads`).
 *            - the section PUT carries stamps forward from the stored
 *              section when the client payload omits them, and stamps
 *              intake/sales fresh on editSource 'ai_format'.
 *
 * Isolation:
 *  - Parts 1a/1b run in `runInTxSandbox` (all touched code uses getDb()).
 *  - Part 3's `storeCompetitorData` imports the BARE `db`, so it runs
 *    against public with unique IDs and a `finally` cleanup.
 *  - Part 2/4 runs the real express report routes inside
 *    `runInIsolatedSchema({ pinGetDbForCrossAsync: true })`; the webhook's
 *    import-log row lands in public via the bare `db` and is cleaned up.
 *    `parseReportPdf` is redirected to a configurable stub via the resolve
 *    hook registered through `--import ./tests/helpers/parseReportPdfSetup.mjs`
 *    (see run-all.ts).
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";
import { eq, inArray } from "drizzle-orm";

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { db, getDb } from "../server/db";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";
import { runInTxSandbox, runInIsolatedSchema, sql } from "./db-sandbox";
import {
  rawCommunicationRecords,
  heatmapSnapshots,
  heatmapCompetitorSnapshots,
} from "@shared/schema";
import {
  workResultLog,
  sourceEventLog,
  applyState,
} from "@shared/models/durablePipeline";
import { applyFrontWebhookResult } from "../server/services/frontWebhookIngestion";
import { storeCompetitorData } from "../server/services/localDominanceService";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import { registerReportRoutes } from "../server/routes/reports";
import {
  REFORMAT_STAMP_KEY,
  COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
} from "../server/services/commonIssuesReformatBackfill";
import {
  JUNE_LEAD_REPARSE_STAMP_KEY,
  JUNE_LEAD_REPARSE_OUTCOME_KEY,
} from "../server/services/juneLeadReparse";
// Imported via the redirected specifier so the test configures the SAME stub
// singleton the webhook route resolves to through the resolve hook.
import {
  __setParseReportPdf,
  __resetParseReportPdf,
} from "../server/services/pdfImportParser";

const TAG = `task-3533-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1a — Front webhook thread envelopes are terminal at ingest.
// ─────────────────────────────────────────────────────────────────────────
async function part1aWebhookEnvelopeTerminal(): Promise<void> {
  console.log("Part 1a — webhook thread envelope written terminal at ingest");
  // NOTE: applyFrontWebhookResult reads/writes via the bare `workerDb`
  // handle, which does NOT see runInTxSandbox seeds (the ALS pin only
  // covers getDb()). So this part seeds real public rows via the bare
  // `db` handle and cleans up everything in a `finally`.
  const conversationId = `conv-${TAG}-envelope`;
  const sourceEventId = `sev-${TAG}-1a`;
  const workResultId = `wr-${TAG}-1a`;
  try {
    await db.insert(sourceEventLog).values({
      id: sourceEventId,
      sourceSystem: "front",
      sourceEventType: "communication_result",
      sourceObjectId: sourceEventId,
      dedupeKey: sourceEventId,
      payloadJson: {},
      receivedAt: new Date(),
    } as any);
    await db.insert(workResultLog).values({
      id: workResultId,
      sourceEventId,
      sourceSystem: "front",
      resultType: "communication_result",
      resultJson: {
        conversationId,
        messageId: `${conversationId}-msg`,
        subject: `Task #3533 envelope ${TAG}`,
        direction: "inbound",
        participants: [{ email: "sender@example.com", role: "sender" }],
        contentText: "body",
        contentPreview: "body",
        rawEventType: "conversation.created",
        timestamp: new Date().toISOString(),
        externalUrl: null,
      },
      createdAt: new Date(),
    } as any);

    const result = await applyFrontWebhookResult(sourceEventId, workResultId);
    check("apply persisted a new record", result.applied === true && !!result.recordId, JSON.stringify(result));

    const [row] = await db
      .select({
        processingStatus: rawCommunicationRecords.processingStatus,
        reason: rawCommunicationRecords.operationalClassificationReason,
        sourceType: rawCommunicationRecords.sourceType,
        sourceSubtype: rawCommunicationRecords.sourceSubtype,
      })
      .from(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.externalSourceId, conversationId));
    check("envelope row exists", !!row);
    check(
      "envelope written processing_status='processed' (NOT pending)",
      row?.processingStatus === "processed",
      `got ${row?.processingStatus}`,
    );
    check(
      "envelope reason = webhook_thread_envelope_no_analysis_path",
      row?.reason === "webhook_thread_envelope_no_analysis_path",
      `got ${row?.reason}`,
    );
    check(
      "envelope is source_type front_email / subtype email_thread",
      row?.sourceType === "front_email" && row?.sourceSubtype === "email_thread",
      `got ${row?.sourceType}/${row?.sourceSubtype}`,
    );
  } finally {
    // Cleanup in FK order: apply_state → raw comm row → work result → event.
    await db.delete(applyState).where(eq(applyState.workResultId, workResultId));
    await db
      .delete(rawCommunicationRecords)
      .where(eq(rawCommunicationRecords.externalSourceId, conversationId));
    await db.delete(workResultLog).where(eq(workResultLog.id, workResultId));
    await db.delete(sourceEventLog).where(eq(sourceEventLog.id, sourceEventId));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1b — mark_legacy predicate: 1-hour guard + email_message exclusion.
// ─────────────────────────────────────────────────────────────────────────
async function part1bMarkLegacyPredicate(): Promise<void> {
  console.log("Part 1b — mark_legacy_front_email_pending_terminal predicate");
  const action = PROD_ACTIONS.find(
    (a) => a.id === "mark_legacy_front_email_pending_terminal",
  );
  assert.ok(action, "action mark_legacy_front_email_pending_terminal must exist");

  await runInTxSandbox(async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    const mk = (suffix: string, subtype: string | null, createdAt: Date, reason?: string) =>
      getDb()
        .insert(rawCommunicationRecords)
        .values({
          sourceType: "front_email",
          sourceSubtype: subtype,
          title: `Task #3533 ${suffix} ${TAG}`,
          timestamp: new Date(),
          processingStatus: "pending",
          operationalClassificationReason: reason ?? null,
          createdAt,
        } as any)
        .returning({ id: rawCommunicationRecords.id })
        .then((r) => r[0].id);

    const oldThread = await mk("old-thread", "email_thread", twoHoursAgo);
    const oldThreadWithReason = await mk("old-thread-reason", "email_thread", twoHoursAgo, "prior_reason");
    const freshThread = await mk("fresh-thread", "email_thread", fiveMinAgo);
    const oldMessage = await mk("old-message", "email_message", twoHoursAgo);
    const oldNullSubtype = await mk("old-null-subtype", null, twoHoursAgo);

    const applied = await action!.apply();
    check(
      "apply drains old rows (applied state)",
      applied.state === "applied" && (applied.rowsAffected ?? 0) >= 3,
      JSON.stringify(applied),
    );

    const rows = await getDb()
      .select({
        id: rawCommunicationRecords.id,
        status: rawCommunicationRecords.processingStatus,
        reason: rawCommunicationRecords.operationalClassificationReason,
      })
      .from(rawCommunicationRecords)
      .where(
        inArray(rawCommunicationRecords.id, [
          oldThread,
          oldThreadWithReason,
          freshThread,
          oldMessage,
          oldNullSubtype,
        ]),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));

    check(
      "old email_thread pending → failed with backlog-drain prefix",
      byId.get(oldThread)?.status === "failed" &&
        (byId.get(oldThread)?.reason ?? "").startsWith("[backlog-drain 2026-05]"),
      JSON.stringify(byId.get(oldThread)),
    );
    check(
      "old row with prior reason keeps it behind the prefix",
      byId.get(oldThreadWithReason)?.status === "failed" &&
        (byId.get(oldThreadWithReason)?.reason ?? "").includes("prior_reason"),
      JSON.stringify(byId.get(oldThreadWithReason)),
    );
    check(
      "old NULL-subtype pending → failed (IS DISTINCT FROM keeps NULLs in scope)",
      byId.get(oldNullSubtype)?.status === "failed",
      JSON.stringify(byId.get(oldNullSubtype)),
    );
    check(
      "fresh (<1h) pending row SURVIVES the drain",
      byId.get(freshThread)?.status === "pending",
      JSON.stringify(byId.get(freshThread)),
    );
    check(
      "email_message pending row SURVIVES (study-driver exclusion)",
      byId.get(oldMessage)?.status === "pending",
      JSON.stringify(byId.get(oldMessage)),
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Part 3 — storeCompetitorData pre-stamps no-URL rows at ingest.
// Uses the BARE `db` import (production code does too) → public schema
// with unique IDs and a finally cleanup.
// ─────────────────────────────────────────────────────────────────────────
async function part3CompetitorIngestStamp(): Promise<void> {
  console.log("Part 3 — storeCompetitorData stamps no-URL rows at ingest");
  let snapshotId: string | undefined;
  try {
    const [snap] = await db
      .insert(heatmapSnapshots)
      .values({
        locationId: `loc-${TAG}`,
        locationName: `Location ${TAG}`,
        campaignId: `camp-${TAG}`,
        keywordId: `kw-${TAG}`,
        keywordName: `keyword ${TAG}`,
        reportDate: new Date(),
        businessLat: 41.8,
        businessLng: -87.6,
        gridTemplate: "5x5",
        gridUnit: "mi",
        gridDistance: 1,
        baseLat: 41.8,
        baseLng: -87.6,
        rawPayload: {},
      } as any)
      .returning({ id: heatmapSnapshots.id });
    snapshotId = snap.id;

    await storeCompetitorData(
      snapshotId,
      null as any, // clientId column is nullable
      `camp-${TAG}`,
      `keyword ${TAG}`,
      new Date(),
      [
        { name: `With URL ${TAG}`, gbpUrl: "https://maps.google.com/?cid=123" },
        { name: `No URL ${TAG}` },
      ],
    );

    const rows = await db
      .select({
        name: heatmapCompetitorSnapshots.competitorName,
        gbpUrl: heatmapCompetitorSnapshots.competitorGbpUrl,
        attemptedAt: heatmapCompetitorSnapshots.gbpUrlBackfillAttemptedAt,
      })
      .from(heatmapCompetitorSnapshots)
      .where(eq(heatmapCompetitorSnapshots.snapshotId, snapshotId));
    const withUrl = rows.find((r) => r.name.startsWith("With URL"));
    const noUrl = rows.find((r) => r.name.startsWith("No URL"));
    check("both competitor rows persisted", rows.length === 2, `got ${rows.length}`);
    check(
      "row WITH a GBP URL stays NULL-stamped (still eligible for label derivation)",
      !!withUrl && withUrl.gbpUrl !== null && withUrl.attemptedAt === null,
      JSON.stringify(withUrl),
    );
    check(
      "row WITHOUT a GBP URL is pre-stamped gbp_url_backfill_attempted_at",
      !!noUrl && noUrl.gbpUrl === null && noUrl.attemptedAt instanceof Date,
      JSON.stringify(noUrl),
    );
  } finally {
    if (snapshotId) {
      await db
        .delete(heatmapCompetitorSnapshots)
        .where(eq(heatmapCompetitorSnapshots.snapshotId, snapshotId))
        .catch(() => undefined);
      await db
        .delete(heatmapSnapshots)
        .where(eq(heatmapSnapshots.id, snapshotId))
        .catch(() => undefined);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Part 2/4 — report section writers preserve/stamp convergence markers.
// ─────────────────────────────────────────────────────────────────────────
const ACTOR_ID = `${TAG}-actor`;
const CLIENT_ID = `${TAG}-client`;
const PUT_REPORT_ID = `${TAG}-put-report`;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated.
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

function webhookHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.CEO_TOOLS_API_TOKEN) {
    headers["authorization"] = `Bearer ${process.env.CEO_TOOLS_API_TOKEN}`;
  }
  if (process.env.WEBHOOK_SECRET) {
    headers["x-webhook-secret"] = process.env.WEBHOOK_SECRET;
  }
  return headers;
}

async function readSectionData(
  isoDb: any,
  reportId: string,
  sectionKey: string,
): Promise<Record<string, any> | undefined> {
  const rows: any = await isoDb.execute(sql`
    SELECT data FROM report_sections
    WHERE report_id = ${reportId} AND section_key = ${sectionKey}
    LIMIT 1
  `);
  const list = Array.isArray(rows) ? rows : rows?.rows;
  return list?.[0]?.data;
}

async function part24SectionStampPreservation(): Promise<void> {
  console.log("Part 2/4 — webhook + PUT convergence-stamp behavior");
  try {
    await runInIsolatedSchema(
      async ({ db: isoDb }) => {
        await isoDb.execute(sql`
          INSERT INTO users (id, role, email, first_name, last_name)
          VALUES (${ACTOR_ID}, 'ceo', ${`${ACTOR_ID}@example.com`}, 'Stamp', 'Tester')
          ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
        `);
        // The user is seeded in the isolated (uncommitted) schema, invisible to
        // requireAuth's ambient public-schema lookup. Pre-register the profile
        // so the real middleware admits it without JIT-provisioning a public row.
        __test_markUserReconciled(ACTOR_ID, {
          id: ACTOR_ID,
          email: `${ACTOR_ID}@example.com`,
          firstName: "Stamp",
          lastName: "Tester",
          role: "ceo",
        });
        await isoDb.execute(sql`
          INSERT INTO clients (id, firm_name)
          VALUES (${CLIENT_ID}, ${`Stamp Fixture ${TAG}`})
          ON CONFLICT (id) DO NOTHING
        `);
        await isoDb.execute(sql`
          INSERT INTO reports (id, client_id, report_month, status, created_by)
          VALUES (${PUT_REPORT_ID}, ${CLIENT_ID}, ${"2026-01"}, 'draft', ${ACTOR_ID})
          ON CONFLICT (id) DO NOTHING
        `);

        const app = buildApp();
        const { server, baseUrl } = await listen(app);
        try {
          __setParseReportPdf(async () => ({
            intake: { commonIssues: "Issue 1: intake blip. Impact: none. Strategic Fix: n/a." },
            sales: { commonIssues: "Issue 1: sales blip. Impact: none. Strategic Fix: n/a." },
            marketing: {},
          }));

          // ── Webhook import #1 — creates the report, stamps intake/sales.
          const pdf = Buffer.from("%PDF-1.4 task-3533 synthetic pdf").toString("base64");
          const res1 = await fetch(`${baseUrl}/api/webhooks/report-import`, {
            method: "POST",
            headers: webhookHeaders(),
            body: JSON.stringify({ clientId: CLIENT_ID, reportMonth: "2026-03", pdf }),
          });
          const body1: any = await res1.json().catch(() => ({}));
          assert.equal(res1.status, 201, `webhook#1: expected 201, got ${res1.status} ${JSON.stringify(body1)}`);
          const whReportId = body1.reportId as string;

          const intake1 = await readSectionData(isoDb, whReportId, "intake");
          const sales1 = await readSectionData(isoDb, whReportId, "sales");
          check(
            "webhook stamps intake with the reformat stamp",
            intake1?.[REFORMAT_STAMP_KEY] === COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
            JSON.stringify(intake1?.[REFORMAT_STAMP_KEY]),
          );
          check(
            "webhook stamps sales with the reformat stamp",
            sales1?.[REFORMAT_STAMP_KEY] === COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
            JSON.stringify(sales1?.[REFORMAT_STAMP_KEY]),
          );

          // ── Manually stamp marketing with the June reparse markers (as the
          //    backfill would), then RE-import the same month. The old code
          //    wiped these on every scheduled re-import.
          const marketing1 = (await readSectionData(isoDb, whReportId, "marketing")) ?? {};
          const stamped = {
            ...marketing1,
            [JUNE_LEAD_REPARSE_STAMP_KEY]: 1,
            [JUNE_LEAD_REPARSE_OUTCOME_KEY]: "reparsed",
          };
          await isoDb.execute(sql`
            UPDATE report_sections SET data = ${JSON.stringify(stamped)}::jsonb
            WHERE report_id = ${whReportId} AND section_key = 'marketing'
          `);

          const res2 = await fetch(`${baseUrl}/api/webhooks/report-import`, {
            method: "POST",
            headers: webhookHeaders(),
            body: JSON.stringify({ clientId: CLIENT_ID, reportMonth: "2026-03", pdf }),
          });
          const body2: any = await res2.json().catch(() => ({}));
          assert.equal(res2.status, 201, `webhook#2: expected 201, got ${res2.status} ${JSON.stringify(body2)}`);
          assert.equal(body2.reportId, whReportId, "webhook#2 must upsert into the SAME report");

          const marketing2 = await readSectionData(isoDb, whReportId, "marketing");
          check(
            "webhook RE-import preserves the June reparse stamp on marketing",
            marketing2?.[JUNE_LEAD_REPARSE_STAMP_KEY] === 1,
            JSON.stringify(marketing2?.[JUNE_LEAD_REPARSE_STAMP_KEY]),
          );
          check(
            "webhook RE-import preserves the June reparse outcome on marketing",
            marketing2?.[JUNE_LEAD_REPARSE_OUTCOME_KEY] === "reparsed",
            JSON.stringify(marketing2?.[JUNE_LEAD_REPARSE_OUTCOME_KEY]),
          );

          // ── Section PUT — marketing save WITHOUT stamps carries them forward.
          const putMkt = await fetch(`${baseUrl}/api/reports/${whReportId}/sections/marketing`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              data: { totalLeads: 42 },
              editSource: "ui_edit",
            }),
          });
          assert.equal(putMkt.status, 200, `PUT marketing: expected 200, got ${putMkt.status}`);
          const marketing3 = await readSectionData(isoDb, whReportId, "marketing");
          check(
            "PUT (ui_edit) without stamps carries June reparse stamps forward",
            marketing3?.[JUNE_LEAD_REPARSE_STAMP_KEY] === 1 &&
              marketing3?.[JUNE_LEAD_REPARSE_OUTCOME_KEY] === "reparsed",
            JSON.stringify(marketing3),
          );
          check(
            "PUT still applied the operator's payload",
            marketing3?.totalLeads === 42,
            JSON.stringify(marketing3?.totalLeads),
          );

          // ── Section PUT — intake ui_edit without stamp preserves the stamp.
          const putIntake = await fetch(`${baseUrl}/api/reports/${whReportId}/sections/intake`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              data: { totalConsults: 7, commonIssues: "edited by operator" },
              editSource: "ui_edit",
            }),
          });
          assert.equal(putIntake.status, 200, `PUT intake: expected 200, got ${putIntake.status}`);
          const intake2 = await readSectionData(isoDb, whReportId, "intake");
          check(
            "PUT intake (ui_edit) carries the reformat stamp forward",
            intake2?.[REFORMAT_STAMP_KEY] === COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
            JSON.stringify(intake2?.[REFORMAT_STAMP_KEY]),
          );

          // ── Section PUT — ai_format on a NEVER-stamped report stamps fresh.
          const putAiFmt = await fetch(`${baseUrl}/api/reports/${PUT_REPORT_ID}/sections/sales`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              data: { commonIssues: "🔴 **Issue:** formatted output" },
              editSource: "ai_format",
            }),
          });
          assert.equal(putAiFmt.status, 200, `PUT ai_format: expected 200, got ${putAiFmt.status}`);
          const salesPut = await readSectionData(isoDb, PUT_REPORT_ID, "sales");
          check(
            "PUT (ai_format) stamps sales fresh even with no prior stamp",
            salesPut?.[REFORMAT_STAMP_KEY] === COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
            JSON.stringify(salesPut?.[REFORMAT_STAMP_KEY]),
          );
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
      {
        tables: [
          "users",
          "clients",
          "command_panels",
          "client_locations",
          "reports",
          "report_sections",
          "report_section_history",
          "client_data_access",
        ],
        pinGetDbForCrossAsync: true,
      },
    );
  } finally {
    __test_resetReconciledUsers();
    __resetParseReportPdf();
    // The webhook route writes its import-log row through the BARE `db`
    // import (public schema, ignores the isolated-schema pin). Clean it up.
    await db
      .execute(sql`DELETE FROM webhook_import_logs WHERE client_id = ${CLIENT_ID}`)
      .catch(() => undefined);
  }
}

async function main(): Promise<void> {
  console.log("Task #3533 — prod-action feeder convergence fixes");
  try {
    await part1aWebhookEnvelopeTerminal();
    await part1bMarkLegacyPredicate();
    await part3CompetitorIngestStamp();
    await part24SectionStampPreservation();
  } finally {
    // Close undici keep-alive sockets so the process drains naturally.
    await getGlobalDispatcher().close().catch(() => undefined);
  }
  console.log(`prod-action-feeder-convergence: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("prod-action-feeder-convergence: FAILED", err);
  process.exitCode = 1;
});
