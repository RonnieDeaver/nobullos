/* test-registration
{
  "name": "Vendor-identifier cleanup prod action + promotion skip reasons (Task #4790)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Guards the one-press vendor-poison cleanup action end-to-end (strip + CAS unmatch + audit + convergence) plus the promotion skip-reason writer guard; isolated-schema DB suite measured ~3.4s solo — cheap for the wall, and the action ships to prod immediately after merge.",
  "tier": "small"
}
test-registration */
/**
 * Task #4790 — convergence test for the `cleanup_vendor_identifier_poison`
 * prod action, plus the per-email skip reasons of
 * `promoteEmailsToClientContact`.
 *
 * The prod poison (read from the replica 2026-08-14, values pinned below as
 * fixtures): Dellutri Law Group's `clients.email_domains` claimed
 * `stripe.com`, `mail.replit.com`, `tabs3.com`, and their contact row
 * carried `receipts+acct_15ypnsjamnyvovfn@stripe.com` +
 * `contact@mail.replit.com` — so 646 of NoBull's own vendor receipts
 * auto-matched into their comm log (531 stripe.com / 95 mail.replit.com /
 * 20 tabs3.com).
 *
 * One press of the action must:
 *   • strip the vendor domains from `clients.email_domains` (legit
 *     `dellutrilawgroup.com` survives) and the vendor emails from the
 *     contact row (legit `cgarratt@…` survives),
 *   • CAS-unmatch every AUTO-matched conversation whose match_reason cites
 *     a vendor identifier: back to `unmatched`, client + confidence
 *     cleared, thread-wide attribution cleared, one `front_match_audit_log`
 *     row each,
 *   • NEVER touch: a manually_matched conversation (even when its reason
 *     cites a vendor), an auto-match citing a legit domain, or an
 *     auto-match citing a NON-vendor lookalike (`notstripe.com`),
 *   • report (never modify) suspicious-looking trusted domains
 *     (`fireflies.ai` here — the real ambiguous case from prod),
 *   • converge: second status is not-needed, second press is a no-op.
 *
 * Isolation: Task #1929 pattern — everything runs inside
 * `runInIsolatedSchema`; the action's reads/writes route through `getDb()`
 * (storage + raw SQL) which honors the isolated-schema override, and the
 * background drain inherits the test's ALS scope.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  getDrainState,
  __resetDrainsForTest,
  type DrainState,
} from "../server/services/prodActionBackgroundDrain";
import { promoteEmailsToClientContact } from "../server/services/clientContactPromotion";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTION_ID = "cleanup_vendor_identifier_poison";
const TABLES = [
  "clients",
  "client_contacts",
  "client_contacts_audit",
  "front_sync_emails",
  "front_match_audit_log",
  "raw_communication_records",
  "prod_action_runs",
] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

// ── Prod-pinned fixtures (read from the prod replica 2026-08-14) ──────────
const DELLUTRI = "client-dellutri-4790";
const STRIPE_RECEIPT_SENDER = "receipts+acct_15ypnsjamnyvovfn@stripe.com";
const REPLIT_SENDER = "contact@mail.replit.com";
const VENDOR_DOMAINS = ["stripe.com", "mail.replit.com", "tabs3.com"] as const;
const LEGIT_DOMAIN = "dellutrilawgroup.com";
const LEGIT_CONTACT_EMAIL = "cgarratt@dellutrilawgroup.com";
// Ambiguous agency-ish domain another client trusts — report-only.
const SUSPICIOUS_CLIENT = "client-suspicious-4790";
const SUSPICIOUS_DOMAIN = "fireflies.ai";

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

function getAction() {
  const action = PROD_ACTIONS.find((a) => a.id === ACTION_ID);
  if (!action) throw new Error(`${ACTION_ID} missing from PROD_ACTIONS registry`);
  return action;
}

async function awaitDrain(timeoutMs = 30_000): Promise<DrainState> {
  const start = Date.now();
  for (;;) {
    const st = getDrainState(ACTION_ID);
    if (st && st.finishedAt !== null) return st;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `drain ${ACTION_ID} did not finish within ${timeoutMs}ms (state=${JSON.stringify(st)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function seedSyncEmail(
  isoDb: IsoDb,
  row: {
    id: string;
    conversationId: string;
    matchStatus: string;
    matchedClientId: string | null;
    matchReason: string | null;
    matchConfidence?: number | null;
  },
): Promise<void> {
  await isoDb.execute(sql`
    INSERT INTO front_sync_emails
      (id, conversation_id, match_status, matched_client_id, match_confidence,
       match_reason, pipeline_state, created_at, state_changed_at)
    VALUES (
      ${row.id}, ${row.conversationId}, ${row.matchStatus},
      ${row.matchedClientId}, ${row.matchConfidence ?? 0.95}, ${row.matchReason},
      'applied', NOW(), NOW()
    )
  `);
}

async function readSyncEmail(
  isoDb: IsoDb,
  id: string,
): Promise<{ match_status: string; matched_client_id: string | null; match_confidence: number | null; match_reason: string | null }> {
  const res: any = await isoDb.execute(sql`
    SELECT match_status, matched_client_id, match_confidence, match_reason
    FROM front_sync_emails WHERE id = ${id}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  assert.ok(rows[0], `front_sync_emails row ${id} missing`);
  return rows[0];
}

async function main(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();

    // ── Seed: the Dellutri poison shape ──────────────────────────────────
    await isoDb.execute(sql`
      INSERT INTO clients (id, firm_name, email_domains, is_archived)
      VALUES
        (${DELLUTRI}, 'Dellutri Law Group',
         ARRAY[${LEGIT_DOMAIN}, 'stripe.com', 'mail.replit.com', 'tabs3.com']::text[], false),
        (${SUSPICIOUS_CLIENT}, 'Ambiguous Agency Client',
         ARRAY['ambiguous-firm.com', ${SUSPICIOUS_DOMAIN}]::text[], false)
    `);
    await isoDb.execute(sql`
      INSERT INTO client_contacts (id, client_id, name, emails, phones, is_primary)
      VALUES ('cc-garratt-4790', ${DELLUTRI}, 'Christie Garratt',
              ARRAY[${LEGIT_CONTACT_EMAIL}, ${STRIPE_RECEIPT_SENDER}, ${REPLIT_SENDER}]::text[],
              ARRAY[]::text[], true)
    `);

    // Vendor-cited auto-matches (must unmatch) — reasons in the exact shape
    // the hard matcher writes.
    await seedSyncEmail(isoDb, {
      id: "fse-v-stripe", conversationId: "cnv_v_stripe",
      matchStatus: "auto_matched", matchedClientId: DELLUTRI,
      matchReason: "Trusted domain match: stripe.com",
    });
    await seedSyncEmail(isoDb, {
      id: "fse-v-exact", conversationId: "cnv_v_exact",
      matchStatus: "auto_matched", matchedClientId: DELLUTRI,
      matchReason: `Exact email match: ${STRIPE_RECEIPT_SENDER}`,
      matchConfidence: 1.0,
    });
    await seedSyncEmail(isoDb, {
      id: "fse-v-replit", conversationId: "cnv_v_replit",
      matchStatus: "auto_matched", matchedClientId: DELLUTRI,
      matchReason: "Trusted domain match: mail.replit.com",
    });
    // Negatives — must NEVER be touched:
    await seedSyncEmail(isoDb, {
      id: "fse-legit", conversationId: "cnv_legit",
      matchStatus: "auto_matched", matchedClientId: DELLUTRI,
      matchReason: `Trusted domain match: ${LEGIT_DOMAIN}`,
    });
    await seedSyncEmail(isoDb, {
      id: "fse-manual", conversationId: "cnv_manual",
      matchStatus: "manually_matched", matchedClientId: DELLUTRI,
      matchReason: "Trusted domain match: stripe.com",
    });
    await seedSyncEmail(isoDb, {
      id: "fse-lookalike", conversationId: "cnv_lookalike",
      matchStatus: "auto_matched", matchedClientId: SUSPICIOUS_CLIENT,
      matchReason: "Trusted domain match: notstripe.com",
    });

    // Thread-wide attribution for one vendor conversation — the unmatch must
    // clear it via the shared stamp helper (null clears).
    await isoDb.execute(sql`
      INSERT INTO raw_communication_records
        (id, source_type, title, timestamp, external_source_id,
         external_thread_id, client_id, created_at, updated_at)
      VALUES ('raw-v-exact-4790', 'front_email', 'Your Replit receipt', NOW(),
              'msg-v-exact-4790', 'cnv_v_exact', ${DELLUTRI}, NOW(), NOW())
    `);

    const action = getAction();

    // ── Status before: pending, with the suspicious domain reported ─────
    const pre = await action.status(null);
    assert.equal(pre.state, "pending", `expected pending, got ${JSON.stringify(pre)}`);
    assert.match(pre.detail ?? "", /2 client row\(s\)/, `detail should count 2 client rows: ${pre.detail}`);
    assert.match(pre.detail ?? "", /3 auto-matched/, `detail should count 3 conversations: ${pre.detail}`);
    assert.match(pre.detail ?? "", new RegExp(SUSPICIOUS_DOMAIN.replace(".", "\\.")),
      `detail should report the suspicious domain: ${pre.detail}`);
    ok("status is pending: 2 client rows + 3 vendor-cited conversations, suspicious domain reported");

    // ── Press once; drain to convergence ─────────────────────────────────
    const out = await action.apply(null);
    assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);
    const state = await awaitDrain();
    assert.equal(state.error, null, `drain errored — ${state.error}`);
    assert.equal(
      state.processed, 5,
      `expected 5 processed (2 row fixes + 3 unmatches), got ${state.processed} (${JSON.stringify(state.perKey)})`,
    );
    assert.deepEqual(
      state.perKey,
      {
        client_domain_lists_cleaned: 1,
        vendor_domains_removed: 3,
        contact_rows_cleaned: 1,
        vendor_contact_emails_removed: 2,
        conversations_unmatched: 3,
      },
      `unexpected perKey ${JSON.stringify(state.perKey)}`,
    );
    ok("one press processed exactly 2 client-row fixes + 3 unmatches");

    // ── Client rows: vendor identifiers gone, legit ones survive ─────────
    const client: any = ((await isoDb.execute(sql`
      SELECT email_domains FROM clients WHERE id = ${DELLUTRI}
    `)) as any).rows[0];
    assert.deepEqual(client.email_domains, [LEGIT_DOMAIN],
      `Dellutri domains should be exactly [${LEGIT_DOMAIN}], got ${JSON.stringify(client.email_domains)}`);
    const contact: any = ((await isoDb.execute(sql`
      SELECT emails FROM client_contacts WHERE id = 'cc-garratt-4790'
    `)) as any).rows[0];
    assert.deepEqual(contact.emails, [LEGIT_CONTACT_EMAIL],
      `contact emails should keep only the legit address, got ${JSON.stringify(contact.emails)}`);
    const suspicious: any = ((await isoDb.execute(sql`
      SELECT email_domains FROM clients WHERE id = ${SUSPICIOUS_CLIENT}
    `)) as any).rows[0];
    assert.deepEqual(suspicious.email_domains, ["ambiguous-firm.com", SUSPICIOUS_DOMAIN],
      "suspicious (report-only) client is never modified");
    ok("vendor domains/emails stripped; legit domain + contact email survive; suspicious client untouched");

    // ── Vendor-cited conversations: unmatched + attribution cleared ──────
    for (const id of ["fse-v-stripe", "fse-v-exact", "fse-v-replit"]) {
      const row = await readSyncEmail(isoDb, id);
      assert.equal(row.match_status, "unmatched", `${id} should be unmatched`);
      assert.equal(row.matched_client_id, null, `${id} client should be cleared`);
      assert.equal(row.match_confidence, null, `${id} confidence should be cleared`);
      assert.match(row.match_reason ?? "", /task-4790/, `${id} reason should record the cleanup`);
    }
    const raw: any = ((await isoDb.execute(sql`
      SELECT client_id FROM raw_communication_records WHERE id = 'raw-v-exact-4790'
    `)) as any).rows[0];
    assert.equal(raw.client_id, null, "thread-wide attribution cleared (raw record client_id null)");
    ok("3 vendor-cited conversations returned to unmatched with attribution cleared");

    // ── Negatives untouched ──────────────────────────────────────────────
    const legit = await readSyncEmail(isoDb, "fse-legit");
    assert.equal(legit.match_status, "auto_matched", "legit-domain auto-match untouched");
    assert.equal(legit.matched_client_id, DELLUTRI);
    const manual = await readSyncEmail(isoDb, "fse-manual");
    assert.equal(manual.match_status, "manually_matched", "manually_matched NEVER touched");
    assert.equal(manual.matched_client_id, DELLUTRI);
    const lookalike = await readSyncEmail(isoDb, "fse-lookalike");
    assert.equal(lookalike.match_status, "auto_matched", "notstripe.com lookalike untouched (regex anchored)");
    ok("legit auto-match, manual match, and notstripe.com lookalike all untouched");

    // ── Audit rows: one per unmatched conversation ───────────────────────
    const audits: any[] = ((await isoDb.execute(sql`
      SELECT sync_email_id, conversation_id, outcome, prior_client_id, prior_match_status, matched_on
      FROM front_match_audit_log WHERE source = 'vendor_identifier_cleanup'
      ORDER BY sync_email_id
    `)) as any).rows;
    assert.equal(audits.length, 3, `expected 3 audit rows, got ${audits.length}`);
    for (const a of audits) {
      assert.equal(a.outcome, "unmatched");
      assert.equal(a.prior_client_id, DELLUTRI);
      assert.equal(a.prior_match_status, "auto_matched");
    }
    const auditMatchedOn = new Set(audits.map((a) => a.matched_on));
    assert.ok(auditMatchedOn.has("stripe.com"), "audit records the cited domain");
    assert.ok(auditMatchedOn.has(STRIPE_RECEIPT_SENDER), "audit records the cited email");
    ok("3 audit rows written with prior state + cited identifier");

    // ── Convergence: second status not-needed, second press a no-op ─────
    __resetDrainsForTest();
    const post = await action.status(null);
    assert.equal(post.state, "not-needed", `expected not-needed, got ${JSON.stringify(post)}`);
    assert.match(post.detail ?? "", new RegExp(SUSPICIOUS_DOMAIN.replace(".", "\\.")),
      "suspicious-domain report persists after cleanup for operator review");
    const out2 = await action.apply(null);
    assert.equal(out2.state, "not-needed", `second press should be not-needed, got ${JSON.stringify(out2)}`);
    const clientAfter2: any = ((await isoDb.execute(sql`
      SELECT email_domains FROM clients WHERE id = ${DELLUTRI}
    `)) as any).rows[0];
    assert.deepEqual(clientAfter2.email_domains, [LEGIT_DOMAIN], "second press changed nothing");
    ok("converged: second status not-needed (suspicious report persists), second press a no-op");

    // ── Promotion skip reasons (Task #4790 writer guard) ─────────────────
    // Mixed batch: vendor + receipt-style + legit — only the legit email is
    // added, and each refusal carries a machine-readable reason.
    const promoMixed = await promoteEmailsToClientContact({
      clientId: DELLUTRI,
      emails: [STRIPE_RECEIPT_SENDER, REPLIT_SENDER, "newhuman@dellutrilawgroup.com", "billing@nonvendor-firm.com"],
      explicitOptIn: true,
    });
    assert.equal(promoMixed.added, 1, `only the legit email is added: ${JSON.stringify(promoMixed)}`);
    const reasonByEmail = new Map(promoMixed.skippedEmails.map((s) => [s.email, s.reason]));
    assert.equal(reasonByEmail.get(STRIPE_RECEIPT_SENDER), "vendor_platform_domain");
    assert.equal(reasonByEmail.get(REPLIT_SENDER), "vendor_platform_domain");
    assert.equal(reasonByEmail.get("billing@nonvendor-firm.com"), "receipt_style_sender");
    const contactAfterPromo: any = ((await isoDb.execute(sql`
      SELECT emails FROM client_contacts WHERE id = 'cc-garratt-4790'
    `)) as any).rows[0];
    assert.ok(contactAfterPromo.emails.includes("newhuman@dellutrilawgroup.com"), "legit email added");
    assert.ok(!contactAfterPromo.emails.includes(STRIPE_RECEIPT_SENDER), "vendor email NOT re-added");
    assert.ok(!contactAfterPromo.emails.includes(REPLIT_SENDER), "vendor email NOT re-added");
    assert.ok(!contactAfterPromo.emails.includes("billing@nonvendor-firm.com"), "receipt-style email NOT added");
    ok("promotion refuses vendor/receipt senders with per-email reasons even under explicit opt-in");

    // All-vendor batch short-circuits without touching storage.
    const promoAllVendor = await promoteEmailsToClientContact({
      clientId: DELLUTRI,
      emails: [STRIPE_RECEIPT_SENDER, REPLIT_SENDER],
      explicitOptIn: true,
    });
    assert.equal(promoAllVendor.added, 0);
    assert.equal(promoAllVendor.reason, "all_filtered");
    assert.equal(promoAllVendor.skippedEmails.length, 2);
    ok("all-vendor promotion returns all_filtered with per-email reasons");
  }, { tables: TABLES });

  console.log(`\n${passed} assertion group(s) passed`);
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
