/* test-registration
{
  "name": "F8 persistence-write boundaries (Task #4153)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4153 (program F8): four route boundaries used to spread raw request bodies into Drizzle writes — agent-memory PUT, SEMrush-integration PUT, report PATCH, client PATCH. This suite pins the seven-point hardening matrix per boundary: valid payloads persist, protected/ownership/server-managed columns cannot be overwritten, unknown keys strip (repo zod convention), omitted fields stay untouched, null-vs-missing survives, invalid bodies cause no partial write, tenant keys stay server-controlled and pre-parse role gates still fire on the raw body. Task #4200 adds the two latent cat-6 storage boundaries (updateSlackChannelMapping, updateRisAutoSourceMapping): runtime schema parse strips protected/unknown keys even from a raw-body-shaped patch. Task #4222 closes the remaining wide-open storage edit functions (§G: aiSuggestion, frontSyncEmail, slackSyncHistory, communicationClientLink, pandadocDocument, agentKnowledgeEntry, agentMatchDecision, clientOpenAsk, clientSavePlay, twilioConversation/Message/Call) with the same runtime-parsed focused update schemas and a 3-step spot matrix per boundary. Task #4521 adds §I: the email-sequence storage writers (template/sequence/enrollment/CAS-advance/step-send) parse focused patch schemas at runtime — identity, pinned recipient/sender and CAS/state-machine columns cannot be forged through a raw-body-shaped patch. A regression here silently reopens cross-client ownership rewrites through public routes.",
  "tier": "small"
}
test-registration */
/**
 * Task #4153 (F8) — persistence-write boundary hardening.
 *
 * Exercises the four fixed boundaries end-to-end through real Express apps
 * (real route registrars + real requireAuth/requireRole middleware behind
 * the Clerk per-request test seam, same harness family as
 * tests/save-plays.test.ts):
 *
 *   A. PUT  /api/clients/:clientId/agent-memory/:id   (agents.ts → agentStorage)
 *   B. PUT  /api/clients/:clientId/semrush-integration (heatmap.ts, update+insert)
 *   C. PATCH /api/reports/:id                          (reports.ts → reportStorage)
 *   D. PATCH /api/clients/:id                          (clients.ts → clientStorage)
 *
 * Task #4200 (F8 follow-up) adds the two latent category-6 STORAGE boundaries
 * (no production route callers; hardened at the storage layer itself):
 *
 *   E. updateSlackChannelMapping   (communicationStorage.ts)
 *   F. updateRisAutoSourceMapping  (risStorage.ts)
 *
 * Per boundary the seven-point matrix: (1) valid payload persists as before,
 * (2) protected/ownership/server-managed fields cannot be overwritten,
 * (3) unknown fields are stripped (existing repo convention — never a 500),
 * (4) omitted fields stay unchanged, (5) null-vs-missing semantics preserved,
 * (6) invalid data causes no partial write, (7) tenant/ownership keys stay
 * server-controlled (URL-param-bound; body attempts ignored; raw-body role
 * gates still 403 before the parse).
 *
 * Seeding uses per-run random suffixes; cleanup deletes in FK-safe order in
 * finally (activity logs → reports → clients cascade → users).
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerAgentRoutes } from "../server/routes/agents";
import { registerHeatmapRoutes } from "../server/routes/heatmap";
import { registerReportRoutes } from "../server/routes/reports";
import { registerClientRoutes } from "../server/routes/clients";

const RUN = `t4153-${randomBytes(4).toString("hex")}`;

const CEO_ID = `${RUN}-ceo`;
const AM_ID = `${RUN}-am`;
const LOW_ID = `${RUN}-low`; // 'sales' role — owner-path only, below AM

const C1 = `${RUN}-client-main`;   // primary tenant under test (owned by AM)
const C2 = `${RUN}-client-other`;  // cross-tenant target — nothing may ever move here
const C_OWNED = `${RUN}-client-owned`; // owned by LOW for raw-body gate tests

const M1 = `${RUN}-memory-1`;
const S1 = `${RUN}-semrush-1`;
const R1 = `${RUN}-report-1`;
const SHARE_TOKEN = `${RUN}-share-orig`;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function row(query: ReturnType<typeof sql>): Promise<any> {
  const r = await db.execute(query);
  return (r as any).rows[0];
}

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role)
    VALUES
      (${CEO_ID}, ${`${CEO_ID}@t4153.example`}, 'T4153', 'Ceo', 'ceo'),
      (${AM_ID}, ${`${AM_ID}@t4153.example`}, 'T4153', 'Manager', 'account_manager'),
      (${LOW_ID}, ${`${LOW_ID}@t4153.example`}, 'T4153', 'Low', 'sales')
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name, owner_id, products)
    VALUES
      (${C1}, ${`${RUN} Main Firm`}, ${AM_ID}, ARRAY['seo']),
      (${C2}, ${`${RUN} Other Firm`}, ${AM_ID}, ARRAY['seo']),
      (${C_OWNED}, ${`${RUN} Owned Firm`}, ${LOW_ID}, ARRAY['seo'])
  `);
  await db.execute(sql`
    INSERT INTO client_agent_memory
      (id, client_id, identifier_type, identifier_value, source, confidence_weight,
       manually_added, usage_count, learned_from_match_id)
    VALUES
      (${M1}, ${C1}, 'email_domain', ${`${RUN}-orig.example`}, 'learned', 1.0, false, 3, NULL)
  `);
  await db.execute(sql`
    INSERT INTO client_semrush_integrations
      (id, client_id, integration_enabled, business_name, sync_status)
    VALUES (${S1}, ${C1}, true, ${`${RUN} Orig Biz`}, 'idle')
  `);
  await db.execute(sql`
    INSERT INTO reports
      (id, client_id, report_month, status, share_token, privacy_mode, hide_lead_quality,
       webhook_import_log_id, source_pdf_storage_key, created_by)
    VALUES (${R1}, ${C1}, '2026-07', 'draft', ${SHARE_TOKEN}, false, false,
            ${`${RUN}-wil-orig`}, ${`${RUN}-key-orig`}, ${AM_ID})
  `);
}

async function cleanup(): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM activity_logs WHERE user_id IN (${CEO_ID}, ${AM_ID}, ${LOW_ID})`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM reports WHERE id = ${R1}`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM ris_auto_source_mappings WHERE auto_source LIKE ${`${RUN}%`}`);
  } catch {}
  // Task #4222 §G fixtures (FK-safe order: children before raw comm / clients).
  for (const q of [
    sql`DELETE FROM ai_suggestions WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM communication_client_links WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM front_sync_emails WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM slack_sync_history WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM pandadoc_documents WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM agent_knowledge_base WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM agent_match_decisions WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM client_open_asks WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM client_save_plays WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM twilio_messages WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM twilio_calls WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM twilio_conversations WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM raw_communication_records WHERE id LIKE ${`${RUN}%`}`,
  ]) {
    try {
      await db.execute(q);
    } catch {}
  }
  try {
    // slack_channel_mappings rows survive client cascade (mapped_client_id is
    // ON DELETE SET NULL), so delete the fixture row explicitly.
    await db.execute(sql`DELETE FROM slack_channel_mappings WHERE id LIKE ${`${RUN}%`}`);
  } catch {}
  // Task #4380 §H fixtures: contacts cascade with the client, but booking
  // pages reference AM_ID and would block the users delete below.
  try {
    await db.execute(sql`DELETE FROM booking_pages WHERE id LIKE ${`${RUN}%`}`);
  } catch {}
  // Task #4521 §I fixtures (FK-safe: sends/enrollments/steps cascade with the
  // sequence; templates are FK-blocked by steps so they go after).
  for (const q of [
    sql`DELETE FROM email_sequence_step_sends WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM email_sequence_enrollments WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM email_sequence_steps WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM email_sequences WHERE id LIKE ${`${RUN}%`}`,
    sql`DELETE FROM email_templates WHERE id LIKE ${`${RUN}%`}`,
  ]) {
    try {
      await db.execute(q);
    } catch {}
  }
  try {
    // client deletes cascade to client_agent_memory + client_semrush_integrations
    await db.execute(sql`DELETE FROM clients WHERE id IN (${C1}, ${C2}, ${C_OWNED})`);
  } catch {}
  try {
    await db.execute(sql`DELETE FROM users WHERE id IN (${CEO_ID}, ${AM_ID}, ${LOW_ID})`);
  } catch {}
}

// Clerk test seam so the real requireAuth middleware and requireRole() DB-role
// checks run against the seeded (public-schema, committed) users rows.
let actingUserId: string | null = AM_ID;

function buildApp(register: (app: express.Express) => void): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  register(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

let baseUrl = "";
async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok - ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// A. PUT /api/clients/:clientId/agent-memory/:id
// ---------------------------------------------------------------------------
async function boundaryAgentMemory(): Promise<void> {
  console.log("\nA. agent-memory PUT boundary");
  const app = buildApp(registerAgentRoutes);
  const { server, baseUrl: b } = await listen(app);
  baseUrl = b;
  try {
    actingUserId = AM_ID;
    const url = `/api/clients/${C1}/agent-memory/${M1}`;

    await step("A1 valid payload persists (value + weight)", async () => {
      const r = await req("PUT", url, { identifierValue: `${RUN}-v2.example`, confidenceWeight: 0.4 });
      assertEq(r.status, 200, "status");
      const m = await row(sql`SELECT * FROM client_agent_memory WHERE id = ${M1}`);
      assertEq(m.identifier_value, `${RUN}-v2.example`, "identifier_value updated");
      assertEq(Number(m.confidence_weight), 0.4, "confidence_weight updated");
    });

    await step("A2 protected/ownership/server fields cannot be overwritten", async () => {
      const r = await req("PUT", url, {
        id: `${RUN}-other-id`,
        clientId: C2,
        source: "manual",
        manuallyAdded: true,
        usageCount: 99,
        learnedFromMatchId: `${RUN}-fake-match`,
        firstSeenAt: "2020-01-01T00:00:00.000Z",
        lastSeenAt: "2020-01-01T00:00:00.000Z",
        createdAt: "2020-01-01T00:00:00.000Z",
        identifierValue: `${RUN}-v2b.example`,
      });
      assertEq(r.status, 200, "status (unknown/protected keys stripped, not 500)");
      const m = await row(sql`SELECT * FROM client_agent_memory WHERE id = ${M1}`);
      assertEq(m.client_id, C1, "client_id (tenant ownership) unchanged");
      assertEq(m.source, "learned", "source unchanged");
      assertEq(m.manually_added, false, "manually_added unchanged");
      assertEq(Number(m.usage_count), 3, "usage_count unchanged");
      assertEq(m.learned_from_match_id, null, "learned_from_match_id unchanged");
      assertEq(m.identifier_value, `${RUN}-v2b.example`, "legit sibling field still applied");
      assert(new Date(m.created_at).getFullYear() > 2020, "created_at not rewound");
    });

    await step("A3 unknown fields are stripped (no error)", async () => {
      const r = await req("PUT", url, { identifierValue: `${RUN}-v3.example`, totallyBogus: 1 });
      assertEq(r.status, 200, "status");
      const m = await row(sql`SELECT identifier_value FROM client_agent_memory WHERE id = ${M1}`);
      assertEq(m.identifier_value, `${RUN}-v3.example`, "value updated");
    });

    await step("A4 omitted fields stay unchanged", async () => {
      const r = await req("PUT", url, { confidenceWeight: 0.9 });
      assertEq(r.status, 200, "status");
      const m = await row(sql`SELECT * FROM client_agent_memory WHERE id = ${M1}`);
      assertEq(m.identifier_value, `${RUN}-v3.example`, "identifier_value untouched");
      assertEq(Number(m.confidence_weight), 0.9, "weight updated");
    });

    await step("A5 null on a NOT NULL column rejects up front (was a 500 constraint blowup)", async () => {
      const r = await req("PUT", url, { identifierValue: null });
      assertEq(r.status, 400, "status");
      const m = await row(sql`SELECT identifier_value FROM client_agent_memory WHERE id = ${M1}`);
      assertEq(m.identifier_value, `${RUN}-v3.example`, "row unchanged");
    });

    await step("A6 invalid data causes no partial write", async () => {
      const r = await req("PUT", url, { identifierValue: `${RUN}-should-not-land.example`, confidenceWeight: "high" });
      assertEq(r.status, 400, "status");
      const m = await row(sql`SELECT * FROM client_agent_memory WHERE id = ${M1}`);
      assertEq(m.identifier_value, `${RUN}-v3.example`, "identifier_value unchanged");
      assertEq(Number(m.confidence_weight), 0.9, "confidence_weight unchanged");
    });

    await step("A7 cross-tenant URL cannot reach the row (scoped lookup 404)", async () => {
      const r = await req("PUT", `/api/clients/${C2}/agent-memory/${M1}`, { identifierValue: `${RUN}-steal.example` });
      assertEq(r.status, 404, "status");
      const m = await row(sql`SELECT identifier_value, client_id FROM client_agent_memory WHERE id = ${M1}`);
      assertEq(m.identifier_value, `${RUN}-v3.example`, "row unchanged");
      assertEq(m.client_id, C1, "still owned by C1");
    });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// B. PUT /api/clients/:clientId/semrush-integration
// ---------------------------------------------------------------------------
async function boundarySemrushIntegration(): Promise<void> {
  console.log("\nB. semrush-integration PUT boundary");
  const app = buildApp(registerHeatmapRoutes);
  const { server, baseUrl: b } = await listen(app);
  baseUrl = b;
  try {
    actingUserId = AM_ID;
    const url = `/api/clients/${C1}/semrush-integration`;

    await step("B1 valid config payload persists", async () => {
      const r = await req("PUT", url, {
        integrationEnabled: false,
        businessName: `${RUN} New Biz`,
        businessLocationId: `${RUN}-loc-1`,
        defaultKeywords: ["k1", "k2"],
      });
      assertEq(r.status, 200, "status");
      const s = await row(sql`SELECT * FROM client_semrush_integrations WHERE id = ${S1}`);
      assertEq(s.integration_enabled, false, "integration_enabled");
      assertEq(s.business_name, `${RUN} New Biz`, "business_name");
      assertEq(s.business_location_id, `${RUN}-loc-1`, "business_location_id");
      assert(Array.isArray(s.default_keywords) && s.default_keywords.length === 2, "default_keywords saved");
    });

    await step("B2 server-managed sync-state columns cannot be overwritten", async () => {
      const r = await req("PUT", url, {
        id: `${RUN}-other-row`,
        syncStatus: "syncing",
        lastSyncOutcome: "pwned",
        lastSyncSummary: "pwned",
        syncProgress: "99%",
        errorMessage: "pwned",
        errorCategory: "pwned",
        warningMessage: "pwned",
        lastSuccessfulSyncAt: "2020-01-01T00:00:00.000Z",
        lastFailedSyncAt: "2020-01-01T00:00:00.000Z",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      assertEq(r.status, 200, "status (stripped, not 500)");
      const s = await row(sql`SELECT * FROM client_semrush_integrations WHERE client_id = ${C1}`);
      assertEq(s.id, S1, "row id unchanged");
      assertEq(s.sync_status, "idle", "sync_status unchanged");
      assertEq(s.last_sync_outcome, null, "last_sync_outcome unchanged");
      assertEq(s.error_message, null, "error_message unchanged");
      assertEq(s.last_successful_sync_at, null, "last_successful_sync_at unchanged");
      assert(new Date(s.created_at).getFullYear() > 2020, "created_at not rewound");
    });

    await step("B3 unknown fields are stripped (no error)", async () => {
      const r = await req("PUT", url, { businessName: `${RUN} B3 Biz`, zzzUnknown: true });
      assertEq(r.status, 200, "status");
      const s = await row(sql`SELECT business_name FROM client_semrush_integrations WHERE id = ${S1}`);
      assertEq(s.business_name, `${RUN} B3 Biz`, "business_name updated");
    });

    await step("B4 omitted fields stay unchanged (partial update)", async () => {
      const r = await req("PUT", url, { semrushCampaignId: `${RUN}-camp-1` });
      assertEq(r.status, 200, "status");
      const s = await row(sql`SELECT * FROM client_semrush_integrations WHERE id = ${S1}`);
      assertEq(s.integration_enabled, false, "integration_enabled untouched (from B1)");
      assertEq(s.business_name, `${RUN} B3 Biz`, "business_name untouched");
      assertEq(s.semrush_campaign_id, `${RUN}-camp-1`, "campaign id updated");
    });

    await step("B5 explicit null clears a nullable column (null vs missing)", async () => {
      const r = await req("PUT", url, { businessLocationId: null });
      assertEq(r.status, 200, "status");
      const s = await row(sql`SELECT business_location_id, business_name FROM client_semrush_integrations WHERE id = ${S1}`);
      assertEq(s.business_location_id, null, "explicit null cleared");
      assertEq(s.business_name, `${RUN} B3 Biz`, "missing field untouched");
    });

    await step("B6 invalid data causes no partial write", async () => {
      const r = await req("PUT", url, { integrationEnabled: "yes", businessName: `${RUN} should-not-land` });
      assertEq(r.status, 400, "status");
      assert(Array.isArray(r.json?.error), "zod issues envelope");
      const s = await row(sql`SELECT integration_enabled, business_name FROM client_semrush_integrations WHERE id = ${S1}`);
      assertEq(s.integration_enabled, false, "integration_enabled unchanged");
      assertEq(s.business_name, `${RUN} B3 Biz`, "business_name unchanged");
    });

    await step("B7 tenant key is URL-bound (body clientId ignored on update AND insert)", async () => {
      const r1 = await req("PUT", url, { clientId: C2, businessName: `${RUN} B7 Biz` });
      assertEq(r1.status, 200, "update status");
      const s = await row(sql`SELECT client_id, business_name FROM client_semrush_integrations WHERE id = ${S1}`);
      assertEq(s.client_id, C1, "update branch: client_id unchanged");
      assertEq(s.business_name, `${RUN} B7 Biz`, "update applied");

      // Insert branch: C2 has no row yet; body tries to claim C1 + seed sync state.
      const r2 = await req("PUT", `/api/clients/${C2}/semrush-integration`, {
        clientId: C1,
        businessName: `${RUN} C2 Biz`,
        syncStatus: "complete",
      });
      assertEq(r2.status, 200, "insert status");
      const s2 = await row(sql`SELECT * FROM client_semrush_integrations WHERE client_id = ${C2}`);
      assert(s2, "row created for C2");
      assertEq(s2.business_name, `${RUN} C2 Biz`, "config field applied");
      assertEq(s2.sync_status, "idle", "sync_status stays server default");
      assert(s2.id !== S1, "distinct row");
    });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// C. PATCH /api/reports/:id
// ---------------------------------------------------------------------------
async function boundaryReportPatch(): Promise<void> {
  console.log("\nC. report PATCH boundary");
  const app = buildApp(registerReportRoutes);
  const { server, baseUrl: b } = await listen(app);
  baseUrl = b;
  try {
    actingUserId = AM_ID;
    const url = `/api/reports/${R1}`;

    await step("C1 valid payload persists (privacy toggles)", async () => {
      const r = await req("PATCH", url, { privacyMode: true, hideLeadQuality: true });
      assertEq(r.status, 200, "status");
      const rep = await row(sql`SELECT privacy_mode, hide_lead_quality FROM reports WHERE id = ${R1}`);
      assertEq(rep.privacy_mode, true, "privacy_mode");
      assertEq(rep.hide_lead_quality, true, "hide_lead_quality");
    });

    await step("C2 ownership/audit/import/share columns cannot be overwritten", async () => {
      const r = await req("PATCH", url, {
        id: `${RUN}-other-report`,
        clientId: C2,
        createdBy: LOW_ID,
        shareToken: `${RUN}-stolen`,
        webhookImportLogId: `${RUN}-wil-new`,
        sourcePdfStorageKey: `${RUN}-key-new`,
        ceoPulseId: `${RUN}-fake-pulse`,
        status: "sent",
      });
      assertEq(r.status, 200, "status (stripped, not 500)");
      const rep = await row(sql`SELECT * FROM reports WHERE id = ${R1}`);
      assertEq(rep.client_id, C1, "client_id (tenant ownership) unchanged");
      assertEq(rep.created_by, AM_ID, "created_by unchanged");
      assertEq(rep.share_token, SHARE_TOKEN, "share_token unchanged");
      assertEq(rep.webhook_import_log_id, `${RUN}-wil-orig`, "webhook_import_log_id unchanged");
      assertEq(rep.source_pdf_storage_key, `${RUN}-key-orig`, "source_pdf_storage_key unchanged");
      assertEq(rep.ceo_pulse_id, null, "ceo_pulse_id unchanged");
      assertEq(rep.status, "sent", "legit sibling field still applied");
    });

    await step("C3 unknown fields are stripped (no error)", async () => {
      const r = await req("PATCH", url, { reportMonth: "2026-06", bogusField: "x" });
      assertEq(r.status, 200, "status");
      const rep = await row(sql`SELECT report_month FROM reports WHERE id = ${R1}`);
      assertEq(rep.report_month, "2026-06", "report_month updated");
    });

    await step("C4 omitted fields stay unchanged", async () => {
      const r = await req("PATCH", url, { status: "draft" });
      assertEq(r.status, 200, "status");
      const rep = await row(sql`SELECT privacy_mode, report_month FROM reports WHERE id = ${R1}`);
      assertEq(rep.privacy_mode, true, "privacy_mode untouched (from C1)");
      assertEq(rep.report_month, "2026-06", "report_month untouched");
    });

    await step("C5 explicit null clears a nullable column (null vs missing)", async () => {
      const r = await req("PATCH", url, { status: null });
      assertEq(r.status, 200, "status");
      const rep = await row(sql`SELECT status, privacy_mode FROM reports WHERE id = ${R1}`);
      assertEq(rep.status, null, "explicit null persisted");
      assertEq(rep.privacy_mode, true, "missing field untouched");
      await req("PATCH", url, { status: "draft" }); // restore
    });

    await step("C6 invalid data causes no partial write", async () => {
      const r = await req("PATCH", url, { privacyMode: "maybe", reportMonth: "2026-09" });
      assertEq(r.status, 400, "status");
      assert(Array.isArray(r.json?.error), "zod issues envelope");
      const rep = await row(sql`SELECT report_month, privacy_mode FROM reports WHERE id = ${R1}`);
      assertEq(rep.report_month, "2026-06", "report_month unchanged");
      assertEq(rep.privacy_mode, true, "privacy_mode unchanged");
    });

    await step("C7 tenant ownership stays server-controlled", async () => {
      const rep = await row(sql`SELECT client_id FROM reports WHERE id = ${R1}`);
      assertEq(rep.client_id, C1, "report still belongs to C1 after every attempt above");
    });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// D. PATCH /api/clients/:id
// ---------------------------------------------------------------------------
async function boundaryClientPatch(): Promise<void> {
  console.log("\nD. client PATCH boundary");
  const app = buildApp(registerClientRoutes);
  const { server, baseUrl: b } = await listen(app);
  baseUrl = b;
  try {
    actingUserId = AM_ID;
    const url = `/api/clients/${C1}`;

    await step("D1 valid payload persists (typed fields + date conversion)", async () => {
      const r = await req("PATCH", url, {
        firmName: `${RUN} Renamed Firm`,
        contactName: `${RUN} Contact`,
        averageCaseValue: 4321.5,
        clientStartDate: "2026-02-03",
      });
      assertEq(r.status, 200, "status");
      const c = await row(sql`SELECT firm_name, contact_name, average_case_value, client_start_date::date::text AS csd FROM clients WHERE id = ${C1}`);
      assertEq(c.firm_name, `${RUN} Renamed Firm`, "firm_name");
      assertEq(c.contact_name, `${RUN} Contact`, "contact_name");
      assertEq(Number(c.average_case_value), 4321.5, "average_case_value");
      assertEq(c.csd, "2026-02-03", "clientStartDate string converted + saved");
    });

    await step("D2 id/clientCode/createdAt/updatedAt cannot be overwritten", async () => {
      const r = await req("PATCH", url, {
        id: `${RUN}-forged-id`,
        clientCode: "HAX-1",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        firmName: `${RUN} Renamed Firm 2`,
      });
      assertEq(r.status, 200, "status (stripped, not 500)");
      const c = await row(sql`SELECT id, client_code, created_at, firm_name FROM clients WHERE id = ${C1}`);
      assert(c, "row still addressable by original id");
      assertEq(c.client_code, null, "client_code unchanged");
      assert(new Date(c.created_at).getFullYear() > 2020, "created_at not rewound");
      assertEq(c.firm_name, `${RUN} Renamed Firm 2`, "legit sibling field still applied");
    });

    await step("D3 unknown fields are stripped (used to 500 at the SQL layer)", async () => {
      const r = await req("PATCH", url, { firmName: `${RUN} Renamed Firm 3`, definitelyNotAColumn: "x" });
      assertEq(r.status, 200, "status");
      const c = await row(sql`SELECT firm_name FROM clients WHERE id = ${C1}`);
      assertEq(c.firm_name, `${RUN} Renamed Firm 3`, "firm_name updated");
    });

    await step("D4 omitted fields stay unchanged", async () => {
      const r = await req("PATCH", url, { contactEmail: `${RUN}@d4.example` });
      assertEq(r.status, 200, "status");
      const c = await row(sql`SELECT firm_name, contact_email, products FROM clients WHERE id = ${C1}`);
      assertEq(c.firm_name, `${RUN} Renamed Firm 3`, "firm_name untouched");
      assertEq(c.contact_email, `${RUN}@d4.example`, "contact_email updated");
      assert(Array.isArray(c.products) && c.products.includes("seo"), "products untouched");
    });

    await step("D5 null-vs-missing preserved (explicit null clears; empty date → null)", async () => {
      const r1 = await req("PATCH", url, { contactName: null });
      assertEq(r1.status, 200, "null status");
      const c1r = await row(sql`SELECT contact_name FROM clients WHERE id = ${C1}`);
      assertEq(c1r.contact_name, null, "explicit null cleared contact_name");
      const r2 = await req("PATCH", url, { clientStartDate: "" });
      assertEq(r2.status, 200, "empty-string date status");
      const c2r = await row(sql`SELECT client_start_date FROM clients WHERE id = ${C1}`);
      assertEq(c2r.client_start_date, null, "empty string converted to null (existing behavior)");
    });

    await step("D6 invalid data causes no partial write", async () => {
      const r = await req("PATCH", url, { averageCaseValue: "lots", firmName: `${RUN} should-not-land` });
      assertEq(r.status, 400, "status");
      assert(Array.isArray(r.json?.error), "issues envelope (same shape as POST create)");
      const c = await row(sql`SELECT firm_name, average_case_value FROM clients WHERE id = ${C1}`);
      assertEq(c.firm_name, `${RUN} Renamed Firm 3`, "firm_name unchanged");
      assertEq(Number(c.average_case_value), 4321.5, "average_case_value unchanged");
    });

    await step("D7 raw-body role gates still fire BEFORE the parse", async () => {
      actingUserId = LOW_ID; // 'sales', owner of C_OWNED only
      const r1 = await req("PATCH", `/api/clients/${C_OWNED}`, { ownerId: AM_ID });
      assertEq(r1.status, 403, "below-AM owner cannot reassign ownership");
      const r2 = await req("PATCH", `/api/clients/${C_OWNED}`, { isArchived: true });
      assertEq(r2.status, 403, "below-AM owner cannot archive");
      actingUserId = AM_ID;
      const r3 = await req("PATCH", url, { isDemo: true });
      assertEq(r3.status, 403, "non-CEO cannot flip demo flag");
      actingUserId = CEO_ID;
      const r4 = await req("PATCH", url, { isDemo: true });
      assertEq(r4.status, 200, "CEO can flip demo flag");
      const c = await row(sql`SELECT is_demo, owner_id FROM clients WHERE id = ${C1}`);
      assertEq(c.is_demo, true, "isDemo persisted via CEO");
      assertEq(c.owner_id, AM_ID, "ownership never moved");
      actingUserId = AM_ID;
    });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// E. updateSlackChannelMapping (storage-level, Task #4200)
// ---------------------------------------------------------------------------
const SLACK1 = `${RUN}-slackmap-1`;
const SLACK_CH = `${RUN}-CH1`;

async function boundarySlackChannelMapping(): Promise<void> {
  console.log("\nE. updateSlackChannelMapping storage boundary");
  const { updateSlackChannelMapping } = await import("../server/storage/communicationStorage");

  await db.execute(sql`
    INSERT INTO slack_channel_mappings (id, channel_id, channel_name, mapped_client_id, auto_created, is_active)
    VALUES (${SLACK1}, ${SLACK_CH}, ${`${RUN}-chan-orig`}, ${C1}, true, true)
  `);

  await step("E1 valid edit persists (name + client remap + toggle)", async () => {
    const out = await updateSlackChannelMapping(SLACK1, {
      channelName: `${RUN}-chan-v2`,
      mappedClientId: C2,
      isActive: false,
    });
    assert(out, "row returned");
    const m = await row(sql`SELECT * FROM slack_channel_mappings WHERE id = ${SLACK1}`);
    assertEq(m.channel_name, `${RUN}-chan-v2`, "channel_name updated");
    assertEq(m.mapped_client_id, C2, "mapped_client_id updated (documented edit surface)");
    assertEq(m.is_active, false, "is_active updated");
  });

  await step("E2 protected/server fields stripped even from a raw-body-shaped patch", async () => {
    const rawBodyShaped = {
      id: `${RUN}-forged-slack-id`,
      channelId: `${RUN}-CH-FORGED`,
      autoCreated: false,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      totallyUnknownKey: "x",
      channelName: `${RUN}-chan-v3`,
    };
    const out = await updateSlackChannelMapping(SLACK1, rawBodyShaped as any);
    assert(out, "row returned (stripped, not thrown/SQL-error)");
    const m = await row(sql`SELECT * FROM slack_channel_mappings WHERE id = ${SLACK1}`);
    assertEq(m.id, SLACK1, "id unchanged");
    assertEq(m.channel_id, SLACK_CH, "channelId (immutable natural key) unchanged");
    assertEq(m.auto_created, true, "autoCreated (server bookkeeping) unchanged");
    assert(new Date(m.created_at).getFullYear() > 2020, "created_at not rewound");
    assert(new Date(m.updated_at).getFullYear() > 2020, "updated_at server-stamped, not caller value");
    assertEq(m.channel_name, `${RUN}-chan-v3`, "legit sibling field still applied");
  });

  await step("E3 invalid type rejects with no write", async () => {
    let threw = false;
    try {
      await updateSlackChannelMapping(SLACK1, { isActive: "yes" } as any);
    } catch {
      threw = true;
    }
    assert(threw, "zod parse rejected invalid patch");
    const m = await row(sql`SELECT is_active, channel_name FROM slack_channel_mappings WHERE id = ${SLACK1}`);
    assertEq(m.is_active, false, "is_active unchanged");
    assertEq(m.channel_name, `${RUN}-chan-v3`, "channel_name unchanged");
  });
}

// ---------------------------------------------------------------------------
// F. updateRisAutoSourceMapping (storage-level, Task #4200)
// ---------------------------------------------------------------------------
const RIS_AS = `${RUN}-auto-source`;

async function boundaryRisAutoSourceMapping(): Promise<void> {
  console.log("\nF. updateRisAutoSourceMapping storage boundary");
  const { updateRisAutoSourceMapping } = await import("../server/storage/risStorage");

  await db.execute(sql`
    INSERT INTO ris_auto_source_mappings (auto_source, label, enabled, sql_template, value_column)
    VALUES (${RIS_AS}, ${`${RUN} Orig Label`}, false, '', 'value')
  `);
  const before = await row(sql`SELECT id, created_at FROM ris_auto_source_mappings WHERE auto_source = ${RIS_AS}`);

  await step("F1 valid edit persists (label + enable + sql)", async () => {
    const out = await updateRisAutoSourceMapping(RIS_AS, {
      label: `${RUN} New Label`,
      enabled: true,
      sqlTemplate: "SELECT 1 AS value",
    });
    assert(out, "row returned");
    const m = await row(sql`SELECT * FROM ris_auto_source_mappings WHERE auto_source = ${RIS_AS}`);
    assertEq(m.label, `${RUN} New Label`, "label updated");
    assertEq(m.enabled, true, "enabled updated");
    assertEq(m.sql_template, "SELECT 1 AS value", "sql_template updated");
  });

  await step("F2 protected/server fields stripped even from a raw-body-shaped patch", async () => {
    const rawBodyShaped = {
      id: `${RUN}-forged-ris-id`,
      autoSource: `${RUN}-forged-source`,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      someUnknownKey: 1,
      label: `${RUN} Label v3`,
    };
    const out = await updateRisAutoSourceMapping(RIS_AS, rawBodyShaped as any);
    assert(out, "row returned (stripped, not thrown/SQL-error)");
    const m = await row(sql`SELECT * FROM ris_auto_source_mappings WHERE id = ${before.id}`);
    assert(m, "row still addressable by original id");
    assertEq(m.auto_source, RIS_AS, "autoSource (immutable key) unchanged");
    assertEq(new Date(m.created_at).toISOString(), new Date(before.created_at).toISOString(), "created_at unchanged");
    assert(new Date(m.updated_at).getFullYear() > 2020, "updated_at server-stamped, not caller value");
    assertEq(m.label, `${RUN} Label v3`, "legit sibling field still applied");
  });

  await step("F3 invalid type rejects with no write", async () => {
    let threw = false;
    try {
      await updateRisAutoSourceMapping(RIS_AS, { comparator: "not-a-comparator" } as any);
    } catch {
      threw = true;
    }
    assert(threw, "zod parse rejected invalid patch");
    const m = await row(sql`SELECT label, comparator FROM ris_auto_source_mappings WHERE auto_source = ${RIS_AS}`);
    assertEq(m.label, `${RUN} Label v3`, "label unchanged");
    assertEq(m.comparator, "none", "comparator unchanged");
  });
}

// ---------------------------------------------------------------------------
// G. Task #4222 — remaining wide-open storage edit boundaries.
//
// Every storage update function that still accepted a broad
// Partial<SelectType>/Partial<InsertType> now parses through a focused
// update schema (shared/models/*). Per boundary the 3-step spot matrix
// (§E/§F pattern): (1) a valid focused edit persists, (2) a raw-body-shaped
// patch with forged id / ownership / protected / unknown keys strips —
// row identity unchanged, legit sibling field still applies — and
// (3) an invalid type rejects with no write.
// ---------------------------------------------------------------------------

const RC1 = `${RUN}-rawcomm-1`;
const G = {
  aiSug: `${RUN}-aisug-1`,
  fse: `${RUN}-fse-1`,
  slackHist: `${RUN}-slackhist-1`,
  link: `${RUN}-commlink-1`,
  panda: `${RUN}-panda-1`,
  kb: `${RUN}-agentkb-1`,
  amd: `${RUN}-agentmd-1`,
  ask: `${RUN}-openask-1`,
  play: `${RUN}-saveplay-1`,
  tconv: `${RUN}-twconv-1`,
  tmsg: `${RUN}-twmsg-1`,
  tcall: `${RUN}-twcall-1`,
};

interface SpotCfg {
  label: string;
  fn: (id: string, data: any) => Promise<unknown>;
  rowId: string;
  selectRow: () => Promise<any>;
  valid: Record<string, unknown>;
  assertValid: (m: any) => void;
  forged: Record<string, unknown>; // raw-body-shaped: forged id/protected/unknown + one legit sibling
  assertForged: (m: any) => void;
  invalid: Record<string, unknown>;
  assertInvalid: (m: any) => void;
}

async function runSpot(cfg: SpotCfg): Promise<void> {
  await step(`${cfg.label}: valid focused edit persists`, async () => {
    const out = await cfg.fn(cfg.rowId, cfg.valid);
    assert(out, "row returned");
    cfg.assertValid(await cfg.selectRow());
  });
  await step(`${cfg.label}: raw-body-shaped patch strips protected/unknown keys`, async () => {
    const out = await cfg.fn(cfg.rowId, cfg.forged);
    assert(out, "row returned (stripped, not thrown/SQL-error)");
    const m = await cfg.selectRow();
    assertEq(m.id, cfg.rowId, "row id unchanged");
    cfg.assertForged(m);
  });
  await step(`${cfg.label}: invalid type rejects with no write`, async () => {
    let threw = false;
    try {
      await cfg.fn(cfg.rowId, cfg.invalid);
    } catch {
      threw = true;
    }
    assert(threw, "zod parse rejected invalid patch");
    cfg.assertInvalid(await cfg.selectRow());
  });
}

async function seedG(): Promise<void> {
  await db.execute(sql`
    INSERT INTO raw_communication_records (id, source_type, title, timestamp)
    VALUES (${RC1}, 'front_email', ${`${RUN} raw comm`}, NOW())
  `);
  await db.execute(sql`
    INSERT INTO ai_suggestions (id, client_id, raw_communication_record_id, destination_type, suggested_title, status)
    VALUES (${G.aiSug}, ${C1}, ${RC1}, 'open_ask', ${`${RUN} sug`}, 'pending')
  `);
  await db.execute(sql`
    INSERT INTO front_sync_emails (id, conversation_id, subject, match_status)
    VALUES (${G.fse}, ${`${RUN}-conv-1`}, ${`${RUN} subj`}, 'unmatched')
  `);
  await db.execute(sql`
    INSERT INTO slack_sync_history (id, status) VALUES (${G.slackHist}, 'running')
  `);
  await db.execute(sql`
    INSERT INTO communication_client_links (id, raw_communication_record_id, client_id, status)
    VALUES (${G.link}, ${RC1}, ${C1}, 'detected')
  `);
  await db.execute(sql`
    INSERT INTO pandadoc_documents (id, document_id, title, status)
    VALUES (${G.panda}, ${`${RUN}-doc-1`}, ${`${RUN} doc`}, 'draft')
  `);
  await db.execute(sql`
    INSERT INTO agent_knowledge_base (id, client_id, fact_category, fact_text, source_agent)
    VALUES (${G.kb}, ${C1}, 'client_preference', ${`${RUN} fact orig`}, 'daily_judgment')
  `);
  await db.execute(sql`
    INSERT INTO agent_match_decisions (id, communication_id, communication_type, client_id, confidence_score, status)
    VALUES (${G.amd}, ${`${RUN}-comm-1`}, 'email', ${C1}, 0.5, 'pending_review')
  `);
  await db.execute(sql`
    INSERT INTO client_open_asks (id, client_id, ask_type, summary, status)
    VALUES (${G.ask}, ${C1}, 'client_ask', ${`${RUN} ask`}, 'open')
  `);
  await db.execute(sql`
    INSERT INTO client_save_plays (id, client_id, title, assigned_to_user_id, due_date, status)
    VALUES (${G.play}, ${C1}, ${`${RUN} play`}, ${AM_ID}, CURRENT_DATE + 30, 'active')
  `);
  await db.execute(sql`
    INSERT INTO twilio_conversations (id, client_id, contact_phone, twilio_phone_number, contact_name)
    VALUES (${G.tconv}, ${C1}, '+15550001111', '+15550002222', ${`${RUN} contact`})
  `);
  await db.execute(sql`
    INSERT INTO twilio_messages (id, conversation_id, direction, from_number, to_number, body, status)
    VALUES (${G.tmsg}, ${G.tconv}, 'inbound', '+15550001111', '+15550002222', ${`${RUN} body orig`}, 'received')
  `);
  await db.execute(sql`
    INSERT INTO twilio_calls (id, client_id, direction, from_number, to_number, status)
    VALUES (${G.tcall}, ${C1}, 'inbound', '+15550001111', '+15550002222', 'initiated')
  `);
}

async function boundaryTask4222StorageSpots(): Promise<void> {
  console.log("\nG. Task #4222 remaining storage edit boundaries");
  const comm = await import("../server/storage/communicationStorage");
  const agent = await import("../server/storage/agentStorage");
  const dj = await import("../server/storage/dailyJudgmentStorage");
  const tw = await import("../server/storage/twilioStorage");

  await seedG();

  await runSpot({
    label: "G1 updateAiSuggestion",
    fn: comm.updateAiSuggestion,
    rowId: G.aiSug,
    selectRow: () => row(sql`SELECT * FROM ai_suggestions WHERE id = ${G.aiSug}`),
    valid: { status: "approved", resolvedAt: new Date(), resolutionNotes: `${RUN} ok` },
    assertValid: (m) => {
      assertEq(m.status, "approved", "status updated");
      assert(m.resolved_at, "resolvedAt set");
    },
    forged: {
      id: `${RUN}-forged`,
      clientId: C2,
      rawCommunicationRecordId: `${RUN}-forged-rc`,
      suggestedTitle: "HACK",
      createdAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      resolutionNotes: `${RUN} v3`,
    },
    assertForged: (m) => {
      assertEq(m.client_id, C1, "clientId (ownership) unchanged");
      assertEq(m.raw_communication_record_id, RC1, "source FK unchanged");
      assertEq(m.suggested_title, `${RUN} sug`, "AI content unchanged");
      assertEq(m.resolution_notes, `${RUN} v3`, "legit sibling field applied");
    },
    invalid: { status: "not-a-status" },
    assertInvalid: (m) => assertEq(m.status, "approved", "status unchanged"),
  });

  await runSpot({
    label: "G2 updateFrontSyncEmail",
    fn: comm.updateFrontSyncEmail,
    rowId: G.fse,
    selectRow: () => row(sql`SELECT * FROM front_sync_emails WHERE id = ${G.fse}`),
    valid: { matchStatus: "matched", matchedClientId: C1, matchConfidence: 0.9, matchReason: `${RUN} reason` },
    assertValid: (m) => {
      assertEq(m.match_status, "matched", "matchStatus updated");
      assertEq(m.matched_client_id, C1, "matchedClientId updated");
    },
    forged: {
      id: `${RUN}-forged`,
      conversationId: `${RUN}-conv-FORGED`,
      pipelineState: "applied",
      versionKey: "forged-vk",
      subject: "HACK",
      unknownKey: 1,
      matchReason: `${RUN} v3`,
    },
    assertForged: (m) => {
      assertEq(m.conversation_id, `${RUN}-conv-1`, "conversationId (natural key) unchanged");
      assertEq(m.pipeline_state, "discovered", "pipelineState (state machine) unchanged");
      assertEq(m.subject, `${RUN} subj`, "ingest-managed subject unchanged");
      assertEq(m.match_reason, `${RUN} v3`, "legit sibling field applied");
    },
    invalid: { matchConfidence: "high" },
    assertInvalid: (m) => assertEq(Number(m.match_confidence), 0.9, "matchConfidence unchanged"),
  });

  await runSpot({
    label: "G3 updateSlackSyncHistory",
    fn: comm.updateSlackSyncHistory,
    rowId: G.slackHist,
    selectRow: () => row(sql`SELECT * FROM slack_sync_history WHERE id = ${G.slackHist}`),
    valid: { status: "completed", channelsProcessed: 3, completedAt: new Date() },
    assertValid: (m) => {
      assertEq(m.status, "completed", "status updated");
      assertEq(Number(m.channels_processed), 3, "counter updated");
      assert(m.completed_at, "completedAt set");
    },
    forged: {
      id: `${RUN}-forged`,
      triggeredBy: AM_ID,
      startedAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      status: "failed",
    },
    assertForged: (m) => {
      assertEq(m.triggered_by, null, "triggeredBy (attribution) unchanged");
      assert(new Date(m.started_at).getFullYear() > 2020, "startedAt not rewound");
      assertEq(m.status, "failed", "legit sibling field applied");
    },
    invalid: { channelsProcessed: "three" },
    assertInvalid: (m) => assertEq(Number(m.channels_processed), 3, "counter unchanged"),
  });

  await runSpot({
    label: "G4 updateCommunicationClientLink",
    fn: comm.updateCommunicationClientLink,
    rowId: G.link,
    selectRow: () => row(sql`SELECT * FROM communication_client_links WHERE id = ${G.link}`),
    valid: { status: "confirmed" },
    assertValid: (m) => assertEq(m.status, "confirmed", "status updated"),
    forged: {
      id: `${RUN}-forged`,
      rawCommunicationRecordId: `${RUN}-forged-rc`,
      clientId: C2,
      unknownKey: "x",
      status: "rejected",
    },
    assertForged: (m) => {
      assertEq(m.raw_communication_record_id, RC1, "record FK (link identity) unchanged");
      assertEq(m.client_id, C1, "clientId (link identity) unchanged");
      assertEq(m.status, "rejected", "legit sibling field applied");
    },
    invalid: { isPrimary: "yes" },
    assertInvalid: (m) => assertEq(m.status, "rejected", "status unchanged"),
  });

  await runSpot({
    label: "G5 updatePandadocDocument",
    fn: comm.updatePandadocDocument,
    rowId: G.panda,
    selectRow: () => row(sql`SELECT * FROM pandadoc_documents WHERE id = ${G.panda}`),
    valid: { title: `${RUN} doc v2`, status: "completed", lastSyncedAt: new Date() },
    assertValid: (m) => {
      assertEq(m.title, `${RUN} doc v2`, "title updated");
      assertEq(m.status, "completed", "status updated");
    },
    forged: {
      id: `${RUN}-forged`,
      documentId: `${RUN}-doc-FORGED`,
      createdAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      title: `${RUN} doc v3`,
    },
    assertForged: (m) => {
      assertEq(m.document_id, `${RUN}-doc-1`, "documentId (vendor natural key) unchanged");
      assert(new Date(m.created_at).getFullYear() > 2020, "createdAt not rewound");
      assertEq(m.title, `${RUN} doc v3`, "legit sibling field applied");
    },
    invalid: { title: 123 },
    assertInvalid: (m) => assertEq(m.title, `${RUN} doc v3`, "title unchanged"),
  });

  await runSpot({
    label: "G6 updateAgentKnowledgeEntry",
    fn: agent.updateAgentKnowledgeEntry,
    rowId: G.kb,
    selectRow: () => row(sql`SELECT * FROM agent_knowledge_base WHERE id = ${G.kb}`),
    valid: { factText: `${RUN} fact v2`, confidence: 0.9, isActive: false },
    assertValid: (m) => {
      assertEq(m.fact_text, `${RUN} fact v2`, "factText updated");
      assertEq(m.is_active, false, "isActive updated");
    },
    forged: {
      id: `${RUN}-forged`,
      clientId: C2,
      sourceAgent: "HACK",
      firstSeenAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      factText: `${RUN} fact v3`,
    },
    assertForged: (m) => {
      assertEq(m.client_id, C1, "clientId (ownership) unchanged");
      assertEq(m.source_agent, "daily_judgment", "sourceAgent (attribution) unchanged");
      assertEq(m.fact_text, `${RUN} fact v3`, "legit sibling field applied");
      assert(new Date(m.updated_at).getFullYear() > 2020, "updatedAt server-stamped");
    },
    invalid: { confidence: "high" },
    assertInvalid: (m) => assertEq(m.fact_text, `${RUN} fact v3`, "factText unchanged"),
  });

  await runSpot({
    label: "G7 updateAgentMatchDecision",
    fn: agent.updateAgentMatchDecision,
    rowId: G.amd,
    selectRow: () => row(sql`SELECT * FROM agent_match_decisions WHERE id = ${G.amd}`),
    valid: { status: "confirmed", reviewedByHuman: true, reviewedAt: new Date(), reviewedByUserId: AM_ID },
    assertValid: (m) => {
      assertEq(m.status, "confirmed", "status updated");
      assertEq(m.reviewed_by_human, true, "reviewedByHuman updated");
    },
    forged: {
      id: `${RUN}-forged`,
      communicationId: `${RUN}-comm-FORGED`,
      clientId: C2,
      confidenceScore: 0.01,
      unknownKey: "x",
      explanationSummary: `${RUN} v3`,
    },
    assertForged: (m) => {
      assertEq(m.communication_id, `${RUN}-comm-1`, "communication identity unchanged");
      assertEq(m.client_id, C1, "clientId unchanged");
      assertEq(Number(m.confidence_score), 0.5, "AI confidenceScore unchanged");
      assertEq(m.explanation_summary, `${RUN} v3`, "legit sibling field applied");
    },
    invalid: { reviewedByHuman: "yes" },
    assertInvalid: (m) => assertEq(m.status, "confirmed", "status unchanged"),
  });

  await runSpot({
    label: "G8 updateClientOpenAsk",
    fn: dj.updateClientOpenAsk,
    rowId: G.ask,
    selectRow: () => row(sql`SELECT * FROM client_open_asks WHERE id = ${G.ask}`),
    valid: { status: "resolved", resolvedAt: new Date(), resolvedBy: AM_ID, resolutionNote: `${RUN} done` },
    assertValid: (m) => {
      assertEq(m.status, "resolved", "status updated");
      assertEq(m.resolved_by, AM_ID, "resolvedBy updated");
    },
    forged: {
      id: `${RUN}-forged`,
      clientId: C2,
      askType: "internal_promise",
      summary: "HACK",
      unknownKey: "x",
      resolutionNote: `${RUN} v3`,
    },
    assertForged: (m) => {
      assertEq(m.client_id, C1, "clientId (ownership) unchanged");
      assertEq(m.ask_type, "client_ask", "askType (identity) unchanged");
      assertEq(m.summary, `${RUN} ask`, "summary (content) unchanged");
      assertEq(m.resolution_note, `${RUN} v3`, "legit sibling field applied");
    },
    invalid: { status: "bogus-status" },
    assertInvalid: (m) => assertEq(m.status, "resolved", "status unchanged"),
  });

  await runSpot({
    label: "G9 updateClientSavePlay",
    fn: dj.updateClientSavePlay,
    rowId: G.play,
    selectRow: () => row(sql`SELECT * FROM client_save_plays WHERE id = ${G.play}`),
    valid: { status: "completed", outcomeNote: `${RUN} won`, closedAt: new Date(), closedByUserId: AM_ID },
    assertValid: (m) => {
      assertEq(m.status, "completed", "status updated");
      assert(m.closed_at, "closedAt set");
    },
    forged: {
      id: `${RUN}-forged`,
      clientId: C2,
      createdByUserId: CEO_ID,
      createdAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      notes: `${RUN} v3`,
    },
    assertForged: (m) => {
      assertEq(m.client_id, C1, "clientId (ownership) unchanged");
      assertEq(m.created_by_user_id, null, "createdByUserId (attribution) unchanged");
      assertEq(m.notes, `${RUN} v3`, "legit sibling field applied");
    },
    invalid: { status: "bogus-status" },
    assertInvalid: (m) => assertEq(m.status, "completed", "status unchanged"),
  });

  await runSpot({
    label: "G10 updateTwilioConversation",
    fn: tw.updateTwilioConversation,
    rowId: G.tconv,
    selectRow: () => row(sql`SELECT * FROM twilio_conversations WHERE id = ${G.tconv}`),
    valid: { contactName: `${RUN} contact v2`, lastMessagePreview: "hey", unreadCount: 2, lastMessageAt: new Date() },
    assertValid: (m) => {
      assertEq(m.contact_name, `${RUN} contact v2`, "contactName updated");
      assertEq(Number(m.unread_count), 2, "unreadCount updated");
    },
    forged: {
      id: `${RUN}-forged`,
      clientId: C2,
      twilioPhoneNumber: "+19998887777",
      unknownKey: "x",
      contactName: `${RUN} contact v3`,
    },
    assertForged: (m) => {
      assertEq(m.client_id, C1, "clientId (ownership) unchanged");
      assertEq(m.twilio_phone_number, "+15550002222", "twilioPhoneNumber (identity) unchanged");
      assertEq(m.contact_name, `${RUN} contact v3`, "legit sibling field applied");
    },
    invalid: { unreadCount: "two" },
    assertInvalid: (m) => assertEq(m.contact_name, `${RUN} contact v3`, "contactName unchanged"),
  });

  await runSpot({
    label: "G11 updateTwilioMessage",
    fn: tw.updateTwilioMessage,
    rowId: G.tmsg,
    selectRow: () => row(sql`SELECT * FROM twilio_messages WHERE id = ${G.tmsg}`),
    valid: { status: "delivered" },
    assertValid: (m) => assertEq(m.status, "delivered", "status updated"),
    forged: {
      id: `${RUN}-forged`,
      conversationId: `${RUN}-forged-conv`,
      body: "HACK",
      direction: "outbound",
      sentByUserId: AM_ID,
      unknownKey: "x",
      errorMessage: `${RUN} v3`,
    },
    assertForged: (m) => {
      assertEq(m.conversation_id, G.tconv, "conversationId unchanged");
      assertEq(m.body, `${RUN} body orig`, "body (content) unchanged");
      assertEq(m.direction, "inbound", "direction (identity) unchanged");
      assertEq(m.error_message, `${RUN} v3`, "legit sibling field applied");
    },
    invalid: { errorCode: 30003 },
    assertInvalid: (m) => assertEq(m.status, "delivered", "status unchanged"),
  });

  await runSpot({
    label: "G12 updateTwilioCall",
    fn: tw.updateTwilioCall,
    rowId: G.tcall,
    selectRow: () => row(sql`SELECT * FROM twilio_calls WHERE id = ${G.tcall}`),
    valid: { status: "completed", duration: 42, answeredAt: new Date() },
    assertValid: (m) => {
      assertEq(m.status, "completed", "status updated");
      assertEq(Number(m.duration), 42, "duration updated");
    },
    forged: {
      id: `${RUN}-forged`,
      clientId: C2,
      direction: "outbound",
      fromNumber: "+19990001111",
      archiveStatus: "archived",
      unknownKey: "x",
      status: "no-answer",
    },
    assertForged: (m) => {
      assertEq(m.client_id, C1, "clientId (ownership) unchanged");
      assertEq(m.direction, "inbound", "direction (identity) unchanged");
      assertEq(m.from_number, "+15550001111", "fromNumber (identity) unchanged");
      assertEq(m.archive_status, "pending", "archive-pipeline state unchanged");
      assertEq(m.status, "no-answer", "legit sibling field applied");
    },
    invalid: { duration: "long" },
    assertInvalid: (m) => assertEq(m.status, "no-answer", "status unchanged"),
  });
}

// ---------------------------------------------------------------------------
// H. Task #4380 — last grandfathered storage edit boundaries closed.
//
// Spot checks (§G 3-step matrix) for the riskiest of the 17 conversions:
// updateClientContact (the contacts PUT route forwards a munged req.body),
// updateClient, and updateBookingPage (ownership column omitted from its
// update schema).
// ---------------------------------------------------------------------------

const H = {
  contact: `${RUN}-contact-1`,
  page: `${RUN}-bookpage-1`,
};

async function boundaryTask4380StorageSpots(): Promise<void> {
  console.log("\nH. Task #4380 final storage edit boundaries");
  const clientStore = await import("../server/storage/clientStorage");
  const bookingStore = await import("../server/storage/bookingStorage");

  await db.execute(sql`
    INSERT INTO client_contacts (id, client_id, name, emails, phones, is_primary)
    VALUES (${H.contact}, ${C1}, ${`${RUN} contact orig`}, ARRAY['orig@example.com'], ARRAY['+1 (555) 000-1111'], false)
  `);
  await db.execute(sql`
    INSERT INTO booking_pages (id, account_manager_user_id, slug, timezone, duration_minutes, title)
    VALUES (${H.page}, ${AM_ID}, ${`${RUN}-slug`}, 'America/Chicago', 30, ${`${RUN} page orig`})
  `);

  await runSpot({
    label: "H1 updateClient",
    fn: clientStore.updateClient,
    rowId: C1,
    selectRow: () => row(sql`SELECT * FROM clients WHERE id = ${C1}`),
    valid: { contactName: `${RUN} cname v2` },
    assertValid: (m) => assertEq(m.contact_name, `${RUN} cname v2`, "contactName updated"),
    forged: {
      id: `${RUN}-forged`,
      clientCode: "FORGED",
      createdAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      contactName: `${RUN} cname v3`,
    },
    assertForged: (m) => {
      assert(m.client_code !== "FORGED", "clientCode (generated identity) unchanged");
      assert(new Date(m.created_at).getFullYear() > 2020, "createdAt not rewound");
      assertEq(m.contact_name, `${RUN} cname v3`, "legit sibling field applied");
    },
    invalid: { isArchived: "yes" },
    assertInvalid: (m) => assertEq(m.contact_name, `${RUN} cname v3`, "contactName unchanged"),
  });

  await runSpot({
    label: "H2 updateClientContact",
    fn: (id, data) => clientStore.updateClientContact(id, data),
    rowId: H.contact,
    selectRow: () => row(sql`SELECT * FROM client_contacts WHERE id = ${H.contact}`),
    valid: { name: `${RUN} contact v2`, phones: ["+1 (555) 222-3333"] },
    assertValid: (m) => {
      assertEq(m.name, `${RUN} contact v2`, "name updated");
      assert(Array.isArray(m.phones_normalized) && m.phones_normalized.length === 1,
        "phonesNormalized derived server-side from phones");
    },
    forged: {
      id: `${RUN}-forged`,
      clientId: C2,
      phonesNormalized: ["+19999999999"],
      unknownKey: "x",
      name: `${RUN} contact v3`,
    },
    assertForged: (m) => {
      assertEq(m.client_id, C1, "clientId (ownership) unchanged");
      assert(!(m.phones_normalized ?? []).includes("+19999999999"),
        "phonesNormalized (derived) cannot be forged directly");
      assertEq(m.name, `${RUN} contact v3`, "legit sibling field applied");
    },
    invalid: { emails: "not-an-array" },
    assertInvalid: (m) => assertEq(m.name, `${RUN} contact v3`, "name unchanged"),
  });

  await runSpot({
    label: "H3 updateBookingPage",
    fn: bookingStore.updateBookingPage,
    rowId: H.page,
    selectRow: () => row(sql`SELECT * FROM booking_pages WHERE id = ${H.page}`),
    valid: { title: `${RUN} page v2`, durationMinutes: 45 },
    assertValid: (m) => {
      assertEq(m.title, `${RUN} page v2`, "title updated");
      assertEq(Number(m.duration_minutes), 45, "durationMinutes updated");
    },
    forged: {
      id: `${RUN}-forged`,
      accountManagerUserId: LOW_ID,
      createdAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      title: `${RUN} page v3`,
    },
    assertForged: (m) => {
      assertEq(m.account_manager_user_id, AM_ID, "accountManagerUserId (ownership) unchanged");
      assert(new Date(m.created_at).getFullYear() > 2020, "createdAt not rewound");
      assertEq(m.title, `${RUN} page v3`, "legit sibling field applied");
    },
    invalid: { durationMinutes: "long" },
    assertInvalid: (m) => assertEq(m.title, `${RUN} page v3`, "title unchanged"),
  });
}

// ---------------------------------------------------------------------------
// I. Task #4521 — email-sequence storage boundaries.
//
// Task #4483 covered these six spread-writes with reviewed markers; #4548/#4521
// replace the markers with runtime-parsed focused patch schemas
// (shared/models/emailSequences.ts). Same 3-step spot matrix as §G. Protected
// per writer: row id, FKs/identity (sequenceId/enrollmentId/stepId/clientId/
// entityId/templateId), pinned recipient/sender, server timestamps and the
// CAS/state-machine columns (enrollment status/currentStepOrder via
// updateEnrollment; step-send linkage/provenance via the step-send patch).
// ---------------------------------------------------------------------------

const I = {
  tpl: `${RUN}-eseq-tpl-1`,
  seq: `${RUN}-eseq-seq-1`,
  step1: `${RUN}-eseq-step-1`,
  step2: `${RUN}-eseq-step-2`,
  enr: `${RUN}-eseq-enr-1`,
  send: `${RUN}-eseq-send-1`,
};

async function seedI(): Promise<void> {
  await db.execute(sql`
    INSERT INTO email_templates (id, name, subject, body_text)
    VALUES (${I.tpl}, ${`${RUN} tpl orig`}, ${`${RUN} subj orig`}, 'body')
  `);
  await db.execute(sql`
    INSERT INTO email_sequences (id, name, status)
    VALUES (${I.seq}, ${`${RUN} seq orig`}, 'active')
  `);
  await db.execute(sql`
    INSERT INTO email_sequence_steps (id, sequence_id, step_order, template_id, delay_minutes)
    VALUES (${I.step1}, ${I.seq}, 1, ${I.tpl}, 0),
           (${I.step2}, ${I.seq}, 2, ${I.tpl}, 60)
  `);
  await db.execute(sql`
    INSERT INTO email_sequence_enrollments
      (id, sequence_id, entity_type, entity_id, client_id, recipient_email,
       sender_user_id, status, current_step_order)
    VALUES (${I.enr}, ${I.seq}, 'client', ${C1}, ${C1},
            ${`${RUN}-orig@example.com`}, ${AM_ID}, 'active', 0)
  `);
  await db.execute(sql`
    INSERT INTO email_sequence_step_sends
      (id, enrollment_id, sequence_id, step_id, step_order, template_id,
       recipient_email, sender_user_id, status)
    VALUES (${I.send}, ${I.enr}, ${I.seq}, ${I.step1}, 1, ${I.tpl},
            ${`${RUN}-orig@example.com`}, ${AM_ID}, 'draft')
  `);
}

async function boundaryTask4521EmailSequenceSpots(): Promise<void> {
  console.log("\nI. Task #4521 email-sequence storage boundaries");
  const es = await import("../server/storage/emailSequencesStorage");

  await seedI();

  await runSpot({
    label: "I1 updateEmailTemplate",
    fn: (id, d) => es.updateEmailTemplate(id, d),
    rowId: I.tpl,
    selectRow: () => row(sql`SELECT * FROM email_templates WHERE id = ${I.tpl}`),
    valid: { name: `${RUN} tpl v2`, subject: `${RUN} subj v2` },
    assertValid: (m) => {
      assertEq(m.name, `${RUN} tpl v2`, "name updated");
      assertEq(m.subject, `${RUN} subj v2`, "subject updated");
    },
    forged: {
      id: `${RUN}-forged`,
      createdBy: AM_ID,
      createdAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      name: `${RUN} tpl v3`,
    },
    assertForged: (m) => {
      assertEq(m.created_by, null, "createdBy (attribution) unchanged");
      assert(new Date(m.created_at).getFullYear() > 2020, "createdAt not rewound");
      assertEq(m.name, `${RUN} tpl v3`, "legit sibling field applied");
    },
    invalid: { archived: "yes" },
    assertInvalid: (m) => assertEq(m.name, `${RUN} tpl v3`, "name unchanged"),
  });

  await runSpot({
    label: "I2 updateEmailSequence",
    fn: (id, d) => es.updateEmailSequence(id, d),
    rowId: I.seq,
    selectRow: () => row(sql`SELECT * FROM email_sequences WHERE id = ${I.seq}`),
    valid: { name: `${RUN} seq v2`, status: "paused" },
    assertValid: (m) => {
      assertEq(m.name, `${RUN} seq v2`, "name updated");
      assertEq(m.status, "paused", "status updated");
    },
    forged: {
      id: `${RUN}-forged`,
      createdBy: AM_ID,
      createdAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      name: `${RUN} seq v3`,
    },
    assertForged: (m) => {
      assertEq(m.created_by, null, "createdBy (attribution) unchanged");
      assert(new Date(m.created_at).getFullYear() > 2020, "createdAt not rewound");
      assertEq(m.name, `${RUN} seq v3`, "legit sibling field applied");
    },
    invalid: { autoSendEnabled: "yes" },
    assertInvalid: (m) => assertEq(m.name, `${RUN} seq v3`, "name unchanged"),
  });

  await runSpot({
    label: "I3 updateEnrollment",
    fn: async (id, d) => {
      await es.updateEnrollment(id, d);
      return true; // void writer — runSpot only needs truthy
    },
    rowId: I.enr,
    selectRow: () => row(sql`SELECT * FROM email_sequence_enrollments WHERE id = ${I.enr}`),
    valid: { nextStepAt: new Date(Date.now() + 24 * 3600 * 1000) },
    assertValid: (m) => assert(m.next_step_at, "nextStepAt set"),
    forged: {
      id: `${RUN}-forged`,
      sequenceId: `${RUN}-forged-seq`,
      clientId: C2,
      entityId: C2,
      recipientEmail: "hack@example.com",
      status: "completed",
      currentStepOrder: 99,
      cancelReason: "manual",
      unknownKey: "x",
      nextStepAt: null,
    },
    assertForged: (m) => {
      assertEq(m.sequence_id, I.seq, "sequenceId (identity) unchanged");
      assertEq(m.client_id, C1, "clientId (ownership) unchanged");
      assertEq(m.recipient_email, `${RUN}-orig@example.com`, "pinned recipient unchanged");
      assertEq(m.status, "active", "status (state machine) unchanged");
      assertEq(Number(m.current_step_order), 0, "CAS counter unchanged");
      assertEq(m.cancel_reason, null, "cancelReason unchanged");
      assertEq(m.next_step_at, null, "legit sibling field applied (null)");
    },
    invalid: { nextStepAt: "soon" },
    assertInvalid: (m) => assertEq(m.status, "active", "row untouched"),
  });

  await runSpot({
    label: "I4 casAdvanceEnrollment",
    fn: async (id, d) => {
      const cur = await row(
        sql`SELECT current_step_order FROM email_sequence_enrollments WHERE id = ${id}`,
      );
      return es.casAdvanceEnrollment(id, Number(cur.current_step_order), d);
    },
    rowId: I.enr,
    selectRow: () => row(sql`SELECT * FROM email_sequence_enrollments WHERE id = ${I.enr}`),
    valid: { currentStepOrder: 1, nextStepAt: new Date(Date.now() + 48 * 3600 * 1000) },
    assertValid: (m) => {
      assertEq(Number(m.current_step_order), 1, "CAS counter advanced");
      assert(m.next_step_at, "nextStepAt set");
    },
    forged: {
      id: `${RUN}-forged`,
      sequenceId: `${RUN}-forged-seq`,
      clientId: C2,
      entityId: C2,
      recipientEmail: "hack@example.com",
      senderUserId: LOW_ID,
      cancelReason: "manual",
      createdAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      currentStepOrder: 2,
      nextStepAt: null,
      status: "completed",
      completedAt: new Date(),
    },
    assertForged: (m) => {
      assertEq(m.sequence_id, I.seq, "sequenceId (identity) unchanged");
      assertEq(m.client_id, C1, "clientId (ownership) unchanged");
      assertEq(m.recipient_email, `${RUN}-orig@example.com`, "pinned recipient unchanged");
      assertEq(m.sender_user_id, AM_ID, "pinned sender unchanged");
      assertEq(m.cancel_reason, null, "cancelReason (cancel writer's column) unchanged");
      assert(new Date(m.created_at).getFullYear() > 2020, "createdAt not rewound");
      assertEq(Number(m.current_step_order), 2, "legit CAS transition applied");
      assertEq(m.status, "completed", "legit advance-vocabulary status applied");
    },
    invalid: { currentStepOrder: "three", nextStepAt: null },
    assertInvalid: (m) => assertEq(Number(m.current_step_order), 2, "CAS counter unchanged"),
  });

  await runSpot({
    label: "I5 casUpdateStepSend",
    fn: (id, d) => es.casUpdateStepSend(id, ["draft", "approved"], d),
    rowId: I.send,
    selectRow: () => row(sql`SELECT * FROM email_sequence_step_sends WHERE id = ${I.send}`),
    valid: { status: "approved", approvedBy: AM_ID, approvedAt: new Date() },
    assertValid: (m) => {
      assertEq(m.status, "approved", "status transitioned");
      assertEq(m.approved_by, AM_ID, "approvedBy set");
    },
    forged: {
      id: `${RUN}-forged`,
      enrollmentId: `${RUN}-forged-enr`,
      sequenceId: `${RUN}-forged-seq`,
      stepId: `${RUN}-forged-step`,
      stepOrder: 99,
      templateId: `${RUN}-forged-tpl`,
      recipientEmail: "hack@example.com",
      senderUserId: LOW_ID,
      aiPersonalized: true,
      createdAt: "2020-01-01T00:00:00.000Z",
      unknownKey: "x",
      errorMessage: `${RUN} err v3`,
    },
    assertForged: (m) => {
      assertEq(m.enrollment_id, I.enr, "enrollmentId (claim linkage) unchanged");
      assertEq(m.step_id, I.step1, "stepId (claim linkage) unchanged");
      assertEq(Number(m.step_order), 1, "stepOrder unchanged");
      assertEq(m.recipient_email, `${RUN}-orig@example.com`, "pinned recipient unchanged");
      assertEq(m.sender_user_id, AM_ID, "pinned sender unchanged");
      assertEq(m.ai_personalized, false, "render provenance unchanged");
      assertEq(m.error_message, `${RUN} err v3`, "legit sibling field applied");
    },
    invalid: { status: "not-a-status" },
    assertInvalid: (m) => assertEq(m.status, "approved", "status unchanged"),
  });

  await runSpot({
    label: "I6 updateStepSend",
    fn: async (id, d) => {
      await es.updateStepSend(id, d);
      return true; // void writer — runSpot only needs truthy
    },
    rowId: I.send,
    selectRow: () => row(sql`SELECT * FROM email_sequence_step_sends WHERE id = ${I.send}`),
    valid: { outboundBatchId: `${RUN}-batch-1`, outboundEmailId: `${RUN}-email-1` },
    assertValid: (m) => {
      assertEq(m.outbound_batch_id, `${RUN}-batch-1`, "outbound linkage set");
      assertEq(m.outbound_email_id, `${RUN}-email-1`, "outbound email linkage set");
    },
    forged: {
      id: `${RUN}-forged`,
      enrollmentId: `${RUN}-forged-enr`,
      stepId: `${RUN}-forged-step`,
      recipientEmail: "hack@example.com",
      senderUserId: LOW_ID,
      aiPersonalized: true,
      unknownKey: "x",
      errorMessage: `${RUN} err v4`,
    },
    assertForged: (m) => {
      assertEq(m.enrollment_id, I.enr, "enrollmentId (claim linkage) unchanged");
      assertEq(m.step_id, I.step1, "stepId (claim linkage) unchanged");
      assertEq(m.recipient_email, `${RUN}-orig@example.com`, "pinned recipient unchanged");
      assertEq(m.sender_user_id, AM_ID, "pinned sender unchanged");
      assertEq(m.ai_personalized, false, "render provenance unchanged");
      assertEq(m.error_message, `${RUN} err v4`, "legit sibling field applied");
    },
    invalid: { missingFields: "none" },
    assertInvalid: (m) => assertEq(m.error_message, `${RUN} err v4`, "row untouched"),
  });
}

async function main(): Promise<void> {
  await cleanup(); // clear any leftovers from a prior aborted run
  await seed();
  try {
    await boundaryAgentMemory();
    await boundarySemrushIntegration();
    await boundaryReportPatch();
    await boundaryClientPatch();
    await boundarySlackChannelMapping();
    await boundaryRisAutoSourceMapping();
    await boundaryTask4222StorageSpots();
    await boundaryTask4380StorageSpots();
    await boundaryTask4521EmailSequenceSpots();
  } finally {
    await cleanup();
  }
  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll persistence-write boundary tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit(); a
// leaked handle surfaces as a hang instead of being masked by a forced exit.
let exitCode = 0;
main()
  .catch((err) => {
    console.error("persistence-write-boundaries: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
