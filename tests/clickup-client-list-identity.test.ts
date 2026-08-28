/* test-registration
{
  "name": "ClickUp Client List identity — stable mapping and preflight capability contracts",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast hermetic contract suite proving stable-ID rename safety, duplicate-task refusal, canonical owning-list classification, exact People field metadata/cardinality issues, and active per-client Doer/Checker matrix derivation with no vendor egress.",
  "tier": "small",
  "tierReason": "Pure in-process classification plus source-level migration assertions; no database, network, browser, child process, or timers.",
  "scanPaths": [
    "server/services/clickUpClientListIdentity.ts",
    "server/services/adsOs/clickUpDirectory.ts",
    "shared/models/clickUpRoleProjection.ts",
    "shared/departmentRoleCapabilities.ts",
    "migrations/20260825150000_clickup_client_list_identity.sql"
  ]
}
test-registration */

import "./helpers/forceTestEnv";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyCanonicalClientListPreflight,
  deriveRequiredRoleColumns,
  findCanonicalMappingConflict,
  getRoleColumnLabel,
} from "../server/services/clickUpClientListIdentity";
import { CANONICAL_PRODUCTION_LIST_ID } from "../server/services/adsOs/paidSearchRoleContract";
import {
  GBP_LOCAL_SEO_DEPARTMENT_ID,
  PAID_SEARCH_DEPARTMENT_ID,
} from "../shared/departmentRoleCapabilities";
import type {
  CuClientListMapping,
  CuRoleProjectionDestination,
} from "../shared/models/clickUpRoleProjection";
import type { DirectoryEvidence } from "../server/services/adsOs/clickUpDirectory";

const NOW = new Date("2026-08-25T12:00:00.000Z");

function destination(
  values: Partial<CuRoleProjectionDestination> & {
    id: string;
    departmentId: string;
    responsibility: string;
    peopleFieldId: string;
  },
): CuRoleProjectionDestination {
  return {
    workspaceId: "workspace-1",
    targetKind: "client_list_parent",
    listId: CANONICAL_PRODUCTION_LIST_ID,
    targetId: null,
    peopleFieldLabel: null,
    peopleFieldType: null,
    maxPeople: 1,
    environment: "production",
    enabled: false,
    sandboxExitApprovedAt: null,
    sandboxExitApprovedBy: null,
    ownerApprovedAt: null,
    ownerApprovedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...values,
  };
}

function mapping(values: Partial<CuClientListMapping> & {
  id: string;
  clientId: string;
  taskId: string;
}): CuClientListMapping {
  return {
    listId: CANONICAL_PRODUCTION_LIST_ID,
    remoteTaskName: null,
    remoteRevision: null,
    provenance: {},
    syncState: "verified",
    conflictEvidence: null,
    ownershipVerifiedAt: NOW,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...values,
  };
}

const departments = [
  {
    id: PAID_SEARCH_DEPARTMENT_ID,
    name: "Paid Search",
    active: true,
    assignmentScope: "per_client",
  },
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Doer only",
    active: true,
    assignmentScope: "per_client",
  },
  {
    id: GBP_LOCAL_SEO_DEPARTMENT_ID,
    name: "Company GBP",
    active: true,
    assignmentScope: "company",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Retired",
    active: false,
    assignmentScope: "per_client",
  },
];

const required = deriveRequiredRoleColumns(departments);
assert.deepEqual(
  required.map((row) => `${row.departmentId}:${row.responsibility}`),
  [
    `${PAID_SEARCH_DEPARTMENT_ID}:doer`,
    `${PAID_SEARCH_DEPARTMENT_ID}:checker`,
    "11111111-1111-4111-8111-111111111111:doer",
  ],
  "matrix includes Doer universally, Checker only by capability, and excludes company/inactive departments",
);
assert.equal(
  required[0].expectedLabel,
  "Paid Search Doer",
  "the expected label is deterministic while the department UUID remains identity",
);
assert.equal(
  getRoleColumnLabel("Renamed Department", "checker"),
  "Renamed Department Checker",
  "a department rename produces a new setup label for review rather than field-ID guessing",
);

const evidence: DirectoryEvidence = {
  canonicalListId: CANONICAL_PRODUCTION_LIST_ID,
  fetchedAt: 1787659200000,
  fields: [
    {
      id: "field-doer",
      label: "GBP - Doer",
      type: "users",
      observedTaskCount: 2,
      observedMaxCardinality: 1,
    },
    {
      id: "field-checker",
      label: "Old Checker Label",
      type: "text",
      observedTaskCount: 1,
      observedMaxCardinality: 2,
    },
    {
      id: "field-checker-duplicate",
      label: "Paid Search Checker",
      type: "users",
      observedTaskCount: 0,
      observedMaxCardinality: null,
    },
    {
      id: "field-checker-duplicate-2",
      label: "Paid Search Checker",
      type: "users",
      observedTaskCount: 0,
      observedMaxCardinality: null,
    },
    {
      id: "field-long-label",
      label: "Doer only Doer",
      type: "people",
      observedTaskCount: 1,
      observedMaxCardinality: 1,
    },
  ],
  normNameToTaskIds: {
    "renamed firm": ["task-a", "task-a-duplicate"],
    "beta llc": ["task-b"],
  },
  parents: [
    {
      taskId: "task-a",
      name: "Renamed Firm",
      normName: "renamed firm",
      status: "active",
      excluded: false,
      doerPeople: [],
      checkerPeople: [],
      doerFieldMeta: null,
      checkerFieldMeta: null,
      subtasks: [],
      hasGads: false,
      hasLsa: false,
      missingProduct: true,
      duplicateNormNameTaskIds: ["task-a-duplicate"],
      remoteRevision: "rev-2",
    },
    {
      taskId: "task-a-duplicate",
      name: "RENAMED   FIRM",
      normName: "renamed firm",
      status: "active",
      excluded: false,
      doerPeople: [],
      checkerPeople: [],
      doerFieldMeta: null,
      checkerFieldMeta: null,
      subtasks: [],
      hasGads: false,
      hasLsa: false,
      missingProduct: true,
      duplicateNormNameTaskIds: ["task-a"],
      remoteRevision: "rev-1",
    },
    {
      taskId: "task-b",
      name: "Beta LLC",
      normName: "beta llc",
      status: "active",
      excluded: false,
      doerPeople: [],
      checkerPeople: [],
      doerFieldMeta: null,
      checkerFieldMeta: null,
      subtasks: [],
      hasGads: false,
      hasLsa: false,
      missingProduct: true,
      duplicateNormNameTaskIds: [],
      remoteRevision: "rev-b",
    },
  ],
};

const destinations = [
  destination({
    id: "dest-doer",
    departmentId: PAID_SEARCH_DEPARTMENT_ID,
    responsibility: "doer",
    peopleFieldId: "field-doer",
    peopleFieldLabel: "GBP - Doer",
    peopleFieldType: "users",
  }),
  destination({
    id: "dest-checker",
    departmentId: PAID_SEARCH_DEPARTMENT_ID,
    responsibility: "checker",
    peopleFieldId: "field-checker",
    peopleFieldLabel: "Paid Search Checker",
    peopleFieldType: "users",
  }),
];

const mappings = [
  mapping({
    id: "mapping-a",
    clientId: "client-a",
    taskId: "task-a",
    remoteTaskName: "Old Firm Name",
    remoteRevision: "rev-1",
  }),
];

const preflight = classifyCanonicalClientListPreflight({
  evidence,
  localClients: [
    { id: "client-a", name: "Local Firm Name" },
    { id: "client-b", name: "  BETA   LLC " },
  ],
  departments,
  destinations,
  mappings,
});

const mapped = preflight.mappings[0];
assert.equal(mapped.mapping.taskId, "task-a", "mapping is addressed by stable task ID");
assert.equal(mapped.observedSyncState, "verified", "renamed remote task remains verified by ID");
assert.equal(mapped.nameChangedSinceLink, true, "rename is visible without breaking identity");
assert.equal(preflight.duplicateClientRows.length, 1, "duplicate ClickUp client rows are visible");
assert.deepEqual(
  preflight.nameOnlyAdoptionCandidates,
  [{
    clientId: "client-b",
    localClientName: "  BETA   LLC ",
    taskId: "task-b",
    remoteTaskName: "Beta LLC",
  }],
  "normalized names produce review candidates only",
);

const doerColumn = preflight.roleColumns.find(
  (row) =>
    row.departmentId === PAID_SEARCH_DEPARTMENT_ID &&
    row.responsibility === "doer",
);
assert.equal(
  doerColumn?.ready,
  true,
  "a short ClickUp label is ready when exact ID, type, and cardinality are valid",
);
assert.equal(doerColumn?.expectedLabel, "Paid Search Doer", "the NoBull role label remains separate");
assert.equal(doerColumn?.field?.label, "GBP - Doer", "the selected ClickUp label remains visible");
const checkerColumn = preflight.roleColumns.find(
  (row) =>
    row.departmentId === PAID_SEARCH_DEPARTMENT_ID &&
    row.responsibility === "checker",
);
assert.deepEqual(
  checkerColumn?.issues.sort(),
  ["invalid_cardinality", "wrong_type"].sort(),
  "non-People and over-cardinality fields remain blocked without using labels as authority",
);
const duplicateLabelField = preflight.fields.find((field) => field.id === "field-checker-duplicate");
assert.deepEqual(
  duplicateLabelField?.duplicateLabelFieldIds.sort(),
  ["field-checker-duplicate", "field-checker-duplicate-2"].sort(),
  "duplicate labels remain visible metadata without deciding a mapping",
);
const missingDoer = preflight.roleColumns.find(
  (row) => row.departmentId === "11111111-1111-4111-8111-111111111111",
);
assert.deepEqual(missingDoer?.issues, ["missing_mapping"], "missing required role column is visible");

const wrongExpectedLabel = classifyCanonicalClientListPreflight({
  evidence,
  localClients: [],
  departments: [departments[0]],
  destinations: [
    destination({
      id: "dest-wrong-label",
      departmentId: PAID_SEARCH_DEPARTMENT_ID,
      responsibility: "doer",
      peopleFieldId: "field-doer",
      peopleFieldLabel: "An operator supplied a different label",
      peopleFieldType: "users",
    }),
  ],
  mappings: [],
});
assert.ok(
  wrongExpectedLabel.roleColumns[0].ready,
  "stored label metadata does not override a freshly verified exact field ID",
);

const longLabelMapping = classifyCanonicalClientListPreflight({
  evidence,
  localClients: [],
  departments: [departments[1]],
  destinations: [
    destination({
      id: "dest-long-label",
      departmentId: departments[1].id,
      responsibility: "doer",
      peopleFieldId: "field-long-label",
      peopleFieldLabel: "Doer only Doer",
      peopleFieldType: "people",
    }),
  ],
  mappings: [],
});
assert.equal(
  longLabelMapping.roleColumns[0].ready,
  true,
  "existing generated long-label mappings remain valid by their stable field ID",
);

const reusedField = classifyCanonicalClientListPreflight({
  evidence,
  localClients: [],
  departments: [departments[0], departments[1]],
  destinations: [
    destination({
      id: "dest-reused-a",
      departmentId: departments[0].id,
      responsibility: "doer",
      peopleFieldId: "field-doer",
      peopleFieldLabel: "GBP - Doer",
      peopleFieldType: "users",
    }),
    destination({
      id: "dest-reused-b",
      departmentId: departments[1].id,
      responsibility: "doer",
      peopleFieldId: "field-doer",
      peopleFieldLabel: "GBP - Doer",
      peopleFieldType: "users",
    }),
  ],
  mappings: [],
});
const reusedDoerColumns = reusedField.roleColumns.filter(
  (column) => column.responsibility === "doer" && column.destination !== null,
);
assert.equal(reusedDoerColumns.length, 2, "the reuse fixture contains both mapped Doer roles");
assert.ok(
  reusedDoerColumns.every((column) => column.issues.includes("duplicate_field_id")),
  "one exact ClickUp field ID reused for two NoBull roles blocks both destinations",
);

assert.deepEqual(
  findCanonicalMappingConflict(mappings, "client-b", "task-a"),
  { kind: "task_bound_to_other_client", otherClientId: "client-a" },
  "one canonical ClickUp task cannot be adopted by a second NoBull client",
);
assert.equal(
  findCanonicalMappingConflict(mappings, "client-a", "task-a"),
  null,
  "repeat binding by the same client is idempotent",
);

const limited = classifyCanonicalClientListPreflight({
  evidence,
  localClients: [
    { id: "client-a", name: "A" },
    { id: "client-b", name: "B" },
    { id: "client-c", name: "C" },
  ],
  departments: [],
  destinations: [],
  mappings: [
    mapping({ id: "map-a", clientId: "client-a", taskId: "task-a" }),
    mapping({ id: "map-b", clientId: "client-b", taskId: "task-b" }),
    mapping({ id: "map-c", clientId: "client-c", taskId: "task-c" }),
  ],
  limit: 2,
});
assert.equal(limited.mappings.length, 2, "bounded preflight limits response rows");
assert.equal(limited.totals.mappings, 3, "bounded preflight totals use the full input universe");
assert.equal(limited.truncated, true, "bounded preflight reports omitted findings truthfully");

const migration = readFileSync(
  "migrations/20260825150000_clickup_client_list_identity.sql",
  "utf8",
);
assert.match(
  migration,
  /UNIQUE INDEX IF NOT EXISTS cu_client_list_mapping_client_uniq[\s\S]*\(client_id\)/,
  "schema enforces exactly one canonical mapping per NoBull client",
);
assert.match(
  migration,
  /UNIQUE INDEX IF NOT EXISTS cu_client_list_mapping_task_uniq[\s\S]*\(list_id, task_id\)/,
  "schema refuses one canonical task being bound to multiple clients",
);
assert.match(
  migration,
  /ownership_verified_at timestamp NOT NULL/,
  "every persisted binding requires owning-list verification evidence",
);
assert.match(
  migration,
  /ADD COLUMN IF NOT EXISTS people_field_label[\s\S]*ADD COLUMN IF NOT EXISTS people_field_type/,
  "migration is repeat-safe and adds reviewed exact role-field metadata",
);

console.log("clickup-client-list-identity: all assertions passed");