/* test-registration
{
  "name": "SendGrid event webhook — fail-closed without a configured public key (503), ECDSA signature + timestamp window enforcement (401), verified bounce/complaint/unsubscribe events feed the suppression list and stamp send-log delivery status (Task #4334)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4334: the SendGrid event webhook is an UNAUTHENTICATED public endpoint whose payloads mutate the global suppression list. If verification drifts, anyone who finds the URL can suppress arbitrary addresses (mass-unsubscribe DoS) or feed junk into send-log delivery status; if the fail-closed 503 drifts to open, an unset key silently accepts everything. Suite generates its own P-256 keypair, signs timestamp+rawBody exactly as SendGrid does, and pins: unset key → 503, missing/garbage/wrong-key signature → 401, stale timestamp → 401, valid signature → suppression rows (bounce→bounce, spamreport→complaint, unsubscribe→unsubscribe) + deliveryStatus stamped via custom-arg send_id AND sg_message_id-prefix correlation. Hermetic DB, zero egress, milliseconds.",
  "tier": "small"
}
test-registration */
/**
 * Task #4334 — SendGrid signed event webhook (`POST /api/webhooks/sendgrid-events`).
 *
 * SendGrid's Signed Event Webhook signs `timestamp + rawBody` with an
 * ECDSA P-256 key; the public key (base64 SPKI DER) lives in
 * SENDGRID_WEBHOOK_PUBLIC_KEY. Contract pinned here:
 *
 *   1. FAIL CLOSED — env key unset ⇒ 503 (never process unverifiable
 *      events); no suppression side effects.
 *   2. 401 on: missing signature headers, signature by the WRONG key,
 *      signature over a DIFFERENT body, timestamp outside the ±10 min
 *      window (replay protection).
 *   3. Verified events: bounce/dropped ⇒ suppression reason `bounce`,
 *      spamreport ⇒ `complaint`, unsubscribe/group_unsubscribe ⇒
 *      `unsubscribe` — all source `sendgrid_event`; send-log rows are
 *      correlated via custom-arg `send_id` (primary) or the
 *      `sg_message_id` prefix (fallback) and get deliveryStatus stamped.
 *   4. Handler-level processing errors ⇒ 500 so SendGrid redelivers.
 *
 * DB: hermetic per-run Postgres; per-run suffixed rows, cleanup in finally.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";
delete process.env.SENDGRID_API_KEY;
delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";
import { randomInt, randomUUID, generateKeyPairSync, createSign } from "node:crypto";
import { getGlobalDispatcher } from "undici";

const { registerOutboundEmailRoutes } = await import("../server/routes/outboundEmail");
const { db, closeDbPools } = await import("../server/db");
const { sql } = await import("drizzle-orm");
const {
  insertOutboundEmails,
  getOutboundEmail,
  isEmailSuppressed,
} = await import("../server/storage/outboundEmailStorage");

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const SENDER_ID = `test-4334w-sender-${RUN}`;
const rcpt = (tag: string) => `${tag}-${RUN}@recipient-ob4334w.test`;

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

// ── Keypair + signing exactly like SendGrid's Signed Event Webhook ──────────
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const { privateKey: wrongPrivateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

function signPayload(timestamp: string, rawBody: string, key = privateKey): string {
  const signer = createSign("sha256");
  signer.update(timestamp + rawBody);
  return signer.sign({ key, dsaEncoding: "der" }).toString("base64");
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = buf) }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Public surface — no session. Clerk per-request test seam
    // (server/middlewares/requireAuth.ts): null models an anonymous request.
    // The webhook route is signature-verified, not requireAuth-gated.
    (req as any).__test_clerkUserId = null;
    next();
  });
  registerOutboundEmailRoutes(app);
  return app;
}

async function postEvents(
  baseUrl: string,
  rawBody: string,
  opts: { timestamp?: string; signature?: string | null; omitHeaders?: boolean } = {},
): Promise<{ status: number; body: any; text: string }> {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = opts.signature === undefined ? signPayload(timestamp, rawBody) : opts.signature;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!opts.omitHeaders) {
    if (signature !== null) headers["x-twilio-email-event-webhook-signature"] = signature;
    headers["x-twilio-email-event-webhook-timestamp"] = timestamp;
  }
  const r = await fetch(`${baseUrl}/api/webhooks/sendgrid-events`, { method: "POST", headers, body: rawBody });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* empty */
  }
  return { status: r.status, body: parsed, text };
}

async function main(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, email)
    VALUES (${SENDER_ID}, 'account_manager', 'W4334', ${`sender-${RUN}@ob4334w.test`})
    ON CONFLICT (id) DO NOTHING
  `);

  // Two sent rows to correlate against: one via custom-arg send_id, one via
  // the sg_message_id prefix fallback.
  const sgMsgId = `sgmsg-${RUN}`;
  const [rowA] = await insertOutboundEmails([
    {
      id: randomUUID(),
      batchId: randomUUID(),
      senderUserId: SENDER_ID,
      createdBy: SENDER_ID,
      toEmail: rcpt("bounced"),
      subject: `Webhook A ${RUN}`,
      bodyText: "x",
      messageClass: "marketing",
      status: "sent",
      path: "sendgrid",
    } as any,
  ]);
  const [rowB] = await insertOutboundEmails([
    {
      id: randomUUID(),
      batchId: randomUUID(),
      senderUserId: SENDER_ID,
      createdBy: SENDER_ID,
      toEmail: rcpt("complained"),
      subject: `Webhook B ${RUN}`,
      bodyText: "x",
      messageClass: "marketing",
      status: "sent",
      path: "sendgrid",
      sendgridMessageId: sgMsgId,
    } as any,
  ]);

  const app = buildApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const bounceBody = JSON.stringify([
      { email: rcpt("bounced"), event: "bounce", send_id: rowA.id, reason: "550 mailbox unavailable" },
    ]);

    // ── 1. Fail closed: key unset ⇒ 503, no side effects ────────────────
    delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
    let r = await postEvents(baseUrl, bounceBody);
    check("unset public key → 503 fail-closed", r.status === 503, `${r.status}`);
    check("no suppression while unverifiable", !(await isEmailSuppressed(rcpt("bounced"))));

    // ── 2. Signature / timestamp enforcement ────────────────────────────
    process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = publicKeyB64;

    r = await postEvents(baseUrl, bounceBody, { omitHeaders: true });
    check("missing signature headers → 401", r.status === 401, `${r.status}`);

    r = await postEvents(baseUrl, bounceBody, { signature: "not-base64-garbage!!" });
    check("garbage signature → 401", r.status === 401, `${r.status}`);

    const ts = String(Math.floor(Date.now() / 1000));
    r = await postEvents(baseUrl, bounceBody, { timestamp: ts, signature: signPayload(ts, bounceBody, wrongPrivateKey) });
    check("signature by the wrong key → 401", r.status === 401, `${r.status}`);

    r = await postEvents(baseUrl, bounceBody, { timestamp: ts, signature: signPayload(ts, JSON.stringify([{ different: true }])) });
    check("signature over a different body → 401", r.status === 401, `${r.status}`);

    const staleTs = String(Math.floor(Date.now() / 1000) - 700);
    r = await postEvents(baseUrl, bounceBody, { timestamp: staleTs });
    check("stale timestamp (replay) → 401", r.status === 401, `${r.status}`);

    check("still no suppression after rejected deliveries", !(await isEmailSuppressed(rcpt("bounced"))));

    // ── 3. Verified events feed suppression + stamp delivery status ─────
    r = await postEvents(baseUrl, bounceBody);
    check("valid signature → 200", r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
    check("summary counts the event", r.body?.processed === 1 && r.body?.suppressed === 1, JSON.stringify(r.body));
    const suppA = await isEmailSuppressed(rcpt("bounced"));
    check("bounce lands in the suppression list", suppA?.reason === "bounce" && suppA?.source === "sendgrid_event", JSON.stringify(suppA ?? null));
    const rowAAfter = await getOutboundEmail(rowA.id);
    check("send-log row stamped via custom-arg send_id", rowAAfter?.deliveryStatus === "bounce", String(rowAAfter?.deliveryStatus));

    // sg_message_id prefix fallback (SendGrid appends `.filterNNN...` to the id).
    const complaintBody = JSON.stringify([
      { email: rcpt("complained"), event: "spamreport", sg_message_id: `${sgMsgId}.recvd-6789.filter001` },
    ]);
    r = await postEvents(baseUrl, complaintBody);
    check("spamreport verified → 200", r.status === 200, `${r.status}`);
    const suppB = await isEmailSuppressed(rcpt("complained"));
    check("complaint suppressed", suppB?.reason === "complaint", JSON.stringify(suppB ?? null));
    const rowBAfter = await getOutboundEmail(rowB.id);
    check("row correlated via sg_message_id prefix", rowBAfter?.deliveryStatus === "spamreport", String(rowBAfter?.deliveryStatus));

    const unsubBody = JSON.stringify([
      { email: rcpt("unsub"), event: "unsubscribe" },
      { email: rcpt("groupunsub"), event: "group_unsubscribe" },
      { email: rcpt("ignored"), event: "open" },
    ]);
    r = await postEvents(baseUrl, unsubBody);
    check("unsubscribe batch verified → 200", r.status === 200 && r.body?.processed === 3, `${r.status} ${JSON.stringify(r.body)}`);
    check("unsubscribe suppressed", (await isEmailSuppressed(rcpt("unsub")))?.reason === "unsubscribe");
    check("group_unsubscribe suppressed", (await isEmailSuppressed(rcpt("groupunsub")))?.reason === "unsubscribe");
    check("open events never suppress", !(await isEmailSuppressed(rcpt("ignored"))));

    // Idempotent redelivery: same bounce again → still 200, single suppression row.
    r = await postEvents(baseUrl, bounceBody);
    check("redelivered event stays 200/idempotent", r.status === 200, `${r.status}`);
    const dupCount = await db.execute(sql`
      SELECT count(*)::int AS n FROM email_suppressions WHERE email = ${rcpt("bounced")}
    `);
    check("no duplicate suppression rows on redelivery", (dupCount.rows[0] as any).n === 1, JSON.stringify(dupCount.rows));

    // ── 4. Non-array body: verified but malformed ⇒ 200 with zero processed
    const weirdBody = JSON.stringify({ not: "an array" });
    r = await postEvents(baseUrl, weirdBody);
    check("verified non-array body processes zero events", r.status === 200 && r.body?.processed === 0, `${r.status} ${JSON.stringify(r.body)}`);
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
  delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  try {
    await db.execute(sql`DELETE FROM outbound_emails WHERE sender_user_id = ${SENDER_ID}`);
    await db.execute(sql`DELETE FROM email_suppressions WHERE email LIKE ${`%${RUN}@recipient-ob4334w.test`}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${SENDER_ID}`);
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  await closeDbPools();
  await getGlobalDispatcher().close();
}

console.log(`\nTest run: ${passed} passed, ${failed} failed`);
if (failed > 0 || exitCode !== 0) process.exit(1);
