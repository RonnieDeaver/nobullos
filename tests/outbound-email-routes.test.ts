/* test-registration
{
  "name": "Outbound email routes — compose fan-out + idempotent re-POST, RBAC (self-send vs lead-only send-as, lead-gated log/suppressions, CEO-gated lane settings), unsubscribe GET-never-suppresses/POST-suppresses-once, domain-change force-disables fallback (Task #4334)",
  "regression": true,
  "sweepOnlyReason": "Route-surface companion to tests/outbound-email-service.test.ts (which is the smoke gate for the seam's policy invariants). This suite pins the HTTP contract: authz matrix per endpoint, zod 400s, compose 202 fan-out + clientBatchKey idempotency, unsubscribe capability-token semantics (GET renders confirm and never suppresses — link scanners follow GETs; POST suppresses within one cycle, idempotent re-POST), and the CEO settings PUT force-disabling the fallback when the domain changes. Full express app + real RBAC middlewares over the hermetic DB — heavier than the service suite and redundant with it for the core routing logic, so regression-sweep only.",
  "tier": "small"
}
test-registration */
/**
 * Task #4334 — outbound email HTTP surface.
 *
 * What must never drift:
 *   1. AUTHZ — compose is authenticated; sending AS someone else is
 *      team-lead+; the send log, suppression CRUD, identities, and counters
 *      are team-lead+; lane settings (domain/from/cap default), domain
 *      verification, and the fallback switch are CEO-only.
 *   2. UNSUBSCRIBE CAPABILITY TOKEN — GET renders a confirmation page and
 *      NEVER suppresses (mail-provider link scanners follow GETs; a
 *      GET-suppress would unsubscribe half the list by itself). POST redeems
 *      the token, suppression lands within the same request cycle, and a
 *      re-POST stays 200/idempotent. Wrong token → 404, malformed → 400 — no
 *      oracle for probing send ids.
 *   3. SETTINGS SAFETY INTERLOCK — changing the marketing domain or the
 *      from-address while the SendGrid fallback is enabled force-disables
 *      the lane (the old verification snapshot no longer vouches for the
 *      new domain).
 *
 * Auth: app-level fake session + seeded users rows; the REAL
 * isAuthenticated/requireTeamLead/requireCeo middlewares run (memory:
 * sheets-test-auth-pattern). DB: hermetic per-run Postgres; per-run suffixed
 * rows, cleanup in finally. undici dispatcher closed at exit.
 */

process.env.NODE_ENV = "test";
// Belt & braces: none of these route tests should ever reach SendGrid.
delete process.env.SENDGRID_API_KEY;
delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomInt } from "node:crypto";
import { getGlobalDispatcher } from "undici";

const { registerOutboundEmailRoutes } = await import("../server/routes/outboundEmail");
const { db, closeDbPools } = await import("../server/db");
const { sql } = await import("drizzle-orm");
const {
  OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY,
  OUTBOUND_MARKETING_DOMAIN_KEY,
  OUTBOUND_EMAIL_QUEUE,
} = await import("../server/services/outboundEmail");
const { getSystemSettingFresh, setSystemSetting } = await import("../server/storage/settingsStorage");
const { isEmailSuppressed, listOutboundEmailsByBatch } = await import("../server/storage/outboundEmailStorage");

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-4334r-ceo-${RUN}`;
const LEAD_ID = `test-4334r-lead-${RUN}`;
const AM_ID = `test-4334r-am-${RUN}`;
const rcpt = (tag: string) => `${tag}-${RUN}@recipient-ob4334r.test`;

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
  // Mirror server/index.ts: capture the raw body for webhook signature
  // verification (unused here, but keeps the app shape realistic).
  app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk per-request test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (→ 401).
    // The pre-Clerk passport-shape injection stopped working when auth migrated.
    (req as any).__test_clerkUserId = activeUserId;
    next();
  });
  registerOutboundEmailRoutes(app);
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
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; text: string }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* HTML or empty */
  }
  return { status: r.status, body: parsed, text };
}

async function main(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, email) VALUES
      (${CEO_ID}, 'ceo', 'Ceo4334r', ${`ceo-${RUN}@ob4334r.test`}),
      (${LEAD_ID}, 'team_lead', 'Lead4334r', ${`lead-${RUN}@ob4334r.test`}),
      (${AM_ID}, 'account_manager', 'Am4334r', ${`am-${RUN}@ob4334r.test`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);

  const app = buildApp();
  const { server, baseUrl } = await listen(app);

  try {
    // ── 1. Compose authz ─────────────────────────────────────────────────
    activeUserId = null;
    let r = await call(baseUrl, "POST", "/api/outbound-email/compose", {
      subject: "s", bodyText: "b", messageClass: "transactional", recipients: [{ email: rcpt("x") }],
    });
    check("unauthenticated compose → 401", r.status === 401, `${r.status}`);

    activeUserId = AM_ID;
    r = await call(baseUrl, "POST", "/api/outbound-email/compose", {
      subject: `Self send ${RUN}`,
      bodyText: "Body text",
      messageClass: "marketing",
      recipients: [{ email: rcpt("self1") }, { email: rcpt("self2") }],
      clientBatchKey: `routes-${RUN}`,
    });
    check("AM composes for self → 202", r.status === 202, `${r.status} ${r.text.slice(0, 120)}`);
    check("compose result fans out per recipient", r.body?.total === 2 && r.body?.enqueued === 2, JSON.stringify(r.body));
    const amBatchId = r.body?.batchId as string;

    const rePost = await call(baseUrl, "POST", "/api/outbound-email/compose", {
      subject: `Self send ${RUN}`,
      bodyText: "Body text",
      messageClass: "marketing",
      recipients: [{ email: rcpt("self1") }, { email: rcpt("self2") }],
      clientBatchKey: `routes-${RUN}`,
    });
    check("idempotent re-POST → same batch, nothing new", rePost.status === 202 && rePost.body?.batchId === amBatchId && rePost.body?.alreadyExisted === 2, JSON.stringify(rePost.body));
    check("re-POST created no extra rows", (await listOutboundEmailsByBatch(amBatchId)).length === 2);

    r = await call(baseUrl, "POST", "/api/outbound-email/compose", {
      senderUserId: LEAD_ID,
      subject: "s", bodyText: "b", messageClass: "transactional", recipients: [{ email: rcpt("imp") }],
    });
    check("AM sending AS someone else → 403", r.status === 403, `${r.status}`);

    activeUserId = LEAD_ID;
    r = await call(baseUrl, "POST", "/api/outbound-email/compose", {
      senderUserId: AM_ID,
      subject: `Lead on behalf ${RUN}`, bodyText: "b", messageClass: "transactional",
      recipients: [{ email: rcpt("obo") }],
    });
    check("lead composes on behalf of AM → 202", r.status === 202, `${r.status}`);

    r = await call(baseUrl, "POST", "/api/outbound-email/compose", {
      subject: "s", bodyText: "b", messageClass: "transactional", recipients: [],
    });
    check("empty recipients → 400 zod", r.status === 400, `${r.status}`);

    r = await call(baseUrl, "POST", "/api/outbound-email/compose", {
      subject: "s", bodyText: "b", messageClass: "bulk_blast", recipients: [{ email: rcpt("z") }],
    });
    check("unknown message class → 400", r.status === 400, `${r.status}`);

    // ── 2. Log / batch / counters authz + shape ──────────────────────────
    activeUserId = AM_ID;
    r = await call(baseUrl, "GET", "/api/outbound-email/log");
    check("send log requires team lead (AM → 403)", r.status === 403, `${r.status}`);
    r = await call(baseUrl, "GET", `/api/outbound-email/batches/${amBatchId}`);
    check("AM reads OWN batch → 200", r.status === 200 && Array.isArray(r.body?.rows) && r.body.rows.length === 2, `${r.status} ${r.text.slice(0, 120)}`);

    activeUserId = LEAD_ID;
    const leadBatch = await call(baseUrl, "POST", "/api/outbound-email/compose", {
      subject: `Lead own ${RUN}`, bodyText: "b", messageClass: "transactional",
      recipients: [{ email: rcpt("leadown") }],
    });
    const leadBatchId = leadBatch.body?.batchId as string;
    activeUserId = AM_ID;
    r = await call(baseUrl, "GET", `/api/outbound-email/batches/${leadBatchId}`);
    check("AM reading someone else's batch → 403", r.status === 403, `${r.status}`);

    activeUserId = LEAD_ID;
    r = await call(baseUrl, "GET", `/api/outbound-email/log?senderUserId=${AM_ID}&limit=10`);
    check(
      "lead reads the send log filtered by sender",
      r.status === 200 && Array.isArray(r.body?.rows) && r.body.rows.every((row: any) => row.senderUserId === AM_ID) && r.body.rows.length >= 3,
      `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`,
    );
    r = await call(baseUrl, "GET", "/api/outbound-email/log?status=nonsense");
    check("bad log filter → 400", r.status === 400, `${r.status}`);

    r = await call(baseUrl, "GET", "/api/outbound-email/counters");
    check(
      "counters expose per-user rows + default cap",
      r.status === 200 && typeof r.body?.defaultCap === "number" && Array.isArray(r.body?.perUser),
      `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`,
    );

    // ── 3. Suppressions CRUD (lead-gated) ────────────────────────────────
    activeUserId = AM_ID;
    r = await call(baseUrl, "GET", "/api/outbound-email/suppressions");
    check("suppression list is lead-gated (AM → 403)", r.status === 403, `${r.status}`);

    activeUserId = LEAD_ID;
    r = await call(baseUrl, "POST", "/api/outbound-email/suppressions", {
      email: rcpt("manual"), reason: "manual", notes: `added in routes test ${RUN}`,
    });
    check("lead adds a suppression", r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 120)}`);
    const suppId = r.body?.row?.id ?? r.body?.id;

    r = await call(baseUrl, "GET", `/api/outbound-email/suppressions?search=${encodeURIComponent(rcpt("manual"))}`);
    check("suppression list finds it", r.status === 200 && (r.body?.rows ?? r.body)?.some?.((s: any) => s.email === rcpt("manual")), `${r.status}`);

    r = await call(baseUrl, "POST", "/api/outbound-email/suppressions", { email: "not-an-email", reason: "manual" });
    check("garbage suppression email → 400", r.status === 400, `${r.status}`);

    if (suppId) {
      r = await call(baseUrl, "DELETE", `/api/outbound-email/suppressions/${suppId}`);
      check("lead removes a suppression", r.status === 200, `${r.status}`);
      check("suppression actually gone", !(await isEmailSuppressed(rcpt("manual"))));
    } else {
      check("suppression id returned for delete", false, JSON.stringify(r.body));
    }

    // ── 4. Settings: lead reads, CEO writes, interlock force-disable ────
    r = await call(baseUrl, "GET", "/api/outbound-email/settings");
    check("lead reads settings", r.status === 200 && typeof r.body?.fallbackEnabled === "boolean" && typeof r.body?.defaultDailyCap === "number", `${r.status} ${r.text.slice(0, 160)}`);

    r = await call(baseUrl, "PUT", "/api/outbound-email/settings", { marketingDomain: `x-${RUN}.test` });
    check("lead cannot write settings (CEO-only) → 403", r.status === 403, `${r.status}`);
    r = await call(baseUrl, "POST", "/api/outbound-email/verify-domain");
    check("lead cannot run verification → 403", r.status === 403, `${r.status}`);
    r = await call(baseUrl, "POST", "/api/outbound-email/fallback-enabled", { enabled: true });
    check("lead cannot flip the fallback → 403", r.status === 403, `${r.status}`);

    activeUserId = CEO_ID;
    r = await call(baseUrl, "POST", "/api/outbound-email/verify-domain");
    check("verify without a domain configured → 400", r.status === 400, `${r.status}`);

    r = await call(baseUrl, "POST", "/api/outbound-email/fallback-enabled", { enabled: true });
    check(
      "CEO enable without verification → 400 with named failures",
      r.status === 400 && Array.isArray(r.body?.failures) && r.body.failures.length > 0,
      `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`,
    );
    check("flag still off", (await getSystemSettingFresh(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY))?.value !== "true");

    // Interlock: domain change while (rogue-)enabled force-disables the lane.
    await setSystemSetting(OUTBOUND_MARKETING_DOMAIN_KEY, `old-${RUN}.test`, CEO_ID);
    await setSystemSetting(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY, "true", CEO_ID);
    r = await call(baseUrl, "PUT", "/api/outbound-email/settings", { marketingDomain: `new-${RUN}.test` });
    check("CEO domain change succeeds", r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    check("response flags the forced disable", r.body?.fallbackDisabled === true, JSON.stringify(r.body));
    check(
      "fallback flag actually off after domain change",
      (await getSystemSettingFresh(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY))?.value === "false",
    );

    // ── 5. Pause switch (lead) ───────────────────────────────────────────
    activeUserId = LEAD_ID;
    r = await call(baseUrl, "POST", "/api/outbound-email/pause", { paused: true });
    check("lead pauses sending", r.status === 200, `${r.status}`);
    r = await call(baseUrl, "GET", "/api/outbound-email/settings");
    check("settings reflect the pause", r.body?.paused === true, JSON.stringify(r.body)?.slice(0, 120));
    await call(baseUrl, "POST", "/api/outbound-email/pause", { paused: false });

    // ── 6. Identities (mailbox mapping) ──────────────────────────────────
    r = await call(baseUrl, "PUT", `/api/outbound-email/identities/${AM_ID}`, {
      frontChannelId: `cha_routes_${RUN}`, fromEmail: `am-${RUN}@mailbox-ob4334r.test`, dailyCap: 5, active: true,
    });
    check("lead maps a user's own-mailbox channel", r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    r = await call(baseUrl, "GET", "/api/outbound-email/identities");
    check(
      "identities list shows the mapping",
      r.status === 200 && r.body?.identities?.some?.((i: any) => i.userId === AM_ID && i.frontChannelId === `cha_routes_${RUN}`),
      `${r.status} ${r.text.slice(0, 160)}`,
    );
    r = await call(baseUrl, "PUT", `/api/outbound-email/identities/ghost-${RUN}`, {
      frontChannelId: "cha_x", fromEmail: "x@y.test", active: true,
    });
    check("mapping an unknown user → 404", r.status === 404, `${r.status}`);

    // ── 7. Unsubscribe capability token ──────────────────────────────────
    const rows = await listOutboundEmailsByBatch(amBatchId);
    const marketingRow = rows.find((x) => x.unsubscribeToken);
    check("marketing compose minted a token at rest", !!marketingRow, JSON.stringify(rows.map((x) => x.status)));
    const tok = `${marketingRow!.id}.${marketingRow!.unsubscribeToken}`;

    activeUserId = null; // public surface — no session
    r = await call(baseUrl, "GET", `/api/email/unsubscribe?t=${encodeURIComponent(tok)}`);
    check("GET renders the confirm page", r.status === 200 && r.text.includes("<form") && r.text.toLowerCase().includes("unsubscribe"), `${r.status}`);
    check("GET does NOT suppress (scanner safety)", !(await isEmailSuppressed(marketingRow!.toEmail)));

    r = await call(baseUrl, "POST", `/api/email/unsubscribe?t=${encodeURIComponent(tok)}`, undefined, { Accept: "application/json" });
    check("POST redeems within one cycle", r.status === 200 && r.body?.ok === true, `${r.status} ${r.text.slice(0, 120)}`);
    check("address is now suppressed", !!(await isEmailSuppressed(marketingRow!.toEmail)));

    r = await call(baseUrl, "POST", `/api/email/unsubscribe?t=${encodeURIComponent(tok)}`, undefined, { Accept: "application/json" });
    check("re-POST is idempotent 200", r.status === 200, `${r.status}`);

    const wrongTok = `${marketingRow!.id}.${"0".repeat(32)}`;
    r = await call(baseUrl, "POST", `/api/email/unsubscribe?t=${encodeURIComponent(wrongTok)}`, undefined, { Accept: "application/json" });
    check("wrong token → 404 (no oracle)", r.status === 404, `${r.status}`);
    r = await call(baseUrl, "POST", `/api/email/unsubscribe?t=garbage`, undefined, { Accept: "application/json" });
    check("malformed token → 400", r.status === 400, `${r.status}`);
    r = await call(baseUrl, "GET", `/api/email/unsubscribe`);
    check("missing token → 400", r.status === 400, `${r.status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  exitCode = 1;
  console.error("FATAL:", err);
} finally {
  try {
    await db.execute(sql`DELETE FROM work_queue WHERE dedupe_key LIKE ${"outbound_email:%"} AND queue_name = ${OUTBOUND_EMAIL_QUEUE}`);
    await db.execute(sql`DELETE FROM outbound_emails WHERE sender_user_id IN (${AM_ID}, ${LEAD_ID})`);
    await db.execute(sql`DELETE FROM email_suppressions WHERE email LIKE ${`%${RUN}@recipient-ob4334r.test`}`);
    await db.execute(sql`DELETE FROM user_email_identities WHERE user_id = ${AM_ID}`);
    await db.execute(sql`DELETE FROM system_settings WHERE key LIKE ${"outbound_%"}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${CEO_ID}, ${LEAD_ID}, ${AM_ID})`);
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  await closeDbPools();
  await getGlobalDispatcher().close();
}

console.log(`\nTest run: ${passed} passed, ${failed} failed`);
if (failed > 0 || exitCode !== 0) process.exit(1);
