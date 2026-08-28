/* test-registration
{
  "name": "Import write policy (Task #755)",
  "scanPaths": [
    "server/routes/heatmap.ts",
    "server/routes/integrations/unmatched.ts",
    "server/services/applyHandlers.ts",
    "server/services/localDominanceSyncWorker.ts",
    "server/services/semrushInventorySync.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Regression tests for the canonical Import Write Policy (Task #755).
 *
 * Covers the four covered surfaces (pdf_import, front_enrichment,
 * semrush_inventory, matcher) and the cleanup-script planners. No DB or
 * network I/O — these are pure-logic tests so they run fast in CI.
 */

// Ensure the Clerk per-request test seam is active for bare repros too.
process.env.NODE_ENV = process.env.NODE_ENV || "test";

import {
  evaluateImportWrite,
  canImportWrite,
  buildImportedSectionNoDataFlags,
  type ImportWriteOutcome,
} from "../server/services/importWritePolicy";
import {
  ENTRY_TRACKED_IMPORT_METRICS,
  importMetricNotFound,
} from "../shared/importMetricPresence";
import {
  planSemrushGhosts,
  planAutoDiscoveredContactGhosts,
  type SemrushGhostRow,
  type ContactGhostRow,
} from "../scripts/cleanup-import-ghosts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

let failed = 0;
async function run(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n    ${(e as Error).message}`);
    failed++;
  }
}

console.log("\n=== Import Write Policy ===");

await run("update of existing entity is allowed for non-strict surfaces only", () => {
  for (const surface of ["front_enrichment", "front_apply", "semrush_inventory", "local_dominance_sync"] as const) {
    const o = evaluateImportWrite(surface, "client_field", "update", { entityExists: true });
    assert(o.decision === "allow_update_existing", `${surface}: expected allow_update_existing, got ${o.decision}`);
    assert(canImportWrite(o), `${surface}: canImportWrite should be true`);
    assert(!o.blocked, `${surface}: blocked should be false`);
  }
});

await run("update of non-existent entity is flagged as a warning, not blocked-fatal", () => {
  const o = evaluateImportWrite("pdf_import", "client_field", "update", { entityExists: false });
  assert(o.decision === "flag_warning", `expected flag_warning, got ${o.decision}`);
  assert(o.blocked, `flag_warning must block the write`);
  assert(o.warning && o.warning.includes("[ImportWritePolicy]"), `warning text expected`);
});

await run("pdf_import is blocked from updating authoritative client_field even when entity exists", () => {
  const o = evaluateImportWrite("pdf_import", "client_field", "update", { entityExists: true, candidateLabel: "averageCaseValue" });
  assert(o.decision === "flag_warning", `expected flag_warning, got ${o.decision}`);
  assert(o.blocked, `pdf client_field update must be blocked`);
});

await run("matcher is blocked from updating authoritative entities", () => {
  const o = evaluateImportWrite("matcher", "client_contact", "update", { entityExists: true });
  assert(o.decision === "reject_write", `expected reject_write, got ${o.decision}`);
  assert(o.blocked, `matcher update must be blocked`);
});

await run("matcher surface is hard-blocked from creating any authoritative entity", () => {
  for (const kind of ["client", "client_contact", "client_location", "product", "location_mapping"] as const) {
    const o = evaluateImportWrite("matcher", kind, "create", { entityExists: false });
    assert(o.decision === "reject_write", `matcher/${kind}: expected reject_write, got ${o.decision}`);
    assert(o.blocked, `matcher/${kind}: should be blocked`);
    assert(!canImportWrite(o), `matcher/${kind}: canImportWrite should be false`);
  }
});

await run("front enrichment routes contact creation to review suggestion", () => {
  const o = evaluateImportWrite("front_enrichment", "client_contact", "create", {
    entityExists: false,
    candidateLabel: "alice@example.com",
  });
  assert(o.decision === "allow_review_suggestion", `expected allow_review_suggestion, got ${o.decision}`);
  assert(!o.blocked, `review_suggestion is not a hard block — caller should write a suggestion row`);
});

await run("front enrichment refuses non-contact authoritative creates", () => {
  const o = evaluateImportWrite("front_enrichment", "client_location", "create", { entityExists: false });
  assert(o.decision === "flag_warning", `expected flag_warning, got ${o.decision}`);
  assert(o.blocked, `should block non-contact creates`);
});

await run("semrush inventory routes unconfigured location_mapping creates to suggestion queue (never authoritative)", () => {
  const o = evaluateImportWrite("semrush_inventory", "location_mapping", "create", { entityExists: false });
  assert(o.decision === "allow_review_suggestion", `expected allow_review_suggestion, got ${o.decision}`);
  assert(!o.blocked, `review-suggestion routing should not block (it queues instead)`);
});

await run("semrush inventory allows update for already-configured mapping", () => {
  const o = evaluateImportWrite("semrush_inventory", "location_mapping", "update", { entityExists: true });
  assert(o.decision === "allow_update_existing", `expected allow_update_existing, got ${o.decision}`);
  assert(!o.blocked, `update of existing mapping must not be blocked`);
});

await run("pdf import drops unknown product/category", () => {
  const a = evaluateImportWrite("pdf_import", "product", "create", { entityExists: false });
  assert(a.decision === "drop_unknown", `product: expected drop_unknown`);
  const b = evaluateImportWrite("pdf_import", "category", "create", { entityExists: false });
  assert(b.decision === "drop_unknown", `category: expected drop_unknown`);
});

await run("pdf import flags warnings for client_field create attempts", () => {
  const o = evaluateImportWrite("pdf_import", "client_field", "create", { entityExists: false });
  assert(o.decision === "flag_warning", `expected flag_warning`);
  assert(o.blocked, `must block authoritative client_field create`);
});

await run("raw_ingest creation is always allowed", () => {
  for (const surface of ["pdf_import", "front_enrichment", "semrush_inventory", "matcher"] as const) {
    const o = evaluateImportWrite(surface, "raw_ingest", "create");
    assert(o.decision === "allow_raw_ingest_create", `${surface}/raw_ingest: expected allow_raw_ingest_create`);
  }
});

console.log("\n=== Cleanup planner ===");

await run("planSemrushGhosts returns only mappings whose locationId is not configured", () => {
  const mappings: SemrushGhostRow[] = [
    { id: "m1", clientId: "c1", locationId: "loc-keep", semrushCampaignId: "x", semrushCampaignName: null },
    { id: "m2", clientId: "c1", locationId: "loc-ghost", semrushCampaignId: "y", semrushCampaignName: "Y" },
    { id: "m3", clientId: "c2", locationId: "loc-other", semrushCampaignId: "z", semrushCampaignName: null },
  ];
  const ghosts = planSemrushGhosts(mappings, new Set(["loc-keep"]));
  assert(ghosts.length === 2, `expected 2 ghosts, got ${ghosts.length}`);
  assert(ghosts.every(g => g.locationId !== "loc-keep"), `should not keep configured`);
});

await run("planAutoDiscoveredContactGhosts only flags non-primary auto-discovered contacts", () => {
  const contacts: ContactGhostRow[] = [
    { id: "c1", clientId: "x", name: "Auto-discovered Contact", emails: ["a@b"], isPrimary: false },
    { id: "c2", clientId: "x", name: "Real Person", emails: ["r@b"], isPrimary: false },
    { id: "c3", clientId: "x", name: "Auto-discovered Contact", emails: [], isPrimary: true },
    { id: "c4", clientId: "x", name: "auto-discovered contact", emails: ["c@b"], isPrimary: false },
  ];
  const ghosts = planAutoDiscoveredContactGhosts(contacts);
  assert(ghosts.length === 2, `expected 2 ghosts (case-insensitive), got ${ghosts.length}`);
  assert(ghosts.find(g => g.id === "c1") && ghosts.find(g => g.id === "c4"), `expected c1 and c4`);
});

console.log("\n=== Manual-match contact promotion (default-NO) ===");

const { promoteEmailsToClientContact } = await import("../server/services/clientContactPromotion");

await run("returns no_opt_in when explicitOptIn is false", async () => {
  const r = await promoteEmailsToClientContact({
    clientId: "c1", emails: ["alice@example.com"], explicitOptIn: false,
  });
  assert(r.added === 0, `expected 0 added, got ${r.added}`);
  assert(r.contactId === null, `expected null contactId`);
  assert(r.reason === "no_opt_in", `expected reason no_opt_in, got ${r.reason}`);
});

await run("returns no_opt_in when explicitOptIn omitted entirely", async () => {
  const r = await promoteEmailsToClientContact({
    clientId: "c1", emails: ["alice@example.com"],
  });
  assert(r.added === 0, `expected 0 added`);
  assert(r.reason === "no_opt_in", `expected reason no_opt_in, got ${r.reason}`);
});

await run("returns no_emails_selected when emails list is empty", async () => {
  const r = await promoteEmailsToClientContact({
    clientId: "c1", emails: [], explicitOptIn: true,
  });
  assert(r.added === 0, `expected 0 added`);
  assert(r.reason === "no_emails_selected", `got ${r.reason}`);
});

await run("Front assignUnmatchedEmail signature returns the new contact opt-in fields", async () => {
  const mod = await import("../server/services/frontIntegration");
  const fnSrc = (mod.assignUnmatchedEmail as Function).toString();
  assert(fnSrc.includes("contactsAdded"), `assignUnmatchedEmail must return contactsAdded`);
  assert(fnSrc.includes("contactCreated"), `assignUnmatchedEmail must return contactCreated`);
  assert(fnSrc.includes("addContactEmails"), `assignUnmatchedEmail must accept addContactEmails`);
});

await run("All three assign-route branches (front/zoom/slack) return contactsAdded + contactCreated", async () => {
  const fs = await import("fs");
  const src = fs.readFileSync("server/routes/integrations/unmatched.ts", "utf8");
  const assignBlock = src.split("/api/integrations/unmatched/:source/:id/assign")[1] || "";
  // Truncate to the body of this single route to avoid bleeding into other handlers.
  const routeBody = assignBlock.slice(0, assignBlock.indexOf("/dismiss"));
  const occurrences = (routeBody.match(/contactsAdded:/g) || []).length;
  assert(occurrences >= 3, `expected contactsAdded in all 3 source branches, found ${occurrences}`);
  const created = (routeBody.match(/contactCreated:/g) || []).length;
  assert(created >= 3, `expected contactCreated in all 3 source branches, found ${created}`);
  assert(routeBody.includes("addContactEmails"), `assign route must read addContactEmails from body`);
});

await run("policy: semrush_inventory + location_mapping + create — configured links directly, unconfigured queues (Task #920A)", () => {
  // Task #920A corrected the over-strict #755 rule: a `location_mapping` row
  // is a *link* between two already-authoritative entities, not a new
  // authoritative entity. Configured (clientId, locationId) pairs are
  // therefore allowed to write the link row directly via
  // `allow_link_existing`. Unconfigured pairs still go to review.
  const configured = evaluateImportWrite("semrush_inventory", "location_mapping", "create", { entityExists: true });
  assert(configured.decision === "allow_link_existing", `configured got ${configured.decision}`);
  assert(configured.blocked === false, "configured must NOT be blocked");
  const unconfigured = evaluateImportWrite("semrush_inventory", "location_mapping", "create", { entityExists: false });
  assert(unconfigured.decision === "allow_review_suggestion", `unconfigured got ${unconfigured.decision}`);
  assert(unconfigured.blocked === false, "review_suggestion is not a hard block");
});

await run("applyHandlers SEMrush branch routes through the canonical write helper (Task #920C)", async () => {
  const fs = await import("fs");
  const src = fs.readFileSync("server/services/applyHandlers.ts", "utf8");
  const block = src.split("if (data.locationCampaigns")[1] || "";
  const handlerBody = block.slice(0, 4000);
  assert(handlerBody.includes("applySemrushLocationMapping"),
    "must route candidates through the canonical write helper (Task #920B/920C)");
  // The helper itself owns the insert; the apply branch must not bypass it
  // with a direct `db.insert(semrushLocationCampaigns)`.
  assert(!/db\.insert\(semrushLocationCampaigns\)/.test(handlerBody)
      && !/workerDb\.insert\(semrushLocationCampaigns\)/.test(handlerBody),
    "must NOT insert directly into semrushLocationCampaigns from inventory apply");
});

await run("heatmap auto-match routes through the canonical write helper (Task #920C)", async () => {
  const fs = await import("fs");
  const src = fs.readFileSync("server/routes/heatmap.ts", "utf8");
  const start = src.indexOf("/auto-match");
  assert(start > 0, "could not locate /auto-match route");
  const after = src.slice(start);
  const end = after.indexOf("\n  app.");
  const handlerBody = end > 0 ? after.slice(0, end) : after;
  // Task #920E: the route delegates to applyAutoMatchCandidates, which is
  // a thin wrapper that drives every candidate through the canonical
  // applySemrushLocationMapping helper. Either name in the handler body
  // satisfies the "routes through the helper" invariant.
  assert(
    handlerBody.includes("applyAutoMatchCandidates")
      || handlerBody.includes("applySemrushLocationMapping"),
    "auto-match must route candidates through the canonical write helper",
  );
  assert(!/db\.insert\(semrushLocationCampaigns\)/.test(handlerBody),
    "auto-match must NOT insert directly into semrushLocationCampaigns");
});

await run("matcher/local-dominance/semrush sync workers contain no inserts into authoritative client tables", async () => {
  const fs = await import("fs");
  const files = [
    "server/services/localDominanceSyncWorker.ts",
    "server/services/semrushInventorySync.ts",
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const tbl of ["clients", "clientLocations", "clientContacts", "semrushLocationCampaigns"]) {
      const re = new RegExp(`\\.insert\\(${tbl}\\)`);
      assert(!re.test(src), `${f} must NOT insert into ${tbl}`);
    }
  }
});

await run("DB-backed: createImportEntitySuggestion persists row and listImportEntitySuggestions returns it (does NOT create client_contact)", async () => {
  if (!process.env.DATABASE_URL) {
    console.log("    (skipped — no DATABASE_URL)");
    return;
  }
  const { getDb } = await import("../server/db");
  const { clients, clientContacts } = await import("../shared/schema");
  const { eq } = await import("drizzle-orm");
  const storage = await import("../server/storage/clientStorage");
  const db = getDb();
  const [client] = await db.insert(clients).values({
    name: `__test_iws_${Date.now()}`,
    firmName: `__test_iws_${Date.now()}`,
  }).returning();
  try {
    const before = await db.select().from(clientContacts).where(eq(clientContacts.clientId, client.id));
    const suggestion = await storage.createImportEntitySuggestion({
      clientId: client.id,
      entityKind: "client_contact",
      surface: "front_enrichment",
      candidate: { name: "Auto Test", emails: ["auto@test.example"], phones: [] },
      sourceRef: { conversationId: "test_conv_1" },
      reason: "regression test",
    });
    assert(!!suggestion?.id, "expected an id back from createImportEntitySuggestion");
    assert(suggestion.status === "pending", `expected pending status, got ${suggestion.status}`);
    const list = await storage.listImportEntitySuggestions({ clientId: client.id, status: "pending" });
    assert(list.some(s => s.id === suggestion.id), "expected new suggestion to be returned by list");
    const after = await db.select().from(clientContacts).where(eq(clientContacts.clientId, client.id));
    assert(after.length === before.length, `client_contacts must NOT be auto-created (before=${before.length}, after=${after.length})`);
  } finally {
    await db.delete(clients).where(eq(clients.id, client.id));
  }
});

console.log("\n=== Import-suggestion review routes (Task #756) ===");

if (!process.env.DATABASE_URL) {
  console.log("  (skipped — no DATABASE_URL)");
} else {
  const express = (await import("express")).default;
  const http = await import("http");
  const { sql } = await import("drizzle-orm");
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../server/db");
  const { clients, clientContacts, importEntitySuggestions, users } = await import("../shared/schema");
  const storageMod = await import("../server/storage/clientStorage");
  const { registerImportSuggestionRoutes } = await import("../server/routes/importSuggestions");

  const db = getDb();
  const REVIEWER_ID = `__test_iws_reviewer_${Date.now()}`;

  // Seed reviewer user with account_manager role.
  await db.execute(sql`
    INSERT INTO users (id, role, first_name, last_name)
    VALUES (${REVIEWER_ID}, 'account_manager', 'Task1225', 'Reviewer')
    ON CONFLICT (id) DO UPDATE SET role = 'account_manager'
  `);

  // Build minimal Express app with the Clerk per-request test seam
  // (server/middlewares/requireAuth.ts): a string authenticates as that user
  // id. The seeded public-schema users row satisfies requireAuth's lookup and
  // the requireAccountManager DB role check; requireAuth populates the legacy
  // req.user.claims.sub shape itself.
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.__test_clerkUserId = REVIEWER_ID;
    next();
  });
  registerImportSuggestionRoutes(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function post(path: string, body: unknown = {}): Promise<{ status: number; body: any }> {
    const r = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed };
  }

  let createdClientId: string | null = null;
  try {
    const [client] = await db.insert(clients).values({
      name: `__test_iws_routes_${Date.now()}`,
      firmName: `__test_iws_routes_${Date.now()}`,
    }).returning();
    createdClientId = client.id;

    await run("approve on pending client_contact suggestion creates contact and stamps reviewer fields", async () => {
      const sugg = await storageMod.createImportEntitySuggestion({
        clientId: client.id,
        entityKind: "client_contact",
        surface: "front_enrichment",
        candidate: { name: "Promo Test", emails: ["promo@example.test"], phones: [] },
        reason: "regression test approve",
      });

      const before = Date.now();
      const r = await post(`/api/import-suggestions/${sugg.id}/approve`, {});
      assert(r.status === 200, `approve expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
      const updated = r.body.suggestion;
      assert(updated.status === "promoted", `expected status promoted, got ${updated.status}`);
      assert(updated.reviewedByUserId === REVIEWER_ID, `expected reviewedByUserId=${REVIEWER_ID}, got ${updated.reviewedByUserId}`);
      assert(updated.reviewedAt && new Date(updated.reviewedAt).getTime() >= before - 1000,
        `expected reviewedAt ~ now, got ${updated.reviewedAt}`);
      assert(updated.promotedEntityId, `expected promotedEntityId, got ${updated.promotedEntityId}`);

      const contactsRows = await db.select().from(clientContacts)
        .where(eq(clientContacts.id, updated.promotedEntityId));
      assert(contactsRows.length === 1, `expected client_contacts row at promotedEntityId`);
      const emails = (contactsRows[0].emails as string[] | null) ?? [];
      assert(emails.includes("promo@example.test"),
        `expected promoted email on contact, got ${JSON.stringify(emails)}`);

      // Re-approving an already-promoted row must 409 and not double-write.
      const r2 = await post(`/api/import-suggestions/${sugg.id}/approve`, {});
      assert(r2.status === 409, `re-approve expected 409, got ${r2.status} body=${JSON.stringify(r2.body)}`);
      const after = await storageMod.getImportEntitySuggestion(sugg.id);
      assert(after?.status === "promoted", `status must remain promoted, got ${after?.status}`);
      assert(after?.reviewedAt?.toISOString() === new Date(updated.reviewedAt).toISOString(),
        `reviewedAt must NOT be re-stamped on second approve`);
      assert(after?.promotedEntityId === updated.promotedEntityId,
        `promotedEntityId must NOT change on second approve`);
    });

    await run("dismiss on pending suggestion stamps status=dismissed + reviewer fields; re-dismiss returns 409", async () => {
      const sugg = await storageMod.createImportEntitySuggestion({
        clientId: client.id,
        entityKind: "client_contact",
        surface: "front_enrichment",
        candidate: { name: "Dismiss Test", emails: ["dismiss@example.test"], phones: [] },
        reason: "regression test dismiss",
      });

      const before = Date.now();
      const r = await post(`/api/import-suggestions/${sugg.id}/dismiss`, {});
      assert(r.status === 200, `dismiss expected 200, got ${r.status} body=${JSON.stringify(r.body)}`);
      const updated = r.body.suggestion;
      assert(updated.status === "dismissed", `expected status dismissed, got ${updated.status}`);
      assert(updated.reviewedByUserId === REVIEWER_ID, `expected reviewedByUserId=${REVIEWER_ID}, got ${updated.reviewedByUserId}`);
      assert(updated.reviewedAt && new Date(updated.reviewedAt).getTime() >= before - 1000,
        `expected reviewedAt ~ now, got ${updated.reviewedAt}`);
      assert(!updated.promotedEntityId, `dismiss must NOT set promotedEntityId`);

      // Re-dismissing must 409 and not re-stamp reviewer fields.
      const r2 = await post(`/api/import-suggestions/${sugg.id}/dismiss`, {});
      assert(r2.status === 409, `re-dismiss expected 409, got ${r2.status} body=${JSON.stringify(r2.body)}`);
      const after = await storageMod.getImportEntitySuggestion(sugg.id);
      assert(after?.status === "dismissed", `status must remain dismissed, got ${after?.status}`);
      assert(after?.reviewedAt?.toISOString() === new Date(updated.reviewedAt).toISOString(),
        `reviewedAt must NOT be re-stamped on second dismiss`);
    });

    await run("dismiss on already-promoted row returns 409 and does not mutate reviewer/promoted fields", async () => {
      const sugg = await storageMod.createImportEntitySuggestion({
        clientId: client.id,
        entityKind: "client_contact",
        surface: "front_enrichment",
        candidate: { name: "Dismiss-After-Promote", emails: ["dap@example.test"], phones: [] },
        reason: "regression test dismiss-after-promote",
      });
      const a = await post(`/api/import-suggestions/${sugg.id}/approve`, {});
      assert(a.status === 200, `setup approve expected 200, got ${a.status}`);
      const promoted = a.body.suggestion;

      const r = await post(`/api/import-suggestions/${sugg.id}/dismiss`, {});
      assert(r.status === 409, `dismiss-after-promote expected 409, got ${r.status}`);
      const after = await storageMod.getImportEntitySuggestion(sugg.id);
      assert(after?.status === "promoted", `status must remain promoted, got ${after?.status}`);
      assert(after?.promotedEntityId === promoted.promotedEntityId,
        `promotedEntityId must NOT change on rejected dismiss`);
      assert(after?.reviewedAt?.toISOString() === new Date(promoted.reviewedAt).toISOString(),
        `reviewedAt must NOT be re-stamped on rejected dismiss`);
      assert(after?.reviewedByUserId === promoted.reviewedByUserId,
        `reviewedByUserId must NOT change on rejected dismiss`);
    });

    await run("approve on already-dismissed row returns 409 and does not flip status", async () => {
      const sugg = await storageMod.createImportEntitySuggestion({
        clientId: client.id,
        entityKind: "client_contact",
        surface: "front_enrichment",
        candidate: { name: "Cross Test", emails: ["cross@example.test"], phones: [] },
        reason: "regression test cross-state",
      });
      const d = await post(`/api/import-suggestions/${sugg.id}/dismiss`, {});
      assert(d.status === 200, `setup dismiss expected 200, got ${d.status}`);

      const r = await post(`/api/import-suggestions/${sugg.id}/approve`, {});
      assert(r.status === 409, `approve-after-dismiss expected 409, got ${r.status}`);
      const after = await storageMod.getImportEntitySuggestion(sugg.id);
      assert(after?.status === "dismissed", `status must remain dismissed, got ${after?.status}`);
      assert(!after?.promotedEntityId, `must NOT set promotedEntityId on rejected approve`);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (createdClientId) {
      try {
        await db.delete(importEntitySuggestions).where(eq(importEntitySuggestions.clientId, createdClientId));
      } catch {}
      try {
        await db.delete(clients).where(eq(clients.id, createdClientId));
      } catch {}
    }
    try {
      await db.execute(sql`DELETE FROM users WHERE id = ${REVIEWER_ID}`);
    } catch {}
  }
}

// ── Task #3772 — imported-section No-Data flags (absent stays absent) ──

console.log("\n=== Imported section No-Data flags (Task #3772) ===");

await run("no fieldConfidence at all flags every entry-tracked metric No-Data", () => {
  for (const sectionKey of ["intake", "sales"] as const) {
    for (const fc of [undefined, null, {}] as const) {
      const flags = buildImportedSectionNoDataFlags(fc, sectionKey);
      for (const field of ENTRY_TRACKED_IMPORT_METRICS[sectionKey]) {
        assert(flags[field] === true, `${sectionKey}.${field} must be flagged when fc=${JSON.stringify(fc)}`);
      }
    }
  }
});

await run("parsed metrics stay unflagged; unparsed metrics are flagged", () => {
  const fc = {
    "intake.avgTimeToAnswer": { confidence: "high", source: "Time to Human Answer: 8.45" },
    "sales.totalCases": { confidence: "high", source: "Total Leads/Consults/Cases row" },
  };
  const intakeFlags = buildImportedSectionNoDataFlags(fc, "intake");
  assert(intakeFlags.avgTimeToAnswer === false, "parsed intake.avgTimeToAnswer must stay unflagged");
  assert(intakeFlags.totalConsults === true, "unparsed intake.totalConsults must be flagged");
  assert(intakeFlags.qualityScore === true, "unparsed intake.qualityScore must be flagged");
  const salesFlags = buildImportedSectionNoDataFlags(fc, "sales");
  assert(salesFlags.totalCases === false, "parsed sales.totalCases must stay unflagged");
  for (const field of ENTRY_TRACKED_IMPORT_METRICS.sales.filter((f) => f !== "totalCases")) {
    assert(salesFlags[field] === true, `unparsed sales.${field} must be flagged`);
  }
});

await run("a parsed ZERO (evidence present) is a real zero — never flagged", () => {
  const fc = { "intake.qualityScore": { confidence: "high", source: "Quality Score: 0" } };
  const flags = buildImportedSectionNoDataFlags(fc, "intake");
  assert(flags.qualityScore === false, "evidence-backed 0 must stay unflagged (means 'entered 0')");
});

await run("flag key sets exactly match the report form's noDataFlags shape", () => {
  const intakeFlags = buildImportedSectionNoDataFlags(undefined, "intake");
  assert(
    JSON.stringify(Object.keys(intakeFlags).sort()) ===
      JSON.stringify(["avgTimeToAnswer", "qualityScore", "totalConsults"]),
    `intake keys drifted: ${Object.keys(intakeFlags).join(",")}`,
  );
  const salesFlags = buildImportedSectionNoDataFlags(undefined, "sales");
  assert(
    JSON.stringify(Object.keys(salesFlags).sort()) ===
      JSON.stringify([
        "avgAgeOpenMatters",
        "averageCaseValue",
        "avgFollowUps",
        "dealTouchDensity",
        "noShowRate",
        "pipelineMomentumScore",
        "qualityScore",
        "totalCases",
      ].sort()),
    `sales keys drifted: ${Object.keys(salesFlags).join(",")}`,
  );
});

await run("importMetricNotFound: evidence-less zero vs evidence-backed / merged values", () => {
  const missed = { intake: { avgTimeToAnswer: 0 }, sales: { totalCases: 0 }, fieldConfidence: {} };
  assert(importMetricNotFound(missed, "intake.avgTimeToAnswer") === true, "evidence-less 0 is not-found");
  assert(importMetricNotFound(missed, "sales.totalCases") === true, "evidence-less sales 0 is not-found");
  const parsedZero = {
    intake: { avgTimeToAnswer: 0 },
    fieldConfidence: { "intake.avgTimeToAnswer": { confidence: "high", source: "Avg Time to Answer: 0" } },
  };
  assert(importMetricNotFound(parsedZero, "intake.avgTimeToAnswer") === false, "evidence-backed 0 is found");
  const merged = { intake: { totalConsults: 42 }, fieldConfidence: {} };
  assert(importMetricNotFound(merged, "intake.totalConsults") === false, "merged non-zero value is real data");
  assert(importMetricNotFound(missed, "intake.commonIssues") === false, "non-numeric keys never match");
  assert(importMetricNotFound(null, "intake.avgTimeToAnswer") === false, "null payload never matches");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exitCode = 1;
}
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
console.log("\nAll import-write-policy tests passed.");
