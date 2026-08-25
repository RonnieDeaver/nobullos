/* test-registration
{
  "name": "Outbound email seam — class-aware suppression enforced compose- and send-time, paid-access delivery survives marketing unsubscribe, mailbox-first routing with no silent fallback, cap→defer→next-UTC-window, SendGrid structurally gated, unknown-outcome terminal no-retry, claim-ledger TOCTOU duplicate block + alert (Tasks #4334/#5144)",
  "regression": true,
  "smoke": true,
  "smokeReason": "The ONE send seam for all client-facing outbound email. Guards the policy invariants that must never drift: unsubscribe suppression visibly skips marketing at compose and send time while paid-book transactional delivery remains available; bounce/complaint/manual safety suppressions still block both classes; a sender without a mapped Front mailbox is BLOCKED with a clear error, never silently re-routed; cap-exhausted sends defer to the next UTC window; the SendGrid lane is structurally unreachable without a passing verification snapshot even if the enabled flag is flipped directly in the DB; an ambiguous vendor outcome is terminal-by-policy; the dispatch-claim CAS blocks TOCTOU double-sends and raises the duplicate alert. Vendor sends injected via the module's test seam (zero egress), alerts captured via the injected sink, hermetic per-run DB, fast.",
  "tier": "small"
}
test-registration */
/**
 * Task #4334 — outbound email service: routing policy + protections.
 *
 * Covers, end to end against the real per-run DB (only the two vendor calls
 * and the alert sink are injected):
 *
 *   1. Enable ceremony fail-closed: setSendgridFallbackEnabled(true) with no
 *      domain/key configured throws SendgridEnableBlockedError (flag stays
 *      off) — enabling without verification is impossible.
 *   2. Compose fan-out: normalize + de-dupe, suppression pre-check produces
 *      VISIBLE `suppressed` rows (never enqueued), per-recipient jobs with
 *      idempotency dedupe keys; re-POST with the same clientBatchKey creates
 *      zero new rows and zero duplicate jobs.
 *   3. blocked_no_mailbox: a sender without an active identity mapping is
 *      blocked with a clear error; the Front stub is never called.
 *   4. Front-channel success: marketing sends carry the per-recipient
 *      unsubscribe link ({sendId}.{token}) in the body; row lands
 *      sent/front_channel with the vendor message id and cap-window stamp.
 *   5. Send-time suppression re-check catches addresses suppressed AFTER
 *      compose.
 *   6. Cap exhaustion → deferred to the exact next UTC window start with a
 *      per-window job dedupe key.
 *   7. Rogue flag flip (raw settings write, bypassing the ceremony) still
 *      cannot reach SendGrid while the verification snapshot is absent.
 *   8. Full enable ceremony success under stubbed SendGrid domain-auth +
 *      injected DMARC resolver; the deferred send then routes to the
 *      SendGrid stub with unsubscribe URL + send id (custom-args
 *      correlation), landing sent/sendgrid.
 *   9. Unknown vendor outcome (SendGrid 5xx-class): row terminal `unknown`,
 *      alerted, and a replayed job does NOT re-send (P11: no auto-retry on
 *      ambiguity).
 *  10. Replay no-op on a sent row (P5) and the claim ledger's already_sent
 *      TOCTOU branch → duplicate_send_attempt alert, vendor not called.
 *  11. Definitive pre-send failure: non-final attempt resets the row to
 *      queued and rethrows for the queue's bounded retry; final attempt
 *      fails terminally (transport_failed) without rethrow.
 *  12. A GHL/unsubscribe suppression blocks marketing but paid-book
 *      transactional delivery passes both compose-time and send-time checks.
 *
 * DB: hermetic per-run Postgres (migrations applied by the harness).
 * Settings writes use the seeded CEO id (system_settings.updated_by FK).
 * No network: SENDGRID_API_KEY is cleared at boot; the ceremony test stubs
 * global fetch for the SendGrid host and restores it in finally.
 */

process.env.NODE_ENV = "test";
// Never let the suite reach the real SendGrid API even where the task env
// has a key configured; the ceremony test installs a scoped fetch stub.
delete process.env.SENDGRID_API_KEY;
delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;

import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";

const { db, closeDbPools } = await import("../server/db");
const { sql } = await import("drizzle-orm");
const outboundService = await import("../server/services/outboundEmail");
const {
  composeOutboundEmails,
  handleOutboundEmailSend,
  setSendgridFallbackEnabled,
  SendgridEnableBlockedError,
  __setOutboundSendDepsForTests,
  __setOutboundEmailAlertNotifyForTests,
  __setDnsTxtResolverForTests,
  __test_sendViaFrontChannel,
  utcDayOf,
  OUTBOUND_EMAIL_QUEUE,
  OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY,
  OUTBOUND_MARKETING_DOMAIN_KEY,
  OUTBOUND_SENDGRID_FROM_EMAIL_KEY,
} = outboundService;
const {
  upsertEmailSuppression,
  isEmailSuppressed,
  getOutboundEmail,
  listOutboundEmailsByBatch,
  upsertUserEmailIdentity,
  countCapWindowSends,
} = await import("../server/storage/outboundEmailStorage");
const { getSystemSettingFresh, setSystemSetting } = await import("../server/storage/settingsStorage");
const { FrontSendOutcomeUnknownError } = await import("../server/services/frontIntegration");
import type { WorkQueueJob } from "@shared/models/workQueue";
import type { OutboundEmail } from "@shared/models/outboundEmail";

const RUN = `${Date.now()}${randomInt(1000, 9999)}`;
const CEO_ID = `test-4334-ceo-${RUN}`;
const SENDER_ID = `test-4334-sender-${RUN}`;
const NOMAP_ID = `test-4334-nomap-${RUN}`;
const DOMAIN = `mail.ob4334-${RUN}.test`;
const rcpt = (tag: string) => `${tag}-${RUN}@recipient-ob4334.test`;

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

function fakeJob(sendId: string, attemptCount = 0, maxAttempts = 3): WorkQueueJob {
  return {
    id: randomUUID(),
    queueName: OUTBOUND_EMAIL_QUEUE,
    payload: { sendId },
    attemptCount,
    maxAttempts,
  } as unknown as WorkQueueJob;
}

// ── Injected vendor stubs + alert sink ───────────────────────────────────────

interface FrontCall {
  channelId: string; to: string; subject: string; bodyText: string; bodyHtml?: string | null; sendId: string;
}
interface SgCall { to: string; fromEmail: string; subject: string; text: string; unsubscribeUrl?: string | null; sendId: string }

const frontCalls: FrontCall[] = [];
const sgCalls: SgCall[] = [];
const alerts: Array<{ registryId: string; dedupeKey: string; text: string }> = [];

let frontBehavior: (call: FrontCall) => Promise<{ messageUid: string | null; status: number }> = async () => ({
  messageUid: `front_msg_${randomUUID().slice(0, 8)}`,
  status: 202,
});
let sgBehavior: (call: SgCall) => Promise<any> = async () => ({
  ok: true,
  sendgridMessageId: `sg_${randomUUID().slice(0, 12)}`,
});

__setOutboundSendDepsForTests({
  sendFrontChannelMessage: async (opts) => {
    frontCalls.push(opts as FrontCall);
    return frontBehavior(opts as FrontCall);
  },
  sendMarketingEmail: (async (opts: any) => {
    sgCalls.push(opts);
    return sgBehavior(opts);
  }) as any,
});
__setOutboundEmailAlertNotifyForTests((registryId, dedupeKey, text) => {
  alerts.push({ registryId, dedupeKey, text });
});

async function main(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, email) VALUES
      (${CEO_ID}, 'ceo', 'Ceo4334', ${`ceo-${RUN}@ob4334.test`}),
      (${SENDER_ID}, 'account_manager', 'Sender4334', ${`sender-${RUN}@ob4334.test`}),
      (${NOMAP_ID}, 'account_manager', 'Nomap4334', ${`nomap-${RUN}@ob4334.test`})
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
  `);
  await upsertUserEmailIdentity({
    userId: SENDER_ID,
    frontChannelId: `cha_test_${RUN}`,
    fromEmail: `sender-${RUN}@ob4334-mailbox.test`,
    dailyCap: 2,
    active: true,
    updatedBy: CEO_ID,
  });

  const today = utcDayOf(new Date());

  // ── 1. Enable ceremony fail-closed (nothing configured) ────────────────
  let threw: unknown = null;
  try {
    await setSendgridFallbackEnabled(true, CEO_ID);
  } catch (err) {
    threw = err;
  }
  check("enable without config throws SendgridEnableBlockedError", threw instanceof SendgridEnableBlockedError);
  check(
    "blocked-enable names the missing domain",
    threw instanceof SendgridEnableBlockedError && threw.failures.some((f) => f.includes("domain not configured")),
    threw instanceof SendgridEnableBlockedError ? threw.failures.join("; ") : String(threw),
  );
  const enabledAfterBlock = await getSystemSettingFresh(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY);
  check("flag stays off after blocked enable", enabledAfterBlock?.value !== "true");

  // ── 2. Compose fan-out + visible suppression skip + idempotent re-POST ─
  await upsertEmailSuppression({
    email: rcpt("presupp"),
    reason: "unsubscribe",
    source: "ghl_event",
    createdBy: CEO_ID,
  });
  const composeParams = {
    senderUserId: SENDER_ID,
    createdBy: SENDER_ID,
    subject: `Hello from the seam ${RUN}`,
    bodyText: "Plain text body.",
    bodyHtml: null,
    messageClass: "marketing" as const,
    recipients: [
      { email: rcpt("r1") },
      { email: rcpt("presupp") },
      { email: rcpt("r1") }, // exact dup
      { email: rcpt("R1").toUpperCase() }, // case dup
    ],
    clientBatchKey: `batch-${RUN}`,
  };
  const compose1 = await composeOutboundEmails(composeParams);
  check("compose de-dupes recipients (2 rows)", compose1.total === 2, JSON.stringify(compose1));
  check("compose reports 1 suppressed + 1 enqueued", compose1.suppressed === 1 && compose1.enqueued === 1, JSON.stringify(compose1));

  const batchRows = await listOutboundEmailsByBatch(compose1.batchId);
  const suppRow = batchRows.find((r) => r.toEmail === rcpt("presupp"));
  const r1Row = batchRows.find((r) => r.toEmail === rcpt("r1"));
  check("suppressed recipient is a VISIBLE row (status=suppressed)", suppRow?.status === "suppressed");
  check("suppressed row carries the reason", (suppRow?.errorMessage ?? "").includes("unsubscribe"));
  assert.ok(r1Row, "r1 row exists");

  const jobsForSupp = await db.execute(sql`
    SELECT id FROM work_queue WHERE dedupe_key = ${`outbound_email:${suppRow!.id}`}
  `);
  check("suppressed row never got a job", jobsForSupp.rows.length === 0);
  const jobsForR1 = await db.execute(sql`
    SELECT id FROM work_queue WHERE dedupe_key = ${`outbound_email:${r1Row!.id}`}
  `);
  check("queued row got exactly one job", jobsForR1.rows.length === 1);

  const compose2 = await composeOutboundEmails(composeParams);
  check("re-POST derives the same batch id", compose2.batchId === compose1.batchId);
  check("re-POST creates no new rows", compose2.alreadyExisted === 2, JSON.stringify(compose2));
  const batchRowsAfter = await listOutboundEmailsByBatch(compose1.batchId);
  check("batch still has exactly 2 rows", batchRowsAfter.length === 2);
  const jobsForR1After = await db.execute(sql`
    SELECT id FROM work_queue WHERE dedupe_key = ${`outbound_email:${r1Row!.id}`}
  `);
  check("re-POST does not duplicate the job", jobsForR1After.rows.length === 1);

  // ── 3. blocked_no_mailbox ───────────────────────────────────────────────
  const composeNoMap = await composeOutboundEmails({
    senderUserId: NOMAP_ID,
    createdBy: NOMAP_ID,
    subject: `No mailbox ${RUN}`,
    bodyText: "x",
    messageClass: "transactional",
    recipients: [{ email: rcpt("nomap") }],
  });
  const noMapRow = (await listOutboundEmailsByBatch(composeNoMap.batchId))[0];
  await handleOutboundEmailSend(fakeJob(noMapRow.id));
  const noMapAfter = await getOutboundEmail(noMapRow.id);
  check("sender without mapping is blocked (blocked_no_mailbox)", noMapAfter?.status === "blocked_no_mailbox");
  check("block error tells the operator where to fix it", (noMapAfter?.errorMessage ?? "").includes("Mailboxes"));
  check("no vendor call for blocked send", frontCalls.length === 0 && sgCalls.length === 0);

  // ── 4. Front-channel success + marketing unsubscribe link ──────────────
  await handleOutboundEmailSend(fakeJob(r1Row!.id));
  const r1After = await getOutboundEmail(r1Row!.id);
  check("r1 sent via front_channel", r1After?.status === "sent" && r1After?.path === "front_channel");
  check("front message id stamped", !!r1After?.frontMessageId);
  check("cap window stamped", r1After?.capWindowDay === today);
  check("front stub called once", frontCalls.length === 1);
  const fc = frontCalls[0];
  check("send goes out on the SENDER'S OWN channel", fc?.channelId === `cha_test_${RUN}`);
  check(
    "marketing body carries the per-recipient unsubscribe link",
    !!fc && fc.bodyText.includes("/api/email/unsubscribe?t=") && fc.bodyText.includes(`${r1Row!.id}.`),
  );
  check("cap counter reflects the send", (await countCapWindowSends(SENDER_ID, today)) === 1);

  // ── 5. Send-time suppression re-check ───────────────────────────────────
  const composeLate = await composeOutboundEmails({
    senderUserId: SENDER_ID,
    createdBy: SENDER_ID,
    subject: `Late suppression ${RUN}`,
    bodyText: "x",
    messageClass: "transactional",
    recipients: [{ email: rcpt("late") }],
  });
  const lateRow = (await listOutboundEmailsByBatch(composeLate.batchId))[0];
  check("late row starts queued", lateRow.status === "queued");
  await upsertEmailSuppression({ email: rcpt("late"), reason: "complaint", source: "manual", createdBy: CEO_ID });
  await handleOutboundEmailSend(fakeJob(lateRow.id));
  const lateAfter = await getOutboundEmail(lateRow.id);
  check("send-time re-check suppresses (visibly skipped)", lateAfter?.status === "suppressed");
  check("no vendor call for late-suppressed send", frontCalls.length === 1);

  // ── 6. Cap exhaustion → defer to next UTC window ────────────────────────
  const composeR3 = await composeOutboundEmails({
    senderUserId: SENDER_ID,
    createdBy: SENDER_ID,
    subject: `Fill cap ${RUN}`,
    bodyText: "x",
    messageClass: "transactional",
    recipients: [{ email: rcpt("r3") }],
  });
  const r3Row = (await listOutboundEmailsByBatch(composeR3.batchId))[0];
  await handleOutboundEmailSend(fakeJob(r3Row.id));
  check("second send fits the cap (2/2)", (await getOutboundEmail(r3Row.id))?.status === "sent");

  const composeR4 = await composeOutboundEmails({
    senderUserId: SENDER_ID,
    createdBy: SENDER_ID,
    subject: `Over cap ${RUN}`,
    bodyText: "x",
    messageClass: "transactional",
    recipients: [{ email: rcpt("r4") }],
  });
  const r4Row = (await listOutboundEmailsByBatch(composeR4.batchId))[0];
  await handleOutboundEmailSend(fakeJob(r4Row.id));
  let r4After = await getOutboundEmail(r4Row.id);
  check("over-cap send defers (no fallback configured)", r4After?.status === "deferred");
  check("deferral counted", r4After?.deferredCount === 1);
  const sched = r4After?.scheduledFor ? new Date(r4After.scheduledFor) : null;
  check(
    "deferred to the exact next UTC window start",
    !!sched &&
      sched.getTime() > Date.now() &&
      sched.getUTCHours() === 0 && sched.getUTCMinutes() === 0 && sched.getUTCSeconds() === 0,
    String(sched),
  );
  const windowJob = await db.execute(sql`
    SELECT id, retry_at FROM work_queue WHERE dedupe_key = ${`outbound_email:${r4Row.id}:w:${utcDayOf(sched ?? new Date())}`}
  `);
  check("re-enqueued with a per-window dedupe key", windowJob.rows.length === 1);
  check("vendor untouched while over cap", frontCalls.length === 2 && sgCalls.length === 0);

  // ── 7. Rogue flag flip cannot reach SendGrid without a snapshot ────────
  await setSystemSetting(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY, "true", CEO_ID);
  await handleOutboundEmailSend(fakeJob(r4Row.id));
  r4After = await getOutboundEmail(r4Row.id);
  check("rogue-enabled flag still defers (no verification snapshot)", r4After?.status === "deferred" && r4After?.deferredCount === 2);
  check("SendGrid stub NOT called on rogue flag", sgCalls.length === 0);
  await setSystemSetting(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY, "false", CEO_ID);

  // ── 8. Full enable ceremony under stubbed vendor + DMARC, then overflow ─
  await setSystemSetting(OUTBOUND_MARKETING_DOMAIN_KEY, DOMAIN, CEO_ID);
  await setSystemSetting(OUTBOUND_SENDGRID_FROM_EMAIL_KEY, `hello@${DOMAIN}`, CEO_ID);
  __setDnsTxtResolverForTests(async (host) => {
    check("DMARC lookup targets _dmarc.<domain>", host === `_dmarc.${DOMAIN}`);
    return [["v=DMARC1; p=quarantine; rua=mailto:d@" + DOMAIN]];
  });
  const realFetch = globalThis.fetch;
  process.env.SENDGRID_API_KEY = "SG.fake-test-key-4334";
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes("/v3/whitelabel/domains")) {
      return new Response(
        JSON.stringify([
          {
            id: 4334,
            domain: DOMAIN,
            valid: true,
            dns: { mail_cname: { valid: true }, dkim1: { valid: true }, dkim2: { valid: true } },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const snapshot = await setSendgridFallbackEnabled(true, CEO_ID);
    check("ceremony passes with valid domain auth + DMARC", !!snapshot && snapshot.sendgridValid && snapshot.dmarcFound);
    check("ceremony flips the flag on", (await getSystemSettingFresh(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY))?.value === "true");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SENDGRID_API_KEY;
    __setDnsTxtResolverForTests(null);
  }

  await handleOutboundEmailSend(fakeJob(r4Row.id));
  r4After = await getOutboundEmail(r4Row.id);
  check("over-cap send now overflows to SendGrid", r4After?.status === "sent" && r4After?.path === "sendgrid");
  check("sendgrid message id stamped", !!r4After?.sendgridMessageId);
  check("SendGrid stub called once", sgCalls.length === 1);
  const sg = sgCalls[0];
  check("fallback uses the configured on-domain from address", sg?.fromEmail === `hello@${DOMAIN}`);
  check("send id passed for custom-args correlation", sg?.sendId === r4Row.id);
  check("one-click unsubscribe URL passed on the SendGrid path", !!sg?.unsubscribeUrl?.includes("/api/email/unsubscribe?t="));
  check("front-path cap consumption unchanged by the overflow", (await countCapWindowSends(SENDER_ID, today)) === 2);

  // ── 9. Unknown outcome: terminal, alerted, never auto-retried ──────────
  const composeR5 = await composeOutboundEmails({
    senderUserId: SENDER_ID,
    createdBy: SENDER_ID,
    subject: `Unknown outcome ${RUN}`,
    bodyText: "x",
    messageClass: "transactional",
    recipients: [{ email: rcpt("r5") }],
  });
  const r5Row = (await listOutboundEmailsByBatch(composeR5.batchId))[0];
  sgBehavior = async () => ({ ok: false, reason: "unknown_outcome", message: "SendGrid 503 mid-flight" });
  await handleOutboundEmailSend(fakeJob(r5Row.id)); // over cap → sendgrid path
  const r5After = await getOutboundEmail(r5Row.id);
  check("ambiguous vendor outcome lands terminal `unknown`", r5After?.status === "unknown");
  const unknownAlert = alerts.find((a) => a.dedupeKey === `outbound_email:unknown:${r5Row.id}`);
  check("unknown outcome alerts the operator", !!unknownAlert && unknownAlert.registryId === "workflow.outbound_email.unknown_outcome");
  const sgCallsBefore = sgCalls.length;
  await handleOutboundEmailSend(fakeJob(r5Row.id));
  check("replayed job does NOT re-send an unknown-outcome row", sgCalls.length === sgCallsBefore);
  sgBehavior = async () => ({ ok: true, sendgridMessageId: `sg_${randomUUID().slice(0, 12)}` });

  // ── 10. Replay no-op on sent + TOCTOU duplicate block ───────────────────
  const frontCallsBefore = frontCalls.length;
  await handleOutboundEmailSend(fakeJob(r1Row!.id));
  check("replay on a sent row is a no-op", frontCalls.length === frontCallsBefore);

  const staleSnapshot = { ...(r1After as OutboundEmail), status: "queued" as const };
  await __test_sendViaFrontChannel(staleSnapshot, `cha_test_${RUN}`, today, fakeJob(r1Row!.id));
  check("stale-snapshot dispatch blocked by the claim ledger", frontCalls.length === frontCallsBefore);
  const dupAlert = alerts.find((a) => a.dedupeKey === `outbound_email:dup:${r1Row!.id}`);
  check("duplicate attempt raises the duplicate_send_attempt alert", !!dupAlert && dupAlert.registryId === "workflow.outbound_email.duplicate_send_attempt");

  // ── 11. Definitive pre-send failure: bounded retry vs final attempt ────
  await setSystemSetting(OUTBOUND_SENDGRID_FALLBACK_ENABLED_KEY, "false", CEO_ID);
  await upsertUserEmailIdentity({
    userId: SENDER_ID,
    frontChannelId: `cha_test_${RUN}`,
    fromEmail: `sender-${RUN}@ob4334-mailbox.test`,
    dailyCap: 50,
    active: true,
    updatedBy: CEO_ID,
  });
  const composeR6 = await composeOutboundEmails({
    senderUserId: SENDER_ID,
    createdBy: SENDER_ID,
    subject: `Transport blip ${RUN}`,
    bodyText: "x",
    messageClass: "transactional",
    recipients: [{ email: rcpt("r6") }],
  });
  const r6Row = (await listOutboundEmailsByBatch(composeR6.batchId))[0];
  frontBehavior = async () => {
    throw new Error("getaddrinfo ENOTFOUND (network down before the vendor saw anything)");
  };
  let rethrown: unknown = null;
  try {
    await handleOutboundEmailSend(fakeJob(r6Row.id, 0, 3));
  } catch (err) {
    rethrown = err;
  }
  const r6Mid = await getOutboundEmail(r6Row.id);
  check("pre-send failure rethrows for the queue's bounded retry", rethrown instanceof Error);
  check("row released back to queued with the claim cleared", r6Mid?.status === "queued" && !r6Mid?.dispatchClaimToken);

  let finalThrew: unknown = null;
  try {
    await handleOutboundEmailSend(fakeJob(r6Row.id, 2, 3));
  } catch (err) {
    finalThrew = err;
  }
  const r6Final = await getOutboundEmail(r6Row.id);
  check("final attempt fails terminally without rethrow", finalThrew === null && r6Final?.status === "failed");
  check("terminal failure is attributed (transport_failed)", r6Final?.errorCode === "transport_failed");
  frontBehavior = async () => ({ messageUid: `front_msg_${randomUUID().slice(0, 8)}`, status: 202 });

  // ── 12. Unknown-outcome on the FRONT path too (thrown error class) ──────
  const composeR7 = await composeOutboundEmails({
    senderUserId: SENDER_ID,
    createdBy: SENDER_ID,
    subject: `Front unknown ${RUN}`,
    bodyText: "x",
    messageClass: "transactional",
    recipients: [{ email: rcpt("r7") }],
  });
  const r7Row = (await listOutboundEmailsByBatch(composeR7.batchId))[0];
  frontBehavior = async () => {
    throw new FrontSendOutcomeUnknownError("Front returned 502 after the request was accepted for processing");
  };
  await handleOutboundEmailSend(fakeJob(r7Row.id));
  const r7After = await getOutboundEmail(r7Row.id);
  check("Front ambiguous outcome also lands terminal `unknown`", r7After?.status === "unknown");
  check(
    "Front unknown outcome alerted",
    alerts.some((a) => a.dedupeKey === `outbound_email:unknown:${r7Row.id}`),
  );
  frontBehavior = async () => ({ messageUid: `front_msg_${randomUUID().slice(0, 8)}`, status: 202 });

  // Suppression check helper sanity (used by every path).
  check("isEmailSuppressed normalizes case", !!(await isEmailSuppressed(rcpt("presupp").toUpperCase())));

  // ── 13. Marketing unsubscribe never blocks paid access delivery ────────
  await upsertUserEmailIdentity({
    userId: SENDER_ID,
    frontChannelId: `cha_test_${RUN}`,
    fromEmail: `sender-${RUN}@ob4334-mailbox.test`,
    dailyCap: 100,
    active: true,
    updatedBy: CEO_ID,
  });
  const paidAccess = await composeOutboundEmails({
    senderUserId: SENDER_ID,
    createdBy: SENDER_ID,
    subject: `Paid access survives unsubscribe ${RUN}`,
    bodyText: "Access your paid book.",
    messageClass: "transactional",
    consentSource: "paid_book_delivery",
    recipients: [{ email: rcpt("presupp") }],
    clientBatchKey: `paid-access-after-ghl-unsubscribe-${RUN}`,
  });
  check(
    "GHL unsubscribe does not suppress paid-access compose",
    paidAccess.suppressed === 0 && paidAccess.enqueued === 1,
    JSON.stringify(paidAccess),
  );
  const paidAccessRow = (await listOutboundEmailsByBatch(paidAccess.batchId))[0];
  check("paid-access row remains queued", paidAccessRow?.status === "queued");
  await handleOutboundEmailSend(fakeJob(paidAccessRow!.id));
  const paidAccessAfter = await getOutboundEmail(paidAccessRow!.id);
  check(
    "send-time unsubscribe recheck still permits paid access",
    paidAccessAfter?.status === "sent" &&
      paidAccessAfter?.messageClass === "transactional" &&
      paidAccessAfter?.consentSource === "paid_book_delivery",
    JSON.stringify(paidAccessAfter),
  );
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  exitCode = 1;
  console.error("FATAL:", err);
} finally {
  __setOutboundSendDepsForTests(null);
  __setOutboundEmailAlertNotifyForTests(null);
  try {
    await db.execute(sql`DELETE FROM work_queue WHERE dedupe_key LIKE ${"outbound_email:%"} AND queue_name = ${OUTBOUND_EMAIL_QUEUE}`);
    await db.execute(sql`DELETE FROM outbound_emails WHERE sender_user_id IN (${SENDER_ID}, ${NOMAP_ID})`);
    await db.execute(sql`DELETE FROM email_suppressions WHERE email LIKE ${`%${RUN}@recipient-ob4334.test`}`);
    await db.execute(sql`DELETE FROM user_email_identities WHERE user_id = ${SENDER_ID}`);
    await db.execute(sql`DELETE FROM system_settings WHERE key LIKE ${"outbound_%"}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${CEO_ID}, ${SENDER_ID}, ${NOMAP_ID})`);
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  await closeDbPools();
}

console.log(`\nTest run: ${passed} passed, ${failed} failed`);
if (failed > 0 || exitCode !== 0) process.exit(1);
