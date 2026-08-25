/* test-registration
{
  "name": "Prod action: SMS consent ledger backfill (Task #4336)",
  "regression": true,
  "sweepOnlyReason": "Task #4336 — prod-action converge/idempotency walk: tx-sandbox seeding across clients/contacts/conversations/messages for an operator-pressed one-and-done backfill; not routine-runtime behavior, sweep coverage is sufficient (the gate smokes the classifier, webhook recording, and send gate).",
  "timeoutMs": 120000,
  "tier": "small"
}
test-registration */
// Task #4336 — coverage for `sms_consent_backfill`, the prod action that
// seeds a consent-ledger row for every phone the system already knows and
// applies historical STOP/START keyword messages (last keyword per phone
// wins, unknown-only guard so live-recorded state is never clobbered).
//
// All writes run inside runInTxSandbox; the action's raw-SQL scans use
// getDb() which the sandbox redirects, so its reads see the seeded rows.
//
// Scenarios:
//   (1) status() pending: names the missing-ledger count and the pending
//       historical keyword count.
//   (2) apply(): seeds `unknown` rows for client/conversation/inbound
//       sources (deduped by match key across sources), applies the LAST
//       historical keyword (STOP then START ⇒ opted_in) as
//       backfill_history, and never clobbers an existing expressed state.
//   (3) Idempotency: re-status is not-needed, re-apply reports not-needed.
//
// Usage: tsx tests/sms-consent-backfill.test.ts

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import { eq } from "drizzle-orm";
import { runInTxSandbox } from "./db-sandbox";
import { getDb } from "../server/db";
import {
  clients,
  twilioConversations,
  twilioMessages,
  smsConsentLedger,
  smsConsentEvents,
} from "@shared/schema";
import { smsConsentBackfillAction } from "../server/services/prodActions/smsConsentActions";
import { applyConsentStateChange } from "../server/storage/smsConsentStorage";
import { normalizeToE164, getPhoneMatchKey } from "../server/services/phoneNormalization";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const sym = ok ? "✓" : "✗";
  if (ok) {
    passed++;
    console.log(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed++;
    console.error(`  ${sym} ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const TWILIO_NUMBER = "+12145550100";

function freshPhone(): string {
  const suffix = String(Math.floor(1000000 + Math.random() * 8999999));
  return `+1215${suffix}`;
}

async function seedConversation(contactPhone: string): Promise<string> {
  const [conv] = await getDb()
    .insert(twilioConversations)
    .values({
      contactPhone,
      contactPhoneNormalized: getPhoneMatchKey(contactPhone),
      twilioPhoneNumber: TWILIO_NUMBER,
      conversationType: "direct",
      status: "active",
      displayName: `backfill-test-${RUN}`,
    })
    .returning({ id: twilioConversations.id });
  return conv.id;
}

async function seedInbound(
  conversationId: string,
  fromNumber: string,
  body: string,
  at: Date,
  sid?: string,
): Promise<void> {
  await getDb().insert(twilioMessages).values({
    conversationId,
    direction: "inbound",
    fromNumber,
    toNumber: TWILIO_NUMBER,
    body,
    status: "received",
    twilioSid: sid ?? null,
    createdAt: at,
  });
}

async function ledgerRowFor(phoneE164: string) {
  const rows = await getDb()
    .select()
    .from(smsConsentLedger)
    .where(eq(smsConsentLedger.phoneNormalized, phoneE164));
  return rows[0] ?? null;
}

async function main(): Promise<void> {
  console.log("Prod action: SMS consent ledger backfill (Task #4336)");

  await runInTxSandbox(async () => {
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const halfDayAgo = new Date(Date.now() - 12 * 3600_000);

    // Baseline — the sandbox sees whatever ledger coverage the run's DB
    // already has, so every assertion below is scoped to OUR fixtures.
    const baseline = await smsConsentBackfillAction.status();

    // P1 — known only via clients.contact_phone (formatted, not E.164).
    const p1 = freshPhone();
    const p1raw = `(${p1.slice(2, 5)}) ${p1.slice(5, 8)}-${p1.slice(8)}`;
    await getDb().insert(clients).values({ firmName: `Backfill Test ${RUN}`, contactPhone: p1raw });

    // P2 — known only via a conversation row.
    const p2 = freshPhone();
    await seedConversation(p2);

    // P3 — known only as an inbound sender (non-keyword chatter).
    const p3 = freshPhone();
    const convP3 = await seedConversation(p3);
    await seedInbound(convP3, p3, "hey, quick question about the invoice", dayAgo);

    // P4 — historical keywords: STOP then START ⇒ last wins ⇒ opted_in.
    const p4 = freshPhone();
    const convP4 = await seedConversation(p4);
    await seedInbound(convP4, p4, "STOP", dayAgo, `SM${RUN}p4stop`);
    await seedInbound(convP4, p4, "START", halfDayAgo, `SM${RUN}p4start`);

    // P5 — live-recorded opted_out BEFORE the backfill runs, plus a later
    // historical START the guard must NOT apply.
    const p5 = freshPhone();
    const convP5 = await seedConversation(p5);
    await seedInbound(convP5, p5, "START", halfDayAgo, `SM${RUN}p5start`);
    await applyConsentStateChange({
      phoneE164: p5,
      phoneMatchKey: getPhoneMatchKey(p5)!,
      newState: "opted_out",
      source: "keyword_inbound",
      evidence: `Live opt-out before backfill (${RUN})`,
      event: { eventType: "opt_out", detail: `test ${RUN}` },
    });

    console.log("\n— 1. status() sees the pending work —");
    const pending = await smsConsentBackfillAction.status();
    check("status is pending", pending.state === "pending", pending.detail);
    // Our fixtures add exactly 4 missing rows (P1–P4; P5 already has one)
    // and at least P4 as a pending historical keyword state on top of
    // whatever the baseline reported.
    check(
      "detail names missing-ledger and historical counts",
      /missing a ledger row/.test(pending.detail ?? "") && /historical keyword/.test(pending.detail ?? ""),
      pending.detail,
    );

    console.log("\n— 2. apply() converges —");
    const outcome = await smsConsentBackfillAction.apply();
    check("apply reports applied", outcome.state === "applied", outcome.detail);

    const r1 = await ledgerRowFor(normalizeToE164(p1raw));
    check("client contact_phone seeded as unknown", r1?.state === "unknown" && r1?.source === "backfill_seed");
    const r2 = await ledgerRowFor(p2);
    check("conversation phone seeded as unknown", r2?.state === "unknown");
    const r3 = await ledgerRowFor(p3);
    check("inbound sender seeded as unknown", r3?.state === "unknown");

    const r4 = await ledgerRowFor(p4);
    check(
      "historical STOP→START ends opted_in via backfill_history (last keyword wins)",
      r4?.state === "opted_in" && r4?.source === "backfill_history",
      `state=${r4?.state} source=${r4?.source}`,
    );
    const p4Events = await getDb()
      .select()
      .from(smsConsentEvents)
      .where(eq(smsConsentEvents.phoneNormalized, p4));
    check(
      "backfill event appended for the applied keyword",
      p4Events.some((e) => e.eventType === "backfill" && e.keyword === "START"),
    );

    const r5 = await ledgerRowFor(p5);
    check(
      "live-recorded opted_out is NEVER clobbered by historical keywords",
      r5?.state === "opted_out" && r5?.source === "keyword_inbound",
      `state=${r5?.state} source=${r5?.source}`,
    );

    console.log("\n— 3. Idempotency —");
    const after = await smsConsentBackfillAction.status();
    // The action converges relative to the whole DB; if the baseline was
    // already clean, our fixtures are now covered too and it must be
    // not-needed. If the run DB had pre-existing gaps (baseline pending),
    // apply() also covered those — either way a re-apply finds nothing new
    // for OUR fixtures.
    check(
      "re-status converges to not-needed once coverage is complete",
      after.state === "not-needed",
      `baseline=${baseline.state} after=${after.state}: ${after.detail}`,
    );
    const reapply = await smsConsentBackfillAction.apply();
    check("re-apply reports not-needed (no double work)", reapply.state === "not-needed", reapply.detail);
    const r4Again = await ledgerRowFor(p4);
    check("re-apply left the applied state untouched", r4Again?.state === "opted_in");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
