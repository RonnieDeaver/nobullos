/* test-registration
{
  "name": "Email sequences routes — template CRUD + merge-vocabulary 400, preview against real records, sequence lifecycle, owner-or-CEO auto-send gate, CEO-only kill switch, steps-locked-under-active-enrollments 409, enroll/approve/reject HTTP contract, draft edit PATCH (200 edited / 400 / 404 / 409 after approve), manual-suppression route + website-unsubscribe intake eagerly cancel drafted sends (Tasks #4335/#4478)",
  "regression": true,
  "sweepOnlyReason": "Route-surface companion to tests/email-sequences-service.test.ts (the smoke gate for the double-send defenses and cancel semantics). This suite pins the HTTP contract only: zod 400s (unknown merge tokens report the exact offenders), authz seams (auto-send is owner-or-CEO, the global kill switch is CEO-only, everything else authenticated), status-code mapping for enroll/approve/reject outcomes (201/409/404), and the PUT-steps 409 while enrollments are active. Full express app + real requireAuth/requireCeo middlewares over the hermetic DB — heavier than and logically redundant with the service suite, so regression-sweep only.",
  "tier": "small"
}
test-registration */
/**
 * Task #4335 — email sequences HTTP surface.
 *
 * What must never drift:
 *   1. AUTHZ — every route is authenticated (401 anonymous); the global
 *      kill switch POST is CEO-only (403 for others); auto-send PATCH is
 *      sequence-owner-or-CEO (403 for a non-owner team member).
 *   2. TEMPLATE SAFETY — creating/updating a template with tokens outside
 *      the merge vocabulary is a 400 naming the offenders (typos surface at
 *      save time, not as broken sends later); preview renders against the
 *      REAL client record with per-field missing reporting.
 *   3. OUTCOME → STATUS MAPPING — enroll 201, repeat-enroll 409
 *      (already_active), unknown sequence 404; approve draft 200/sent,
 *      re-approve 409 (not_pending); reject 200 then 409; PUT steps under
 *      active enrollments 409.
 *   4. SUPPRESSION SIDE EFFECT — POST /api/outbound-email/suppressions
 *      cancels active enrollments for the address immediately; the
 *      already-drafted step send can no longer be approved (409).
 *   5. WEBSITE UNSUBSCRIBE INTAKE — the public /api/website/inquiry
 *      unsubscribe path routes through the same side-effect helper:
 *      enrollment cancelled (reason "unsubscribed"), draft dead (409).
 *
 * Auth: per-request Clerk test seam (req.__test_clerkUserId) + seeded users
 * rows; the REAL isAuthenticated/requireCeo middlewares run. DB: hermetic
 * per-run Postgres; per-run suffixed rows. undici dispatcher closed at exit.
 */

process.env.NODE_ENV = "test";
delete process.env.SENDGRID_API_KEY;
delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomInt, randomUUID } from "node:crypto";
import { getGlobalDispatcher } from "undici";

const { registerEmailSequencesRoutes } = await import("../server/routes/emailSequences");
const { registerOutboundEmailRoutes } = await import("../server/routes/outboundEmail");
const { registerWebsiteRoutes } = await import("../server/routes/website");
const { db, closeDbPools } = await import("../server/db");
const { sql } = await import("drizzle-orm");
const { handleEmailSequenceStepJob, EMAIL_SEQUENCES_PAUSED_KEY } = await import(
  "../server/services/emailSequences"
);
const { getSystemSettingFresh, setSystemSetting } = await import(
  "../server/storage/settingsStorage"
);
const { listEnrollments } = await import("../server/storage/emailSequencesStorage");
const { clients } = await import("@shared/models/clients");

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-4335r-ceo-${RUN}`;
const LEAD_ID = `test-4335r-lead-${RUN}`;
const AM_ID = `test-4335r-am-${RUN}`;
const rcpt = (tag: string) => `${tag}-${RUN}@recipient-seq4335r.test`;

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

let activeUserId: string | null = AM_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk-era per-request test seam (memory: clerk-route-test-auth-seam).
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerEmailSequencesRoutes(app);
  // Suppression admin route — section 11 proves its eager sequence-cancel
  // side effect end to end; public website inquiry route — section 12
  // proves the website-unsubscribe intake path does the same
  // (Task #4335 review hardening).
  registerOutboundEmailRoutes(app);
  registerWebsiteRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* empty */
  }
  return { status: r.status, body: parsed };
}

async function main(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, email) VALUES
      (${CEO_ID}, 'ceo', 'Ceo4335r', ${`ceo-${RUN}@seq4335r.test`}),
      (${LEAD_ID}, 'team_lead', 'Lead4335r', ${`lead-${RUN}@seq4335r.test`}),
      (${AM_ID}, 'account_manager', 'Am4335r', ${`am-${RUN}@seq4335r.test`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  const [client] = await db
    .insert(clients)
    .values({
      firmName: `Route Firm ${RUN}`,
      contactName: "Rita Route",
      contactEmail: rcpt("client"),
      ownerId: LEAD_ID,
      lifecycleStage: "lead",
    })
    .returning();

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── 1. Anonymous → 401 ───────────────────────────────────────────────────
    activeUserId = null;
    let r = await call(baseUrl, "GET", "/api/email-sequences");
    check("anonymous list → 401", r.status === 401, `${r.status}`);
    r = await call(baseUrl, "POST", "/api/email-templates", { name: "x", subject: "s", bodyText: "b" });
    check("anonymous template create → 401", r.status === 401, `${r.status}`);

    // ── 2. Templates: create / vocabulary 400 / list / patch ────────────────
    activeUserId = AM_ID;
    r = await call(baseUrl, "POST", "/api/email-templates", {
      name: `Rt T1 ${RUN}`,
      subject: "Hello {{client.firmName}}",
      bodyText: "Hi {{contact.firstName|there}}, from {{sender.email}}. Deal: {{deal.name}}",
    });
    check("template create → 201", r.status === 201 && !!r.body?.template?.id,
      `${r.status} ${JSON.stringify(r.body)}`);
    const templateId = r.body.template.id as string;

    r = await call(baseUrl, "POST", "/api/email-templates", {
      name: `Rt bad ${RUN}`,
      subject: "Oops {{contact.nmae}}",
      bodyText: "b",
    });
    check(
      "unknown merge token → 400 naming the offender",
      r.status === 400 && Array.isArray(r.body?.unknownTokens) &&
        r.body.unknownTokens.includes("contact.nmae"),
      `${r.status} ${JSON.stringify(r.body)}`,
    );

    r = await call(baseUrl, "GET", "/api/email-templates");
    check(
      "template list returns rows + merge vocabulary",
      r.status === 200 &&
        (r.body?.templates ?? []).some((t: any) => t.id === templateId) &&
        typeof r.body?.mergeFields === "object" &&
        !!r.body.mergeFields["contact.firstName"],
      `${r.status}`,
    );

    r = await call(baseUrl, "PATCH", `/api/email-templates/${templateId}`, {
      description: "route-test template",
    });
    check("template patch → 200", r.status === 200 &&
      r.body?.template?.description === "route-test template", `${r.status}`);
    r = await call(baseUrl, "PATCH", `/api/email-templates/${templateId}`, {
      bodyText: "now with {{bad.token}}",
    });
    check("template patch with unknown token → 400", r.status === 400 &&
      (r.body?.unknownTokens ?? []).includes("bad.token"), `${r.status}`);

    // ── 3. Preview against the real client record ────────────────────────────
    r = await call(baseUrl, "POST", `/api/email-templates/${templateId}/preview`, {
      entityType: "client",
      entityId: client.id,
    });
    check(
      "preview renders real values + reports missing fields",
      r.status === 200 &&
        r.body?.preview?.subject === `Hello Route Firm ${RUN}` &&
        (r.body?.preview?.missing ?? []).includes("deal.name") &&
        r.body?.target?.recipientEmail === rcpt("client") &&
        r.body?.target?.senderUserId === LEAD_ID,
      `${r.status} ${JSON.stringify(r.body)}`,
    );
    r = await call(baseUrl, "POST", `/api/email-templates/${templateId}/preview`, {
      entityType: "client",
      entityId: randomUUID(), // well-formed but unknown → 404 (malformed ids are zod 400s)
    });
    check("preview against unknown record → 404", r.status === 404, `${r.status}`);

    // ── 4. Sequence create (starts paused) + list counts ─────────────────────
    r = await call(baseUrl, "POST", "/api/email-sequences", {
      name: `Rt Seq ${RUN}`,
      description: "route seq",
      steps: [
        { templateId, delayMinutes: 0 },
        { templateId, delayMinutes: 1440 },
      ],
    });
    check(
      "sequence create → 201, starts paused with steps",
      r.status === 201 && r.body?.sequence?.status === "paused" &&
        (r.body?.steps ?? []).length === 2,
      `${r.status} ${JSON.stringify(r.body?.sequence)}`,
    );
    const seqId = r.body.sequence.id as string;

    r = await call(baseUrl, "POST", "/api/email-sequences", {
      name: `Rt bad seq ${RUN}`,
      steps: [{ templateId: "nope", delayMinutes: 0 }],
    });
    check("sequence create with unknown template → 400", r.status === 400, `${r.status}`);

    r = await call(baseUrl, "GET", "/api/email-sequences");
    const listRow = (r.body?.sequences ?? []).find((s: any) => s.id === seqId);
    check("list row carries stepCount/activeEnrollments/pendingDrafts",
      r.status === 200 && listRow?.stepCount === 2 && listRow?.activeEnrollments === 0 &&
        listRow?.pendingDrafts === 0,
      JSON.stringify(listRow));

    // ── 5. Auto-send gate: non-owner 403, owner 200, CEO 200 ─────────────────
    activeUserId = LEAD_ID; // not the creator (AM created it), not CEO
    r = await call(baseUrl, "PATCH", `/api/email-sequences/${seqId}/auto-send`, { enabled: true });
    check("auto-send by non-owner team member → 403", r.status === 403, `${r.status}`);
    activeUserId = AM_ID; // creator
    r = await call(baseUrl, "PATCH", `/api/email-sequences/${seqId}/auto-send`, { enabled: true });
    check("auto-send by owner → 200", r.status === 200 &&
      r.body?.sequence?.autoSendEnabled === true, `${r.status}`);
    activeUserId = CEO_ID;
    r = await call(baseUrl, "PATCH", `/api/email-sequences/${seqId}/auto-send`, { enabled: false });
    check("auto-send by CEO → 200 (off again)", r.status === 200 &&
      r.body?.sequence?.autoSendEnabled === false, `${r.status}`);

    // ── 6. Kill switch: CEO-only ─────────────────────────────────────────────
    activeUserId = AM_ID;
    r = await call(baseUrl, "GET", "/api/email-sequences/settings");
    check("settings GET (any auth) → 200 paused:false", r.status === 200 &&
      r.body?.paused === false, `${r.status} ${JSON.stringify(r.body)}`);
    r = await call(baseUrl, "POST", "/api/email-sequences/settings", { paused: true });
    check("kill switch by non-CEO → 403", r.status === 403, `${r.status}`);
    activeUserId = CEO_ID;
    r = await call(baseUrl, "POST", "/api/email-sequences/settings", { paused: true });
    const settingNow = await getSystemSettingFresh(EMAIL_SEQUENCES_PAUSED_KEY);
    check("kill switch by CEO → 200 and persisted", r.status === 200 &&
      settingNow?.value === "true", `${r.status}/${settingNow?.value}`);
    r = await call(baseUrl, "POST", "/api/email-sequences/settings", { paused: false });
    check("kill switch restored to false", r.status === 200, `${r.status}`);

    // ── 7. Activate, enroll (201 → 409), steps locked (409) ──────────────────
    activeUserId = AM_ID;
    r = await call(baseUrl, "PATCH", `/api/email-sequences/${seqId}`, { status: "active" });
    check("activate → 200", r.status === 200 && r.body?.sequence?.status === "active",
      `${r.status}`);

    r = await call(baseUrl, "POST", `/api/email-sequences/${seqId}/enroll`, {
      entityType: "client",
      entityId: client.id,
    });
    check("enroll → 201 enrolled", r.status === 201 && r.body?.outcome === "enrolled",
      `${r.status} ${JSON.stringify(r.body)}`);
    const enrollmentId = r.body.enrollmentId as string;

    r = await call(baseUrl, "POST", `/api/email-sequences/${seqId}/enroll`, {
      entityType: "client",
      entityId: client.id,
    });
    check("second enroll → 409 already_active", r.status === 409 &&
      r.body?.outcome === "already_active", `${r.status}`);
    r = await call(baseUrl, "POST", `/api/email-sequences/nonexistent/enroll`, {
      entityType: "client",
      entityId: client.id,
    });
    check("enroll into unknown sequence → 404", r.status === 404, `${r.status}`);

    r = await call(baseUrl, "PUT", `/api/email-sequences/${seqId}/steps`, {
      steps: [{ templateId, delayMinutes: 0 }],
    });
    check("PUT steps under an active enrollment → 409", r.status === 409, `${r.status}`);

    // ── 8. Approval queue surface: draft → approve 200 → reject 409 ──────────
    await handleEmailSequenceStepJob({ payload: { enrollmentId, stepOrder: 1 } });
    r = await call(baseUrl, "GET", "/api/email-sequences/approvals");
    const item = (r.body?.items ?? []).find((i: any) => i.enrollmentId === enrollmentId);
    check("approvals queue lists the draft with sequence context",
      r.status === 200 && !!item && item.sequenceName === `Rt Seq ${RUN}` &&
        item.status === "draft",
      `${r.status} ${JSON.stringify(item ?? r.body)}`);

    // Task #4478 — drafts are editable before approval, frozen after.
    r = await call(baseUrl, "PATCH", `/api/email-sequences/step-sends/${item.id}`, {
      subject: `Edited via API ${RUN}`,
      bodyText: `Edited body via API ${RUN}`,
    });
    check("edit draft → 200 with the frozen edited content",
      r.status === 200 && r.body?.outcome === "edited" &&
        r.body?.stepSend?.renderedSubject === `Edited via API ${RUN}` &&
        r.body?.stepSend?.renderedBodyText === `Edited body via API ${RUN}`,
      `${r.status} ${JSON.stringify(r.body)}`);
    r = await call(baseUrl, "PATCH", `/api/email-sequences/step-sends/${item.id}`, {
      subject: "", bodyText: "x",
    });
    check("edit with empty subject → 400", r.status === 400, `${r.status}`);
    r = await call(baseUrl, "PATCH", `/api/email-sequences/step-sends/nonexistent`, {
      subject: "s", bodyText: "b",
    });
    check("edit unknown step-send → 404", r.status === 404, `${r.status}`);

    r = await call(baseUrl, "POST", `/api/email-sequences/step-sends/${item.id}/approve`, {});
    check("approve draft → 200 sent", r.status === 200 && r.body?.outcome === "sent",
      `${r.status} ${JSON.stringify(r.body)}`);
    r = await call(baseUrl, "PATCH", `/api/email-sequences/step-sends/${item.id}`, {
      subject: "too late", bodyText: "too late",
    });
    check("edit after approve → 409 not_pending", r.status === 409, `${r.status}`);
    r = await call(baseUrl, "POST", `/api/email-sequences/step-sends/${item.id}/reject`, {});
    check("reject after approve → 409 not_pending", r.status === 409, `${r.status}`);
    r = await call(baseUrl, "POST", `/api/email-sequences/step-sends/nonexistent/approve`, {});
    check("approve unknown step-send → 404", r.status === 404, `${r.status}`);

    // ── 9. Detail + analytics + enrollments listings ─────────────────────────
    r = await call(baseUrl, "GET", `/api/email-sequences/${seqId}`);
    check(
      "detail returns sequence + steps(templateName) + analytics",
      r.status === 200 &&
        r.body?.sequence?.id === seqId &&
        (r.body?.steps ?? [])[0]?.templateName === `Rt T1 ${RUN}` &&
        r.body?.analytics?.enrolled === 1 &&
        r.body?.analytics?.inProgress === 1,
      `${r.status} ${JSON.stringify(r.body?.analytics)}`,
    );
    r = await call(baseUrl, "GET", `/api/email-sequences/${seqId}/enrollments?status=active`);
    check("enrollments listing filters by status", r.status === 200 &&
      (r.body?.enrollments ?? []).length === 1, `${r.status}`);
    r = await call(baseUrl, "GET", `/api/email-sequences/${seqId}/analytics`);
    check("analytics endpoint shape", r.status === 200 &&
      Array.isArray(r.body?.analytics?.perStep), `${r.status}`);

    // ── 10. Manual cancel endpoint: 200 then 409 ─────────────────────────────
    r = await call(baseUrl, "POST", `/api/email-sequences/enrollments/${enrollmentId}/cancel`, {
      note: "route-test cancel",
    });
    check("cancel enrollment → 200", r.status === 200 && r.body?.cancelled === true,
      `${r.status}`);
    r = await call(baseUrl, "POST", `/api/email-sequences/enrollments/${enrollmentId}/cancel`, {});
    check("re-cancel → 409 (not active)", r.status === 409, `${r.status}`);

    // ── 11. Manual suppression route eagerly cancels enrollment + draft ──────
    activeUserId = LEAD_ID;
    const [clientSup] = await db
      .insert(clients)
      .values({
        firmName: `Route Firm Sup ${RUN}`,
        contactName: "Sam Suppressed",
        contactEmail: rcpt("suppressed"),
        ownerId: LEAD_ID,
        lifecycleStage: "lead",
      })
      .returning();
    r = await call(baseUrl, "POST", `/api/email-sequences/${seqId}/enroll`, {
      entityType: "client",
      entityId: clientSup.id,
    });
    check("suppression-flow enroll → 201", r.status === 201, `${r.status}`);
    const supEnrollmentId = r.body.enrollmentId as string;
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: supEnrollmentId, stepOrder: 1 },
    });
    r = await call(baseUrl, "GET", "/api/email-sequences/approvals");
    const supItem = (r.body?.items ?? []).find(
      (i: any) => i.enrollmentId === supEnrollmentId,
    );
    check("draft queued before suppression", !!supItem && supItem.status === "draft",
      JSON.stringify(supItem ?? r.body));
    r = await call(baseUrl, "POST", "/api/outbound-email/suppressions", {
      email: rcpt("suppressed"),
      reason: "manual",
      notes: "route-test manual suppression",
    });
    check("manual suppression via admin route → 201", r.status === 201,
      `${r.status} ${JSON.stringify(r.body)}`);
    const supEnr = (await listEnrollments(seqId, "cancelled")).find(
      (e) => e.id === supEnrollmentId,
    );
    check(
      "suppression route cancelled the enrollment immediately (reason 'suppressed')",
      supEnr?.cancelReason === "suppressed",
      JSON.stringify(supEnr ?? {}),
    );
    r = await call(baseUrl, "POST", `/api/email-sequences/step-sends/${supItem.id}/approve`, {});
    check(
      "drafted send can no longer be approved after manual suppression → 409",
      r.status === 409,
      `${r.status} ${JSON.stringify(r.body)}`,
    );

    // ── 12. Website unsubscribe intake eagerly cancels enrollment + draft ────
    const [clientWeb] = await db
      .insert(clients)
      .values({
        firmName: `Route Firm WebUnsub ${RUN}`,
        contactName: "Wendy Webb",
        contactEmail: rcpt("webunsub"),
        ownerId: LEAD_ID,
        lifecycleStage: "lead",
      })
      .returning();
    r = await call(baseUrl, "POST", `/api/email-sequences/${seqId}/enroll`, {
      entityType: "client",
      entityId: clientWeb.id,
    });
    check("web-unsub-flow enroll → 201", r.status === 201, `${r.status}`);
    const webEnrollmentId = r.body.enrollmentId as string;
    await handleEmailSequenceStepJob({
      payload: { enrollmentId: webEnrollmentId, stepOrder: 1 },
    });
    r = await call(baseUrl, "GET", "/api/email-sequences/approvals");
    const webItem = (r.body?.items ?? []).find(
      (i: any) => i.enrollmentId === webEnrollmentId,
    );
    check("draft queued before website unsubscribe",
      !!webItem && webItem.status === "draft",
      JSON.stringify(webItem ?? r.body));
    // Public intake endpoint — unauthenticated by design.
    r = await call(baseUrl, "POST", "/api/website/inquiry", {
      kind: "unsubscribe",
      email: rcpt("webunsub"),
    });
    check("website unsubscribe intake → 200 ok", r.status === 200 && r.body?.ok === true,
      `${r.status} ${JSON.stringify(r.body)}`);
    const webEnr = (await listEnrollments(seqId, "cancelled")).find(
      (e) => e.id === webEnrollmentId,
    );
    check(
      "website unsubscribe cancelled the enrollment immediately (reason 'unsubscribed')",
      webEnr?.cancelReason === "unsubscribed",
      JSON.stringify(webEnr ?? {}),
    );
    r = await call(baseUrl, "POST", `/api/email-sequences/step-sends/${webItem.id}/approve`, {});
    check(
      "drafted send can no longer be approved after website unsubscribe → 409",
      r.status === 409,
      `${r.status} ${JSON.stringify(r.body)}`,
    );

    // ── 13. Archive cancels active enrollments ───────────────────────────────
    r = await call(baseUrl, "POST", `/api/email-sequences/${seqId}/enroll`, {
      entityType: "client",
      entityId: client.id,
    });
    check("re-enroll after cancel → 201", r.status === 201, `${r.status}`);
    r = await call(baseUrl, "PATCH", `/api/email-sequences/${seqId}`, { status: "archived" });
    const activeAfterArchive = await listEnrollments(seqId, "active");
    check("archive → 200 and cancels the active enrollment",
      r.status === 200 && activeAfterArchive.length === 0,
      `${r.status} active=${activeAfterArchive.length}`);
    const cancelled = (await listEnrollments(seqId, "cancelled")).find(
      (e) => e.cancelReason === "sequence_archived",
    );
    check("archived cancel visible with reason", !!cancelled, JSON.stringify(cancelled ?? {}));
  } finally {
    await setSystemSetting(EMAIL_SEQUENCES_PAUSED_KEY, "false", CEO_ID).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  await getGlobalDispatcher().close();
  await closeDbPools();
}
