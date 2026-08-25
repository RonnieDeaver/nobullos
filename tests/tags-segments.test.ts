/* test-registration
{
  "name": "Tags & segments engine (Task #4329)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4329: tags & segments engine. Proves the contracts every later CRM feature (scoring, audiences) hangs off: the shared criteria evaluator's determinism rules (missing/null fails everything but is_not_set, case-insensitive strings, empty set matches nothing), the registry↔extractor key lockstep the engine header promises, rule application converging on write AND via the reconciliation sweep without ever touching manual rows (source=manual survives, source=rule heals both drift directions, orphaned segment members reaped), the 409 rule-row protection on the manual remove route, team_lead gating on definition CRUD, and record-level access on manual tagging (sales owner-only, demo client hidden from non-CEO). A drift here silently mis-tags or mis-segments every record in the CRM.",
  "tier": "small"
}
test-registration */
// future-date-literal-reviewed: expected_close_date 2026-09-01 is compared only against the literal 2026-08-31 bound in the after/before operator checks (literal-vs-literal); no real-clock comparison — it cannot rot.
/**
 * Task #4329 — Tags & segments engine coverage.
 *
 * Runs the REAL registerTagsSegmentsRoutes (+ registerDealsRoutes for the
 * on-write hook path) against a real Express app with an injected
 * passport-shaped session (switchable acting user, following
 * tests/deals-routes.test.ts) and the real db (hermetic per-run DB under
 * `npm test`).
 *
 *   1.  Evaluator units — operators per type, AND/OR combinators,
 *       missing-value semantics, empty-set-matches-nothing, case folding.
 *   2.  Registry↔extractor lockstep — every criteriaFieldRegistry key is
 *       emitted by the matching server extraction helper.
 *   3.  validateCriteriaSet — unknown field, illegal operator-for-type,
 *       missing value operand, entity mismatch all reject.
 *   4.  Definition CRUD gating — tag/segment create is team_lead-gated
 *       (AM 403); duplicate name 409; invalid criteria 400.
 *   5.  Rule tags on record write — creating a matching deal through the
 *       REAL deals route applies the rule tag (source=rule); PATCHing it
 *       below the threshold removes it; the manual tag survives both.
 *   6.  Manual apply/remove — apply is idempotent, remove returns the
 *       updated list, removing a rule-sourced row answers 409, and the
 *       row survives (engine-owned).
 *   7.  Record access — sales can tag only owned records (403 otherwise),
 *       demo clients 404 for non-CEO actors.
 *   8.  Segments — create evaluates synchronously (memberCount + members
 *       list), client changes re-evaluate on the engine's write seam,
 *       recompute route converges, member list joins live client rows.
 *   9.  Sweep convergence — hand-corrupted state (missing rule row, bogus
 *       rule row, orphaned member) heals in ONE runTagSegmentReconciliation
 *       pass; manual rows untouched; status setting stamped with a parseable
 *       summary.
 *   10. Status + settings + sweep routes — status shape, kill-switch PATCH
 *       round-trip, interval floor 400, sweep enqueue 202 lands a work_queue
 *       job of the right type.
 *
 * The clients/contacts on-write hooks (clients.ts POST/PATCH, agents.ts
 * contacts) call the same evaluateRecordWriteSafe seam exercised in step 8;
 * mounting those route monoliths here would drag half the app into the
 * suite for no additional engine coverage.
 *
 * All fixtures are RUN-suffixed and removed in finally; list assertions
 * filter to RUN-prefixed names, never totals (shared-DB hygiene). Rule
 * criteria always include a `name starts_with RUN` / `firm_name
 * starts_with RUN` conjunct so ambient rows in a shared batch DB can never
 * match a fixture rule.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

import express, { type NextFunction, type Request, type Response } from "express";
import http, { type Server } from "http";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";

import { db } from "../server/db";
import { registerTagsSegmentsRoutes } from "../server/routes/tagsSegments";
import { registerDealsRoutes } from "../server/routes/deals";
import {
  clientContacts,
  clients,
  clientTags,
  deals,
  dealTags,
  segmentMembers,
  segments,
  tags,
} from "@shared/schema";
import {
  criteriaFieldRegistry,
  evaluateCriteriaSet,
  validateCriteriaSet,
  type CriteriaSet,
} from "@shared/criteria";
import {
  clientToCriteriaRecord,
  contactToCriteriaRecord,
  dealToCriteriaRecord,
  runTagSegmentReconciliation,
  evaluateRecordWriteSafe,
  pruneSegmentMembershipSafe,
  TAG_SEGMENT_RECONCILE_QUEUE,
  TAG_SEGMENT_SWEEP_STATUS_SETTING,
} from "../server/services/tagSegmentEngine";

const HEX = randomBytes(4).toString("hex");
const RUN = `t4329-${HEX}`;

const TL_ID = `${RUN}-tl`;     // team_lead → definition CRUD
const AM_ID = `${RUN}-am`;     // account_manager → tags any record, no CRUD
const SALES_ID = `${RUN}-sales`;  // sales role, owns C_OWNED
const SALES2_ID = `${RUN}-s2`;    // sales role, owns nothing

const C_OWNED = `${RUN}-client-owned`; // owned by SALES, practice areas carry RUN marker
const C_OTHER = `${RUN}-client-other`; // owned by AM
const C_DEMO = `${RUN}-client-demo`;   // demo client (hidden from non-CEO)

const PA_MARKER = `${RUN}-pi`; // RUN-scoped practice area used by segment criteria

const SETTING_KEYS = [
  "tags_segments_sweep_enabled",
  "tags_segments_sweep_interval_ms",
  TAG_SEGMENT_SWEEP_STATUS_SETTING,
];

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// ── Harness ─────────────────────────────────────────────────────────────────

let actingUserId: string | null = TL_ID;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Clerk test seam (server/middlewares/requireAuth.ts): a string
    // authenticates as that user id; null is explicit-unauthenticated (401).
    (req as any).__test_clerkUserId = actingUserId;
    next();
  });
  registerTagsSegmentsRoutes(app);
  registerDealsRoutes(app); // on-write hook path (create/patch deal)
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

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ── Criteria helpers ─────────────────────────────────────────────────────────

/** RUN-scoped rule: name starts with RUN AND amount >= 10000. */
function largeDealCriteria(): CriteriaSet {
  return {
    combinator: "and",
    groups: [
      {
        combinator: "and",
        conditions: [
          { field: "name", operator: "starts_with", value: RUN },
          { field: "amount", operator: "gte", value: 10000 },
        ],
      },
    ],
  };
}

/** RUN-scoped segment: practice_areas includes the RUN marker, not demo. */
function segmentCriteria(): CriteriaSet {
  return {
    combinator: "and",
    groups: [
      {
        combinator: "and",
        conditions: [
          { field: "practice_areas", operator: "includes", value: PA_MARKER },
          { field: "is_demo", operator: "is_false" },
        ],
      },
    ],
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES
      (${TL_ID}, ${`${TL_ID}@t4329.example`}, 'Task4329', 'Lead', 'team_lead', 'lead'),
      (${AM_ID}, ${`${AM_ID}@t4329.example`}, 'Task4329', 'Manager', 'account_manager', 'core'),
      (${SALES_ID}, ${`${SALES_ID}@t4329.example`}, 'Task4329', 'Seller', 'sales', 'core'),
      (${SALES2_ID}, ${`${SALES2_ID}@t4329.example`}, 'Task4329', 'Other', 'sales', 'core')
  `);
  await db.insert(clients).values([
    {
      id: C_OWNED,
      firmName: `${RUN} Owned Firm`,
      ownerId: SALES_ID,
      isArchived: false,
      isDemo: false,
      practiceAreas: [PA_MARKER, "mva"],
      averageCaseValue: 9000,
    },
    {
      id: C_OTHER,
      firmName: `${RUN} Other Firm`,
      ownerId: AM_ID,
      isArchived: false,
      isDemo: false,
      practiceAreas: ["em"],
      averageCaseValue: 1000,
    },
    {
      id: C_DEMO,
      firmName: `${RUN} Demo Firm`,
      ownerId: AM_ID,
      isArchived: false,
      isDemo: true,
      practiceAreas: [PA_MARKER],
    },
  ] as any);
}

async function cleanup(): Promise<void> {
  // Settings rows first: the PATCH route stamps updated_by = TL user.
  await db.execute(
    sql`DELETE FROM system_settings WHERE key IN (${sql.join(
      SETTING_KEYS.map((k) => sql`${k}`),
      sql`, `,
    )})`,
  );
  // Tag/segment definitions cascade their join rows.
  await db.delete(tags).where(like(tags.name, `${RUN}%`));
  await db.delete(segments).where(like(segments.name, `${RUN}%`));
  await db.delete(deals).where(like(deals.name, `${RUN}%`));
  // Orphan/member litter for fixture entity ids (defensive; cascades cover most).
  await db
    .delete(segmentMembers)
    .where(inArray(segmentMembers.entityId, [C_OWNED, C_OTHER, C_DEMO, `${RUN}-ghost`]));
  await db.execute(
    sql`DELETE FROM work_queue WHERE job_type = ${TAG_SEGMENT_RECONCILE_QUEUE}`,
  );
  await db.execute(sql`DELETE FROM clients WHERE id IN (${C_OWNED}, ${C_OTHER}, ${C_DEMO})`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${RUN}%`}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let failures = 0;
  async function step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err: any) {
      failures += 1;
      console.error(`FAIL - ${name}`);
      console.error(`  ${err?.message ?? err}`);
    }
  }

  await seed();
  const app = buildApp();
  const started = await listen(app);
  const server = started.server;
  baseUrl = started.baseUrl;

  let ruleTagId = "";     // "Large deal" rule tag (deal)
  let manualTagId = "";   // manual-only tag (deal)
  let clientTagId = "";   // manual-only tag (client)
  let segmentId = "";     // client segment on PA_MARKER
  let bigDealId = "";     // matching deal (via real route)
  let contactId = "";     // contact on C_OWNED

  try {
    // ── 1. Evaluator units ────────────────────────────────────────────────
    await step("evaluator: operators, combinators, missing-value semantics", async () => {
      const rec = {
        name: `${RUN} Acme`,
        amount: 15000,
        stage_name: "Negotiation",
        has_client: true,
        practice_areas: ["PI", "MVA"],
        expected_close_date: "2026-09-01",
        lost_reason: null,
      };
      const one = (field: string, operator: string, value?: unknown): boolean =>
        evaluateCriteriaSet(
          {
            combinator: "and",
            groups: [
              {
                combinator: "and",
                conditions: [{ field, operator: operator as any, value: value as any }],
              },
            ],
          },
          rec as any,
        );

      // strings fold case + trim
      assertEq(one("name", "contains", "acme"), true, "contains case-insensitive");
      assertEq(one("name", "starts_with", RUN.toUpperCase()), true, "starts_with case-insensitive");
      assertEq(one("stage_name", "equals", " negotiation "), true, "equals trims + folds");
      assertEq(one("name", "not_contains", "zzz"), true, "not_contains");
      // numbers
      assertEq(one("amount", "gte", 15000), true, "gte boundary");
      assertEq(one("amount", "gt", 15000), false, "gt strict");
      assertEq(one("amount", "lte", 14999), false, "lte");
      // dates
      assertEq(one("expected_close_date", "after", "2026-08-31"), true, "date after");
      assertEq(one("expected_close_date", "before", "2026-08-31"), false, "date before");
      // booleans + arrays
      assertEq(one("has_client", "is_true"), true, "is_true");
      assertEq(one("practice_areas", "includes", "pi"), true, "includes case-insensitive");
      assertEq(one("practice_areas", "not_includes", "em"), true, "not_includes");
      // missing/null fails everything but is_not_set
      assertEq(one("lost_reason", "contains", "x"), false, "null fails contains");
      assertEq(one("lost_reason", "is_not_set"), true, "null passes is_not_set");
      assertEq(one("lost_reason", "is_set"), false, "null fails is_set");
      assertEq(one("nonexistent_field", "is_not_set"), true, "missing passes is_not_set");

      // empty set matches nothing
      assertEq(
        evaluateCriteriaSet({ combinator: "and", groups: [] }, rec as any),
        false,
        "empty groups match nothing",
      );

      // OR-of-groups / AND-within-group interplay
      const orSet: CriteriaSet = {
        combinator: "or",
        groups: [
          {
            combinator: "and",
            conditions: [
              { field: "amount", operator: "gte", value: 999999 },
              { field: "has_client", operator: "is_true" },
            ],
          },
          {
            combinator: "or",
            conditions: [
              { field: "stage_name", operator: "equals", value: "nope" },
              { field: "practice_areas", operator: "includes", value: "mva" },
            ],
          },
        ],
      };
      assertEq(evaluateCriteriaSet(orSet, rec as any), true, "or-of-groups");
    });

    // ── 2. Registry ↔ extractor lockstep ─────────────────────────────────
    await step("registry keys match server extraction helpers exactly", async () => {
      const now = new Date();
      const dealRecord = dealToCriteriaRecord({
        id: "x",
        name: "n",
        amount: 1,
        expectedCloseDate: "2026-01-01",
        lostReason: null,
        clientId: null,
        isArchived: false,
        createdAt: now,
        stageName: "s",
      } as any);
      const clientRecord = clientToCriteriaRecord({
        id: "x",
        firmName: "f",
        contactName: null,
        contactEmail: null,
        consultType: "free",
        practiceAreas: [],
        products: [],
        averageCaseValue: null,
        monthlyReviewTarget: null,
        isDemo: false,
        isArchived: false,
        clientStartDate: null,
        createdAt: now,
      } as any);
      const contactRecord = contactToCriteriaRecord({
        id: "x",
        name: "c",
        emails: [],
        phones: [],
        roleTitle: null,
        isPrimary: false,
        createdAt: now,
      } as any);
      const byEntity = { deal: dealRecord, client: clientRecord, contact: contactRecord };
      for (const [entity, record] of Object.entries(byEntity)) {
        for (const field of criteriaFieldRegistry[entity as keyof typeof byEntity]) {
          assert(
            field.key in record,
            `${entity} extractor missing registry key '${field.key}'`,
          );
        }
      }
    });

    // ── 3. Validation rejects ─────────────────────────────────────────────
    await step("validateCriteriaSet rejects bad fields/operators/values", async () => {
      const bad = (set: unknown, entity: "deal" | "client" | "contact" = "deal") =>
        validateCriteriaSet(entity, set as CriteriaSet);
      assert(
        bad({
          combinator: "and",
          groups: [{ combinator: "and", conditions: [{ field: "no_such", operator: "equals", value: "x" }] }],
        }).length > 0,
        "unknown field rejected",
      );
      assert(
        bad({
          combinator: "and",
          groups: [{ combinator: "and", conditions: [{ field: "amount", operator: "contains", value: "x" }] }],
        }).length > 0,
        "operator/type mismatch rejected",
      );
      assert(
        bad({
          combinator: "and",
          groups: [{ combinator: "and", conditions: [{ field: "amount", operator: "gte" }] }],
        }).length > 0,
        "missing value operand rejected",
      );
      assert(
        bad({
          combinator: "and",
          groups: [{ combinator: "and", conditions: [{ field: "firm_name", operator: "equals", value: "x" }] }],
        }).length > 0,
        "client-only field rejected for deal entity",
      );
      assertEq(bad(largeDealCriteria()).length, 0, "valid criteria accepted");
    });

    // ── 4. Definition CRUD gating ─────────────────────────────────────────
    await step("tag CRUD is team_lead-gated; dup name 409; bad criteria 400", async () => {
      actingUserId = null;
      assertEq((await api("GET", "/api/tags")).status, 401, "unauthenticated GET /api/tags");

      actingUserId = AM_ID;
      assertEq(
        (await api("POST", "/api/tags", { name: `${RUN} nope`, color: "#2563eb", entityType: "deal" })).status,
        403,
        "AM tag create 403",
      );

      actingUserId = TL_ID;
      const bad = await api("POST", "/api/tags", {
        name: `${RUN} bad`,
        color: "#2563eb",
        entityType: "deal",
        criteria: {
          combinator: "and",
          groups: [{ combinator: "and", conditions: [{ field: "firm_name", operator: "equals", value: "x" }] }],
        },
      });
      assertEq(bad.status, 400, "entity-mismatched criteria 400");

      const rule = await api("POST", "/api/tags", {
        name: `${RUN} Large deal`,
        color: "#16a34a",
        entityType: "deal",
        criteria: largeDealCriteria(),
      });
      assertEq(rule.status, 201, "rule tag created");
      ruleTagId = rule.json.id;

      const manual = await api("POST", "/api/tags", {
        name: `${RUN} Watchlist`,
        color: "#7c3aed",
        entityType: "deal",
      });
      assertEq(manual.status, 201, "manual tag created");
      manualTagId = manual.json.id;

      const clientTag = await api("POST", "/api/tags", {
        name: `${RUN} VIP`,
        color: "#ea580c",
        entityType: "client",
      });
      assertEq(clientTag.status, 201, "client tag created");
      clientTagId = clientTag.json.id;

      const dup = await api("POST", "/api/tags", {
        name: `${RUN} Large deal`,
        color: "#2563eb",
        entityType: "deal",
      });
      assertEq(dup.status, 409, "duplicate tag name 409");

      const list = await api("GET", "/api/tags?entityType=deal");
      assertEq(list.status, 200, "tag list");
      const mine = (list.json.tags as any[]).filter((t) => t.name.startsWith(RUN));
      assertEq(mine.length, 2, "both RUN deal tags listed");
    });

    // ── 5. Rule tags on record write (real deals routes) ─────────────────
    await step("rule tag applies on deal create and removes on downgrade PATCH", async () => {
      actingUserId = AM_ID;
      // Ensure the sales pipeline exists (lazy seed).
      const pipelines = await api("GET", "/api/deals/pipelines");
      assertEq(pipelines.status, 200, "pipelines GET");

      const created = await api("POST", "/api/deals", {
        name: `${RUN} Big Deal`,
        clientId: C_OWNED,
        amount: 25000,
      });
      assertEq(created.status, 201, "deal created");
      bigDealId = created.json.id;

      const tagsAfterCreate = await api("GET", `/api/deals/${bigDealId}/tags`);
      assertEq(tagsAfterCreate.status, 200, "record tags GET");
      const ruleRow = (tagsAfterCreate.json as any[]).find((t) => t.id === ruleTagId);
      assert(ruleRow, "rule tag applied on create");
      assertEq(ruleRow.source, "rule", "applied row is rule-sourced");

      // Manual tag beside it.
      const applied = await api("POST", `/api/deals/${bigDealId}/tags`, { tagId: manualTagId });
      assertEq(applied.status, 201, "manual apply");

      // Downgrade below threshold via the REAL deals PATCH (on-write hook).
      const patched = await api("PATCH", `/api/deals/${bigDealId}`, { amount: 500 });
      assertEq(patched.status, 200, "deal PATCH");

      const tagsAfterPatch = await api("GET", `/api/deals/${bigDealId}/tags`);
      const ids = (tagsAfterPatch.json as any[]).map((t) => t.id);
      assert(!ids.includes(ruleTagId), "rule tag removed after downgrade");
      assert(ids.includes(manualTagId), "manual tag survives rule removal");

      // Upgrade again — rule row returns.
      await api("PATCH", `/api/deals/${bigDealId}`, { amount: 50000 });
      const tagsAfterUpgrade = await api("GET", `/api/deals/${bigDealId}/tags`);
      assert(
        (tagsAfterUpgrade.json as any[]).some((t) => t.id === ruleTagId && t.source === "rule"),
        "rule tag re-applied after upgrade",
      );
    });

    // ── 6. Manual apply/remove + 409 protection ──────────────────────────
    await step("manual remove works; rule-sourced remove answers 409 and row survives", async () => {
      actingUserId = AM_ID;
      // Idempotent re-apply.
      const again = await api("POST", `/api/deals/${bigDealId}/tags`, { tagId: manualTagId });
      assertEq(again.status, 201, "re-apply idempotent");
      const rows = await db
        .select()
        .from(dealTags)
        .where(and(eq(dealTags.dealId, bigDealId), eq(dealTags.tagId, manualTagId)));
      assertEq(rows.length, 1, "exactly one manual row after re-apply");

      const ruleRemove = await api("DELETE", `/api/deals/${bigDealId}/tags/${ruleTagId}`);
      assertEq(ruleRemove.status, 409, "rule row remove 409");
      const stillThere = await db
        .select()
        .from(dealTags)
        .where(and(eq(dealTags.dealId, bigDealId), eq(dealTags.tagId, ruleTagId)));
      assertEq(stillThere.length, 1, "rule row survives 409");

      const manualRemove = await api("DELETE", `/api/deals/${bigDealId}/tags/${manualTagId}`);
      assertEq(manualRemove.status, 200, "manual remove 200");
      assert(
        !(manualRemove.json as any[]).some((t) => t.id === manualTagId),
        "manual tag gone from returned list",
      );

      const missingRemove = await api("DELETE", `/api/deals/${bigDealId}/tags/${manualTagId}`);
      assertEq(missingRemove.status, 404, "second remove 404");
    });

    // ── 7. Record-level access on manual tagging ─────────────────────────
    await step("sales owner-only tagging; demo client hidden from non-CEO", async () => {
      actingUserId = SALES2_ID; // owns nothing
      assertEq(
        (await api("POST", `/api/clients/${C_OWNED}/tags`, { tagId: clientTagId })).status,
        403,
        "foreign sales apply 403",
      );
      actingUserId = SALES_ID; // owns C_OWNED
      assertEq(
        (await api("POST", `/api/clients/${C_OWNED}/tags`, { tagId: clientTagId })).status,
        201,
        "owner sales apply 201",
      );
      actingUserId = AM_ID; // not CEO → demo client invisible
      assertEq(
        (await api("POST", `/api/clients/${C_DEMO}/tags`, { tagId: clientTagId })).status,
        404,
        "demo client 404 for non-CEO",
      );
      // Entity-type mismatch: deal tag on a client record.
      assertEq(
        (await api("POST", `/api/clients/${C_OWNED}/tags`, { tagId: manualTagId })).status,
        400,
        "entity-type mismatch 400",
      );
    });

    // ── 8. Segments ───────────────────────────────────────────────────────
    await step("segment create evaluates synchronously; write seam + recompute converge", async () => {
      actingUserId = AM_ID;
      assertEq(
        (await api("POST", "/api/segments", { name: `${RUN} nope`, entityType: "client", criteria: segmentCriteria() })).status,
        403,
        "AM segment create 403",
      );

      actingUserId = TL_ID;
      const created = await api("POST", "/api/segments", {
        name: `${RUN} PI Firms`,
        entityType: "client",
        criteria: segmentCriteria(),
      });
      assertEq(created.status, 201, "segment created");
      segmentId = created.json.id;
      assertEq(created.json.memberCount, 1, "sync eval counted C_OWNED only (demo excluded)");

      const members = await api("GET", `/api/segments/${segmentId}/members`);
      assertEq(members.status, 200, "members GET");
      assertEq(members.json.total, 1, "one member");
      assertEq(members.json.members[0].entityId, C_OWNED, "member is C_OWNED");
      assert(
        String(members.json.members[0].name).startsWith(RUN),
        "member list joins live client row",
      );

      // C_OTHER gains the marker → engine write seam adds it.
      await db
        .update(clients)
        .set({ practiceAreas: [PA_MARKER] })
        .where(eq(clients.id, C_OTHER));
      await evaluateRecordWriteSafe("client", C_OTHER);
      const grown = await api("GET", `/api/segments/${segmentId}/members`);
      assertEq(grown.json.total, 2, "member added by write-seam eval");

      // Marker removed → recompute route drops it.
      await db.update(clients).set({ practiceAreas: ["em"] }).where(eq(clients.id, C_OTHER));
      const recompute = await api("POST", `/api/segments/${segmentId}/recompute`);
      assertEq(recompute.status, 200, "recompute 200");
      assertEq(recompute.json.memberCount, 1, "recompute converged back to 1");

      // Contact segment: engine seam over contacts.
      const [contact] = await db
        .insert(clientContacts)
        .values({ clientId: C_OWNED, name: `${RUN} Contact`, isPrimary: true, emails: [`${RUN}@x.example`] } as any)
        .returning({ id: clientContacts.id });
      contactId = contact.id;
      const contactSeg = await api("POST", "/api/segments", {
        name: `${RUN} Primaries`,
        entityType: "contact",
        criteria: {
          combinator: "and",
          groups: [
            {
              combinator: "and",
              conditions: [
                { field: "name", operator: "starts_with", value: RUN },
                { field: "is_primary", operator: "is_true" },
              ],
            },
          ],
        },
      });
      assertEq(contactSeg.status, 201, "contact segment created");
      assertEq(contactSeg.json.memberCount, 1, "contact segment counts the primary contact");
    });

    // ── 9. Sweep convergence ─────────────────────────────────────────────
    await step("reconciliation sweep heals drift both directions, spares manual, reaps orphans", async () => {
      // Corrupt state:
      // (a) delete the rule row the big deal SHOULD have,
      await db
        .delete(dealTags)
        .where(and(eq(dealTags.dealId, bigDealId), eq(dealTags.tagId, ruleTagId)));
      // (b) plant a bogus rule row on a non-matching record via a fresh small deal,
      const [smallDeal] = await db
        .select({ id: deals.id })
        .from(deals)
        .where(eq(deals.name, `${RUN} Big Deal`));
      // reuse big deal, but plant bogus rule row of the MANUAL tag (no criteria ⇒ engine owns zero rows)
      await db
        .insert(dealTags)
        .values({ dealId: smallDeal.id, tagId: manualTagId, source: "rule", appliedBy: null } as any)
        .onConflictDoNothing();
      // (c) re-apply a manual row that must survive,
      actingUserId = AM_ID;
      await api("POST", `/api/clients/${C_OWNED}/tags`, { tagId: clientTagId });
      // (d) orphan segment member (entity id that joins nothing).
      await db
        .insert(segmentMembers)
        .values({ segmentId, entityId: `${RUN}-ghost` } as any)
        .onConflictDoNothing();

      const summary = await runTagSegmentReconciliation();
      // tagsEvaluated counts RULE tags only (criteria-less tags take the
      // cheap rule-row reap path instead of a population scan).
      assert(summary.tagsEvaluated >= 1, `evaluated my rule tag (got ${summary.tagsEvaluated})`);
      assert(summary.segmentsEvaluated >= 2, "evaluated my segments");
      assertEq(summary.errors.length, 0, `sweep errors: ${summary.errors.join("; ")}`);

      // (a) healed
      const ruleBack = await db
        .select()
        .from(dealTags)
        .where(and(eq(dealTags.dealId, bigDealId), eq(dealTags.tagId, ruleTagId)));
      assertEq(ruleBack.length, 1, "missing rule row restored");
      assertEq(ruleBack[0].source, "rule", "restored as rule-sourced");
      // (b) bogus rule row on criteria-less tag reaped
      const bogus = await db
        .select()
        .from(dealTags)
        .where(and(eq(dealTags.tagId, manualTagId), eq(dealTags.source, "rule")));
      assertEq(bogus.length, 0, "bogus rule row on criteria-less tag reaped");
      // (c) manual row untouched
      const manualStill = await db
        .select()
        .from(clientTags)
        .where(and(eq(clientTags.clientId, C_OWNED), eq(clientTags.tagId, clientTagId)));
      assertEq(manualStill.length, 1, "manual client tag survives sweep");
      assertEq(manualStill[0].source, "manual", "still manual-sourced");
      // (d) orphan reaped
      const ghost = await db
        .select()
        .from(segmentMembers)
        .where(eq(segmentMembers.entityId, `${RUN}-ghost`));
      assertEq(ghost.length, 0, "orphaned member reaped");

      // Status setting stamped + parseable.
      const status = await db.execute(
        sql`SELECT value FROM system_settings WHERE key = ${TAG_SEGMENT_SWEEP_STATUS_SETTING}`,
      );
      assertEq(status.rows.length, 1, "sweep status setting stamped");
      const parsed = JSON.parse((status.rows[0] as any).value);
      assert(typeof parsed.durationMs === "number", "status has durationMs");
      assert(typeof parsed.startedAt === "string", "status has startedAt");

      // Client delete prunes memberships via the prune seam.
      await pruneSegmentMembershipSafe(C_OTHER);
      const otherRows = await db
        .select()
        .from(segmentMembers)
        .where(eq(segmentMembers.entityId, C_OTHER));
      assertEq(otherRows.length, 0, "pruned entity has no membership rows");
    });

    // ── 10. Status / settings / sweep routes ─────────────────────────────
    await step("status shape, kill-switch PATCH round-trip, sweep enqueue 202", async () => {
      actingUserId = AM_ID;
      assertEq((await api("GET", "/api/tags-segments/status")).status, 403, "status is team_lead-gated");

      actingUserId = TL_ID;
      const status = await api("GET", "/api/tags-segments/status");
      assertEq(status.status, 200, "status 200");
      assertEq(typeof status.json.sweepEnabled, "boolean", "sweepEnabled boolean");
      assert(status.json.lastSweep, "lastSweep populated after direct run");
      assert(Array.isArray(status.json.definitions), "definitions array");
      const defNames = status.json.definitions.map((d: any) => d.name);
      assert(defNames.some((n: string) => n === `${RUN} Large deal`), "rule tag in definitions");
      assert(defNames.some((n: string) => n === `${RUN} PI Firms`), "segment in definitions");
      const ruleDef = status.json.definitions.find((d: any) => d.name === `${RUN} Large deal`);
      assert(ruleDef.lastEvaluatedAt, "rule tag shows lastEvaluatedAt");

      // Kill switch round-trip.
      assertEq(
        (await api("PATCH", "/api/tags-segments/settings", { enabled: true })).status,
        200,
        "settings PATCH",
      );
      const afterEnable = await api("GET", "/api/tags-segments/status");
      assertEq(afterEnable.json.sweepEnabled, true, "kill switch reads back true");
      assertEq(
        (await api("PATCH", "/api/tags-segments/settings", { intervalMs: 1000 })).status,
        400,
        "interval below 5-min floor 400",
      );
      await api("PATCH", "/api/tags-segments/settings", { enabled: false });

      // Sweep enqueue.
      const sweep = await api("POST", "/api/tags-segments/sweep");
      assertEq(sweep.status, 202, "sweep enqueue 202");
      const job = await db.execute(
        sql`SELECT id FROM work_queue WHERE job_type = ${TAG_SEGMENT_RECONCILE_QUEUE} AND status IN ('pending', 'processing')`,
      );
      assert(job.rows.length >= 1, "work_queue job of reconcile type present");
    });

    // ── Tag delete cascades ───────────────────────────────────────────────
    await step("tag delete removes chips everywhere (cascade)", async () => {
      actingUserId = TL_ID;
      assertEq((await api("DELETE", `/api/tags/${ruleTagId}`)).status, 204, "tag delete 204");
      const orphanRows = await db.select().from(dealTags).where(eq(dealTags.tagId, ruleTagId));
      assertEq(orphanRows.length, 0, "join rows cascaded");
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
    await cleanup();
    // Route tests hang on undici keep-alive sockets otherwise.
    try {
      const { getGlobalDispatcher } = await import("undici");
      await getGlobalDispatcher().close();
    } catch {}
  }

  if (failures > 0) throw new Error(`${failures} test step(s) failed`);
  console.log("\nAll tags & segments tests passed");
}

// Test teardown in server/db.ts drains the pg pools in test mode, so the
// process exits on its own once work settles — no manual process.exit().
let exitCode = 0;
main()
  .catch((err) => {
    console.error("tags-segments: FAILED");
    console.error(err?.message ?? err);
    exitCode = 1;
  })
  .finally(() => {
    process.exitCode = exitCode;
  });
