/* test-registration
{
  "name": "Front attach sender to client route (baseline triage, Task #3424)",
  "tier": "medium"
}
test-registration */
/**
 * Task #2525 — End-to-end isolated-schema test for the Front "Attach to client"
 * feature: POST /api/integrations/front/attach-sender-to-client must lift the
 * match rate by attaching a domain/email to a client and re-evaluating ONLY the
 * affected unmatched `front_sync_emails` rows, flipping them to `auto_matched`
 * while leaving unrelated rows untouched.
 *
 * Why an isolated schema (not the tx sandbox): the Express request handler runs
 * in a separate async context outside the sandbox's ALS scope, so we pin
 * getDb() at the isolated, cloned tables via `pinGetDbForCrossAsync` (the
 * cross-async handler then reads the seeded rows instead of live `public`).
 *
 * The OpenAI operational classifier no longer exists (removed in Task #2637),
 * so triage runs deterministic hard-match only — the test is hermetic and
 * makes no external HTTP calls. The
 * apply step is kept local by pre-seeding a `raw_communication_records` row
 * (matched on `external_source_id`) so `applyMatchedConversation` takes the
 * existing-record branch instead of calling the Front API to ingest.
 *
 * Public-API doc note: this test exercises our OWN route + service code, not a
 * third-party endpoint; no external API surface is touched (the classifier and
 * Front-ingest paths that would call OpenAI / Front are both suppressed as
 * described above). Prior-task research: builds on the Task #867
 * trusted-domain / exact-email hard-match rules; consulted Task #2512's
 * isolated-schema route-test harness pattern.
 *
 * Cases:
 *   1. Domain attach (private domain) → affected unmatched row flips to
 *      auto_matched; an unrelated unmatched row (different domain) is untouched.
 *   2. Public free-mail domain AND internal company domain attach → 400, and
 *      the client's trusted-domain list is unchanged (changes nothing).
 *   3. Exact-email attach via promoteEmailsToClientContact → the matching
 *      unmatched row flips to auto_matched.
 *   4. Spam / automated sender exact-email attach → 400, and nothing changed:
 *      no client_contacts row created and the unmatched row is NOT flipped
 *      (Task #2539 — covers the `isSpamSenderEmail` 400 branch left untested
 *      by #2525).
 *
 * Task #2538 — the ambiguous safety branch. The hard matcher
 * (`resolveFrontHardMatch`) deliberately returns `ambiguous` (no auto-claim)
 * when a domain/email maps to MORE THAN ONE client, so a conversation is never
 * misfiled under the wrong firm. Cases 1 & 3 only cover the unique-match happy
 * path; these add end-to-end coverage of the no-auto-claim branch through the
 * same attach route + re-evaluation:
 *   5. Domain attach where a SECOND client already trusts that domain → the
 *      attach still succeeds (target client gains the domain) and returns 200,
 *      but the affected row stays `unmatched` (collides → ambiguous), never
 *      `auto_matched`.
 *   6. Exact-email attach where a SECOND client already owns that email → the
 *      attach still succeeds and returns 200, but the affected row stays
 *      `unmatched` (collides → ambiguous).
 */

import assert from "node:assert/strict";
import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import type { AddressInfo } from "node:net";

import { runInIsolatedSchema, sql } from "./db-sandbox";
import { registerIntegrationRoutes } from "../server/routes/integrations";
import { setKillSwitch } from "../server/services/killSwitches";
import { invalidateHardMatchIndexes } from "../server/services/frontHardMatch";
import {
  __test_markUserReconciled,
  __test_resetReconciledUsers,
} from "../server/middlewares/requireAuth";

// Take the Clerk per-request test seam even under a bare `npx tsx` repro.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

// Hermetic: the manual-only kill switch suppresses the OpenAI classifier and a
// pre-seeded raw record suppresses Front ingest, so no upstream HTTP should
// occur. Guard against accidental network egress so a regression is loud.
const originalFetch: typeof fetch = global.fetch;
global.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  throw new Error(`[task-2525] Unexpected network call during hermetic test: ${url}`);
}) as any;

const AM_ID = "task-2525-am";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): authenticate as AM_ID.
    (req as any).__test_clerkUserId = AM_ID;
    next();
  });
  registerIntegrationRoutes(app);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function postAttach(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  // Use the un-stubbed fetch (the global stub throws); this is a local loopback
  // call to our own server, not an external API.
  const r = await originalFetch(`${baseUrl}/api/integrations/front/attach-sender-to-client`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

const TABLES = [
  "users",
  "clients",
  "client_contacts",
  "client_contacts_audit",
  "front_sync_emails",
  "front_hydrate_snapshots",
  "raw_communication_records",
  "front_match_audit_log",
  "import_entity_suggestions",
  "front_filter_rules",
  "system_settings",
] as const;

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  \u2717 ${name}: ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
  }
}

async function main(): Promise<void> {
  console.log("Front Attach-to-client lifts match rate end-to-end (Task #2525)");

  await runInIsolatedSchema(
    async ({ db }) => {
      // ── Seed: AM user (role gating reads users via getDb → isolated) ──────
      await db.execute(sql`
        INSERT INTO users (id, role, first_name)
        VALUES (${AM_ID}, 'account_manager', 'Task2525 AM')
      `);
      // User is seeded in the isolated (uncommitted) schema; requireAuth
      // resolves identity via the ambient PUBLIC-schema db, so pre-register
      // the profile in the module registry with the role the route needs.
      __test_markUserReconciled(AM_ID, {
        id: AM_ID,
        role: "account_manager",
        firstName: "Task2525 AM",
      });

      // ── Seed: two clients, both with empty trusted-domain lists ──────────
      const CLIENT_DOMAIN = "c-2525-domain";
      const CLIENT_EMAIL = "c-2525-email";
      const CLIENT_SPAM = "c-2525-spam";
      // Task #2538 — ambiguous-branch fixtures.
      // Domain collision: B already trusts the shared domain; the operator then
      // attaches it to A. Once BOTH trust it the matcher must refuse to claim.
      const SHARED_DOMAIN = "shared-firm.com";
      const AMBIG_DOMAIN_A = "c-2538-ambig-domain-a"; // gains SHARED_DOMAIN via attach
      const AMBIG_DOMAIN_B = "c-2538-ambig-domain-b"; // already trusts SHARED_DOMAIN
      // Email collision: A already owns the shared email; the operator then
      // attaches it to B. Once BOTH own it the matcher must refuse to claim.
      const SHARED_EMAIL = "shared@law-partners.com";
      const AMBIG_EMAIL_A = "c-2538-ambig-email-a"; // already owns SHARED_EMAIL
      const AMBIG_EMAIL_B = "c-2538-ambig-email-b"; // gains SHARED_EMAIL via attach
      await db.execute(sql`
        INSERT INTO clients (id, firm_name, email_domains, is_archived)
        VALUES
          (${CLIENT_DOMAIN}, 'Acme Law Firm', ARRAY[]::text[], false),
          (${CLIENT_EMAIL}, 'Beta Legal Group', ARRAY[]::text[], false),
          (${CLIENT_SPAM}, 'Gamma Law Partners', ARRAY[]::text[], false),
          (${AMBIG_DOMAIN_A}, 'Gamma Law Firm', ARRAY[]::text[], false),
          (${AMBIG_DOMAIN_B}, 'Delta Legal Group', ARRAY[${SHARED_DOMAIN}]::text[], false),
          (${AMBIG_EMAIL_A}, 'Epsilon Law Firm', ARRAY[]::text[], false),
          (${AMBIG_EMAIL_B}, 'Zeta Legal Group', ARRAY[]::text[], false)
      `);

      // Pre-seed the contact that makes the email collision real: A already
      // owns SHARED_EMAIL before the operator attaches it to B.
      await db.execute(sql`
        INSERT INTO client_contacts (client_id, name, emails, phones, is_primary)
        VALUES (${AMBIG_EMAIL_A}, 'Existing Owner', ARRAY[${SHARED_EMAIL}]::text[], ARRAY[]::text[], true)
      `);

      // ── Seed: unmatched front_sync_emails rows ───────────────────────────
      // Affected by the domain attach (acme-law.com).
      const CONV_DOMAIN = "conv-2525-domain";
      // Unrelated (different domain) — must stay untouched.
      const CONV_UNRELATED = "conv-2525-unrelated";
      // Affected by the exact-email attach (carol@personal-law.com).
      const CONV_EMAIL = "conv-2525-email";
      // Spam / automated sender — the attach must be rejected and this row must
      // stay unmatched (Task #2539).
      const CONV_SPAM = "conv-2525-spam";
      const SPAM_EMAIL = "noreply@gamma-law.com";
      // Task #2538 — rows that collide between two clients and must stay
      // unmatched after the attach (the ambiguous safety branch).
      const CONV_AMBIG_DOMAIN = "conv-2538-ambig-domain"; // dan@shared-firm.com
      const CONV_AMBIG_EMAIL = "conv-2538-ambig-email";   // shared@law-partners.com

      const rows: Array<{ conv: string; email: string; name: string }> = [
        { conv: CONV_DOMAIN, email: "jane@acme-law.com", name: "Jane Doe" },
        { conv: CONV_UNRELATED, email: "bob@other-firm.com", name: "Bob Roe" },
        { conv: CONV_EMAIL, email: "carol@personal-law.com", name: "Carol Poe" },
        { conv: CONV_SPAM, email: SPAM_EMAIL, name: "Gamma Notifications" },
        { conv: CONV_AMBIG_DOMAIN, email: `dan@${SHARED_DOMAIN}`, name: "Dan Foe" },
        { conv: CONV_AMBIG_EMAIL, email: SHARED_EMAIL, name: "Eve Loe" },
      ];

      for (const r of rows) {
        const participants = JSON.stringify([{ name: r.name, email: r.email, role: "from" }]);
        const versionKey = `${r.conv}::no_msg`;
        await db.execute(sql`
          INSERT INTO front_sync_emails
            (conversation_id, subject, snippet, participants_json, match_status,
             pipeline_state, version_key)
          VALUES
            (${r.conv}, ${"Subject " + r.conv}, ${"snippet"},
             ${participants}::jsonb, 'unmatched', 'apply_pending', ${versionKey})
        `);
        // Hydrated snapshot so apply finds it (no Front re-hydrate call).
        await db.execute(sql`
          INSERT INTO front_hydrate_snapshots
            (conversation_id, version_key, conversation_json, messages_json, message_count)
          VALUES
            (${r.conv}, ${versionKey}, '{}'::jsonb, '[]'::jsonb, 0)
        `);
      }

      // Pre-seed raw records for the two rows we EXPECT to flip, each already
      // pointing at the target client → apply takes the existing-record noop
      // branch (no ingestConversation / Front API call).
      await db.execute(sql`
        INSERT INTO raw_communication_records
          (client_id, source_type, title, timestamp, external_source_id)
        VALUES
          (${CLIENT_DOMAIN}, 'front_email', 'raw domain', now(), ${CONV_DOMAIN}),
          (${CLIENT_EMAIL}, 'front_email', 'raw email', now(), ${CONV_EMAIL})
      `);

      // Deterministic hard-match is the only matching path (the operational
      // classifier was removed in Task #2637), so the test is hermetic and
      // makes no external HTTP calls.
      invalidateHardMatchIndexes();

      const { server, baseUrl } = await listen(buildApp());
      try {
        // ── Case 1: private-domain attach lifts the match rate ─────────────
        const r1 = await postAttach(baseUrl, { clientId: CLIENT_DOMAIN, domain: "acme-law.com" });
        check("domain attach returns 200", () => assert.equal(r1.status, 200, JSON.stringify(r1.json)));
        check("domain attach reports exactly one re-evaluated + matched row", () => {
          assert.equal(r1.json.reEvaluated, 1, `reEvaluated=${r1.json.reEvaluated}`);
          assert.equal(r1.json.matched, 1, `matched=${r1.json.matched}`);
        });

        const domainRow = (await db.execute(sql`
          SELECT match_status, matched_client_id FROM front_sync_emails WHERE conversation_id = ${CONV_DOMAIN}
        `)).rows[0] as any;
        check("affected domain row flipped to auto_matched on the target client", () => {
          assert.equal(domainRow.match_status, "auto_matched");
          assert.equal(domainRow.matched_client_id, CLIENT_DOMAIN);
        });

        const unrelatedRow = (await db.execute(sql`
          SELECT match_status, matched_client_id FROM front_sync_emails WHERE conversation_id = ${CONV_UNRELATED}
        `)).rows[0] as any;
        check("unrelated row (different domain) is untouched", () => {
          assert.equal(unrelatedRow.match_status, "unmatched");
          assert.equal(unrelatedRow.matched_client_id, null);
        });

        const domainsAfter1 = (await db.execute(sql`
          SELECT email_domains FROM clients WHERE id = ${CLIENT_DOMAIN}
        `)).rows[0] as any;
        check("trusted-domain list now contains the attached domain", () => {
          assert.deepEqual(domainsAfter1.email_domains, ["acme-law.com"]);
        });

        // ── Case 2: public + company domain attaches are rejected, no-op ───
        const before2 = (await db.execute(sql`
          SELECT email_domains FROM clients WHERE id = ${CLIENT_DOMAIN}
        `)).rows[0] as any;

        const rPublic = await postAttach(baseUrl, { clientId: CLIENT_DOMAIN, domain: "gmail.com" });
        check("public free-mail domain attach rejected with 400", () => assert.equal(rPublic.status, 400));

        const rCompany = await postAttach(baseUrl, { clientId: CLIENT_DOMAIN, domain: "nobullmarketing.com" });
        check("internal company domain attach rejected with 400", () => assert.equal(rCompany.status, 400));

        // Task #4790 — vendor platform domains (the Dellutri poison shape:
        // stripe.com was trusted to a client and 531 of NoBull's own Stripe
        // receipts auto-matched). Refused like public/internal, including
        // subdomains (mail.replit.com — prod-pinned value).
        const rVendor = await postAttach(baseUrl, { clientId: CLIENT_DOMAIN, domain: "stripe.com" });
        check("vendor platform domain attach rejected with 400", () =>
          assert.equal(rVendor.status, 400, JSON.stringify(rVendor.json)));
        check("400 body explains the domain is a vendor platform", () =>
          assert.ok(/vendor/i.test(String(rVendor.json?.error)), JSON.stringify(rVendor.json)));
        const rVendorSub = await postAttach(baseUrl, { clientId: CLIENT_DOMAIN, domain: "mail.replit.com" });
        check("vendor platform SUBDOMAIN attach rejected with 400", () =>
          assert.equal(rVendorSub.status, 400, JSON.stringify(rVendorSub.json)));

        const after2 = (await db.execute(sql`
          SELECT email_domains FROM clients WHERE id = ${CLIENT_DOMAIN}
        `)).rows[0] as any;
        check("rejected domain attaches change nothing (trusted-domain list unchanged)", () => {
          assert.deepEqual(after2.email_domains, before2.email_domains);
        });

        // ── Case 3: exact-email attach lifts the match rate ────────────────
        const r3 = await postAttach(baseUrl, { clientId: CLIENT_EMAIL, email: "carol@personal-law.com" });
        check("email attach returns 200", () => assert.equal(r3.status, 200, JSON.stringify(r3.json)));
        check("email attach reports exactly one re-evaluated + matched row", () => {
          assert.equal(r3.json.reEvaluated, 1, `reEvaluated=${r3.json.reEvaluated}`);
          assert.equal(r3.json.matched, 1, `matched=${r3.json.matched}`);
        });

        const emailRow = (await db.execute(sql`
          SELECT match_status, matched_client_id FROM front_sync_emails WHERE conversation_id = ${CONV_EMAIL}
        `)).rows[0] as any;
        check("email-matched row flipped to auto_matched on the target client", () => {
          assert.equal(emailRow.match_status, "auto_matched");
          assert.equal(emailRow.matched_client_id, CLIENT_EMAIL);
        });

        const contact = (await db.execute(sql`
          SELECT emails FROM client_contacts WHERE client_id = ${CLIENT_EMAIL}
        `)).rows[0] as any;
        check("promoteEmailsToClientContact recorded the attached email on a contact", () => {
          assert.ok(
            Array.isArray(contact?.emails) && contact.emails.includes("carol@personal-law.com"),
            `contact emails=${JSON.stringify(contact?.emails)}`,
          );
        });

        // ── Case 4: spam / automated sender attach is rejected, no-op ──────
        const contactsBeforeSpam = (await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM client_contacts WHERE client_id = ${CLIENT_SPAM}
        `)).rows[0] as any;

        const rSpam = await postAttach(baseUrl, { clientId: CLIENT_SPAM, email: SPAM_EMAIL });
        check("spam / automated sender attach rejected with 400", () =>
          assert.equal(rSpam.status, 400, JSON.stringify(rSpam.json)));
        check("400 body explains the sender looks automated/spam", () =>
          assert.ok(/automated\/spam/i.test(String(rSpam.json?.error)), JSON.stringify(rSpam.json)));

        const contactsAfterSpam = (await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM client_contacts WHERE client_id = ${CLIENT_SPAM}
        `)).rows[0] as any;
        check("rejected spam attach created no client_contacts row", () => {
          assert.equal(contactsBeforeSpam.n, 0);
          assert.equal(contactsAfterSpam.n, 0);
        });

        const spamRow = (await db.execute(sql`
          SELECT match_status, matched_client_id FROM front_sync_emails WHERE conversation_id = ${CONV_SPAM}
        `)).rows[0] as any;
        check("spam-sender row is NOT flipped (stays unmatched)", () => {
          assert.equal(spamRow.match_status, "unmatched");
          assert.equal(spamRow.matched_client_id, null);
        });

        // Task #4790 — vendor-platform ADDRESS attach is rejected the same
        // way. Prod-pinned senders (read 2026-08-14): the exact Stripe
        // receipt address + the Replit sender that poisoned Dellutri's
        // contact row. Both must 400 with a vendor reason and create no
        // contact row.
        for (const vendorEmail of [
          "receipts+acct_15ypnsjamnyvovfn@stripe.com",
          "contact@mail.replit.com",
        ]) {
          const rv = await postAttach(baseUrl, { clientId: CLIENT_SPAM, email: vendorEmail });
          check(`vendor address attach rejected with 400 (${vendorEmail})`, () =>
            assert.equal(rv.status, 400, JSON.stringify(rv.json)));
          check(`400 body names the vendor platform (${vendorEmail})`, () =>
            assert.ok(/vendor/i.test(String(rv.json?.error)), JSON.stringify(rv.json)));
        }
        const contactsAfterVendor = (await db.execute(sql`
          SELECT COUNT(*)::int AS n FROM client_contacts WHERE client_id = ${CLIENT_SPAM}
        `)).rows[0] as any;
        check("rejected vendor attaches created no client_contacts row", () =>
          assert.equal(contactsAfterVendor.n, 0));

        // ── Case 5 (Task #2538): ambiguous DOMAIN never auto-attaches ──────
        // Delta already trusts SHARED_DOMAIN; the operator now attaches it to
        // Gamma too. The attach itself succeeds (Gamma gains the domain) and
        // returns 200, but the affected row collides between two clients so
        // the matcher refuses to auto-claim — it stays unmatched.
        const r4 = await postAttach(baseUrl, { clientId: AMBIG_DOMAIN_A, domain: SHARED_DOMAIN });
        check("ambiguous domain attach still returns 200", () => assert.equal(r4.status, 200, JSON.stringify(r4.json)));
        check("ambiguous domain attach matches zero rows (no auto-claim)", () => {
          assert.equal(r4.json.reEvaluated, 1, `reEvaluated=${r4.json.reEvaluated}`);
          assert.equal(r4.json.matched, 0, `matched=${r4.json.matched}`);
        });

        const ambigDomainTarget = (await db.execute(sql`
          SELECT email_domains FROM clients WHERE id = ${AMBIG_DOMAIN_A}
        `)).rows[0] as any;
        check("target client did gain the trusted domain (attach succeeded)", () => {
          assert.deepEqual(ambigDomainTarget.email_domains, [SHARED_DOMAIN]);
        });

        const ambigDomainRow = (await db.execute(sql`
          SELECT match_status, matched_client_id FROM front_sync_emails WHERE conversation_id = ${CONV_AMBIG_DOMAIN}
        `)).rows[0] as any;
        check("ambiguous-domain row stays unmatched (never misfiled to either client)", () => {
          assert.equal(ambigDomainRow.match_status, "unmatched");
          assert.equal(ambigDomainRow.matched_client_id, null);
        });

        // ── Case 6 (Task #2538): ambiguous EMAIL never auto-attaches ───────
        // Epsilon already owns SHARED_EMAIL; the operator now attaches it to
        // Zeta too. The attach succeeds (Zeta gains the contact email) and
        // returns 200, but the row collides between two clients → unmatched.
        const r5 = await postAttach(baseUrl, { clientId: AMBIG_EMAIL_B, email: SHARED_EMAIL });
        check("ambiguous email attach still returns 200", () => assert.equal(r5.status, 200, JSON.stringify(r5.json)));
        check("ambiguous email attach matches zero rows (no auto-claim)", () => {
          assert.equal(r5.json.reEvaluated, 1, `reEvaluated=${r5.json.reEvaluated}`);
          assert.equal(r5.json.matched, 0, `matched=${r5.json.matched}`);
        });

        const ambigEmailContact = (await db.execute(sql`
          SELECT emails FROM client_contacts WHERE client_id = ${AMBIG_EMAIL_B}
        `)).rows[0] as any;
        check("target client did gain the contact email (attach succeeded)", () => {
          assert.ok(
            Array.isArray(ambigEmailContact?.emails) && ambigEmailContact.emails.includes(SHARED_EMAIL),
            `contact emails=${JSON.stringify(ambigEmailContact?.emails)}`,
          );
        });

        const ambigEmailRow = (await db.execute(sql`
          SELECT match_status, matched_client_id FROM front_sync_emails WHERE conversation_id = ${CONV_AMBIG_EMAIL}
        `)).rows[0] as any;
        check("ambiguous-email row stays unmatched (never misfiled to either client)", () => {
          assert.equal(ambigEmailRow.match_status, "unmatched");
          assert.equal(ambigEmailRow.matched_client_id, null);
        });

        // ── Task #4790 (review round 2): the GENERAL client/contact CRUD APIs
        // are identifier writers too — POST/PATCH /api/clients and the contact
        // create/update routes must refuse vendor/receipt identifiers, or a
        // cleaned client row could be re-poisoned outside the attach surface
        // and the cleanup prod action would stop converging.
        {
          const crudApp = express();
          crudApp.use(express.json());
          crudApp.use((req: Request, _res: Response, next: NextFunction) => {
            (req as any).__test_clerkUserId = AM_ID;
            next();
          });
          const { registerClientRoutes } = await import("../server/routes/clients");
          const { registerAgentRoutes } = await import("../server/routes/agents");
          registerClientRoutes(crudApp);
          registerAgentRoutes(crudApp);
          const crud = await listen(crudApp);
          try {
            const call = async (method: string, path: string, body: unknown) => {
              const r = await originalFetch(`${crud.baseUrl}${path}`, {
                method,
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              });
              const json = await r.json().catch(() => ({}));
              return { status: r.status, json };
            };

            // Trusted-domain edits: vendor root + subdomain refused.
            // "stripe.com" / "mail.replit.com" / the receipts+… address below are
            // the exact poison values read from prod on 2026-08-14.
            const patchVendor = await call("PATCH", `/api/clients/${CLIENT_DOMAIN}`, {
              emailDomains: ["stripe.com"],
            });
            check("PATCH /api/clients refuses a vendor trusted domain (stripe.com)", () => {
              assert.equal(patchVendor.status, 400, JSON.stringify(patchVendor.json).slice(0, 300));
              assert.equal(patchVendor.json?.code, "VENDOR_IDENTIFIER_REFUSED");
              assert.match(String(patchVendor.json?.error ?? ""), /vendor/i);
            });

            const patchSub = await call("PATCH", `/api/clients/${CLIENT_DOMAIN}`, {
              emailDomains: ["mail.replit.com"],
            });
            check("PATCH refuses a vendor SUBDOMAIN (mail.replit.com — prod's poison entry)", () => {
              assert.equal(patchSub.status, 400);
              assert.equal(patchSub.json?.code, "VENDOR_IDENTIFIER_REFUSED");
            });

            // False-positive guard: a real firm domain still saves.
            const patchOk = await call("PATCH", `/api/clients/${CLIENT_DOMAIN}`, {
              emailDomains: ["acme-law.com"],
            });
            check("PATCH still accepts a legit firm domain (false-positive guard)", () => {
              assert.equal(patchOk.status, 200, JSON.stringify(patchOk.json).slice(0, 300));
            });

            const domainsNow = (await db.execute(sql`
              SELECT email_domains FROM clients WHERE id = ${CLIENT_DOMAIN}
            `)).rows[0] as any;
            check("vendor domains never landed on the client row", () => {
              const list: string[] = domainsNow?.email_domains ?? [];
              assert.ok(
                !list.includes("stripe.com") && !list.includes("mail.replit.com"),
                JSON.stringify(list),
              );
              assert.ok(list.includes("acme-law.com"), JSON.stringify(list));
            });

            // Legacy primary contactEmail path (accepted by the same schema).
            const patchLegacy = await call("PATCH", `/api/clients/${CLIENT_DOMAIN}`, {
              contactEmail: "receipts+acct_15ypnsjamnyvovfn@stripe.com",
            });
            check("PATCH refuses a vendor/receipt legacy contactEmail", () => {
              assert.equal(patchLegacy.status, 400);
              assert.equal(patchLegacy.json?.code, "VENDOR_IDENTIFIER_REFUSED");
            });

            // Create path: refused BEFORE any write (products valid so the
            // vendor check — which sits after product validation — is reached).
            const { CANONICAL_PRODUCTS } = await import("../server/utils/productResolution");
            const createVendor = await call("POST", "/api/clients", {
              firmName: "Task4790 Vendor Refusal Firm",
              products: [CANONICAL_PRODUCTS[0]],
              emailDomains: ["tabs3.com"],
            });
            check("POST /api/clients refuses vendor trusted domains at create", () => {
              assert.equal(createVendor.status, 400, JSON.stringify(createVendor.json).slice(0, 300));
              assert.equal(createVendor.json?.code, "VENDOR_IDENTIFIER_REFUSED");
            });
            const createdCount = (await db.execute(sql`
              SELECT COUNT(*)::int AS n FROM clients WHERE firm_name = 'Task4790 Vendor Refusal Firm'
            `)).rows[0] as any;
            check("refused create wrote nothing", () => assert.equal(createdCount.n, 0));

            // Contact CRUD: receipt-style sender on a NON-vendor domain is
            // refused too (policy is about the sender shape, not just domain).
            const contactReceipt = await call("POST", `/api/clients/${CLIENT_DOMAIN}/contacts`, {
              name: "Billing Robot",
              emails: ["receipts@some-random-firm.com"],
            });
            check("POST contacts refuses a receipt-style sender on a NON-vendor domain", () => {
              assert.equal(contactReceipt.status, 400, JSON.stringify(contactReceipt.json).slice(0, 300));
              assert.equal(contactReceipt.json?.code, "VENDOR_IDENTIFIER_REFUSED");
            });

            const contactVendor = await call("POST", `/api/clients/${CLIENT_DOMAIN}/contacts`, {
              name: "Replit Robot",
              emails: ["contact@mail.replit.com"],
            });
            check("POST contacts refuses a vendor-domain email", () => {
              assert.equal(contactVendor.status, 400);
              assert.equal(contactVendor.json?.code, "VENDOR_IDENTIFIER_REFUSED");
            });

            // False-positive guard: a legit human contact saves…
            const contactOk = await call("POST", `/api/clients/${CLIENT_DOMAIN}/contacts`, {
              name: "Real Person",
              emails: ["real.person@acme-law.com"],
            });
            check("POST contacts still accepts a legit human email", () => {
              assert.ok(
                contactOk.status === 200 || contactOk.status === 201,
                `status=${contactOk.status} ${JSON.stringify(contactOk.json).slice(0, 200)}`,
              );
            });

            // …and updating it with a vendor address is refused, leaving the row clean.
            const contactId = contactOk.json?.id;
            const putVendor = await call("PUT", `/api/clients/${CLIENT_DOMAIN}/contacts/${contactId}`, {
              emails: ["real.person@acme-law.com", "billing@tabs3.com"],
            });
            check("PUT contacts refuses adding a vendor email on update", () => {
              assert.equal(putVendor.status, 400, JSON.stringify(putVendor.json).slice(0, 300));
              assert.equal(putVendor.json?.code, "VENDOR_IDENTIFIER_REFUSED");
            });
            const contactEmails = (await db.execute(sql`
              SELECT emails FROM client_contacts WHERE id = ${contactId}
            `)).rows[0] as any;
            check("vendor email never landed on the contact row", () => {
              assert.ok(
                Array.isArray(contactEmails?.emails) &&
                  !contactEmails.emails.some((e: string) => e.includes("tabs3.com")),
                JSON.stringify(contactEmails?.emails),
              );
            });
          } finally {
            await new Promise<void>((resolve) => crud.server.close(() => resolve()));
          }
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        invalidateHardMatchIndexes();
        __test_resetReconciledUsers();
      }
    },
    { tables: TABLES, pinGetDbForCrossAsync: true },
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .then(() => {
    global.fetch = originalFetch;
  })
  .catch((err) => {
    global.fetch = originalFetch;
    console.error("Test runner failed:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
