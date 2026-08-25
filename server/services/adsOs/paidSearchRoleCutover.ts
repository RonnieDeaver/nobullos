// @db-pool-intent: ambient
/**
 * Task #5157 — Paid Search role cutover service.
 *
 * Handles:
 *  1. Cutover mode state: GET/PUT via one validated JSON system setting
 *     ("paid_search_role_cutover_state"). Modes: legacy | compare | universal.
 *  2. Preview: bounded CEO-only read-only preview comparing ClickUp parents
 *     to NoBull customers, the unique Paid Search department, its members,
 *     existing assignments, and projection destinations.
 *  3. Role overlay resolver contract: given rows with canonical ClickUp client
 *     name + legacy doer/checker, return mode + display doer/checker.
 *  4. Import helpers: used by the prod action (paidSearchRoleImportAction.ts).
 *
 * This service owns NO scheduler/queue/pool changes.
 * Interactive writes use the assignment boundary's normal projection path.
 * The one-time import uses its dedicated NoBull-only mutation so it cannot
 * stage or execute ClickUp writes.
 */

import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  sdDepartments,
  sdDepartmentMembers,
  sdClientDeptAssignments,
  cuRoleProjectionDestinations,
  cuRoleProjectionClientTargets,
  type CuRoleProjectionDestination,
} from "@shared/schema";
import { clients } from "@shared/models/clients";
import {
  psRoleImportAudit,
  psRoleImportAttempts,
} from "@shared/models/paidSearchRoleImport";
import type { ProjectionTx } from "../clickUpRoleProjectionKick";
import { users } from "@shared/models/auth";
import { getDb, withDbAttribution } from "../../db";
import { storage } from "../../storage";
import {
  normClientName,
  fetchDirectoryEvidence,
  type ParentEvidence,
  type DirectoryEvidence,
} from "./clickUpDirectory";
import {
  CANONICAL_PRODUCTION_LIST_ID,
  CLICKUP_DOER_FIELD_ID,
  CLICKUP_CHECKER_FIELD_ID,
  PAID_SEARCH_DEPT_NAME,
} from "./paidSearchRoleContract";
export { PAID_SEARCH_DEPT_NAME } from "./paidSearchRoleContract";
import { PAID_SEARCH_CUTOVER_SETTING_KEY as GATE_SETTING_KEY } from "./paidSearchCutoverGate";
import {
  resolveEffectiveRolesForClientsBatched,
  setClientDepartmentAssignmentNoProjection,
  type BatchedEffectiveRole,
} from "../assignmentBoundary";

// ---------------------------------------------------------------------------
// System setting key for cutover state
// ---------------------------------------------------------------------------

// Single source of truth for the setting key lives in the cycle-free gate leaf.
export const PAID_SEARCH_CUTOVER_SETTING_KEY = GATE_SETTING_KEY;

// ---------------------------------------------------------------------------
// Canonical Paid Search department name (fail-closed detection)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mode definitions
// ---------------------------------------------------------------------------

export const CUTOVER_MODES = ["legacy", "compare", "universal"] as const;
export type CutoverMode = (typeof CUTOVER_MODES)[number];

export interface CutoverState {
  mode: CutoverMode;
  projectionWritesEnabled: boolean;
  // Explicit approval stamps (must be present to enable certain modes)
  readApproved: boolean;
  readApprovedBy: string | null;
  readApprovedAt: string | null;
  projectionWriteApproved: boolean;
  projectionWriteApprovedBy: string | null;
  projectionWriteApprovedAt: string | null;
  // Exact Paid Search department id captured when projection writes are
  // enabled. The projection worker's fresh gate matches this against the
  // destination's department before allowing any governed mutation.
  approvedDepartmentId: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

const DEFAULT_CUTOVER_STATE: CutoverState = {
  mode: "legacy",
  projectionWritesEnabled: false,
  readApproved: false,
  readApprovedBy: null,
  readApprovedAt: null,
  projectionWriteApproved: false,
  projectionWriteApprovedBy: null,
  projectionWriteApprovedAt: null,
  approvedDepartmentId: null,
  updatedBy: null,
  updatedAt: null,
};

export async function getCutoverState(): Promise<CutoverState> {
  try {
    // Cutover state is safety-critical. Read it fresh so a cross-instance
    // revoke or mode change is honored immediately rather than after a cache
    // TTL. The worker independently performs the same fresh read before every
    // governed mutation.
    const setting = await storage.getSystemSettingFresh(PAID_SEARCH_CUTOVER_SETTING_KEY);
    if (!setting?.value) return { ...DEFAULT_CUTOVER_STATE };
    const parsed = JSON.parse(setting.value);
    return normalizeCutoverState(parsed);
  } catch (err: any) {
    console.warn(`[PaidSearchCutover] getCutoverState failed: ${err?.message ?? err}`);
    return { ...DEFAULT_CUTOVER_STATE };
  }
}

function normalizeCutoverState(raw: any): CutoverState {
  const mode: CutoverMode = CUTOVER_MODES.includes(raw?.mode) ? raw.mode : "legacy";
  const projectionWritesEnabled = raw?.projectionWritesEnabled === true;
  const readApproved = raw?.readApproved === true;
  const projectionWriteApproved = raw?.projectionWriteApproved === true;

  // Safety: universal reads require explicit read approval.
  const effectiveMode: CutoverMode =
    mode === "universal" && !readApproved ? "legacy" : mode;

  const approvedDepartmentId =
    typeof raw?.approvedDepartmentId === "string" && raw.approvedDepartmentId.length > 0
      ? raw.approvedDepartmentId
      : null;

  // Safety: projection writes require both approvals AND an exact persisted
  // department scope. A malformed state can never authorize an unscoped write.
  const effectiveProjWrites =
    projectionWritesEnabled &&
    readApproved &&
    projectionWriteApproved &&
    approvedDepartmentId !== null;

  return {
    mode: effectiveMode,
    projectionWritesEnabled: effectiveProjWrites,
    readApproved,
    readApprovedBy: raw?.readApprovedBy ?? null,
    readApprovedAt: raw?.readApprovedAt ?? null,
    projectionWriteApproved,
    projectionWriteApprovedBy: raw?.projectionWriteApprovedBy ?? null,
    projectionWriteApprovedAt: raw?.projectionWriteApprovedAt ?? null,
    approvedDepartmentId,
    updatedBy: raw?.updatedBy ?? null,
    updatedAt: raw?.updatedAt ?? null,
  };
}

export type CutoverStateAction =
  | "setMode"
  | "setProjectionWritesEnabled"
  | "approveRead"
  | "revokeRead"
  | "approveProjectionWrite"
  | "revokeProjectionWrite";

export interface CutoverStatePatch {
  action: CutoverStateAction;
  mode?: CutoverMode;
  projectionWritesEnabled?: boolean;
}

export type PutCutoverStateResult =
  | { ok: true; state: CutoverState }
  | { ok: false; error: string };

/**
 * Update cutover state. Validates business rules fail-closed:
 *  - universal mode requires readApproved first.
 *  - projectionWritesEnabled=true requires readApproved + projectionWriteApproved
 *    + existing production destinations for Doer/Checker using the two canonical
 *    field IDs only.
 *  - Revocation safely returns to legacy / writes false as applicable.
 */
export async function putCutoverState(
  patch: CutoverStatePatch,
  actorId: string,
  now: Date = new Date(),
): Promise<PutCutoverStateResult> {
  const current = await getCutoverState();
  const nowIso = now.toISOString();
  let next = { ...current, updatedBy: actorId, updatedAt: nowIso };

  switch (patch.action) {
    case "setMode": {
      const mode = patch.mode;
      if (!mode || !CUTOVER_MODES.includes(mode)) {
        return { ok: false, error: "Invalid mode. Must be legacy, compare, or universal." };
      }
      if (mode === "universal" && !current.readApproved) {
        return {
          ok: false,
          error:
            "Universal mode requires explicit read approval first. Use action=approveRead.",
        };
      }
      next.mode = mode;
      break;
    }
    case "setProjectionWritesEnabled": {
      const enable = patch.projectionWritesEnabled;
      if (enable === undefined) {
        return { ok: false, error: "projectionWritesEnabled boolean is required." };
      }
      if (enable) {
        if (!current.readApproved) {
          return {
            ok: false,
            error: "Projection writes require read approval first. Use action=approveRead.",
          };
        }
        if (!current.projectionWriteApproved) {
          return {
            ok: false,
            error:
              "Projection writes require projection write approval. Use action=approveProjectionWrite.",
          };
        }
        // Validate canonical production destinations exist for Doer/Checker.
        const destCheck = await validateProductionDestinations();
        if (!destCheck.ok) {
          return { ok: false, error: destCheck.error };
        }
        // Persist the exact Paid Search department id the fresh worker gate
        // will match against before allowing a governed mutation.
        next.approvedDepartmentId = destCheck.departmentId;
      }
      next.projectionWritesEnabled = !!enable;
      break;
    }
    case "approveRead": {
      next.readApproved = true;
      next.readApprovedBy = actorId;
      next.readApprovedAt = nowIso;
      break;
    }
    case "revokeRead": {
      // Revoking read approval forces mode back to legacy and disables writes.
      next.readApproved = false;
      next.readApprovedBy = null;
      next.readApprovedAt = null;
      next.mode = "legacy";
      next.projectionWritesEnabled = false;
      break;
    }
    case "approveProjectionWrite": {
      if (!current.readApproved) {
        return {
          ok: false,
          error: "Read approval is required before projection write approval.",
        };
      }
      next.projectionWriteApproved = true;
      next.projectionWriteApprovedBy = actorId;
      next.projectionWriteApprovedAt = nowIso;
      break;
    }
    case "revokeProjectionWrite": {
      next.projectionWriteApproved = false;
      next.projectionWriteApprovedBy = null;
      next.projectionWriteApprovedAt = null;
      next.projectionWritesEnabled = false;
      break;
    }
    default: {
      return { ok: false, error: `Unknown action: ${(patch as any).action}` };
    }
  }

  const normalized = normalizeCutoverState(next);
  await storage.setSystemSetting(
    PAID_SEARCH_CUTOVER_SETTING_KEY,
    JSON.stringify(normalized),
    actorId,
  );
  return { ok: true, state: normalized };
}

/**
 * Validate that production destinations for Doer (responsibility=doer) and
 * Checker (responsibility=checker) exist, are enabled, and have the two
 * canonical People field IDs.
 */
async function validateProductionDestinations(): Promise<
  { ok: true; departmentId: string } | { ok: false; error: string }
> {
  const dept = await findPaidSearchDepartment();
  if (!dept.ok) return { ok: false, error: dept.error };

  const dests = await withDbAttribution(
    "paidSearchCutover:validateProductionDestinations",
    async () => {
      const db = getDb();
      return db
        .select()
        .from(cuRoleProjectionDestinations)
        .where(
          and(
            eq(cuRoleProjectionDestinations.departmentId, dept.department.id),
            eq(cuRoleProjectionDestinations.environment, "production"),
          ),
        );
    },
  );

  const byResponsibility = new Map<string, typeof dests[0]>();
  for (const d of dests) byResponsibility.set(d.responsibility, d);

  const doerDest = byResponsibility.get("doer");
  const checkerDest = byResponsibility.get("checker");

  if (!doerDest || !checkerDest) {
    return {
      ok: false,
      error:
        "Production destinations for both Doer and Checker must exist before enabling projection writes.",
    };
  }
  // Exact production contract only: the canonical list, per-client parent
  // targets, and the two existing People fields. Both generic destination
  // approvals are required in addition to the Paid Search cutover approvals.
  if (
    doerDest.listId !== CANONICAL_PRODUCTION_LIST_ID ||
    checkerDest.listId !== CANONICAL_PRODUCTION_LIST_ID
  ) {
    return {
      ok: false,
      error:
        `Both destinations must use the canonical production Client List ${CANONICAL_PRODUCTION_LIST_ID}.`,
    };
  }
  if (
    doerDest.targetKind !== "client_list_parent" ||
    checkerDest.targetKind !== "client_list_parent"
  ) {
    return {
      ok: false,
      error: "Both destinations must use client_list_parent targets.",
    };
  }
  // Canonical field IDs only.
  if (
    doerDest.peopleFieldId !== CLICKUP_DOER_FIELD_ID ||
    checkerDest.peopleFieldId !== CLICKUP_CHECKER_FIELD_ID
  ) {
    return {
      ok: false,
      error:
        `Destinations must use the canonical People field IDs (doer: ${CLICKUP_DOER_FIELD_ID}, checker: ${CLICKUP_CHECKER_FIELD_ID}).`,
    };
  }
  if (!doerDest.enabled || !checkerDest.enabled) {
    return {
      ok: false,
      error:
        "Both Doer and Checker production destinations must be enabled before enabling projection writes.",
    };
  }
  if (
    !doerDest.sandboxExitApprovedAt ||
    !checkerDest.sandboxExitApprovedAt ||
    !doerDest.ownerApprovedAt ||
    !checkerDest.ownerApprovedAt
  ) {
    return {
      ok: false,
      error:
        "Both Doer and Checker production destinations require sandbox-exit and owner approval before enabling projection writes.",
    };
  }
  return { ok: true, departmentId: dept.department.id };
}

// ---------------------------------------------------------------------------
// Department detection: fail-closed on duplicate/missing
// ---------------------------------------------------------------------------

type FindDeptResult =
  | { ok: true; department: typeof sdDepartments.$inferSelect }
  | { ok: false; error: string };

/**
 * Find the unique Paid Search department by exact name match.
 * Fail-closed: returns error on duplicate or missing.
 */
export async function findPaidSearchDepartment(): Promise<FindDeptResult> {
  return withDbAttribution("paidSearchCutover:findDept", async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(sdDepartments)
      .where(eq(sdDepartments.name, PAID_SEARCH_DEPT_NAME));

    if (rows.length === 0) {
      return {
        ok: false,
        error: `Paid Search department not found. Expected exact name: "${PAID_SEARCH_DEPT_NAME}".`,
      };
    }
    if (rows.length > 1) {
      return {
        ok: false,
        error: `Duplicate Paid Search departments found (${rows.length}). Cannot proceed — resolve duplicates first.`,
      };
    }
    return { ok: true, department: rows[0] };
  });
}

// ---------------------------------------------------------------------------
// Preview: bounded read-only comparison
// ---------------------------------------------------------------------------

/**
 * Build clickupUserId → NoBull userId map with duplicate detection.
 * A ClickUp user ID that resolves to more than one distinct active member
 * userId is recorded as "dup" (ambiguous) rather than last-write-wins.
 */
function buildMemberByClickupId(
  members: Array<{ userId: string; clickupUserId: string | null }>,
): Map<string, string | "dup"> {
  const out = new Map<string, string | "dup">();
  for (const m of members) {
    if (!m.clickupUserId) continue;
    const existing = out.get(m.clickupUserId);
    if (existing === undefined) {
      out.set(m.clickupUserId, m.userId);
    } else if (existing !== "dup" && existing !== m.userId) {
      out.set(m.clickupUserId, "dup");
    }
  }
  return out;
}

/**
 * Matching normalizer for parent↔client name matching (Task #5157 fix 4).
 *
 * STRICT exact match: trim + case-insensitive only. Internal whitespace is
 * PRESERVED (NOT collapsed) — two names match only when byte-identical after
 * trimming leading/trailing whitespace and lowercasing. This is deliberately
 * stricter than the directory's normClientName (which collapses internal
 * runs of whitespace): a name-fallback match must never fuzz two visibly
 * different ClickUp/NoBull names into one. No whitespace collapse, no token
 * reordering, no punctuation stripping, no legal-suffix handling, no
 * email/username signals.
 */
export function normClientNameForMatch(name: string): string {
  return name.trim().toLowerCase();
}

export const PREVIEW_MAX_PARENTS = 500;

export interface PreviewFlag {
  code: string;
  message: string;
}

export interface PreviewRow {
  /** Stable ClickUp parent task ID. */
  clickupTaskId: string;
  /** Canonical ClickUp client name (display). */
  clickupClientName: string;
  /** Normalized ClickUp client name (for matching). */
  normName: string;
  /** ClickUp raw status. */
  clickupStatus: string;
  /** Whether this parent is excluded (offboarded). */
  excluded: boolean;
  /** Whether this parent has missing products (no GAds/LSA subtasks). */
  missingProduct: boolean;
  /** Whether this parent name is a duplicate (multiple parents same norm name). */
  duplicateName: boolean;
  /** Doer ClickUp user ID(s) from People field (raw). */
  doerClickupIds: string[];
  /** Checker ClickUp user ID(s) from People field (raw). */
  checkerClickupIds: string[];
  /** Whether doer has multiple people (flags a data quality issue). */
  doerMultiPerson: boolean;
  /** Whether checker has multiple people. */
  checkerMultiPerson: boolean;
  /** Matched NoBull client ID (null if unmapped). */
  matchedClientId: string | null;
  /** Matched NoBull client firmName (null if unmapped). */
  matchedClientName: string | null;
  /** Whether the NoBull client name is a duplicate (multiple clients same case-insensitive match). */
  duplicateClientName: boolean;
  /** Whether the ClickUp doer user ID has a mapped NoBull member. */
  doerMapped: boolean;
  /** Whether the ClickUp checker user ID has a mapped NoBull member. */
  checkerMapped: boolean;
  /** NoBull user ID for the resolved doer (null if unmapped). */
  doerNobullUserId: string | null;
  /** NoBull user ID for the resolved checker (null if unmapped). */
  checkerNobullUserId: string | null;
  /** Existing NoBull assignment primary user ID (null if none). */
  existingPrimaryUserId: string | null;
  /** Existing NoBull assignment checker user ID (null if none). */
  existingCheckerUserId: string | null;
  /** Whether a production Doer projection destination exists with this client's target. */
  hasDoerDestinationTarget: boolean;
  /** Whether a production Checker projection destination exists with this client's target. */
  hasCheckerDestinationTarget: boolean;
  /** How the client was matched: "binding" (stable target), "name" (exact), or null. */
  matchedVia: "binding" | "name" | null;
  /** Doer People field metadata (id/name/type), safe to display. */
  doerFieldMeta: { id: string; name: string; type: string } | null;
  /** Checker People field metadata (id/name/type), safe to display. */
  checkerFieldMeta: { id: string; name: string; type: string } | null;
  /** Other parent task IDs sharing this norm name (duplicate provenance). */
  duplicateTaskIds: string[];
  /** Distinct client IDs bound to this parent's stable task id (binding provenance). */
  boundClientIds: string[];
  /** GAds/LSA subtask evidence found under this parent (subtaskId/name/product/cid). */
  productEvidence: Array<{
    subtaskId: string;
    subtaskName: string;
    product: "gads" | "lsa" | null;
    cid: string | null;
  }>;
  /** Whether any subtask carries a GAds CID. */
  hasGads: boolean;
  /** Whether any subtask carries an LSA CID. */
  hasLsa: boolean;
  /**
   * Effective NoBull universal doer user ID for the matched client (Task #5157
   * fix 6). Uses the batched override-then-default resolver + active-member
   * eligibility semantics. null when unmatched OR the effective doer is
   * unresolved/ineligible — universal unresolved stays null. The compare
   * DISPLAY continues to show legacy ClickUp values elsewhere; these fields are
   * pure evidence.
   */
  universalDoerUserId: string | null;
  /** Effective NoBull universal checker user ID for the matched client. */
  universalCheckerUserId: string | null;
  /**
   * Whether the ClickUp-derived doer (doerNobullUserId) differs from the
   * NoBull universal effective doer. null when there is nothing to compare
   * (unmatched client, or the universal doer is unresolved/null).
   */
  doerMismatch: boolean | null;
  /** Whether the ClickUp-derived checker differs from the universal checker. */
  checkerMismatch: boolean | null;
  /** Flags for this row. */
  flags: PreviewFlag[];
  /** Whether this row is eligible for import (no blocking flags). */
  eligible: boolean;
}

export interface PreviewResult {
  ok: boolean;
  error?: string;
  /** Unique Paid Search department ID (null if not found/duplicate). */
  departmentId: string | null;
  /** Counts summary. */
  summary: {
    totalParents: number;
    liveParents: number;
    excludedParents: number;
    eligibleForImport: number;
    flaggedRows: number;
    dupNames: number;
    missingProduct: number;
    unmappedClients: number;
    unmappedDoer: number;
    unmappedChecker: number;
    conflict: number;
  };
  /** Bounded rows (at most PREVIEW_MAX_PARENTS). */
  rows: PreviewRow[];
  truncated: boolean;
  fetchedAt: number;
}

/**
 * Build the bounded paid-search role cutover preview.
 * Returns at most PREVIEW_MAX_PARENTS parent rows.
 *
 * Match parent→client:
 *   1. Persisted exact target binding (cu_role_projection_client_targets) first.
 *   2. Else UNIQUE case-insensitive exact firmName match among NoBull customer clients.
 *
 * No fuzzy/AI/email/username/legal-suffix matching.
 */
export async function buildPreview(): Promise<PreviewResult> {
  const emptyResult = (error: string): PreviewResult => ({
    ok: false,
    error,
    departmentId: null,
    summary: {
      totalParents: 0, liveParents: 0, excludedParents: 0,
      eligibleForImport: 0, flaggedRows: 0, dupNames: 0,
      missingProduct: 0, unmappedClients: 0, unmappedDoer: 0,
      unmappedChecker: 0, conflict: 0,
    },
    rows: [],
    truncated: false,
    fetchedAt: Date.now(),
  });

  // 1. Find the unique Paid Search department.
  const deptResult = await findPaidSearchDepartment();
  if (!deptResult.ok) return emptyResult(deptResult.error);
  const dept = deptResult.department;

  // 2. Fetch ClickUp evidence.
  const evidence = await fetchDirectoryEvidence();
  if (!evidence) {
    return emptyResult(
      "ClickUp evidence fetch failed. Check ClickUp configuration.",
    );
  }

  // 3. Load DB data in parallel.
  const [
    customerClients,
    deptMembers,
    existingAssignments,
    productionDests,
  ] = await withDbAttribution("paidSearchCutover:preview:load", async () => {
    const db = getDb();
    return Promise.all([
      // NoBull customer clients (not archived, not demo, lifecycleStage=customer).
      db
        .select({
          id: clients.id,
          firmName: clients.firmName,
          isArchived: clients.isArchived,
          isDemo: clients.isDemo,
          lifecycleStage: clients.lifecycleStage,
        })
        .from(clients)
        .where(
          and(
            eq(clients.isArchived, false),
            eq(clients.isDemo, false),
            eq(clients.lifecycleStage, "customer"),
          ),
        ),
      // Active department members.
      db
        .select({
          userId: sdDepartmentMembers.userId,
          clickupUserId: sdDepartmentMembers.clickupUserId,
          active: sdDepartmentMembers.active,
        })
        .from(sdDepartmentMembers)
        .where(
          and(
            eq(sdDepartmentMembers.departmentId, dept.id),
            eq(sdDepartmentMembers.active, true),
          ),
        ),
      // Existing client→dept assignments.
      db
        .select()
        .from(sdClientDeptAssignments)
        .where(eq(sdClientDeptAssignments.departmentId, dept.id)),
      // Production projection destinations for this dept.
      db
        .select()
        .from(cuRoleProjectionDestinations)
        .where(
          and(
            eq(cuRoleProjectionDestinations.departmentId, dept.id),
            eq(cuRoleProjectionDestinations.environment, "production"),
          ),
        ),
    ]);
  });

  // 4. Build indices.
  // NoBull client by STRICT match key (trim + lowercase only, NO whitespace
  // collapse — Task #5157 fix 4) → { id, firmName }[].
  const clientsByNorm = new Map<string, Array<{ id: string; firmName: string }>>();
  for (const c of customerClients) {
    const key = normClientNameForMatch(c.firmName);
    if (!clientsByNorm.has(key)) clientsByNorm.set(key, []);
    clientsByNorm.get(key)!.push({ id: c.id, firmName: c.firmName });
  }

  // Member by clickupUserId → NoBull userId. A ClickUp user ID mapped to more
  // than one active member is AMBIGUOUS: we record "dup" and never pick a
  // last-write-wins winner.
  const memberByClickupId = buildMemberByClickupId(deptMembers);

  // Existing assignment by clientId.
  const assignmentByClient = new Map<string, typeof existingAssignments[0]>();
  for (const a of existingAssignments) {
    assignmentByClient.set(a.clientId, a);
  }

  // Production destination by responsibility.
  const destByResp = new Map<string, typeof productionDests[0]>();
  for (const d of productionDests) destByResp.set(d.responsibility, d);
  const doerDestId = destByResp.get("doer")?.id;
  const checkerDestId = destByResp.get("checker")?.id;

  // Load client targets for any production destinations we found.
  let clientTargetByClientAndDest = new Map<string, string>(); // `${clientId}:${destId}` → taskId
  // Reverse index: parent taskId → distinct client ids bound to it (both dests).
  const bindingClientsByTaskId = new Map<string, Set<string>>();
  const clientById = new Map<string, { id: string; firmName: string }>();
  for (const c of customerClients) clientById.set(c.id, { id: c.id, firmName: c.firmName });
  if (doerDestId || checkerDestId) {
    const destIds = [doerDestId, checkerDestId].filter((x): x is string => !!x);
    const allClientIds = customerClients.map((c) => c.id);
    if (allClientIds.length > 0) {
      const targets = await withDbAttribution(
        "paidSearchCutover:preview:loadTargets",
        async () => {
          const db = getDb();
          return db
            .select()
            .from(cuRoleProjectionClientTargets)
            .where(
              and(
                inArray(cuRoleProjectionClientTargets.clientId, allClientIds),
                inArray(cuRoleProjectionClientTargets.destinationId, destIds),
              ),
            );
        },
      );
      for (const t of targets) {
        clientTargetByClientAndDest.set(
          `${t.clientId}:${t.destinationId}`,
          t.targetId,
        );
        // Reverse index for stable-binding matching: parent taskId →
        // set of distinct client ids bound to it across BOTH destinations.
        const set = bindingClientsByTaskId.get(t.targetId) ?? new Set<string>();
        set.add(t.clientId);
        bindingClientsByTaskId.set(t.targetId, set);
      }
    }
  }

  // Compare-evidence (Task #5157 fix 6): resolve the NoBull universal effective
  // doer/checker for EVERY customer client in ONE bounded batched load (no
  // N+1), reusing the canonical override-then-default + active-member
  // eligibility semantics. Ineligible/unresolved effective roles surface as
  // null. Failure is non-fatal: the compare booleans degrade to null.
  let effectiveByClient = new Map<
    string,
    { doer: BatchedEffectiveRole; checker: BatchedEffectiveRole }
  >();
  try {
    effectiveByClient = await resolveEffectiveRolesForClientsBatched({
      departmentId: dept.id,
      clientIds: customerClients.map((c) => c.id),
    });
  } catch (err: any) {
    console.warn(
      `[PaidSearchCutover] preview compare-evidence resolve failed (booleans null): ${err?.message ?? err}`,
    );
  }
  const universalRoleFor = (
    role: BatchedEffectiveRole | undefined,
  ): string | null => (role && role.userId && role.eligible ? role.userId : null);

  // 5. Process parents.
  const parents = evidence.parents.slice(0, PREVIEW_MAX_PARENTS);
  const truncated = evidence.parents.length > PREVIEW_MAX_PARENTS;
  const rows: PreviewRow[] = [];

  let liveParents = 0;
  let excludedParents = 0;
  let eligibleForImport = 0;
  let flaggedRows = 0;
  let dupNames = 0;
  let missingProduct = 0;
  let unmappedClients = 0;
  let unmappedDoer = 0;
  let unmappedChecker = 0;
  let conflict = 0;

  for (const parent of parents) {
    const flags: PreviewFlag[] = [];

    if (parent.excluded) excludedParents++;
    else liveParents++;

    // Duplicate ClickUp parent name (raw signal). Whether this BLOCKS the row
    // is decided AFTER matching: a duplicate parent name only blocks when the
    // client is (or would be) resolved by NAME fallback. A parent with exactly
    // one unambiguous stable target binding can still be imported despite a
    // duplicate name (Task #5157 fix 4). The blocking flag is pushed later.
    const isDupName = parent.duplicateNormNameTaskIds.length > 0;

    // Excluded check.
    if (parent.excluded) {
      flags.push({
        code: "excluded",
        message: `Parent status "${parent.status}" is excluded (offboarded).`,
      });
    }

    // Missing product check.
    if (parent.missingProduct) {
      missingProduct++;
      flags.push({
        code: "missing_product",
        message: "Parent has no subtasks with a recognized GAds or LSA product CID.",
      });
    }

    // Doer multi-person.
    const doerMultiPerson = parent.doerPeople.length > 1;
    if (doerMultiPerson) {
      flags.push({
        code: "doer_multi_person",
        message: `Doer field has ${parent.doerPeople.length} people (must be 1 for import).`,
      });
    }

    // Checker multi-person.
    const checkerMultiPerson = parent.checkerPeople.length > 1;
    if (checkerMultiPerson) {
      flags.push({
        code: "checker_multi_person",
        message: `Checker field has ${parent.checkerPeople.length} people (must be 1 for import).`,
      });
    }

    // Doer/checker blank.
    const doerBlank = parent.doerPeople.length === 0;
    const checkerBlank = parent.checkerPeople.length === 0;
    if (doerBlank) {
      flags.push({ code: "doer_blank", message: "Doer People field is blank." });
    }
    if (checkerBlank) {
      flags.push({ code: "checker_blank", message: "Checker People field is blank." });
    }

    // Client matching:
    //  1. Stable target binding FIRST — matches only if EXACTLY ONE distinct
    //     client is bound to this parent's stable task id across both dests.
    //     A conflicting/duplicate binding (>1 client) is flagged ambiguous and
    //     the row is ineligible; we never pick the first binding.
    //  2. Else UNIQUE case-insensitive exact firmName match.
    let matchedClientId: string | null = null;
    let matchedClientName: string | null = null;
    let dupClientName = false;
    let matchedVia: "binding" | "name" | null = null;
    let ambiguousBinding = false;

    const boundClients = bindingClientsByTaskId.get(parent.taskId);
    if (boundClients && boundClients.size > 0) {
      if (boundClients.size === 1) {
        const onlyId = [...boundClients][0];
        const c = clientById.get(onlyId);
        if (c) {
          matchedClientId = c.id;
          matchedClientName = c.firmName;
          matchedVia = "binding";
        }
      } else {
        ambiguousBinding = true;
        flags.push({
          code: "ambiguous_target_binding",
          message: `Parent task ${parent.taskId} is bound to ${boundClients.size} distinct clients across projection destinations — ambiguous, cannot auto-match.`,
        });
      }
    }

    // Fallback: unique case-insensitive exact firmName match (STRICT — trim +
    // lowercase only, NO whitespace collapse, Task #5157 fix 4).
    if (!matchedClientId && !ambiguousBinding) {
      const candidates = clientsByNorm.get(normClientNameForMatch(parent.name)) ?? [];
      if (candidates.length === 1) {
        matchedClientId = candidates[0].id;
        matchedClientName = candidates[0].firmName;
        matchedVia = "name";
      } else if (candidates.length > 1) {
        dupClientName = true;
        flags.push({
          code: "duplicate_client_name",
          message: `NoBull has ${candidates.length} customers matching "${parent.name}" — cannot auto-match.`,
        });
      }
    }

    if (!matchedClientId && !dupClientName && !ambiguousBinding) {
      unmappedClients++;
      flags.push({
        code: "unmapped_client",
        message: `No NoBull customer matches "${parent.name}" by exact name.`,
      });
    }

    // Duplicate parent name BLOCKS only when the match relies on NAME fallback
    // (matchedVia !== "binding"). A single unambiguous stable binding beats the
    // ambiguity of a shared name and is importable (Task #5157 fix 4).
    const dupNameBlocks = isDupName && matchedVia !== "binding";
    if (isDupName) dupNames++;
    if (dupNameBlocks) {
      flags.push({
        code: "duplicate_parent_name",
        message: `Parent name "${parent.name}" appears ${parent.duplicateNormNameTaskIds.length + 1} times in the list and no unambiguous stable binding resolves it.`,
      });
    }

    // Member mapping.
    const doerClickupId =
      parent.doerPeople.length === 1 ? parent.doerPeople[0].clickupUserId : null;
    const checkerClickupId =
      parent.checkerPeople.length === 1 ? parent.checkerPeople[0].clickupUserId : null;

    const doerLookup = doerClickupId ? memberByClickupId.get(doerClickupId) : undefined;
    const checkerLookup = checkerClickupId ? memberByClickupId.get(checkerClickupId) : undefined;
    const doerDup = doerLookup === "dup";
    const checkerDup = checkerLookup === "dup";
    const doerNobullUserId = doerLookup && doerLookup !== "dup" ? doerLookup : null;
    const checkerNobullUserId =
      checkerLookup && checkerLookup !== "dup" ? checkerLookup : null;

    const doerMapped = !!doerNobullUserId;
    const checkerMapped = !!checkerNobullUserId;

    if (doerDup) {
      flags.push({
        code: "ambiguous_doer_member",
        message: `ClickUp doer ID "${doerClickupId}" maps to more than one active member — ambiguous, cannot import.`,
      });
    } else if (doerClickupId && !doerMapped) {
      unmappedDoer++;
      flags.push({
        code: "unmapped_doer",
        message: `ClickUp doer ID "${doerClickupId}" has no matching active Paid Search department member.`,
      });
    }
    if (checkerDup) {
      flags.push({
        code: "ambiguous_checker_member",
        message: `ClickUp checker ID "${checkerClickupId}" maps to more than one active member — ambiguous, cannot import.`,
      });
    } else if (checkerClickupId && !checkerMapped) {
      unmappedChecker++;
      flags.push({
        code: "unmapped_checker",
        message: `ClickUp checker ID "${checkerClickupId}" has no matching active Paid Search department member.`,
      });
    }

    // Existing assignment conflict check.
    const existingAssignment = matchedClientId
      ? assignmentByClient.get(matchedClientId)
      : null;
    const existingPrimaryUserId = existingAssignment?.primaryUserId ?? null;
    const existingCheckerUserId = existingAssignment?.checkerUserId ?? null;

    // Conflict: existing non-null primary differs from desired doer.
    if (
      existingPrimaryUserId &&
      doerNobullUserId &&
      existingPrimaryUserId !== doerNobullUserId
    ) {
      conflict++;
      flags.push({
        code: "conflict_doer",
        message: `Existing doer assignment differs from ClickUp value — would not overwrite.`,
      });
    }
    // Conflict: existing non-null checker differs from desired checker.
    if (
      existingCheckerUserId &&
      checkerNobullUserId &&
      existingCheckerUserId !== checkerNobullUserId
    ) {
      conflict++;
      flags.push({
        code: "conflict_checker",
        message: `Existing checker assignment differs from ClickUp value — would not overwrite.`,
      });
    }

    // Production target evidence.
    const hasDoerDestinationTarget = !!(
      matchedClientId && doerDestId &&
      clientTargetByClientAndDest.has(`${matchedClientId}:${doerDestId}`)
    );
    const hasCheckerDestinationTarget = !!(
      matchedClientId && checkerDestId &&
      clientTargetByClientAndDest.has(`${matchedClientId}:${checkerDestId}`)
    );

    // Eligible for import: must have matched client, at least one People ID
    // that maps to a member, no duplicate name, no multi-person, not excluded,
    // no conflict on that role.
    const blockingCodes = [
      "conflict_doer",
      "conflict_checker",
      "unmapped_client",
      "duplicate_client_name",
      "duplicate_parent_name",
      "ambiguous_target_binding",
      "ambiguous_doer_member",
      "ambiguous_checker_member",
    ];
    const eligible =
      !parent.excluded &&
      !dupNameBlocks &&
      !dupClientName &&
      !ambiguousBinding &&
      !doerDup &&
      !checkerDup &&
      !!matchedClientId &&
      flags.filter((f) => blockingCodes.includes(f.code)).length === 0 &&
      (doerMapped || checkerMapped);

    if (eligible) eligibleForImport++;
    if (flags.length > 0) flaggedRows++;

    // Compare-evidence (fix 6): universal effective doer/checker + per-role
    // mismatch booleans. Only meaningful for a matched client; the universal
    // value stays null when unresolved/ineligible. Mismatch is null when there
    // is nothing to compare (no matched client OR null universal value).
    const effective = matchedClientId ? effectiveByClient.get(matchedClientId) : undefined;
    const universalDoerUserId = universalRoleFor(effective?.doer);
    const universalCheckerUserId = universalRoleFor(effective?.checker);
    const doerMismatch =
      matchedClientId && universalDoerUserId !== null
        ? universalDoerUserId !== doerNobullUserId
        : null;
    const checkerMismatch =
      matchedClientId && universalCheckerUserId !== null
        ? universalCheckerUserId !== checkerNobullUserId
        : null;

    rows.push({
      clickupTaskId: parent.taskId,
      clickupClientName: parent.name,
      normName: parent.normName,
      clickupStatus: parent.status,
      excluded: parent.excluded,
      missingProduct: parent.missingProduct,
      duplicateName: isDupName,
      doerClickupIds: parent.doerPeople.map((p) => p.clickupUserId),
      checkerClickupIds: parent.checkerPeople.map((p) => p.clickupUserId),
      doerMultiPerson,
      checkerMultiPerson,
      matchedClientId,
      matchedClientName,
      duplicateClientName: dupClientName,
      doerMapped,
      checkerMapped,
      doerNobullUserId,
      checkerNobullUserId,
      existingPrimaryUserId,
      existingCheckerUserId,
      hasDoerDestinationTarget,
      hasCheckerDestinationTarget,
      matchedVia,
      doerFieldMeta: parent.doerFieldMeta,
      checkerFieldMeta: parent.checkerFieldMeta,
      duplicateTaskIds: parent.duplicateNormNameTaskIds,
      boundClientIds: boundClients ? [...boundClients] : [],
      productEvidence: parent.subtasks,
      hasGads: parent.hasGads,
      hasLsa: parent.hasLsa,
      universalDoerUserId,
      universalCheckerUserId,
      doerMismatch,
      checkerMismatch,
      flags,
      eligible,
    });
  }

  return {
    ok: true,
    departmentId: dept.id,
    summary: {
      totalParents: evidence.parents.length,
      liveParents,
      excludedParents,
      eligibleForImport,
      flaggedRows,
      dupNames,
      missingProduct,
      unmappedClients,
      unmappedDoer,
      unmappedChecker,
      conflict,
    },
    rows,
    truncated,
    fetchedAt: evidence.fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Role overlay resolver contract
// ---------------------------------------------------------------------------

export interface OverlayInputRow {
  /** Canonical ClickUp client name (unchanged by resolver). */
  clickupClientName: string;
  /** Legacy ClickUp doer (username or null). */
  legacyDoer: string | null;
  /** Legacy ClickUp checker (username or null). */
  legacyChecker: string | null;
}

export interface MismatchDiagnostic {
  field: "doer" | "checker";
  clickupValue: string | null;
  universalValue: string | null;
}

export interface OverlayOutputRow {
  /** Canonical ClickUp client name (unchanged). */
  clickupClientName: string;
  /** Active mode for this row. */
  mode: CutoverMode;
  /** Display doer (mode-dependent). */
  displayDoer: string | null;
  /** Display checker (mode-dependent). */
  displayChecker: string | null;
  /** Mismatch diagnostics (compare mode only, empty otherwise). */
  mismatches: MismatchDiagnostic[];
}

export interface OverlayResolverResult {
  rows: OverlayOutputRow[];
  /** Mode used for all rows in this batch. */
  mode: CutoverMode;
  /** Non-fatal diagnostics (e.g. DB failure → fell back to legacy). */
  diagnostics: string[];
}

/**
 * Batched exported role overlay resolver.
 *
 * Given rows with ClickUp canonical clientName and legacy doer/checker:
 *  - legacy: display ClickUp values (no NoBull lookup).
 *  - compare: display ClickUp values; record/return mismatch diagnostics.
 *  - universal: display NoBull effective Doer/Checker from resolveUniversalAssignment
 *    for exact uniquely matched clients; null for unassigned. Other roles are
 *    outside this cutover.
 *
 * Resolves display names from users without N+1 queries.
 * On DB/config failure: fail closed to legacy, expose safe diagnostics (no throw).
 */
export async function resolveRoleOverlay(
  rows: OverlayInputRow[],
  opts?: { departmentId?: string },
): Promise<OverlayResolverResult> {
  const diagnostics: string[] = [];

  let state: CutoverState;
  try {
    state = await getCutoverState();
  } catch (err: any) {
    diagnostics.push(`getCutoverState failed: ${err?.message ?? "unknown"} — falling back to legacy`);
    state = { ...DEFAULT_CUTOVER_STATE };
  }

  const mode = state.mode;

  // Fast path: legacy — return ClickUp values directly.
  if (mode === "legacy") {
    return {
      rows: rows.map((r) => ({
        clickupClientName: r.clickupClientName,
        mode,
        displayDoer: r.legacyDoer,
        displayChecker: r.legacyChecker,
        mismatches: [],
      })),
      mode,
      diagnostics,
    };
  }

  // For compare/universal: need department + client resolution.
  let dept: { id: string } | null = null;
  let deptError: string | null = null;
  try {
    const deptResult = await findPaidSearchDepartment();
    if (!deptResult.ok) {
      deptError = deptResult.error;
    } else {
      dept = deptResult.department;
    }
  } catch (err: any) {
    deptError = `findPaidSearchDepartment failed: ${err?.message ?? "unknown"}`;
  }

  if (!dept) {
    diagnostics.push(`${deptError} — falling back to legacy`);
    return {
      rows: rows.map((r) => ({
        clickupClientName: r.clickupClientName,
        mode: "legacy",
        displayDoer: r.legacyDoer,
        displayChecker: r.legacyChecker,
        mismatches: [],
      })),
      mode: "legacy",
      diagnostics,
    };
  }

  const departmentId = opts?.departmentId ?? dept.id;

  // Load NoBull customers for name matching (no N+1).
  let nobullClients: Array<{ id: string; firmName: string }> = [];
  try {
    nobullClients = await withDbAttribution("paidSearchCutover:overlay:clients", async () => {
      const db = getDb();
      return db
        .select({ id: clients.id, firmName: clients.firmName })
        .from(clients)
        .where(
          and(
            eq(clients.isArchived, false),
            eq(clients.isDemo, false),
            eq(clients.lifecycleStage, "customer"),
          ),
        );
    });
  } catch (err: any) {
    diagnostics.push(
      `clients load failed: ${err?.message ?? "unknown"} — falling back to legacy`,
    );
    return {
      rows: rows.map((r) => ({
        clickupClientName: r.clickupClientName,
        mode: "legacy",
        displayDoer: r.legacyDoer,
        displayChecker: r.legacyChecker,
        mismatches: [],
      })),
      mode: "legacy",
      diagnostics,
    };
  }

  // Build norm name → unique client map.
  const normToClient = new Map<string, { id: string; firmName: string } | "dup">();
  for (const c of nobullClients) {
    const key = normClientName(c.firmName);
    if (normToClient.has(key)) {
      normToClient.set(key, "dup");
    } else {
      normToClient.set(key, c);
    }
  }

  // Collect the set of UNIQUELY matched client ids (dup norm names excluded).
  const clientIds = new Set<string>();
  for (const row of rows) {
    const entry = normToClient.get(normClientName(row.clickupClientName));
    if (entry && entry !== "dup") clientIds.add(entry.id);
  }

  // Batched effective-role resolution — one bounded DB load, no N+1.
  // Whole-batch failure falls back to legacy display.
  let effectiveByClient = new Map<
    string,
    { doer: BatchedEffectiveRole; checker: BatchedEffectiveRole }
  >();
  try {
    effectiveByClient = await resolveEffectiveRolesForClientsBatched({
      departmentId,
      clientIds: [...clientIds],
    });
  } catch (err: any) {
    diagnostics.push(
      `batched effective-role resolve failed: ${err?.message ?? "unknown"} — falling back to legacy`,
    );
    return {
      rows: rows.map((r) => ({
        clickupClientName: r.clickupClientName,
        mode: "legacy",
        displayDoer: r.legacyDoer,
        displayChecker: r.legacyChecker,
        mismatches: [],
      })),
      mode: "legacy",
      diagnostics,
    };
  }

  // Batch-load display names for every effective userId in one query.
  const userIds = new Set<string>();
  for (const roles of effectiveByClient.values()) {
    if (roles.doer.userId) userIds.add(roles.doer.userId);
    if (roles.checker.userId) userIds.add(roles.checker.userId);
  }
  const userDisplayNames = new Map<string, string>();
  if (userIds.size > 0) {
    try {
      const userRows = await withDbAttribution(
        "paidSearchCutover:overlay:users",
        async () => {
          const db = getDb();
          return db
            .select({
              id: users.id,
              firstName: users.firstName,
              lastName: users.lastName,
              email: users.email,
            })
            .from(users)
            .where(inArray(users.id, [...userIds]));
        },
      );
      for (const u of userRows) {
        const name =
          [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
          u.email ||
          u.id;
        userDisplayNames.set(u.id, name);
      }
    } catch (err: any) {
      diagnostics.push(
        `users load failed: ${err?.message ?? "unknown"} — display names may be IDs`,
      );
    }
  }

  const displayFor = (role: BatchedEffectiveRole | undefined): string | null => {
    // Only eligible (active-member) users are surfaced; ineligible/stale → null.
    if (!role || !role.userId || !role.eligible) return null;
    return userDisplayNames.get(role.userId) ?? role.userId;
  };

  const outputRows: OverlayOutputRow[] = [];
  for (const row of rows) {
    const key = normClientName(row.clickupClientName);
    const entry = normToClient.get(key);
    const clientId = entry && entry !== "dup" ? entry.id : null;
    const effective = clientId ? effectiveByClient.get(clientId) : undefined;

    const universalDoerDisplay = displayFor(effective?.doer);
    const universalCheckerDisplay = displayFor(effective?.checker);

    let displayDoer: string | null;
    let displayChecker: string | null;
    let rowMode: CutoverMode = mode;
    const mismatches: MismatchDiagnostic[] = [];

    if (mode === "universal") {
      // Universal: matched client → NoBull effective values (null when
      // unresolved/ineligible). Unmatched/duplicate name → null roles (NOT
      // legacy), but the row's mode is reported legacy so callers
      // can distinguish "no NoBull mapping" from "universal blank".
      if (clientId) {
        displayDoer = universalDoerDisplay;
        displayChecker = universalCheckerDisplay;
        rowMode = "universal";
      } else {
        displayDoer = null;
        displayChecker = null;
        rowMode = "legacy";
      }
    } else {
      // Compare: always display ClickUp values; record mismatches vs NoBull.
      displayDoer = row.legacyDoer;
      displayChecker = row.legacyChecker;
      rowMode = "compare";
      if (clientId) {
        if (row.legacyDoer !== universalDoerDisplay) {
          mismatches.push({
            field: "doer",
            clickupValue: row.legacyDoer,
            universalValue: universalDoerDisplay,
          });
        }
        if (row.legacyChecker !== universalCheckerDisplay) {
          mismatches.push({
            field: "checker",
            clickupValue: row.legacyChecker,
            universalValue: universalCheckerDisplay,
          });
        }
      }
    }

    outputRows.push({
      clickupClientName: row.clickupClientName,
      mode: rowMode,
      displayDoer,
      displayChecker,
      mismatches,
    });
  }

  return {
    rows: outputRows,
    mode,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Dashboard-facing overlay adapter
// ---------------------------------------------------------------------------

/**
 * Resolves paid-search role overlays for a batch of ClickUp client rows.
 * Returns a Map from normalized client name → { doer, checker } for display.
 *
 * Signature matches the contract expected by amDashboard, dashboardService,
 * lsaDashboardService, and combinedDashboardService (all read callers are
 * NOT edited — they call this function). Fail closed to ClickUp values on
 * any error.
 */
export async function resolvePaidSearchRoleOverlays(
  inputs: Array<{ clientName: string; legacyDoer: string | null; legacyChecker: string | null }>,
): Promise<Map<string, { doer: string | null; checker: string | null }>> {
  const out = new Map<string, { doer: string | null; checker: string | null }>();

  if (inputs.length === 0) return out;

  try {
    const rows: OverlayInputRow[] = inputs.map((inp) => ({
      clickupClientName: inp.clientName,
      legacyDoer: inp.legacyDoer,
      legacyChecker: inp.legacyChecker,
    }));

    const result = await resolveRoleOverlay(rows);

    for (const row of result.rows) {
      out.set(normClientName(row.clickupClientName), {
        doer: row.displayDoer,
        checker: row.displayChecker,
      });
    }
  } catch (err: any) {
    // Fail closed: return ClickUp values directly.
    console.warn(
      `[PaidSearchCutover] resolvePaidSearchRoleOverlays failed (falling back to ClickUp): ${err?.message ?? err}`,
    );
    for (const inp of inputs) {
      out.set(normClientName(inp.clientName), {
        doer: inp.legacyDoer,
        checker: inp.legacyChecker,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Import helpers (used by the prod action)
// ---------------------------------------------------------------------------

export const IMPORT_MAX_PARENTS = 500;
export const IMPORT_MAX_ROLE_SLOTS = 1000;

export interface ImportAuditRowInput {
  clickupParentTaskId: string;
  role: "doer" | "checker";
  disposition:
    | "imported"
    | "unchanged"
    | "conflict"
    | "blank"
    | "ineligible"
    | "retryable";
  reason: string;
  clientId: string | null;
  clickupFieldId: string | null;
  clickupUserIdCurrent: string | null;
  nobullUserId: string | null;
  departmentId: string | null;
  clickupClientName: string;
  appliedBy: string | null;
}

interface ImportAuditPersistenceContext {
  importRunId: string;
  attemptedAt: Date;
  beforeWriteInTransaction?: (
    rows: readonly ImportAuditRowInput[],
  ) => Promise<void>;
}

async function writeImportAuditRowsInTransaction(
  tx: ProjectionTx,
  rows: ImportAuditRowInput[],
  context: ImportAuditPersistenceContext,
): Promise<void> {
  if (rows.length === 0) return;
  await context.beforeWriteInTransaction?.(rows);
  await tx.insert(psRoleImportAttempts).values(
    rows.map((row) => ({
      importRunId: context.importRunId,
      clickupParentTaskId: row.clickupParentTaskId,
      role: row.role,
      disposition: row.disposition,
      reason: row.reason,
      clientId: row.clientId ?? undefined,
      clickupFieldId: row.clickupFieldId ?? undefined,
      clickupUserIdCurrent: row.clickupUserIdCurrent ?? undefined,
      nobullUserId: row.nobullUserId ?? undefined,
      departmentId: row.departmentId ?? undefined,
      clickupClientName: row.clickupClientName,
      attemptedAt: context.attemptedAt,
      attemptedBy: row.appliedBy ?? undefined,
    })),
  );

  for (const row of rows) {
    // Retryables are append-only evidence, not current/resume state.
    if (row.disposition === "retryable") continue;
    await tx
      .insert(psRoleImportAudit)
      .values({
        clickupParentTaskId: row.clickupParentTaskId,
        role: row.role,
        disposition: row.disposition,
        reason: row.reason,
        clientId: row.clientId ?? undefined,
        clickupFieldId: row.clickupFieldId ?? undefined,
        clickupUserIdCurrent: row.clickupUserIdCurrent ?? undefined,
        nobullUserId: row.nobullUserId ?? undefined,
        departmentId: row.departmentId ?? undefined,
        clickupClientName: row.clickupClientName,
        appliedAt: context.attemptedAt,
        appliedBy: row.appliedBy ?? undefined,
      })
      .onConflictDoUpdate({
        target: [psRoleImportAudit.clickupParentTaskId, psRoleImportAudit.role],
        set: {
          disposition: row.disposition,
          reason: row.reason,
          clientId: row.clientId ?? undefined,
          clickupFieldId: row.clickupFieldId ?? undefined,
          clickupUserIdCurrent: row.clickupUserIdCurrent ?? undefined,
          nobullUserId: row.nobullUserId ?? undefined,
          departmentId: row.departmentId ?? undefined,
          clickupClientName: row.clickupClientName,
          appliedAt: context.attemptedAt,
          appliedBy: row.appliedBy ?? undefined,
          updatedAt: context.attemptedAt,
        },
      });
  }
}

/**
 * Persist evaluated slots when no assignment side effect occurred:
 *  - append every slot to immutable attempt history;
 *  - upsert non-transient current/resume state by (parent task, role).
 *
 * Successful assignment outcomes use writeImportAuditRowsInTransaction from
 * the assignment mutation callback so assignment + "imported" evidence are one
 * atomic commit.
 */
export async function upsertImportAuditRows(
  rows: ImportAuditRowInput[],
  context: ImportAuditPersistenceContext = {
    importRunId: randomUUID(),
    attemptedAt: new Date(),
  },
): Promise<void> {
  if (rows.length === 0) return;
  await withDbAttribution("paidSearchCutover:import:upsertAudit", async () => {
    const db = getDb();
    await db.transaction(async (tx) => {
      await writeImportAuditRowsInTransaction(tx, rows, context);
    });
  });
}

/**
 * TERMINAL dispositions that a repeat Apply must SKIP (Task #5157 fix 5).
 *
 * ONLY "imported" and "unchanged" are terminal — the desired NoBull state is
 * reached and nothing further should happen. Every OTHER disposition
 * (conflict, blank, ineligible) is durable EVIDENCE but NON-terminal: it is
 * re-evaluated on the next press so that correcting the underlying data (e.g.
 * mapping a member, clearing a conflicting assignment, resolving a duplicate
 * name) lets a subsequent Apply advance the slot without any manual audit
 * surgery. Transient write failures are append-only attempt evidence but do
 * not enter current/resume state, so they are retried on the next press.
 */
const TERMINAL_DISPOSITIONS = new Set<string>([
  "imported",
  "unchanged",
]);

/**
 * Dispositions that were ATTEMPTED but did not reach a terminal state. These
 * rows are re-evaluated every press. When the pending window would exceed the
 * bound, NEVER-attempted parents are chosen ahead of these previously-attempted
 * unresolved parents so a large unresolved backlog cannot starve fresh parents
 * (Task #5157 fix 5).
 */
const NONTERMINAL_ATTEMPTED_DISPOSITIONS = new Set<string>([
  "conflict",
  "blank",
  "ineligible",
]);

/**
 * Load existing audit rows for resume logic (Task #5157 fix 5).
 *
 * Returns:
 *  - terminalBySlot: `${taskId}:${role}` → disposition, TERMINAL only
 *    (imported/unchanged). These slots are SKIPPED on a repeat press.
 *  - attemptedTaskIds: the set of task IDs that have ANY persisted audit row
 *    (terminal or non-terminal). Used to order never-attempted parents ahead
 *    of previously-attempted-but-unresolved parents when the pending window is
 *    bounded, so an unresolved backlog cannot starve fresh parents.
 */
export async function loadExistingAuditState(
  taskIds: string[],
): Promise<{ terminalBySlot: Map<string, string>; attemptedTaskIds: Set<string> }> {
  if (taskIds.length === 0) {
    return { terminalBySlot: new Map(), attemptedTaskIds: new Set() };
  }
  const rows = await withDbAttribution("paidSearchCutover:import:loadAudit", async () => {
    const db = getDb();
    return db
      .select({
        clickupParentTaskId: psRoleImportAudit.clickupParentTaskId,
        role: psRoleImportAudit.role,
        disposition: psRoleImportAudit.disposition,
      })
      .from(psRoleImportAudit)
      .where(inArray(psRoleImportAudit.clickupParentTaskId, taskIds));
  });
  const terminalBySlot = new Map<string, string>();
  const attemptedTaskIds = new Set<string>();
  for (const r of rows) {
    attemptedTaskIds.add(r.clickupParentTaskId);
    if (TERMINAL_DISPOSITIONS.has(r.disposition)) {
      terminalBySlot.set(`${r.clickupParentTaskId}:${r.role}`, r.disposition);
    }
  }
  return { terminalBySlot, attemptedTaskIds };
}

/**
 * Back-compat: terminal-only slot map (imported/unchanged). Retained for any
 * external caller; the import path uses loadExistingAuditState directly.
 */
export async function loadExistingAuditDispositions(
  taskIds: string[],
): Promise<Map<string, string>> {
  const { terminalBySlot } = await loadExistingAuditState(taskIds);
  return terminalBySlot;
}

/**
 * Import summary counts from the audit table.
 */
export async function getImportAuditSummary(): Promise<{
  imported: number;
  unchanged: number;
  conflict: number;
  blank: number;
  ineligible: number;
  total: number;
}> {
  return withDbAttribution("paidSearchCutover:import:summary", async () => {
    const db = getDb();
    const rows = await db
      .select({
        disposition: psRoleImportAudit.disposition,
      })
      .from(psRoleImportAudit);

    const counts: Record<string, number> = {
      imported: 0, unchanged: 0, conflict: 0, blank: 0, ineligible: 0,
    };
    for (const r of rows) {
      if (r.disposition in counts) counts[r.disposition]++;
    }
    return {
      imported: counts.imported,
      unchanged: counts.unchanged,
      conflict: counts.conflict,
      blank: counts.blank,
      ineligible: counts.ineligible,
      total: rows.length,
    };
  });
}

/**
 * Execute the bounded, resumable import of paid search roles.
 *
 * Rules:
 *  - Max IMPORT_MAX_PARENTS parents / IMPORT_MAX_ROLE_SLOTS role slots.
 *  - Only preview-eligible rows: exact parent→client mapping, exactly one
 *    People ID, exact member clickupUserId→userId mapping.
 *  - Import only Doer and Checker; legacy role slots are outside this flow.
 *  - Never overwrite a non-null explicit client role with a different user;
 *    record conflict.
 *  - Uses the dedicated NoBull-only assignment mutation: shared
 *    lock/eligibility/upsert semantics with zero projection staging or egress.
 *  - Durable per-parent/role dispositions persisted; repeated apply resumes/skips
 *    terminal items.
 *  - Idempotent: no guesses.
 */
export interface ImportResult {
  ok: boolean;
  error?: string;
  processed: number;
  imported: number;
  unchanged: number;
  conflict: number;
  blank: number;
  ineligible: number;
  skippedTerminal: number;
  /** Slots that hit a transient write failure and were left retryable. */
  retryable: number;
  roleSlotsUsed: number;
  truncated: boolean;
}

export async function runPaidSearchRoleImport(
  actorId: string | null,
  dependencies: {
    /**
     * Failure-injection seam used to prove assignment + imported evidence are
     * atomic. Production callers omit it.
     */
    beforeAuditWriteInTransaction?: (
      rows: readonly ImportAuditRowInput[],
    ) => Promise<void>;
  } = {},
): Promise<ImportResult> {
  const auditContext: ImportAuditPersistenceContext = {
    importRunId: randomUUID(),
    attemptedAt: new Date(),
    beforeWriteInTransaction: dependencies.beforeAuditWriteInTransaction,
  };
  const emptyResult = (error: string): ImportResult => ({
    ok: false,
    error,
    processed: 0,
    imported: 0,
    unchanged: 0,
    conflict: 0,
    blank: 0,
    ineligible: 0,
    skippedTerminal: 0,
    retryable: 0,
    roleSlotsUsed: 0,
    truncated: false,
  });

  // The import writes NoBull assignment rows via
  // setClientDepartmentAssignmentNoProjection, which shares the same
  // lock/eligibility/company-scope/upsert path as the interactive write but
  // stages ZERO projection commands and makes ZERO ClickUp vendor calls (Task
  // #5157 fix 1). The import reads FROM ClickUp and must never project back
  // OUT; therefore it never creates cu_role_projection_commands and never
  // emits an apply/read-back — structurally zero egress, independent of the
  // cutover flag or destination/approval state. Projection back to ClickUp
  // remains the generic worker's job (driven by the interactive path).

  // 1. Find department.
  const deptResult = await findPaidSearchDepartment();
  if (!deptResult.ok) return emptyResult(deptResult.error);
  const dept = deptResult.department;

  // 2. Fetch evidence.
  const evidence = await fetchDirectoryEvidence();
  if (!evidence) {
    return emptyResult("ClickUp evidence fetch failed. Check ClickUp configuration.");
  }

  // 3. Load DB data.
  const [customerClients, deptMembers, existingAssignments, productionDests] =
    await withDbAttribution("paidSearchCutover:import:loadDb", async () => {
      const db = getDb();
      return Promise.all([
        db
          .select({ id: clients.id, firmName: clients.firmName })
          .from(clients)
          .where(
            and(
              eq(clients.isArchived, false),
              eq(clients.isDemo, false),
              eq(clients.lifecycleStage, "customer"),
            ),
          ),
        db
          .select({
            userId: sdDepartmentMembers.userId,
            clickupUserId: sdDepartmentMembers.clickupUserId,
          })
          .from(sdDepartmentMembers)
          .where(
            and(
              eq(sdDepartmentMembers.departmentId, dept.id),
              eq(sdDepartmentMembers.active, true),
            ),
          ),
        db
          .select({
            clientId: sdClientDeptAssignments.clientId,
            primaryUserId: sdClientDeptAssignments.primaryUserId,
            checkerUserId: sdClientDeptAssignments.checkerUserId,
          })
          .from(sdClientDeptAssignments)
          .where(eq(sdClientDeptAssignments.departmentId, dept.id)),
        db
          .select()
          .from(cuRoleProjectionDestinations)
          .where(
            and(
              eq(cuRoleProjectionDestinations.departmentId, dept.id),
              eq(cuRoleProjectionDestinations.environment, "production"),
            ),
          ),
      ]);
    });

  // Indices. STRICT match key (trim + lowercase only, NO whitespace collapse —
  // Task #5157 fix 4).
  const normToClient = new Map<string, { id: string; firmName: string } | "dup">();
  for (const c of customerClients) {
    const key = normClientNameForMatch(c.firmName);
    normToClient.set(key, normToClient.has(key) ? "dup" : c);
  }
  const clientById = new Map<string, { id: string; firmName: string }>();
  for (const c of customerClients) clientById.set(c.id, { id: c.id, firmName: c.firmName });

  // Duplicate-aware member map: dup clickupUserId → "dup".
  const memberByClickupId = buildMemberByClickupId(deptMembers);

  const assignmentByClient = new Map<string, typeof existingAssignments[0]>();
  for (const a of existingAssignments) assignmentByClient.set(a.clientId, a);

  // Stable target-binding reverse index: parent taskId → distinct
  // client ids bound across BOTH production destinations. Only a size-1 set is
  // an unambiguous binding match.
  const destByResp = new Map<string, typeof productionDests[0]>();
  for (const d of productionDests) destByResp.set(d.responsibility, d);
  const bindingDestIds = [destByResp.get("doer")?.id, destByResp.get("checker")?.id].filter(
    (x): x is string => !!x,
  );
  const bindingClientsByTaskId = new Map<string, Set<string>>();
  if (bindingDestIds.length > 0 && customerClients.length > 0) {
    const targets = await withDbAttribution(
      "paidSearchCutover:import:loadTargets",
      async () => {
        const db = getDb();
        return db
          .select()
          .from(cuRoleProjectionClientTargets)
          .where(
            and(
              inArray(
                cuRoleProjectionClientTargets.clientId,
                customerClients.map((c) => c.id),
              ),
              inArray(cuRoleProjectionClientTargets.destinationId, bindingDestIds),
            ),
          );
      },
    );
    for (const t of targets) {
      const set = bindingClientsByTaskId.get(t.targetId) ?? new Set<string>();
      set.add(t.clientId);
      bindingClientsByTaskId.set(t.targetId, set);
    }
  }

  // Resolve parent → client: stable binding FIRST (only if exactly
  // one distinct client bound), else unique exact norm-name. Never first
  // binding; ambiguous binding → null (row becomes ineligible below).
  const resolveClientForParent = (
    parent: ParentEvidence,
  ): { clientId: string | null; ambiguousBinding: boolean; matchedVia: "binding" | "name" | null } => {
    const bound = bindingClientsByTaskId.get(parent.taskId);
    if (bound && bound.size > 0) {
      if (bound.size === 1) {
        const onlyId = [...bound][0];
        return {
          clientId: clientById.has(onlyId) ? onlyId : null,
          ambiguousBinding: false,
          matchedVia: clientById.has(onlyId) ? "binding" : null,
        };
      }
      return { clientId: null, ambiguousBinding: true, matchedVia: null };
    }
    // STRICT trim+lowercase-only name match (fix 4).
    const entry = normToClient.get(normClientNameForMatch(parent.name));
    return {
      clientId: entry && entry !== "dup" ? entry.id : null,
      ambiguousBinding: false,
      matchedVia: entry && entry !== "dup" ? "name" : null,
    };
  };

  // Load ALL existing audit state across EVERY parent (not just the first
  // window) so repeated presses advance PAST already-terminal parents instead
  // of permanently re-reading the first 500 (Task #5157 fix 5).
  const allTaskIds = evidence.parents.map((p) => p.taskId);
  const { terminalBySlot: existingDispositions, attemptedTaskIds } =
    await loadExistingAuditState(allTaskIds);

  // A parent is fully terminal when BOTH roles have a TERMINAL disposition
  // (imported/unchanged). Only these are skipped from the pending set; a parent
  // whose only rows are conflict/blank/ineligible is NON-terminal and remains
  // pending so a data correction can advance it.
  const isParentFullyTerminal = (taskId: string): boolean =>
    existingDispositions.has(`${taskId}:doer`) &&
    existingDispositions.has(`${taskId}:checker`);

  const pendingParents = evidence.parents.filter(
    (p) => !isParentFullyTerminal(p.taskId),
  );

  // Ordering (fix 5): NEVER-attempted parents first, then previously-attempted
  // but still-unresolved parents. This keeps a large unresolved backlog (>500
  // conflict/blank/ineligible rows) from starving brand-new parents on every
  // press. Preserve original list order WITHIN each group (stable partition).
  const neverAttempted = pendingParents.filter((p) => !attemptedTaskIds.has(p.taskId));
  const previouslyAttempted = pendingParents.filter((p) => attemptedTaskIds.has(p.taskId));
  const orderedPending = [...neverAttempted, ...previouslyAttempted];

  // Bounded window advances beyond terminal parents.
  const parents = orderedPending.slice(0, IMPORT_MAX_PARENTS);
  const truncated = orderedPending.length > IMPORT_MAX_PARENTS;

  let processed = 0;
  let imported = 0;
  let unchanged = 0;
  let conflict = 0;
  let blank = 0;
  let ineligible = 0;
  let skippedTerminal = 0;
  let roleSlotsUsed = 0;
  // Non-persisted transient write failures — left non-terminal so a repeat
  // press retries the slot.
  let retryable = 0;

  const auditRows: ImportAuditRowInput[] = [];

  for (const parent of parents) {
    processed++;

    // Determine client match: stable binding first, then unique exact name.
    const { clientId, ambiguousBinding, matchedVia } = resolveClientForParent(parent);
    // Duplicate parent name blocks ONLY when matched via name fallback; a single
    // unambiguous stable binding is importable despite a duplicate name (fix 4).
    const dupNameBlocks =
      parent.duplicateNormNameTaskIds.length > 0 && matchedVia !== "binding";

    // Both roles for this parent count against the slot budget.
    const roles: Array<{ role: "doer" | "checker"; fieldId: string; people: typeof parent.doerPeople }> = [
      { role: "doer", fieldId: CLICKUP_DOER_FIELD_ID, people: parent.doerPeople },
      { role: "checker", fieldId: CLICKUP_CHECKER_FIELD_ID, people: parent.checkerPeople },
    ];

    for (const roleSpec of roles) {
      const terminalKey = `${parent.taskId}:${roleSpec.role}`;

      // Skip terminal items.
      if (existingDispositions.has(terminalKey)) {
        skippedTerminal++;
        continue;
      }

      if (roleSlotsUsed >= IMPORT_MAX_ROLE_SLOTS) {
        break;
      }
      roleSlotsUsed++;

      // Ineligible: excluded, blocking duplicate name, ambiguous binding, no
      // matched client. NOTE: ineligible is NON-terminal (Task #5157 fix 5) —
      // it is durable evidence but re-evaluated on the next press after the
      // underlying data is corrected.
      if (
        parent.excluded ||
        dupNameBlocks ||
        ambiguousBinding ||
        !clientId
      ) {
        ineligible++;
        auditRows.push({
          clickupParentTaskId: parent.taskId,
          role: roleSpec.role,
          disposition: "ineligible",
          reason: parent.excluded
            ? `Excluded status: ${parent.status}`
            : dupNameBlocks
            ? "Duplicate ClickUp parent name (no unambiguous stable binding)"
            : ambiguousBinding
            ? "Ambiguous stable target binding (parent bound to >1 client)"
            : "No unique NoBull client match by exact name",
          clientId,
          clickupFieldId: roleSpec.fieldId,
          clickupUserIdCurrent: null,
          nobullUserId: null,
          departmentId: dept.id,
          clickupClientName: parent.name,
          appliedBy: actorId,
        });
        continue;
      }

      // Blank field: no People ID.
      if (roleSpec.people.length === 0) {
        blank++;
        auditRows.push({
          clickupParentTaskId: parent.taskId,
          role: roleSpec.role,
          disposition: "blank",
          reason: "ClickUp People field is empty",
          clientId,
          clickupFieldId: roleSpec.fieldId,
          clickupUserIdCurrent: null,
          nobullUserId: null,
          departmentId: dept.id,
          clickupClientName: parent.name,
          appliedBy: actorId,
        });
        continue;
      }

      // Multi-person: ineligible (must be exactly one for import).
      if (roleSpec.people.length > 1) {
        ineligible++;
        auditRows.push({
          clickupParentTaskId: parent.taskId,
          role: roleSpec.role,
          disposition: "ineligible",
          reason: `Multiple people in field (${roleSpec.people.length}) — must be exactly 1`,
          clientId,
          clickupFieldId: roleSpec.fieldId,
          clickupUserIdCurrent: roleSpec.people.map((p) => p.clickupUserId).join(","),
          nobullUserId: null,
          departmentId: dept.id,
          clickupClientName: parent.name,
          appliedBy: actorId,
        });
        continue;
      }

      const clickupUserId = roleSpec.people[0].clickupUserId;
      const memberLookup = memberByClickupId.get(clickupUserId);

      // Ambiguous ClickUp identity: mapped to >1 active member → never pick a
      // last-write-wins winner. Ineligible.
      if (memberLookup === "dup") {
        ineligible++;
        auditRows.push({
          clickupParentTaskId: parent.taskId,
          role: roleSpec.role,
          disposition: "ineligible",
          reason: `ClickUp user ID "${clickupUserId}" maps to more than one active dept member — ambiguous`,
          clientId,
          clickupFieldId: roleSpec.fieldId,
          clickupUserIdCurrent: clickupUserId,
          nobullUserId: null,
          departmentId: dept.id,
          clickupClientName: parent.name,
          appliedBy: actorId,
        });
        continue;
      }

      const nobullUserId = memberLookup ?? null;

      // Unmapped ClickUp user: ineligible.
      if (!nobullUserId) {
        ineligible++;
        auditRows.push({
          clickupParentTaskId: parent.taskId,
          role: roleSpec.role,
          disposition: "ineligible",
          reason: `ClickUp user ID "${clickupUserId}" has no matching active dept member`,
          clientId,
          clickupFieldId: roleSpec.fieldId,
          clickupUserIdCurrent: clickupUserId,
          nobullUserId: null,
          departmentId: dept.id,
          clickupClientName: parent.name,
          appliedBy: actorId,
        });
        continue;
      }

      // Check existing assignment for this role.
      const existing = assignmentByClient.get(clientId);
      const existingRoleUserId =
        roleSpec.role === "doer"
          ? (existing?.primaryUserId ?? null)
          : (existing?.checkerUserId ?? null);

      // Conflict: existing non-null role with different user.
      if (existingRoleUserId && existingRoleUserId !== nobullUserId) {
        conflict++;
        auditRows.push({
          clickupParentTaskId: parent.taskId,
          role: roleSpec.role,
          disposition: "conflict",
          reason: `Existing ${roleSpec.role} differs (existing: ${existingRoleUserId}, desired: ${nobullUserId}) — not overwriting`,
          clientId,
          clickupFieldId: roleSpec.fieldId,
          clickupUserIdCurrent: clickupUserId,
          nobullUserId,
          departmentId: dept.id,
          clickupClientName: parent.name,
          appliedBy: actorId,
        });
        continue;
      }

      // Unchanged: already correct.
      if (existingRoleUserId === nobullUserId) {
        unchanged++;
        auditRows.push({
          clickupParentTaskId: parent.taskId,
          role: roleSpec.role,
          disposition: "unchanged",
          reason: "Already assigned to the same user",
          clientId,
          clickupFieldId: roleSpec.fieldId,
          clickupUserIdCurrent: clickupUserId,
          nobullUserId,
          departmentId: dept.id,
          clickupClientName: parent.name,
          appliedBy: actorId,
        });
        continue;
      }

      // Import: write the assignment. Build a full Doer/Checker patch retaining
      // the other supported role.
      const currentPrimary =
        roleSpec.role === "doer" ? nobullUserId : (existing?.primaryUserId ?? null);
      const currentChecker =
        roleSpec.role === "checker" ? nobullUserId : (existing?.checkerUserId ?? null);

      const importedAuditRow: ImportAuditRowInput = {
        clickupParentTaskId: parent.taskId,
        role: roleSpec.role,
        disposition: "imported",
        reason: "Assignment written successfully",
        clientId,
        clickupFieldId: roleSpec.fieldId,
        clickupUserIdCurrent: clickupUserId,
        nobullUserId,
        departmentId: dept.id,
        clickupClientName: parent.name,
        appliedBy: actorId,
      };
      let mutation: Awaited<ReturnType<typeof setClientDepartmentAssignmentNoProjection>>;
      try {
        // NoBull-only write: import populates NoBull's assignment table from
        // ClickUp's existing state and must NEVER project back to ClickUp.
        // This function stages ZERO projection commands and makes ZERO vendor
        // calls even with prod destinations + approvals enabled (Task #5157
        // fix 1). Projection back out remains the generic worker's job driven
        // by the interactive setClientDepartmentAssignment path.
        mutation = await setClientDepartmentAssignmentNoProjection({
          clientId,
          departmentId: dept.id,
          primaryUserId: currentPrimary,
          checkerUserId: currentChecker,
          expectedAssignment: existing
            ? {
                primaryUserId: existing.primaryUserId,
                checkerUserId: existing.checkerUserId,
              }
            : null,
          afterAssignmentWriteInTransaction: async (tx) => {
            await writeImportAuditRowsInTransaction(
              tx,
              [importedAuditRow],
              auditContext,
            );
          },
        });
      } catch (err: any) {
        // Thrown error (e.g. transient DB): preserve append-only retry evidence
        // but do not write current/resume state, so the next press retries.
        retryable++;
        auditRows.push({
          clickupParentTaskId: parent.taskId,
          role: roleSpec.role,
          disposition: "retryable",
          reason: "Assignment write failed transiently; slot remains retryable",
          clientId,
          clickupFieldId: roleSpec.fieldId,
          clickupUserIdCurrent: clickupUserId,
          nobullUserId,
          departmentId: dept.id,
          clickupClientName: parent.name,
          appliedBy: actorId,
        });
        continue;
      }

      // A non-ok result (eligibility/company-scope) is a real, deterministic
      // rejection — record it as terminal ineligible with the exact kind. It
      // is NOT counted as imported.
      if (!mutation.ok) {
        if (mutation.kind === "concurrent_conflict") {
          conflict++;
          auditRows.push({
            clickupParentTaskId: parent.taskId,
            role: roleSpec.role,
            disposition: "conflict",
            reason:
              "NoBull assignment changed after the import snapshot — preserved the newer operator state",
            clientId,
            clickupFieldId: roleSpec.fieldId,
            clickupUserIdCurrent: clickupUserId,
            nobullUserId,
            departmentId: dept.id,
            clickupClientName: parent.name,
            appliedBy: actorId,
          });
          continue;
        }
        const kind =
          mutation.kind === "ineligible"
            ? `ineligible (${mutation.field}=${mutation.userId})`
            : mutation.kind;
        ineligible++;
        auditRows.push({
          clickupParentTaskId: parent.taskId,
          role: roleSpec.role,
          disposition: "ineligible",
          reason: `Assignment write rejected: ${kind}`,
          clientId,
          clickupFieldId: roleSpec.fieldId,
          clickupUserIdCurrent: clickupUserId,
          nobullUserId,
          departmentId: dept.id,
          clickupClientName: parent.name,
          appliedBy: actorId,
        });
        continue;
      }

      // Success — reflect the persisted assignment in the local cache so
      // subsequent roles for the same client see the supported role state.
      assignmentByClient.set(clientId, {
        clientId: mutation.assignment.clientId,
        primaryUserId: mutation.assignment.primaryUserId,
        checkerUserId: mutation.assignment.checkerUserId,
      });

      imported++;
    }
  }

  // Persist audit rows.
  if (auditRows.length > 0) {
    await upsertImportAuditRows(auditRows, auditContext);
  }

  return {
    ok: true,
    processed,
    imported,
    unchanged,
    conflict,
    blank,
    ineligible,
    skippedTerminal,
    retryable,
    roleSlotsUsed,
    truncated,
  };
}
