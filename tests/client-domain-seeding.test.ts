/* test-registration
{
  "name": "Client trusted-domain seeding derivation + apply (Task #4049)",
  "smoke": true,
  "smokeReason": "Fast fixture-scoped DB test (~2s): guards the seeding action's exclusion rails (freemail/gateway/vendor/threshold/ambiguity) — a regression here silently writes bad trusted domains onto client records.",
  "tier": "small"
}
test-registration */
// Task #4049 — `server/services/clientDomainSeeding.ts` guardrails:
//
//   Derivation sources
//     - contact emails (`client_contacts.emails` + `clients.contact_email`)
//     - HUMAN participant domains across ≥3 DISTINCT already-matched
//       conversations of the same client
//   Exclusions (each pinned here)
//     - public/free-mail incl. suffix subdomains (txt.voice.google.com)
//     - vendor-platform + company domains
//     - automated-sender contact addresses contribute nothing
//     - participant domains below the 3-conversation threshold (unless
//       contact-backed)
//     - cross-client AMBIGUITY refused: candidate claimed by two clients, and
//       candidate claimed by ANOTHER client's existing emailDomains list
//     - domains already present on the client are skipped (idempotence)
//   Apply
//     - writes merged lists through storage.updateClient, second derivation
//       reports zero additions for the same fixtures (write-through)
//
// Runs against the hermetic per-run test DB with random-suffix fixture IDs;
// all assertions are scoped to THIS test's fixture clients/domains (the shared
// run DB may contain other suites' litter — never assert absolute totals).

import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { db } from "../server/db";
import { clients, clientContacts, frontSyncEmails } from "@shared/schema";
import {
  deriveClientDomainSeedPlan,
  applyClientDomainSeedPlan,
  MIN_PARTICIPANT_MATCHED_CONVERSATIONS,
} from "../server/services/clientDomainSeeding";

const TAG = `4049s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

// Fixture domains — random-suffixed so nothing in the shared run DB collides.
const DOM_CONTACT = `malik-contact-${TAG}.com`;      // clientA contact email domain
const DOM_ROW_CONTACT = `alpha-rowmail-${TAG}.com`;  // clientA clients.contact_email domain
const DOM_PARTICIPANT = `beta-part-${TAG}.com`;      // clientB ≥3 matched convs
const DOM_BELOW = `beta-below-${TAG}.com`;           // clientB 2 matched convs (< threshold)
const DOM_AUTOMATED = `beta-noreply-${TAG}.com`;     // clientB ≥3 convs but automated senders only
const DOM_SHARED = `shared-claim-${TAG}.com`;        // contact-claimed by BOTH clientC and clientD
const DOM_EXISTING_CLAIM = `existing-claim-${TAG}.com`; // on clientF's existing list; clientE contact claims it

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
  }
}

async function seedMatchedConv(conversationId: string, clientId: string, senderEmail: string): Promise<void> {
  await db.insert(frontSyncEmails).values({
    conversationId,
    subject: `Matched conv ${conversationId}`,
    snippet: "seed",
    participantsJson: [
      { name: "Sender", email: senderEmail, role: "from" },
      { name: "Ops", email: "ops@nobullmarketing.com", role: "to" },
    ] as any,
    matchStatus: "auto_matched",
    matchedClientId: clientId,
    matchConfidence: 1,
    matchReason: "[seed] fixture matched row",
    pipelineState: "applied",
    lastMessageAt: new Date(),
  } as any);
}

async function run(): Promise<void> {
  const clientIds: string[] = [];
  const convIds: string[] = [];

  const mkClient = async (firmName: string, extra: Partial<typeof clients.$inferInsert> = {}) => {
    const [row] = await db
      .insert(clients)
      .values({ firmName: `${firmName} ${TAG}`, isArchived: false, ...extra } as any)
      .returning();
    clientIds.push(row.id);
    return row;
  };

  try {
    // clientA — contact-derived domains from BOTH contact sources; plus a
    // freemail + gateway + automated contact that must contribute nothing.
    const clientA = await mkClient("Seed Alpha Firm", { contactEmail: `owner@${DOM_ROW_CONTACT}` });
    await db.insert(clientContacts).values({
      clientId: clientA.id,
      name: "Alpha Contact",
      emails: [
        `ricky@${DOM_CONTACT}`,
        `personal@gmail.com`,                       // freemail — silently dropped
        `1555@txt.voice.google.com`,                // public gateway subdomain — dropped
        `noreply@should-not-seed-${TAG}.com`,       // automated contact — contributes nothing
      ],
    } as any);

    // clientB — participant-derived: DOM_PARTICIPANT on 3 distinct matched
    // convs (human), DOM_BELOW on 2 (below threshold), DOM_AUTOMATED on 3 but
    // automated senders only.
    const clientB = await mkClient("Seed Beta Firm");
    for (let i = 0; i < MIN_PARTICIPANT_MATCHED_CONVERSATIONS; i++) {
      const conv = `conv-${TAG}-part-${i}`;
      convIds.push(conv);
      await seedMatchedConv(conv, clientB.id, `human${i}@${DOM_PARTICIPANT}`);
    }
    for (let i = 0; i < MIN_PARTICIPANT_MATCHED_CONVERSATIONS - 1; i++) {
      const conv = `conv-${TAG}-below-${i}`;
      convIds.push(conv);
      await seedMatchedConv(conv, clientB.id, `human${i}@${DOM_BELOW}`);
    }
    for (let i = 0; i < MIN_PARTICIPANT_MATCHED_CONVERSATIONS; i++) {
      const conv = `conv-${TAG}-auto-${i}`;
      convIds.push(conv);
      await seedMatchedConv(conv, clientB.id, `noreply@${DOM_AUTOMATED}`);
    }

    // clientC + clientD — both contact-claim DOM_SHARED → ambiguity refusal.
    const clientC = await mkClient("Seed Gamma Firm");
    const clientD = await mkClient("Seed Delta Firm");
    for (const c of [clientC, clientD]) {
      await db.insert(clientContacts).values({
        clientId: c.id,
        name: "Shared Contact",
        emails: [`someone@${DOM_SHARED}`],
      } as any);
    }

    // clientE contact-claims a domain that already sits on clientF's existing
    // emailDomains list → refused (existing lists join the claim set).
    const clientF = await mkClient("Seed Zeta Firm", { emailDomains: [DOM_EXISTING_CLAIM] });
    const clientE = await mkClient("Seed Epsilon Firm");
    await db.insert(clientContacts).values({
      clientId: clientE.id,
      name: "Epsilon Contact",
      emails: [`lawyer@${DOM_EXISTING_CLAIM}`],
    } as any);

    // clientG — archived; its contact domain must not appear anywhere.
    const DOM_ARCHIVED = `archived-${TAG}.com`;
    const clientG = await mkClient("Seed Archived Firm", {
      isArchived: true,
      contactEmail: `x@${DOM_ARCHIVED}`,
    });

    // ── Derive ──────────────────────────────────────────────────────────────
    const plan = await deriveClientDomainSeedPlan();
    const entryFor = (clientId: string) => plan.entries.find((e) => e.clientId === clientId);
    const additionsFor = (clientId: string) =>
      (entryFor(clientId)?.additions ?? []).map((a) => a.domain);

    check("clientA gains both contact-source domains", () => {
      const doms = additionsFor(clientA.id);
      assert.ok(doms.includes(DOM_CONTACT), `missing ${DOM_CONTACT} in ${JSON.stringify(doms)}`);
      assert.ok(doms.includes(DOM_ROW_CONTACT), `missing ${DOM_ROW_CONTACT} in ${JSON.stringify(doms)}`);
    });
    check("freemail + gateway subdomain contacts contribute nothing", () => {
      const doms = additionsFor(clientA.id);
      assert.ok(!doms.includes("gmail.com"), "gmail.com must never seed");
      assert.ok(!doms.includes("txt.voice.google.com"), "gateway subdomain must never seed");
    });
    check("automated contact address contributes nothing", () => {
      const doms = additionsFor(clientA.id);
      assert.ok(
        !doms.includes(`should-not-seed-${TAG}.com`),
        "noreply@ contact must not derive a trusted domain",
      );
    });
    check("clientB gains the ≥3-conversation human participant domain", () => {
      const doms = additionsFor(clientB.id);
      assert.ok(doms.includes(DOM_PARTICIPANT), `missing ${DOM_PARTICIPANT} in ${JSON.stringify(doms)}`);
      const add = entryFor(clientB.id)!.additions.find((a) => a.domain === DOM_PARTICIPANT)!;
      assert.ok(
        add.matchedConversations >= MIN_PARTICIPANT_MATCHED_CONVERSATIONS,
        `evidence count ${add.matchedConversations}`,
      );
    });
    check("below-threshold participant domain is excluded (and counted)", () => {
      assert.ok(!additionsFor(clientB.id).includes(DOM_BELOW), `${DOM_BELOW} must not seed`);
      assert.ok(plan.excluded.belowThreshold >= 1, "belowThreshold counter must reflect the drop");
    });
    check("automated-only participant domain is excluded (and counted)", () => {
      assert.ok(!additionsFor(clientB.id).includes(DOM_AUTOMATED), `${DOM_AUTOMATED} must not seed`);
      assert.ok(plan.excluded.automatedOnly >= 1, "automatedOnly counter must reflect the drop");
    });
    check("two-client contact claim is refused as ambiguous for BOTH", () => {
      assert.ok(!additionsFor(clientC.id).includes(DOM_SHARED));
      assert.ok(!additionsFor(clientD.id).includes(DOM_SHARED));
      const amb = plan.excluded.ambiguous.find((a) => a.domain === DOM_SHARED);
      assert.ok(amb, `${DOM_SHARED} must be reported ambiguous`);
      assert.equal(amb!.firmNames.length, 2, JSON.stringify(amb));
    });
    check("claim against another client's EXISTING list is refused", () => {
      assert.ok(!additionsFor(clientE.id).includes(DOM_EXISTING_CLAIM));
      const amb = plan.excluded.ambiguous.find((a) => a.domain === DOM_EXISTING_CLAIM);
      assert.ok(amb, `${DOM_EXISTING_CLAIM} must be reported ambiguous (existing-list claim)`);
    });
    check("archived client derives nothing", () => {
      assert.equal(entryFor(clientG.id), undefined, "archived client must have no plan entry");
    });

    // ── Apply (write-through: re-derives fresh) ────────────────────────────
    const result = await applyClientDomainSeedPlan();
    check("apply reports our fixture clients among the updates", () => {
      assert.ok(result.clientsUpdated >= 2, `clientsUpdated=${result.clientsUpdated}`);
      assert.ok(result.domainsAdded >= 3, `domainsAdded=${result.domainsAdded}`);
    });

    const [aAfter] = await db.select().from(clients).where(inArray(clients.id, [clientA.id]));
    const [bAfter] = await db.select().from(clients).where(inArray(clients.id, [clientB.id]));
    check("clientA record now carries both contact domains", () => {
      assert.ok((aAfter.emailDomains ?? []).includes(DOM_CONTACT), JSON.stringify(aAfter.emailDomains));
      assert.ok((aAfter.emailDomains ?? []).includes(DOM_ROW_CONTACT), JSON.stringify(aAfter.emailDomains));
    });
    check("clientB record now carries the participant domain and nothing excluded", () => {
      const doms = bAfter.emailDomains ?? [];
      assert.ok(doms.includes(DOM_PARTICIPANT), JSON.stringify(doms));
      assert.ok(!doms.includes(DOM_BELOW));
      assert.ok(!doms.includes(DOM_AUTOMATED));
    });

    // ── Idempotence: a fresh derivation finds nothing new for our fixtures ──
    const plan2 = await deriveClientDomainSeedPlan();
    check("second derivation adds nothing for the fixture clients", () => {
      for (const id of [clientA.id, clientB.id]) {
        const e = plan2.entries.find((x) => x.clientId === id);
        assert.equal(e, undefined, `client ${id} must have no further additions: ${JSON.stringify(e)}`);
      }
    });
    check("ambiguous refusals persist across derivations (never auto-resolved)", () => {
      assert.ok(plan2.excluded.ambiguous.some((a) => a.domain === DOM_SHARED));
    });
  } finally {
    if (convIds.length > 0) {
      await db.delete(frontSyncEmails).where(inArray(frontSyncEmails.conversationId, convIds));
    }
    if (clientIds.length > 0) {
      await db.delete(clientContacts).where(inArray(clientContacts.clientId, clientIds));
      await db.delete(clients).where(inArray(clients.id, clientIds));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error("client-domain-seeding test crashed:", err);
    process.exit(1);
  },
);
