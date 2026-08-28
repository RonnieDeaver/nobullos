/* test-registration
{
  "name": "Paid Search role cutover — directory evidence collection + governed-destination classification (Task #5157)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #5157: the cutover reads its ground truth from fetchDirectoryEvidence(), which MUST preserve stable ClickUp task IDs, ALL raw People IDs plus field metadata, duplicate provenance, GAds/LSA subtask evidence, blank/multi-person, offboarded, and missing-product signals, pinned exclusively to the canonical Client List — and the gate's isGovernedPaidSearchDestination() must classify only production doer/checker canonical-field destinations as governed. Stubbed fetch (path-shape only), injected token store: no DB, no network.",
  "tier": "small",
  "tierReason": "The mechanically broad ClickUp/cutover import closure is exercised through pure in-process token and fetch seams; there is no database, browser, network, child process, or timer."
}
test-registration */
/**
 * Ads OS — Paid Search role cutover EVIDENCE + governed-destination
 * classification (Task #5157). Pure, hermetic: fetch stubbed at global.fetch
 * (dispatched on URL path shape, never a live vendor hostname), token store
 * injected (no settings/DB read). No DB, no network, no timers.
 *
 * fetchDirectoryEvidence() contracts under test:
 *  (a) stable task IDs carried verbatim as `taskId`;
 *  (b) BOTH field metadata (id/name/type) AND every raw People ID (all
 *      persons, not just the first) captured for doer + checker;
 *  (c) duplicate provenance: parents sharing a normalized name cross-link via
 *      duplicateNormNameTaskIds + normNameToTaskIds;
 *  (d) GAds ("Google Ads …") and LSA ("LSA …") subtask evidence with CID,
 *      and missingProduct when neither is present;
 *  (e) blank-name parents skipped; multi-person fields preserved in full;
 *  (f) offboarded parents preserved but flagged excluded;
 *  (g) pinned to the canonical CLICKUP_CLIENT_LIST_ID — no other list fetched;
 *  (h) null (fail-closed) when the canonical fetch fails.
 *
 * isGovernedPaidSearchDestination() contracts: production + canonical list +
 * canonical doer/checker People field = governed; sandbox, supervisor,
 * non-canonical list, or non-canonical field = NOT governed.
 */

import { strict as assert } from "node:assert";
import {
  EMPTY_CLICKUP_PRACTICE_AREA_FIELDS,
  isClickUpListFieldPath,
} from "./helpers/clickUpPracticeAreaFixture";

// --- Env BEFORE any module import: config constants read at load time. ------
process.env.CLICKUP_API_TOKEN = "pk_fake_cutover_evidence";

// Canonical config defaults (Task #5157 spec §3.2 / §9).
const CANONICAL_LIST_ID = "901417549202"; // CLICKUP_CLIENT_LIST_ID default
const F_CID = "a886aa6f-c7f8-41cc-940b-8afef551bf49"; // CLICKUP_CLIENT_CID_FIELD_ID
const F_DOER = "21335dc5-98ba-470c-b8a9-944e3cfed343"; // CLICKUP_DOER_FIELD_ID
const F_CHECKER = "0bfb4a38-47e4-4343-bb83-051a9fd40122"; // CLICKUP_CHECKER_FIELD_ID

// --- Fixture: a single canonical Client List page with subtasks. -------------
// Parents intentionally exercise: multi-person doer, blank checker, duplicate
// normalized name, offboarded status, GAds+LSA subtasks, and missing product.
const peopleField = (id: string, name: string, persons: any[]) => ({
  id,
  name,
  type: "users",
  value: persons,
});

const CLICKUP_TASKS = {
  last_page: true,
  tasks: [
    // Parent A — live, two doers (multi-person), one checker, GAds + LSA subtasks.
    {
      id: "task-A",
      name: "Acme Law",
      date_updated: "1787600000000",
      status: { status: "active" },
      custom_fields: [
        peopleField(F_DOER, "Doer", [
          { id: 101, username: "dana", email: "dana@x.com" },
          { id: 102, username: "second", email: "second@x.com" },
        ]),
        peopleField(F_CHECKER, "Checker", [{ id: 201, username: "carl", email: "carl@x.com" }]),
      ],
    },
    // Parent B — live, DUPLICATE normalized name of A ("acme law"), blank fields.
    {
      id: "task-B",
      name: "ACME   LAW",
      status: { status: "active" },
      custom_fields: [
        peopleField(F_DOER, "Doer", []), // blank doer
        // checker field entirely absent → checkerFieldMeta null, checkerPeople []
      ],
    },
    // Parent C — OFFBOARDED (excluded), still preserved. Missing product.
    {
      id: "task-C",
      name: "Gone Firm",
      status: { status: "Offboarded" }, // matches CLICKUP_EXCLUDED_CLIENT_STATUSES default
      custom_fields: [
        peopleField(F_DOER, "Doer", [{ id: 301, username: "dpc", email: "dpc@x.com" }]),
      ],
    },
    // Parent D — blank NAME → skipped entirely.
    {
      id: "task-D",
      name: "   ",
      status: { status: "active" },
      custom_fields: [],
    },
    // --- Subtasks (carry `parent`). --------------------------------------------
    {
      id: "sub-A-gads",
      parent: "task-A",
      name: "Google Ads — Acme",
      custom_fields: [{ id: F_CID, value: "111-222-3333" }],
    },
    {
      id: "sub-A-lsa",
      parent: "task-A",
      name: "LSA — Acme",
      custom_fields: [{ id: F_CID, value: "444 555 6666" }],
    },
    // A subtask under B whose name matches no product prefix → no product signal.
    {
      id: "sub-B-none",
      parent: "task-B",
      name: "Reporting misc",
      custom_fields: [{ id: F_CID, value: "999" }],
    },
  ],
};

// --- fetch stub: path-shape dispatch only, records every fetched list. --------
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let clickUpDown = false;
const fetchedListIds: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input?.url ?? input);
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* non-absolute → realFetch */
  }
  if (isClickUpListFieldPath(pathname)) {
    if (clickUpDown) return jsonResponse({ err: "outage" }, 503);
    return jsonResponse({
      fields: [
        ...EMPTY_CLICKUP_PRACTICE_AREA_FIELDS.fields,
        { id: F_DOER, name: "Doer", type: "users" },
        { id: F_CHECKER, name: "Checker", type: "users" },
      ],
    });
  }
  // ClickUp v2 list-task fetch: /api/v2/list/<listId>/task
  const m = pathname.match(/^\/api\/v2\/list\/([^/]+)\/task$/);
  if (m) {
    fetchedListIds.push(m[1]);
    if (clickUpDown) return jsonResponse({ err: "outage" }, 503);
    return jsonResponse(CLICKUP_TASKS);
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- Modules under test (imported AFTER env + fetch stub). --------------------
const directory = await import("../server/services/adsOs/clickUpDirectory");
const gate = await import("../server/services/adsOs/paidSearchCutoverGate");
const config = await import("../server/services/adsOs/config");
const contract = await import("../server/services/adsOs/paidSearchRoleContract");
const tok = await import("../server/services/clickUpCompanyToken");

// Env-only token (no settings/DB read), noop alert hooks (no dispatcher chain).
tok.__setClickUpCompanyTokenStoreForTest({
  async get() {
    return undefined;
  },
  async set() {},
  async del() {},
  async recordAudit() {},
});
tok.invalidateClickUpCompanyTokenCache();
directory.__setDirectoryAlertHooksForTest({ onSuccess: async () => {}, onFailure: async () => {} });

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.equal(cond, true, label);
  passed++;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
console.log("phase 1: fetchDirectoryEvidence — canonical evidence bundle");
{
  ok(
    config.resolveOperationalClickUpClientListId(
      { CLICKUP_CLIENT_LIST_ID: "sandbox-copy" } as NodeJS.ProcessEnv,
      true,
    ) === CANONICAL_LIST_ID,
    "production operational directory ignores a non-canonical list override",
  );
  ok(
    config.resolveOperationalClickUpClientListId(
      { CLICKUP_CLIENT_LIST_ID: "sandbox-copy" } as NodeJS.ProcessEnv,
      false,
    ) === "sandbox-copy",
    "non-production operational directory retains the explicit staging override seam",
  );
  ok(
    contract.CLICKUP_DOER_FIELD_ID === F_DOER &&
      contract.CLICKUP_CHECKER_FIELD_ID === F_CHECKER,
    "Paid Search projection contract pins the exact existing People fields",
  );
  const ev = await directory.fetchDirectoryEvidence();
  ok(ev !== null, "evidence bundle returned (not null) on healthy fetch");
  const parents = ev!.parents;
  ok(ev!.canonicalListId === CANONICAL_LIST_ID, "evidence names the exact canonical list ID");
  const doerInventory = ev!.fields.find((field) => field.id === F_DOER);
  ok(
    doerInventory?.label === "Doer" &&
      doerInventory.type === "users" &&
      doerInventory.observedMaxCardinality === 2,
    "field inventory preserves exact ID/label/type and observed cardinality",
  );

  // (g) Pinned to the canonical list, and ONLY that list, was fetched.
  ok(
    fetchedListIds.length > 0 && fetchedListIds.every((id) => id === CANONICAL_LIST_ID),
    "pinned to canonical CLICKUP_CLIENT_LIST_ID — no other list read",
  );

  const byId = new Map(parents.map((p) => [p.taskId, p]));
  // (e) Blank-name parent D skipped; A, B, C present.
  ok(byId.has("task-A") && byId.has("task-B") && byId.has("task-C"), "parents A/B/C present");
  ok(!byId.has("task-D"), "blank-name parent skipped");

  const A = byId.get("task-A")!;
  const B = byId.get("task-B")!;
  const C = byId.get("task-C")!;

  // (a) Stable task ID carried verbatim.
  ok(A.taskId === "task-A", "stable ClickUp task ID preserved verbatim");
  ok(A.remoteRevision === "1787600000000", "opaque remote revision evidence is preserved");

  // (b) ALL raw People IDs (multi-person) + field metadata for doer & checker.
  ok(
    A.doerPeople.map((p) => p.clickupUserId).join(",") === "101,102",
    "multi-person doer: ALL raw People IDs captured (not just first)",
  );
  ok(
    A.doerFieldMeta?.id === F_DOER && A.doerFieldMeta?.type === "users",
    "doer field metadata (id/type) captured alongside raw IDs",
  );
  ok(
    A.checkerPeople.length === 1 && A.checkerPeople[0].clickupUserId === "201",
    "checker raw People ID captured",
  );
  ok(A.checkerFieldMeta?.id === F_CHECKER, "checker field metadata captured");

  // (e) Blank / absent fields on B.
  ok(B.doerPeople.length === 0, "blank doer field → empty People list");
  ok(B.checkerFieldMeta === null, "absent checker field → null field metadata");

  // (c) Duplicate provenance: A and B share normalized name "acme law".
  ok(A.normName === "acme law" && B.normName === "acme law", "normalized name collapses whitespace/case");
  ok(
    A.duplicateNormNameTaskIds.includes("task-B") && B.duplicateNormNameTaskIds.includes("task-A"),
    "duplicate provenance cross-links parents sharing a normalized name",
  );
  ok(
    (ev!.normNameToTaskIds["acme law"] ?? []).sort().join(",") === "task-A,task-B",
    "normNameToTaskIds indexes both duplicate task IDs",
  );

  // (d) GAds + LSA subtask evidence, with CID; missingProduct false on A.
  ok(A.hasGads === true && A.hasLsa === true, "GAds + LSA subtasks both detected on parent A");
  ok(A.missingProduct === false, "parent with a recognized product is not missingProduct");
  const gadsSub = A.subtasks.find((s) => s.product === "gads");
  const lsaSub = A.subtasks.find((s) => s.product === "lsa");
  ok(gadsSub?.cid === "1112223333", "GAds subtask CID normalized to digits only");
  ok(lsaSub?.cid === "4445556666", "LSA subtask CID normalized to digits only");

  // (d) B's subtask has no product prefix → missingProduct true.
  ok(B.hasGads === false && B.hasLsa === false, "unrecognized subtask name yields no product");
  ok(B.missingProduct === true, "parent with no recognized product flagged missingProduct");

  // (f) Offboarded parent preserved but flagged excluded.
  ok(C.excluded === true, "offboarded parent flagged excluded");
  ok(C.status === "offboarded", "excluded parent still carries its raw (lowercased) status");
  ok(byId.has("task-C"), "excluded parent is PRESERVED in the evidence set");
}

// ---------------------------------------------------------------------------
console.log("phase 2: fetchDirectoryEvidence — fail-closed on fetch failure");
{
  clickUpDown = true;
  const ev = await directory.fetchDirectoryEvidence();
  ok(ev === null, "fetch failure → null evidence (callers fail closed)");
  clickUpDown = false;
}

// ---------------------------------------------------------------------------
console.log("phase 3: isGovernedPaidSearchDestination — classification");
{
  // Signature is { listId, peopleFieldId, environment } only.
  const doerProd = {
    listId: CANONICAL_LIST_ID,
    peopleFieldId: F_DOER,
    environment: "production",
  };
  const checkerProd = { ...doerProd, peopleFieldId: F_CHECKER };

  ok(
    gate.isGovernedPaidSearchDestination(doerProd) === true,
    "production doer destination on canonical list + canonical field is governed",
  );
  ok(
    gate.isGovernedPaidSearchDestination(checkerProd) === true,
    "production checker destination on canonical list + canonical field is governed",
  );
  ok(
    gate.isGovernedPaidSearchDestination({ ...doerProd, environment: "sandbox" }) === false,
    "sandbox destination is NOT governed",
  );
  ok(
    gate.isGovernedPaidSearchDestination({ ...doerProd, listId: "some-other-list" }) === false,
    "non-canonical list is NOT governed",
  );
  ok(
    gate.isGovernedPaidSearchDestination({ ...doerProd, listId: null }) === false,
    "null list (direct-task company scope) is NOT governed by the canonical-list gate",
  );
  ok(
    gate.isGovernedPaidSearchDestination({ ...doerProd, peopleFieldId: "supervisor-field-uuid" }) === false,
    "a non-canonical (e.g. supervisor) People field is NOT governed",
  );
}

console.log(`\npaid-search-cutover-evidence: ${passed} assertions passed`);
