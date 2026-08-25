// @db-pool-intent: ambient
/**
 * Company-wide assignment boundary.
 *
 * The sd_* tables remain the canonical store. This service is the one neutral
 * read/write boundary over their company, per-client, default, membership, and
 * ClickUp projection semantics. server/services/sdRoleResolution.ts is only a
 * compatibility re-export for existing Service Desk consumers.
 */

import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  clickupUserTokens,
  sdClientDeptAssignments,
  sdDepartmentMembers,
  sdDepartments,
  sdListMapping,
  type UniversalAssignmentProjectionIdentity,
  type UniversalAssignmentResponsibility,
  type UniversalAssignmentSnapshot,
  type UniversalAssignmentSource,
} from "@shared/schema";
import { clients } from "@shared/models/clients";
import { departmentSupportsChecker } from "@shared/departmentRoleCapabilities";
import { getDb, withDbAttribution } from "../db";
import {
  stageProjectionCommandsInTx,
  attemptProjectionCommandNow,
  readProjectionCommandStatuses,
  type ProjectionRoleInput,
  type ProjectionStageSummary,
  type ProjectionCommandRef,
} from "./clickUpRoleProjection";
import {
  kickClickUpRoleProjectionSafe,
  type ProjectionTx,
} from "./clickUpRoleProjectionKick";

// ─── Projection summary envelope ─────────────────────────────────────────────
// Included in mutation results without breaking existing fields.

/**
 * Aggregate projection state after a mutation. `state` reflects the WORST
 * outstanding command state across the affected refs (priority order below);
 * for bulk (>3) fan-out it stays "pending" (safe-kicked, not awaited).
 */
export type ProjectionAggregateState =
  | "failed"
  | "blocked"
  | "ambiguous"
  | "drift"
  | "disabled"
  | "pending"
  | "synced";

export interface ProjectionSummary {
  staged: number;
  nobullOnly: number;
  blocked: number;
  disabled: number;
  /** Honest post-attempt aggregate. */
  state: ProjectionAggregateState;
}

function emptyProjectionSummary(): ProjectionSummary {
  return { staged: 0, nobullOnly: 0, blocked: 0, disabled: 0, state: "synced" };
}

// Worst-first priority for aggregating multiple command statuses.
const STATE_PRIORITY: ProjectionAggregateState[] = [
  "failed",
  "blocked",
  "ambiguous",
  "drift",
  "disabled",
  "pending",
  "synced",
];

/**
 * Narrow a staging summary into the public envelope WITHOUT post-attempt info.
 * Used for bulk fan-out (safe-kick) where no immediate attempt is awaited.
 */
function toProjectionSummary(s: ProjectionStageSummary): ProjectionSummary {
  return {
    staged: s.staged,
    nobullOnly: s.nobullOnly,
    blocked: s.blocked + s.missingIdentity,
    disabled: s.disabled,
    // Rows were staged but attempts not awaited here → pending (unless nothing
    // was staged at all, in which case synced/no-op).
    state: s.staged > 0 ? "pending" : "synced",
  };
}

/** Minimal shape summaryFromStatuses needs from a re-read command row. */
export interface ProjectionRefStatusLite {
  clientId: string;
  destinationId: string;
  status: string;
  verifiedAt: Date | null;
}

const MAX_IMMEDIATE_ATTEMPTS = 3;

/**
 * Bounded post-commit immediate attempts. For a small number of exact commands
 * (single-client save, member removal) we synchronously attempt each exact
 * (clientId, destinationId) target, await it, then RE-READ the exact command
 * statuses to derive an honest post-attempt summary. Larger fan-out (>3)
 * safe-kicks and returns a pending summary. Never throws.
 *
 * `state === "synced"` ONLY if every staged ref is status=synced AND verifiedAt.
 */
async function runBoundedImmediateAttempts(
  stage: ProjectionStageSummary,
): Promise<ProjectionSummary> {
  const refs = stage.stagedRefs;
  if (refs.length === 0) return toProjectionSummary(stage);

  if (refs.length > MAX_IMMEDIATE_ATTEMPTS) {
    // Bulk path: safe-kick only, never block the caller. Pending summary.
    void kickClickUpRoleProjectionSafe();
    return toProjectionSummary(stage);
  }

  for (const ref of refs) {
    // attemptProjectionCommandNow never throws; releases DB before vendor calls.
    await attemptProjectionCommandNow(ref.clientId, ref.destinationId);
  }

  // Honest post-attempt read of exact command statuses.
  const statuses = await readProjectionCommandStatuses(refs);
  return summaryFromStatuses(stage, statuses);
}

/**
 * Member-lifecycle variant: await bounded immediate attempts for a collected
 * set of exact refs (side-effect only; member APIs do not return a projection
 * summary). >3 refs safe-kick. Never throws.
 */
async function runBoundedImmediateAttemptsRefs(
  refs: ProjectionCommandRef[],
): Promise<void> {
  if (refs.length === 0) return;
  if (refs.length > MAX_IMMEDIATE_ATTEMPTS) {
    void kickClickUpRoleProjectionSafe();
    return;
  }
  for (const ref of refs) {
    await attemptProjectionCommandNow(ref.clientId, ref.destinationId);
  }
}

/**
 * Derive an honest post-attempt aggregate from the re-read command statuses.
 *
 * `state === "synced"` is emitted ONLY when the re-read rows EXACTLY cover the
 * staged refs — i.e. there is one row per staged (clientId,destinationId) ref,
 * no missing rows, no duplicate ref keys, no extra/mismatched keys — AND every
 * one of those rows is status=synced with a non-null verifiedAt. Any coverage
 * gap (missing / duplicate / mismatched row) collapses to a safe non-synced
 * state (blocked if we cannot account for a ref, else the worst present state,
 * never below "pending"), so a partial or corrupt read can never be reported as
 * fully synced. Exported for direct unit testing (architect review #C).
 */
export function summaryFromStatuses(
  stage: ProjectionStageSummary,
  statuses: ProjectionRefStatusLite[],
): ProjectionSummary {
  const base = toProjectionSummary(stage);
  const refs = stage.stagedRefs;
  if (refs.length === 0) return base;

  const refKey = (r: { clientId: string; destinationId: string }): string =>
    `${r.clientId}\u0000${r.destinationId}`;
  const expected = new Set(refs.map(refKey));

  // Index the returned rows by ref key, detecting duplicates.
  const byKey = new Map<string, ProjectionRefStatusLite>();
  let duplicate = false;
  let extraneous = false;
  for (const s of statuses) {
    const k = refKey(s);
    if (!expected.has(k)) {
      extraneous = true;
      continue;
    }
    if (byKey.has(k)) duplicate = true;
    byKey.set(k, s);
  }

  // Exact coverage: every expected ref present exactly once, nothing extra.
  const exactCoverage =
    !duplicate &&
    !extraneous &&
    byKey.size === expected.size &&
    statuses.length === expected.size;

  if (exactCoverage) {
    const allSyncedVerified = refs.every((r) => {
      const row = byKey.get(refKey(r));
      return !!row && row.status === "synced" && row.verifiedAt !== null;
    });
    if (allSyncedVerified) {
      return { ...base, state: "synced" };
    }
  }

  // Not exact / not all synced-verified → worst present state, but never synced.
  let worst: ProjectionAggregateState = "pending";
  for (const r of refs) {
    const row = byKey.get(refKey(r));
    // A staged ref with no corresponding row cannot be confirmed → blocked.
    const st: ProjectionAggregateState = row ? normalizeState(row.status) : "blocked";
    if (STATE_PRIORITY.indexOf(st) < STATE_PRIORITY.indexOf(worst)) worst = st;
  }
  // A duplicate/extraneous row signals a corrupt read — never above blocked.
  if ((duplicate || extraneous) && STATE_PRIORITY.indexOf("blocked") < STATE_PRIORITY.indexOf(worst)) {
    worst = "blocked";
  }
  // Guard: worst can never be "synced" on this path.
  if (worst === "synced") worst = "pending";
  return { ...base, state: worst };
}

function normalizeState(status: string): ProjectionAggregateState {
  switch (status) {
    case "failed":
    case "blocked":
    case "ambiguous":
    case "drift":
    case "disabled":
    case "pending":
    case "synced":
      return status;
    default:
      return "pending";
  }
}

/**
 * Build role inputs for a per-client assignment. Resolves ClickUp IDs from
 * member records already held in tx (via a re-select), if available.
 * This is intentionally lightweight: we pass what we know; the projection
 * worker resolves exact CU IDs from the mapping at attempt time.
 */
async function buildClientProjectionRoles(
  tx: any,
  clientId: string,
  departmentId: string,
  primaryUserId: string | null | undefined,
  checkerUserId: string | null | undefined,
): Promise<ProjectionRoleInput[]> {
  const userIds = [primaryUserId, checkerUserId].filter(
    (id): id is string => !!id,
  );
  // Resolve ClickUp IDs for known members.
  const memberRows: Array<{ userId: string; clickupUserId: string | null }> =
    userIds.length > 0
      ? await tx
          .select({
            userId: sdDepartmentMembers.userId,
            clickupUserId: sdDepartmentMembers.clickupUserId,
          })
          .from(sdDepartmentMembers)
          .where(
            and(
              eq(sdDepartmentMembers.departmentId, departmentId),
              inArray(sdDepartmentMembers.userId, userIds),
              eq(sdDepartmentMembers.active, true),
            ),
          )
      : [];
  const cuIdByUser = new Map(
    memberRows.map((m) => [m.userId, m.clickupUserId ?? null]),
  );

  const roles: ProjectionRoleInput[] = [];
  const deptId = departmentId;
  if (primaryUserId !== undefined) {
    roles.push({
      clientId,
      departmentId: deptId,
      responsibility: "doer",
      desiredUserId: primaryUserId,
      desiredClickupUserId: primaryUserId ? (cuIdByUser.get(primaryUserId) ?? null) : null,
    });
  }
  if (checkerUserId !== undefined && departmentSupportsChecker(departmentId)) {
    roles.push({
      clientId,
      departmentId: deptId,
      responsibility: "checker",
      desiredUserId: checkerUserId,
      desiredClickupUserId: checkerUserId ? (cuIdByUser.get(checkerUserId) ?? null) : null,
    });
  }
  return roles;
}

/**
 * Fan-out staging for a department default/scope change. Within the same tx:
 *   - Company-scope department: stage ONE command using a deterministic
 *     non-client subject key `company:<departmentId>` with the department's
 *     effective (default) role holders.
 *   - Per-client department: derive every client that has a per-client
 *     assignment row in this department, compute each client's EFFECTIVE role
 *     after the write (assignment override else department default), and stage
 *     per-client commands.
 *
 * Returns the number of client subjects staged (for immediate-vs-kick decision).
 * No network in tx.
 */
async function fanOutDepartmentProjectionInTx(
  tx: any,
  departmentId: string,
  changedResponsibilities: UniversalAssignmentResponsibility[],
): Promise<{ subjects: number; summary: ProjectionStageSummary }> {
  const [dept] = await tx
    .select({
      id: sdDepartments.id,
      assignmentScope: sdDepartments.assignmentScope,
      defaultPrimaryUserId: sdDepartments.defaultPrimaryUserId,
      defaultCheckerUserId: sdDepartments.defaultCheckerUserId,
    })
    .from(sdDepartments)
    .where(eq(sdDepartments.id, departmentId))
    .limit(1);

  if (!dept) return { subjects: 0, summary: emptyStageSummary() };

  // Company scope: single company subject with department defaults as effective.
  if (isCompanyScoped(dept)) {
    const effective = computeEffectiveRoles(dept, null);
    const roles = await buildClientProjectionRoles(
      tx,
      `company:${departmentId}`,
      departmentId,
      effective.primaryUserId,
      effective.checkerUserId,
    );
    const summary = await stageProjectionCommandsInTx(tx, roles);
    return { subjects: 1, summary };
  }

  // Per-client scope: a default/scope change affects the EFFECTIVE role of EVERY
  // eligible active customer client in the department universe — including
  // clients with NO override row that inherit the department defaults. Enumerate
  // the full universe (clients LEFT JOIN assignment overrides), bounded only by
  // this department. Mirrors the coverage grid: customers only, not archived.
  const universe: Array<{
    clientId: string;
    primaryUserId: string | null;
    checkerUserId: string | null;
  }> = await tx
    .select({
      clientId: clients.id,
      primaryUserId: sdClientDeptAssignments.primaryUserId,
      checkerUserId: sdClientDeptAssignments.checkerUserId,
    })
    .from(clients)
    .leftJoin(
      sdClientDeptAssignments,
      and(
        eq(sdClientDeptAssignments.clientId, clients.id),
        eq(sdClientDeptAssignments.departmentId, departmentId),
      ),
    )
    .where(
      and(eq(clients.isArchived, false), eq(clients.lifecycleStage, "customer")),
    );

  if (universe.length === 0) return { subjects: 0, summary: emptyStageSummary() };

  // Stage ONLY the changed responsibilities per client (a default change to the
  // checker slot must not re-stage the doer commands).
  const changed = new Set(
    changedResponsibilities.filter(
      (responsibility) =>
        responsibility !== "checker" || departmentSupportsChecker(departmentId),
    ),
  );
  const allRoles: ProjectionRoleInput[] = [];
  for (const c of universe) {
    const assignment =
      c.primaryUserId !== null || c.checkerUserId !== null
        ? {
            primaryUserId: c.primaryUserId,
            checkerUserId: c.checkerUserId,
          }
        : null;
    const effective = computeEffectiveRoles(dept, assignment);
    const roles = await buildClientProjectionRoles(
      tx,
      c.clientId,
      departmentId,
      changed.has("doer") ? effective.primaryUserId : undefined,
      changed.has("checker") ? effective.checkerUserId : undefined,
    );
    for (const r of roles) allRoles.push(r);
  }
  const summary = await stageProjectionCommandsInTx(tx, allRoles);
  return { subjects: universe.length, summary };
}

function emptyStageSummary(): ProjectionStageSummary {
  return { staged: 0, nobullOnly: 0, blocked: 0, disabled: 0, missingIdentity: 0, stagedRefs: [] };
}

/** TEST-ONLY seam exercising the department fan-out universe enumeration. */
export function fanOutDepartmentProjectionForTest(
  tx: any,
  departmentId: string,
  changedResponsibilities: UniversalAssignmentResponsibility[],
): Promise<{ subjects: number; summary: ProjectionStageSummary }> {
  return fanOutDepartmentProjectionInTx(tx, departmentId, changedResponsibilities);
}

export interface SdDeptRoleFields {
  id?: string;
  assignmentScope: string;
  defaultPrimaryUserId: string | null;
  defaultCheckerUserId: string | null;
}

export interface SdAssignmentRoleFields {
  primaryUserId: string | null;
  checkerUserId: string | null;
}

export type SdRoleSource = "assignment" | "default" | "company" | null;

export interface SdEffectiveRoles {
  primaryUserId: string | null;
  checkerUserId: string | null;
  sources: { primary: SdRoleSource; checker: SdRoleSource };
}

type DepartmentRow = SdDeptRoleFields & {
  id: string;
  name: string;
  active: boolean;
  updatedAt: Date;
};

type AssignmentRow = SdAssignmentRoleFields & {
  id: string;
  clientId: string;
  departmentId: string;
  updatedAt: Date;
};

export type AssignmentRoleHolderPatch = {
  primaryUserId?: string | null;
  checkerUserId?: string | null;
};

export type AssignmentEligibilityFailure =
  | { ok: false; kind: "department_not_found" }
  | { ok: false; kind: "unsupported_role"; field: "checkerUserId" }
  | {
      ok: false;
      kind: "ineligible";
      field: keyof AssignmentRoleHolderPatch;
      userId: string;
    };

export type AssignmentEligibilityResult =
  | { ok: true; department: DepartmentRow }
  | AssignmentEligibilityFailure;

const ROLE_FIELD_BY_RESPONSIBILITY: Record<
  UniversalAssignmentResponsibility,
  keyof SdAssignmentRoleFields
> = {
  doer: "primaryUserId",
  checker: "checkerUserId",
};

export function isCompanyScoped(
  dept: Pick<SdDeptRoleFields, "assignmentScope"> | null | undefined,
): boolean {
  return dept?.assignmentScope === "company";
}

export const SD_UNKNOWN_DEPT_ROLE_FIELDS: SdDeptRoleFields = {
  assignmentScope: "per_client",
  defaultPrimaryUserId: null,
  defaultCheckerUserId: null,
};

export function computeEffectiveRoles(
  dept: SdDeptRoleFields,
  assignment: SdAssignmentRoleFields | null | undefined,
): SdEffectiveRoles {
  // Checker is opt-in by stable department identity.  Do not allow historical
  // values in the generic columns to resurrect a Checker role for Doer-only
  // departments.
  const supportsChecker = "id" in dept && typeof dept.id === "string"
    ? departmentSupportsChecker(dept.id)
    : false;
  if (isCompanyScoped(dept)) {
    return {
      primaryUserId: dept.defaultPrimaryUserId ?? null,
      checkerUserId: supportsChecker ? dept.defaultCheckerUserId ?? null : null,
      sources: {
        primary: dept.defaultPrimaryUserId ? "company" : null,
        checker: supportsChecker && dept.defaultCheckerUserId ? "company" : null,
      },
    };
  }

  const pick = (
    assigned: string | null | undefined,
    fallback: string | null | undefined,
  ): { userId: string | null; source: SdRoleSource } => {
    if (assigned) return { userId: assigned, source: "assignment" };
    if (fallback) return { userId: fallback, source: "default" };
    return { userId: null, source: null };
  };
  const primary = pick(assignment?.primaryUserId, dept.defaultPrimaryUserId);
  const checker = supportsChecker
    ? pick(assignment?.checkerUserId, dept.defaultCheckerUserId)
    : { userId: null, source: null as SdRoleSource };
  return {
    primaryUserId: primary.userId,
    checkerUserId: checker.userId,
    sources: { primary: primary.source, checker: checker.source },
  };
}

export async function loadDeptRoleFields(
  deptIds: string[],
): Promise<Map<string, DepartmentRow>> {
  const out = new Map<string, DepartmentRow>();
  if (deptIds.length === 0) return out;
  const rows = await withDbAttribution("assignments:departments:load", async () => {
    const db = getDb();
    return db
      .select({
        id: sdDepartments.id,
        name: sdDepartments.name,
        active: sdDepartments.active,
        assignmentScope: sdDepartments.assignmentScope,
        defaultPrimaryUserId: sdDepartments.defaultPrimaryUserId,
        defaultCheckerUserId: sdDepartments.defaultCheckerUserId,
        updatedAt: sdDepartments.updatedAt,
      })
      .from(sdDepartments)
      .where(inArray(sdDepartments.id, deptIds));
  });
  for (const row of rows) out.set(row.id, row);
  return out;
}

export async function resolveEffectiveRoles(args: {
  departmentId: string | null;
  clientId: string | null;
  dept?: SdDeptRoleFields | null;
}): Promise<SdEffectiveRoles> {
  const { departmentId, clientId } = args;
  let dept = args.dept ?? null;
  if (!dept && departmentId) {
    dept = (await loadDeptRoleFields([departmentId])).get(departmentId) ?? null;
  }
  const deptFields = dept ?? SD_UNKNOWN_DEPT_ROLE_FIELDS;
  let assignment: SdAssignmentRoleFields | null = null;
  if (!isCompanyScoped(deptFields) && clientId && departmentId) {
    const [row] = await withDbAttribution("assignments:clientOverride:load", async () => {
      const db = getDb();
      return db
        .select({
          primaryUserId: sdClientDeptAssignments.primaryUserId,
          checkerUserId: sdClientDeptAssignments.checkerUserId,
        })
        .from(sdClientDeptAssignments)
        .where(
          and(
            eq(sdClientDeptAssignments.clientId, clientId),
            eq(sdClientDeptAssignments.departmentId, departmentId),
          ),
        )
        .limit(1);
    });
    assignment = row ?? null;
  }
  const effectiveDept: SdDeptRoleFields = departmentId
    ? ({ ...deptFields, id: departmentId } as SdDeptRoleFields)
    : deptFields;
  return computeEffectiveRoles(effectiveDept, assignment);
}

type ClickUpIdentityTarget = {
  userId: string;
  departmentId?: string | null;
  requireActiveDepartmentMembership?: boolean;
  allowDurableMemberFallback?: boolean;
  preferredClickUpUserId?: string | null;
  preferredClickUpUserIdVerified?: boolean;
};

export type ResolvedClickUpIdentity = UniversalAssignmentProjectionIdentity & {
  userId: string;
  departmentId: string | null;
  activeDepartmentMember: boolean;
};

function identityKey(userId: string, departmentId?: string | null): string {
  return `${userId}|${departmentId ?? ""}`;
}

function isoMax(values: Array<Date | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is Date => value instanceof Date)
    .map((value) => value.getTime());
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function tokenWorkspaceState(
  token: {
    workspaceId: string | null;
    authorizedWorkspaces: unknown;
  } | undefined,
  workspaceId: string | null,
): UniversalAssignmentProjectionIdentity["workspaceVerification"] {
  if (!workspaceId) return "not_requested";
  if (!token) return "unverified";
  const known = new Set<string>();
  if (Array.isArray(token.authorizedWorkspaces)) {
    for (const workspace of token.authorizedWorkspaces) {
      if (
        workspace &&
        typeof workspace === "object" &&
        "id" in workspace &&
        typeof (workspace as { id?: unknown }).id !== "undefined"
      ) {
        known.add(String((workspace as { id: unknown }).id));
      }
    }
  }
  if (known.size === 0) return "unverified";
  return known.has(workspaceId) ? "verified" : "mismatch";
}

/**
 * Resolve durable ClickUp identity independently from personal credential
 * state. An active department member's stored ClickUp id remains projection
 * ready when their personal OAuth token is absent or disconnected.
 */
export async function resolveClickUpIdentities(
  targets: ClickUpIdentityTarget[],
  workspaceId: string | null = null,
): Promise<Map<string, ResolvedClickUpIdentity>> {
  const out = new Map<string, ResolvedClickUpIdentity>();
  if (targets.length === 0) return out;

  const userIds = [...new Set(targets.map((target) => target.userId))];
  const { members, tokens, configuredWorkspaceId } = await withDbAttribution("assignments:clickupIdentity:load", async () => {
    const db = getDb();
    const [members, tokens, mappingRows] = await Promise.all([
      db
        .select({
          userId: sdDepartmentMembers.userId,
          departmentId: sdDepartmentMembers.departmentId,
          clickupUserId: sdDepartmentMembers.clickupUserId,
          updatedAt: sdDepartmentMembers.updatedAt,
        })
        .from(sdDepartmentMembers)
        .where(
          and(
            inArray(sdDepartmentMembers.userId, userIds),
            eq(sdDepartmentMembers.active, true),
          ),
        ),
      db
        .select({
          userId: clickupUserTokens.userId,
          clickupUserId: clickupUserTokens.clickupUserId,
          status: clickupUserTokens.status,
          workspaceId: clickupUserTokens.workspaceId,
          authorizedWorkspaces: clickupUserTokens.authorizedWorkspaces,
          updatedAt: clickupUserTokens.updatedAt,
        })
        .from(clickupUserTokens)
        .where(inArray(clickupUserTokens.userId, userIds)),
      workspaceId
        ? db
            .select({ workspaceId: sdListMapping.clickupWorkspaceId })
            .from(sdListMapping)
            .limit(1)
        : Promise.resolve([]),
    ]);
    return {
      members,
      tokens,
      configuredWorkspaceId: mappingRows[0]?.workspaceId ?? null,
    };
  });

  const membersByUser = new Map<string, typeof members>();
  for (const member of members) {
    const list = membersByUser.get(member.userId) ?? [];
    list.push(member);
    membersByUser.set(member.userId, list);
  }
  const tokenByUser = new Map(tokens.map((token) => [token.userId, token]));

  for (const target of targets) {
    const userMembers = membersByUser.get(target.userId) ?? [];
    const uniqueDurableIds = [
      ...new Set(
        userMembers
          .map((candidate) => candidate.clickupUserId?.trim() || null)
          .filter((id): id is string => !!id),
      ),
    ];
    const member = target.departmentId
      ? userMembers.find((candidate) => candidate.departmentId === target.departmentId)
      : uniqueDurableIds.length === 1
        ? userMembers.find(
            (candidate) => candidate.clickupUserId?.trim() === uniqueDurableIds[0],
          )
        : undefined;
    const token = tokenByUser.get(target.userId);
    const requireActiveDepartmentMembership =
      target.requireActiveDepartmentMembership ?? !!target.departmentId;
    const activeDepartmentMember = !requireActiveDepartmentMembership || !!member;
    const credentialConnected = token?.status === "connected";
    const credentialStatus = token?.status ?? "not_connected";
    const tokenVerification = tokenWorkspaceState(token, workspaceId);
    const memberVerification: UniversalAssignmentProjectionIdentity["workspaceVerification"] =
      !workspaceId
        ? "not_requested"
        : !configuredWorkspaceId
          ? "unverified"
          : configuredWorkspaceId === workspaceId
            ? "verified"
            : "mismatch";
    const providedVerification: UniversalAssignmentProjectionIdentity["workspaceVerification"] =
      !workspaceId
        ? "not_requested"
        : target.preferredClickUpUserIdVerified
          ? "verified"
          : "unverified";
    const providedId = target.preferredClickUpUserId?.trim() || null;
    const memberId =
      target.allowDurableMemberFallback === false
        ? null
        : member?.clickupUserId?.trim() || null;
    const tokenId =
      credentialConnected &&
      (!workspaceId || tokenVerification === "verified")
        ? token?.clickupUserId?.trim() || null
        : null;
    // Preserve the established connected-token preference. The durable member
    // id is the fallback that keeps projection working after disconnect.
    const externalUserId = activeDepartmentMember
      ? providedId ?? tokenId ?? memberId
      : null;
    const source = providedId
      ? "provided"
      : tokenId
        ? "personal_oauth"
        : memberId
          ? "department_member"
          : null;
    const durableIdentity = source === "provided" || source === "department_member";
    const effectiveWorkspaceVerification =
      source === "provided"
        ? providedVerification
        : source === "department_member"
          ? memberVerification
          : tokenVerification;
    const resolved: ResolvedClickUpIdentity = {
      provider: "clickup",
      userId: target.userId,
      departmentId: target.departmentId ?? null,
      workspaceId,
      externalUserId,
      source,
      credentialConnected,
      credentialStatus,
      workspaceVerification: effectiveWorkspaceVerification,
      activeDepartmentMember,
      ready:
        activeDepartmentMember &&
        !!externalUserId &&
        (!workspaceId || effectiveWorkspaceVerification === "verified"),
      revision: isoMax([member?.updatedAt, token?.updatedAt]),
    };
    out.set(identityKey(target.userId, target.departmentId), resolved);
  }

  return out;
}

export async function resolveClickUpIdentity(
  target: ClickUpIdentityTarget,
  workspaceId: string | null = null,
): Promise<ResolvedClickUpIdentity> {
  const resolved = await resolveClickUpIdentities([target], workspaceId);
  return resolved.get(identityKey(target.userId, target.departmentId))!;
}

function neutralSource(source: SdRoleSource): UniversalAssignmentSource {
  return source === "assignment" ? "client_override" : source;
}

function emptyProjection(workspaceId: string | null): UniversalAssignmentProjectionIdentity {
  return {
    provider: "clickup",
    workspaceId,
    externalUserId: null,
    source: null,
    credentialConnected: false,
    credentialStatus: "not_connected",
    workspaceVerification: workspaceId ? "unverified" : "not_requested",
    ready: false,
    revision: null,
  };
}

function buildSnapshot(args: {
  department: DepartmentRow;
  clientId: string | null;
  assignment: AssignmentRow | null;
  activeMembers: Set<string>;
  identities: Map<string, ResolvedClickUpIdentity>;
  workspaceId: string | null;
  computedAt: string;
}): UniversalAssignmentSnapshot {
  const { department, assignment, clientId, activeMembers, identities, workspaceId, computedAt } = args;
  const effective = computeEffectiveRoles(department, assignment);
  const roleInput: Partial<Record<
    UniversalAssignmentResponsibility,
    { userId: string | null; source: SdRoleSource }
  >> = {
    doer: { userId: effective.primaryUserId, source: effective.sources.primary },
  };
  if (departmentSupportsChecker(department.id)) {
    roleInput.checker = { userId: effective.checkerUserId, source: effective.sources.checker };
  }
  const roles = Object.fromEntries(
    (Object.entries(roleInput) as Array<
      [UniversalAssignmentResponsibility, { userId: string | null; source: SdRoleSource }]
    >).map(([responsibility, value]) => {
      const eligible = !!value.userId && activeMembers.has(value.userId);
      return [
        responsibility,
        {
          userId: value.userId,
          source: neutralSource(value.source),
          eligibility: !value.userId ? "unassigned" : eligible ? "eligible" : "ineligible",
          stale: !!value.userId && !eligible,
          projection: value.userId
            ? identities.get(identityKey(value.userId, department.id)) ?? emptyProjection(workspaceId)
            : emptyProjection(workspaceId),
        },
      ];
    }),
  ) as UniversalAssignmentSnapshot["roles"];

  const clientOverrideUpdatedAt =
    !isCompanyScoped(department) && assignment ? assignment.updatedAt.toISOString() : null;
  return {
    clientId,
    departmentId: department.id,
    scope: isCompanyScoped(department) ? "company" : "per_client",
    departmentActive: department.active,
    revision: [
      isCompanyScoped(department) ? "company" : "per_client",
      department.updatedAt.toISOString(),
      clientOverrideUpdatedAt ?? "no-client-override",
    ].join(":"),
    freshness: {
      computedAt,
      departmentUpdatedAt: department.updatedAt.toISOString(),
      clientOverrideUpdatedAt,
    },
    roles,
  };
}

export async function resolveUniversalAssignmentsForDepartments(args: {
  departmentIds?: string[];
  clientId: string | null;
  workspaceId?: string | null;
  activeOnly?: boolean;
}): Promise<Map<string, UniversalAssignmentSnapshot>> {
  if (args.departmentIds && args.departmentIds.length === 0) {
    return new Map<string, UniversalAssignmentSnapshot>();
  }
  const workspaceId = args.workspaceId ?? null;
  const activeOnly = args.activeOnly ?? true;
  const { departments, assignments, members } = await withDbAttribution(
    "assignments:snapshots:load",
    async () => {
      const db = getDb();
      const departmentFilter = args.departmentIds?.length
        ? inArray(sdDepartments.id, args.departmentIds)
        : undefined;
      const departments = await db
        .select({
          id: sdDepartments.id,
          name: sdDepartments.name,
          active: sdDepartments.active,
          assignmentScope: sdDepartments.assignmentScope,
          defaultPrimaryUserId: sdDepartments.defaultPrimaryUserId,
          defaultCheckerUserId: sdDepartments.defaultCheckerUserId,
          updatedAt: sdDepartments.updatedAt,
        })
        .from(sdDepartments)
        .where(
          departmentFilter && activeOnly
            ? and(departmentFilter, eq(sdDepartments.active, true))
            : departmentFilter ?? (activeOnly ? eq(sdDepartments.active, true) : undefined),
        );
      const departmentIds = departments.map((department) => department.id);
      const perClientIds = departments
        .filter((department) => !isCompanyScoped(department))
        .map((department) => department.id);
      const [assignments, members] = await Promise.all([
        args.clientId && perClientIds.length > 0
          ? db
              .select()
              .from(sdClientDeptAssignments)
              .where(
                and(
                  eq(sdClientDeptAssignments.clientId, args.clientId),
                  inArray(sdClientDeptAssignments.departmentId, perClientIds),
                ),
              )
          : Promise.resolve([]),
        departmentIds.length > 0
          ? db
              .select({
                departmentId: sdDepartmentMembers.departmentId,
                userId: sdDepartmentMembers.userId,
              })
              .from(sdDepartmentMembers)
              .where(
                and(
                  inArray(sdDepartmentMembers.departmentId, departmentIds),
                  eq(sdDepartmentMembers.active, true),
                ),
              )
          : Promise.resolve([]),
      ]);
      return { departments, assignments: assignments as AssignmentRow[], members };
    },
  );

  const assignmentByDepartment = new Map(
    assignments.map((assignment) => [assignment.departmentId, assignment]),
  );
  const activeMembersByDepartment = new Map<string, Set<string>>();
  for (const member of members) {
    const set = activeMembersByDepartment.get(member.departmentId) ?? new Set<string>();
    set.add(member.userId);
    activeMembersByDepartment.set(member.departmentId, set);
  }

  const identityTargets: ClickUpIdentityTarget[] = [];
  for (const department of departments) {
    const effective = computeEffectiveRoles(
      department,
      assignmentByDepartment.get(department.id) ?? null,
    );
    for (const userId of [
      effective.primaryUserId,
      departmentSupportsChecker(department.id) ? effective.checkerUserId : null,
    ]) {
      if (userId) identityTargets.push({ userId, departmentId: department.id });
    }
  }
  const identities = await resolveClickUpIdentities(
    [...new Map(identityTargets.map((target) => [identityKey(target.userId, target.departmentId), target])).values()],
    workspaceId,
  );
  const computedAt = new Date().toISOString();
  const out = new Map<string, UniversalAssignmentSnapshot>();
  for (const department of departments) {
    out.set(
      department.id,
      buildSnapshot({
        department,
        clientId: isCompanyScoped(department) ? null : args.clientId,
        assignment: assignmentByDepartment.get(department.id) ?? null,
        activeMembers: activeMembersByDepartment.get(department.id) ?? new Set<string>(),
        identities,
        workspaceId,
        computedAt,
      }),
    );
  }
  return out;
}

export async function resolveUniversalAssignment(args: {
  departmentId: string;
  clientId: string | null;
  workspaceId?: string | null;
}): Promise<UniversalAssignmentSnapshot | null> {
  const snapshots = await resolveUniversalAssignmentsForDepartments({
    departmentIds: [args.departmentId],
    clientId: args.clientId,
    workspaceId: args.workspaceId,
    activeOnly: false,
  });
  return snapshots.get(args.departmentId) ?? null;
}

/**
 * Task #5157 — batched effective-role resolver for MANY clients in ONE
 * department, in a single bounded DB load (no N+1). Preserves the canonical
 * override-then-default semantics (computeEffectiveRoles) and active-member
 * eligibility. Returns the supported Doer/Checker roles.
 *
 * A client id absent from the returned map means "no effective doer/checker"
 * (department not found, or company-scoped with no defaults). Callers that
 * need a fail-closed null should treat a missing entry as null roles.
 */
export interface BatchedEffectiveRole {
  /** Effective userId after override-then-default (null = unassigned). */
  userId: string | null;
  /** true when userId is set AND is an active department member. */
  eligible: boolean;
}

export async function resolveEffectiveRolesForClientsBatched(args: {
  departmentId: string;
  clientIds: string[];
}): Promise<Map<string, { doer: BatchedEffectiveRole; checker: BatchedEffectiveRole }>> {
  const out = new Map<
    string,
    { doer: BatchedEffectiveRole; checker: BatchedEffectiveRole }
  >();
  const uniqueClientIds = [...new Set(args.clientIds)];
  if (uniqueClientIds.length === 0) return out;

  const { department, assignments, activeMemberIds } = await withDbAttribution(
    "assignments:effectiveRoles:batched",
    async () => {
      const db = getDb();
      const [dept] = await db
        .select({
          id: sdDepartments.id,
          name: sdDepartments.name,
          active: sdDepartments.active,
          assignmentScope: sdDepartments.assignmentScope,
          defaultPrimaryUserId: sdDepartments.defaultPrimaryUserId,
          defaultCheckerUserId: sdDepartments.defaultCheckerUserId,
          updatedAt: sdDepartments.updatedAt,
        })
        .from(sdDepartments)
        .where(eq(sdDepartments.id, args.departmentId))
        .limit(1);
      if (!dept) {
        return { department: null, assignments: [] as AssignmentRow[], activeMemberIds: new Set<string>() };
      }
      const [assignments, members] = await Promise.all([
        isCompanyScoped(dept)
          ? Promise.resolve([] as AssignmentRow[])
          : db
              .select()
              .from(sdClientDeptAssignments)
              .where(
                and(
                  eq(sdClientDeptAssignments.departmentId, args.departmentId),
                  inArray(sdClientDeptAssignments.clientId, uniqueClientIds),
                ),
              ),
        db
          .select({ userId: sdDepartmentMembers.userId })
          .from(sdDepartmentMembers)
          .where(
            and(
              eq(sdDepartmentMembers.departmentId, args.departmentId),
              eq(sdDepartmentMembers.active, true),
            ),
          ),
      ]);
      const activeMemberIds = new Set(members.map((m) => m.userId));
      return { department: dept, assignments: assignments as AssignmentRow[], activeMemberIds };
    },
  );

  if (!department) return out;

  const assignmentByClient = new Map(
    assignments.map((a) => [a.clientId, a]),
  );
  const toRole = (userId: string | null): BatchedEffectiveRole => ({
    userId,
    eligible: !!userId && activeMemberIds.has(userId),
  });

  for (const clientId of uniqueClientIds) {
    const effective = computeEffectiveRoles(
      department,
      assignmentByClient.get(clientId) ?? null,
    );
    out.set(clientId, {
      doer: toRole(effective.primaryUserId),
      checker: toRole(
        departmentSupportsChecker(department.id) ? effective.checkerUserId : null,
      ),
    });
  }
  return out;
}

export interface SdSubmitAutoAssign {
  primaryUserId: string | null;
  checkerUserId: string | null;
  primaryClickupId: string | null;
  checkerClickupId: string | null;
}

export async function resolveSubmitAutoAssign(args: {
  departmentId: string | null;
  clientId: string | null;
  dept?: SdDeptRoleFields | null;
  workspaceId?: string | null;
}): Promise<SdSubmitAutoAssign> {
  if (!args.departmentId) {
    const effective = await resolveEffectiveRoles(args);
    return {
      primaryUserId: effective.primaryUserId,
      checkerUserId: effective.checkerUserId,
      primaryClickupId: null,
      checkerClickupId: null,
    };
  }
  const snapshot = await resolveUniversalAssignment({
    departmentId: args.departmentId,
    clientId: args.clientId,
    workspaceId: args.workspaceId,
  });
  if (!snapshot) {
    return {
      primaryUserId: null,
      checkerUserId: null,
      primaryClickupId: null,
      checkerClickupId: null,
    };
  }
  return {
    primaryUserId: snapshot.roles.doer.userId,
    checkerUserId: snapshot.roles.checker?.userId ?? null,
    primaryClickupId: snapshot.roles.doer.projection.ready
      ? snapshot.roles.doer.projection.externalUserId
      : null,
    checkerClickupId: snapshot.roles.checker?.projection.ready
      ? snapshot.roles.checker.projection.externalUserId
      : null,
  };
}

async function lockAssignmentDepartment(db: any, departmentId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`universal-assignment:${departmentId}`})::bigint)`,
  );
}

async function validateAssignmentEligibilityUsing(
  db: any,
  departmentId: string,
  patch: AssignmentRoleHolderPatch,
  options: { activeDepartmentOnly?: boolean } = {},
): Promise<AssignmentEligibilityResult> {
  const predicates = [eq(sdDepartments.id, departmentId)];
  if (options.activeDepartmentOnly) predicates.push(eq(sdDepartments.active, true));
  const [department] = (await db
    .select()
    .from(sdDepartments)
    .where(and(...predicates))
    .limit(1)) as DepartmentRow[];
  if (!department) return { ok: false, kind: "department_not_found" };
  if (patch.checkerUserId && !departmentSupportsChecker(department.id)) {
    return { ok: false, kind: "unsupported_role", field: "checkerUserId" };
  }
  const entries = (
    Object.entries(patch) as Array<[keyof AssignmentRoleHolderPatch, string | null | undefined]>
  ).filter((entry): entry is [keyof AssignmentRoleHolderPatch, string] => !!entry[1]);
  if (entries.length === 0) return { ok: true, department };
  const userIds = [...new Set(entries.map(([, userId]) => userId))];
  const memberships = await db
    .select({ userId: sdDepartmentMembers.userId })
    .from(sdDepartmentMembers)
    .where(
      and(
        eq(sdDepartmentMembers.departmentId, departmentId),
        inArray(sdDepartmentMembers.userId, userIds),
        eq(sdDepartmentMembers.active, true),
      ),
    );
  const eligibleUserIds = new Set(
    memberships.map((membership: { userId: string }) => membership.userId),
  );
  for (const [field, userId] of entries) {
    if (!eligibleUserIds.has(userId)) {
      return { ok: false, kind: "ineligible", field, userId };
    }
  }
  return { ok: true, department };
}

export async function validateAssignmentEligibility(
  departmentId: string,
  patch: AssignmentRoleHolderPatch,
  options: { activeDepartmentOnly?: boolean } = {},
): Promise<AssignmentEligibilityResult> {
  return withDbAttribution("assignments:eligibility", async () =>
    validateAssignmentEligibilityUsing(getDb(), departmentId, patch, options),
  );
}

export type ClientAssignmentMutationResult =
  | {
      ok: true;
      assignment: typeof sdClientDeptAssignments.$inferSelect;
      projection: ProjectionSummary;
    }
  | AssignmentEligibilityFailure
  | { ok: false; kind: "company_scope" };

export async function setClientDepartmentAssignment(args: {
  clientId: string;
  departmentId: string;
  primaryUserId: string | null;
  checkerUserId: string | null;
}): Promise<ClientAssignmentMutationResult> {
  const mutation = await withDbAttribution("assignments:clientOverride:set", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      await lockAssignmentDepartment(tx, args.departmentId);
      const eligibility = await validateAssignmentEligibilityUsing(
        tx,
        args.departmentId,
        {
          primaryUserId: args.primaryUserId,
          checkerUserId: args.checkerUserId,
        },
        { activeDepartmentOnly: true },
      );
      if (!eligibility.ok) return eligibility;
      if (isCompanyScoped(eligibility.department)) {
        return { ok: false as const, kind: "company_scope" as const };
      }
      const [assignment] = await tx
        .insert(sdClientDeptAssignments)
        .values({
          clientId: args.clientId,
          departmentId: args.departmentId,
          primaryUserId: args.primaryUserId,
          checkerUserId: args.checkerUserId,
        })
        .onConflictDoUpdate({
          target: [sdClientDeptAssignments.clientId, sdClientDeptAssignments.departmentId],
          set: {
            primaryUserId: args.primaryUserId,
            checkerUserId: args.checkerUserId,
            updatedAt: new Date(),
          },
        })
        .returning();
      // Stage projection commands inside transaction (no network calls).
      const roles = await buildClientProjectionRoles(
        tx,
        args.clientId,
        args.departmentId,
        args.primaryUserId,
        args.checkerUserId,
      );
      const projection = await stageProjectionCommandsInTx(tx, roles);
      return { ok: true as const, assignment, projection };
    });
  });
  if (!mutation.ok) return mutation;
  // Single-client save is a small, bounded set of exact commands (<= 3 roles).
  // Await exact-target immediate attempts and return the HONEST post-attempt
  // summary (re-read exact command statuses), never the pre-attempt staging one.
  const projection = await runBoundedImmediateAttempts(mutation.projection);
  return {
    ok: true,
    assignment: mutation.assignment,
    projection,
  };
}

export type ClientAssignmentNoProjectionResult =
  | { ok: true; assignment: typeof sdClientDeptAssignments.$inferSelect }
  | AssignmentEligibilityFailure
  | { ok: false; kind: "company_scope" }
  | { ok: false; kind: "concurrent_conflict" };

type ClientAssignmentRoleSnapshot = {
  primaryUserId: string | null;
  checkerUserId: string | null;
};

/**
 * Task #5157 fix 1 — NoBull-ONLY client-department assignment write.
 *
 * Shares the same lock → active-department eligibility → company-scope guard
 * → conflict-upsert pattern as setClientDepartmentAssignment, but performs ZERO
 * projection command staging (no buildClientProjectionRoles /
 * stageProjectionCommandsInTx) and ZERO immediate vendor attempts (no
 * runBoundedImmediateAttempts). It therefore NEVER touches
 * cu_role_projection_commands and NEVER emits a single ClickUp vendor apply/
 * read-back call — even when production destinations exist and every cutover
 * approval is enabled.
 *
 * This is the write used by the Paid Search role IMPORT, whose contract is to
 * populate NoBull's own assignment table from ClickUp's existing state without
 * projecting anything back out to ClickUp (the import reads FROM ClickUp; it
 * must not write back). Projection back to ClickUp remains the job of the
 * generic role-projection worker driven by the interactive
 * setClientDepartmentAssignment path, which is left unchanged.
 */
export async function setClientDepartmentAssignmentNoProjection(args: {
  clientId: string;
  departmentId: string;
  primaryUserId: string | null;
  checkerUserId: string | null;
  /**
   * Compare-and-set guard for one-time imports. Null means the caller
   * observed no assignment row. The comparison runs while holding the same
   * department lock used by interactive assignment writes, so an operator
   * Doer/Checker edit after preview is never overwritten by a stale role upsert.
   */
  expectedAssignment: ClientAssignmentRoleSnapshot | null;
  /**
   * Optional durable side effect that must commit atomically with the
   * assignment (the one-time import uses it for its append-only audit row).
   * Throwing rolls the assignment write back. Must perform DB work only.
   */
  afterAssignmentWriteInTransaction?: (
    tx: ProjectionTx,
    assignment: typeof sdClientDeptAssignments.$inferSelect,
  ) => Promise<void>;
}): Promise<ClientAssignmentNoProjectionResult> {
  return withDbAttribution("assignments:clientOverride:setNoProjection", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      await lockAssignmentDepartment(tx, args.departmentId);
      const eligibility = await validateAssignmentEligibilityUsing(
        tx,
        args.departmentId,
        {
          primaryUserId: args.primaryUserId,
          checkerUserId: args.checkerUserId,
        },
        { activeDepartmentOnly: true },
      );
      if (!eligibility.ok) return eligibility;
      if (isCompanyScoped(eligibility.department)) {
        return { ok: false as const, kind: "company_scope" as const };
      }
      const [currentAssignment] = await tx
        .select({
          primaryUserId: sdClientDeptAssignments.primaryUserId,
          checkerUserId: sdClientDeptAssignments.checkerUserId,
        })
        .from(sdClientDeptAssignments)
        .where(
          and(
            eq(sdClientDeptAssignments.clientId, args.clientId),
            eq(sdClientDeptAssignments.departmentId, args.departmentId),
          ),
        )
        .limit(1);
      const expected = args.expectedAssignment;
      const currentMatchesExpected =
        expected === null
          ? currentAssignment === undefined
          : currentAssignment !== undefined &&
            currentAssignment.primaryUserId === expected.primaryUserId &&
            currentAssignment.checkerUserId === expected.checkerUserId;
      if (!currentMatchesExpected) {
        return { ok: false as const, kind: "concurrent_conflict" as const };
      }
      const [assignment] = await tx
        .insert(sdClientDeptAssignments)
        .values({
          clientId: args.clientId,
          departmentId: args.departmentId,
          primaryUserId: args.primaryUserId,
          checkerUserId: args.checkerUserId,
        })
        .onConflictDoUpdate({
          target: [sdClientDeptAssignments.clientId, sdClientDeptAssignments.departmentId],
          set: {
            primaryUserId: args.primaryUserId,
            checkerUserId: args.checkerUserId,
            updatedAt: new Date(),
          },
        })
        .returning();
      await args.afterAssignmentWriteInTransaction?.(tx, assignment);
      // NO projection staging, NO immediate vendor attempts — NoBull-only.
      return { ok: true as const, assignment };
    });
  });
}

export type DepartmentRoleMutationResult =
  | {
      ok: true;
      previous: typeof sdDepartments.$inferSelect;
      department: typeof sdDepartments.$inferSelect;
      projection: ProjectionSummary;
    }
  | AssignmentEligibilityFailure;

export async function setDepartmentRoleAssignments(args: {
  departmentId: string;
  patch: AssignmentRoleHolderPatch;
}): Promise<DepartmentRoleMutationResult> {
  const set: AssignmentRoleHolderPatch & { updatedAt: Date } = { updatedAt: new Date() };
  if (args.patch.primaryUserId !== undefined) set.primaryUserId = args.patch.primaryUserId || null;
  if (args.patch.checkerUserId !== undefined) set.checkerUserId = args.patch.checkerUserId || null;
  const departmentSet = {
    ...(set.primaryUserId !== undefined ? { defaultPrimaryUserId: set.primaryUserId } : {}),
    ...(set.checkerUserId !== undefined ? { defaultCheckerUserId: set.checkerUserId } : {}),
    updatedAt: set.updatedAt,
  };
  const mutation = await withDbAttribution("assignments:departmentRoles:set", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      await lockAssignmentDepartment(tx, args.departmentId);
      const eligibility = await validateAssignmentEligibilityUsing(
        tx,
        args.departmentId,
        args.patch,
      );
      if (!eligibility.ok) return eligibility;
      const previous = eligibility.department as typeof sdDepartments.$inferSelect;
      const [department] = await tx
        .update(sdDepartments)
        .set(departmentSet)
        .where(eq(sdDepartments.id, args.departmentId))
        .returning();
      // Default-slot change fan-out: stage per-affected-client (or company) commands
      // inside this tx (no network). computeEffectiveRoles resolves override-else-default.
      const changed: UniversalAssignmentResponsibility[] = [];
      if (args.patch.primaryUserId !== undefined) changed.push("doer");
      if (args.patch.checkerUserId !== undefined) changed.push("checker");
      const fan = await fanOutDepartmentProjectionInTx(tx, args.departmentId, changed);
      return {
        ok: true as const,
        previous,
        department,
        projection: toProjectionSummary(fan.summary),
        subjects: fan.subjects,
      };
    });
  });
  if (!mutation.ok) return mutation;
  // Fan-out affects many subjects → safe-kick only (bulk path).
  void kickClickUpRoleProjectionSafe();
  return {
    ok: true,
    previous: mutation.previous,
    department: mutation.department,
    projection: mutation.projection,
  };
}

export type DepartmentConfigurationPatch = {
  name?: string;
  active?: boolean;
  sortOrder?: number;
  assignmentScope?: typeof sdDepartments.$inferInsert.assignmentScope;
  defaultPrimaryUserId?: string | null;
  defaultCheckerUserId?: string | null;
};

export async function updateDepartmentConfiguration(args: {
  departmentId: string;
  patch: DepartmentConfigurationPatch;
}): Promise<
  | { ok: true; department: typeof sdDepartments.$inferSelect; projection: ProjectionSummary }
  | AssignmentEligibilityFailure
> {
  const rolePatch: AssignmentRoleHolderPatch = {
    ...(args.patch.defaultPrimaryUserId !== undefined
      ? { primaryUserId: args.patch.defaultPrimaryUserId }
      : {}),
    ...(args.patch.defaultCheckerUserId !== undefined
      ? { checkerUserId: args.patch.defaultCheckerUserId }
      : {}),
  };
  const result = await withDbAttribution("assignments:department:update", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      await lockAssignmentDepartment(tx, args.departmentId);
      const eligibility = await validateAssignmentEligibilityUsing(
        tx,
        args.departmentId,
        rolePatch,
      );
      if (!eligibility.ok) return eligibility;
      const [department] = await tx
        .update(sdDepartments)
        .set({ // spread-write-approved: typed DepartmentConfigurationPatch fields, each individually whitelisted (name/active/sortOrder/assignmentScope/default*UserId); no request-shaped object reaches this write and no ownership/audit/sync-state column is spread.
          ...(args.patch.name !== undefined ? { name: args.patch.name } : {}),
          ...(args.patch.active !== undefined ? { active: args.patch.active } : {}),
          ...(args.patch.sortOrder !== undefined ? { sortOrder: args.patch.sortOrder } : {}),
          ...(args.patch.assignmentScope !== undefined
            ? { assignmentScope: args.patch.assignmentScope }
            : {}),
          ...(args.patch.defaultPrimaryUserId !== undefined
            ? { defaultPrimaryUserId: args.patch.defaultPrimaryUserId || null }
            : {}),
          ...(args.patch.defaultCheckerUserId !== undefined
            ? { defaultCheckerUserId: args.patch.defaultCheckerUserId || null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(sdDepartments.id, args.departmentId))
        .returning();
      // Fan-out for default-slot AND assignmentScope changes: stage per-affected
      // subject commands inside this tx (no network). A scope change flips
      // company↔per-client effective resolution, so re-stage all responsibilities.
      const scopeChanged = args.patch.assignmentScope !== undefined;
      const changed: UniversalAssignmentResponsibility[] = [];
      if (scopeChanged || args.patch.defaultPrimaryUserId !== undefined) changed.push("doer");
      if (scopeChanged || args.patch.defaultCheckerUserId !== undefined) changed.push("checker");
      let projection = emptyProjectionSummary();
      if (changed.length > 0) {
        const fan = await fanOutDepartmentProjectionInTx(tx, args.departmentId, changed);
        projection = toProjectionSummary(fan.summary);
      }
      return { ok: true as const, department, projection };
    });
  });
  if (!result.ok) return result;
  // Fan-out is a bulk path → safe-kick only.
  void kickClickUpRoleProjectionSafe();
  return result;
}

export type BulkAssignmentMutationResult =
  | {
      ok: true;
      changes: Array<{
        clientId: string;
        previousUserId: string | null;
        newUserId: string | null;
        overwritten: boolean;
      }>;
      projection: ProjectionSummary;
    }
  | AssignmentEligibilityFailure
  | { ok: false; kind: "company_scope" }
  | { ok: false; kind: "invalid_clients"; clientIds: string[] };

export async function setBulkClientAssignments(args: {
  departmentId: string;
  responsibility: UniversalAssignmentResponsibility;
  userId: string | null;
  clientIds: string[];
}): Promise<BulkAssignmentMutationResult> {
  const roleColumn = ROLE_FIELD_BY_RESPONSIBILITY[args.responsibility];
  const result = await withDbAttribution("assignments:bulk:set", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      await lockAssignmentDepartment(tx, args.departmentId);
      const eligibility = await validateAssignmentEligibilityUsing(
        tx,
        args.departmentId,
        { [roleColumn]: args.userId },
        { activeDepartmentOnly: true },
      );
      if (!eligibility.ok) return eligibility;
      if (isCompanyScoped(eligibility.department)) {
        return { ok: false as const, kind: "company_scope" as const };
      }
      const validClients = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(
          and(
            inArray(clients.id, args.clientIds),
            eq(clients.isArchived, false),
            eq(clients.lifecycleStage, "customer"),
          ),
        );
      if (validClients.length !== args.clientIds.length) {
        const validIds = new Set(validClients.map((client: { id: string }) => client.id));
        return {
          ok: false as const,
          kind: "invalid_clients" as const,
          clientIds: args.clientIds.filter((clientId) => !validIds.has(clientId)),
        };
      }
      const existing = await tx
        .select()
        .from(sdClientDeptAssignments)
        .where(
          and(
            eq(sdClientDeptAssignments.departmentId, args.departmentId),
            inArray(sdClientDeptAssignments.clientId, args.clientIds),
          ),
        );
      const byClient = new Map(existing.map((assignment) => [assignment.clientId, assignment]));
      const out: Array<{
        clientId: string;
        previousUserId: string | null;
        newUserId: string | null;
        overwritten: boolean;
      }> = [];
      for (const clientId of args.clientIds) {
        const previousUserId =
          (byClient.get(clientId)?.[roleColumn] as string | null | undefined) ?? null;
        await tx
          .insert(sdClientDeptAssignments)
          .values({
            clientId,
            departmentId: args.departmentId,
            primaryUserId: roleColumn === "primaryUserId" ? args.userId : null,
            checkerUserId: roleColumn === "checkerUserId" ? args.userId : null,
          })
          .onConflictDoUpdate({
            target: [sdClientDeptAssignments.clientId, sdClientDeptAssignments.departmentId],
            set: { [roleColumn]: args.userId, updatedAt: new Date() },
          });
        out.push({
          clientId,
          previousUserId,
          newUserId: args.userId,
          overwritten: previousUserId !== null && previousUserId !== args.userId,
        });
      }
      // Stage projection commands for all clients in bulk (safe-kick only; no immediate attempt).
      // Resolve ClickUp ID for the single user being set.
      const cuIdRow = args.userId
        ? await tx
            .select({ clickupUserId: sdDepartmentMembers.clickupUserId })
            .from(sdDepartmentMembers)
            .where(
              and(
                eq(sdDepartmentMembers.departmentId, args.departmentId),
                eq(sdDepartmentMembers.userId, args.userId),
                eq(sdDepartmentMembers.active, true),
              ),
            )
            .limit(1)
        : [];
      const cuId = cuIdRow[0]?.clickupUserId ?? null;
      const bulkRoles: ProjectionRoleInput[] = args.clientIds.map((clientId) => ({
        clientId,
        departmentId: args.departmentId,
        responsibility: args.responsibility,
        desiredUserId: args.userId,
        desiredClickupUserId: args.userId ? cuId : null,
      }));
      const projection = await stageProjectionCommandsInTx(tx, bulkRoles);
      return { ok: true as const, changes: out, projection };
    });
  });
  // Post-commit: safe-kick (bulk can return pending without immediate attempt).
  void kickClickUpRoleProjectionSafe();
  return result as BulkAssignmentMutationResult;
}

export type ClearedMemberAssignments = {
  clientAssignments: Array<{
    clientId: string;
    clearedPrimary: boolean;
    clearedChecker: boolean;
  }>;
  departmentSlots: {
    clearedPrimary: boolean;
    clearedChecker: boolean;
  };
};

function emptyClearedMemberAssignments(): ClearedMemberAssignments {
  return {
    clientAssignments: [],
    departmentSlots: {
      clearedPrimary: false,
      clearedChecker: false,
    },
  };
}

async function clearAssignmentsForMemberUsing(
  db: any,
  departmentId: string,
  userId: string,
  stagedRefsOut?: ProjectionCommandRef[],
): Promise<ClearedMemberAssignments> {
  const affected = (await db
    .select()
    .from(sdClientDeptAssignments)
    .where(
      and(
        eq(sdClientDeptAssignments.departmentId, departmentId),
        or(
          eq(sdClientDeptAssignments.primaryUserId, userId),
          eq(sdClientDeptAssignments.checkerUserId, userId),
        ),
      ),
    )) as Array<typeof sdClientDeptAssignments.$inferSelect>;
  const clientAssignments: ClearedMemberAssignments["clientAssignments"] = [];

  // Build projection roles for cleared assignments (null = clear the People field).
  const projectionRoles: ProjectionRoleInput[] = [];

  for (const assignment of affected) {
    const clearedPrimary = assignment.primaryUserId === userId;
    const clearedChecker = assignment.checkerUserId === userId;
    await db
      .update(sdClientDeptAssignments)
      .set({ // spread-write-approved: internally computed clear flags (cleared* booleans derived by comparing the departing member's userId to the row's own slots); only literal `null` clears are spread — no request-shaped data or ownership/audit column.
        ...(clearedPrimary ? { primaryUserId: null } : {}),
        ...(clearedChecker ? { checkerUserId: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sdClientDeptAssignments.id, assignment.id));
    clientAssignments.push({
      clientId: assignment.clientId,
      clearedPrimary,
      clearedChecker,
    });
    // Stage projection clear for each cleared responsibility.
    if (clearedPrimary) {
      projectionRoles.push({
        clientId: assignment.clientId,
        departmentId,
        responsibility: "doer",
        desiredUserId: null,
        desiredClickupUserId: null,
      });
    }
    if (clearedChecker) {
      projectionRoles.push({
        clientId: assignment.clientId,
        departmentId,
        responsibility: "checker",
        desiredUserId: null,
        desiredClickupUserId: null,
      });
    }
  }

  // Stage all projection clears atomically within the same transaction.
  if (projectionRoles.length > 0) {
    const summary = await stageProjectionCommandsInTx(db, projectionRoles);
    if (stagedRefsOut) for (const ref of summary.stagedRefs) stagedRefsOut.push(ref);
  }

  const departmentSlots = {
    clearedPrimary: false,
    clearedChecker: false,
  };
  const [department] = (await db
    .select()
    .from(sdDepartments)
    .where(eq(sdDepartments.id, departmentId))
    .limit(1)) as Array<typeof sdDepartments.$inferSelect>;
  if (department) {
    departmentSlots.clearedPrimary = department.defaultPrimaryUserId === userId;
    departmentSlots.clearedChecker = department.defaultCheckerUserId === userId;
    if (
      departmentSlots.clearedPrimary ||
      departmentSlots.clearedChecker
    ) {
      await db
        .update(sdDepartments)
        .set({ // spread-write-approved: internally computed clear flags (departmentSlots.cleared* derived by comparing the departing member's userId to the department's own default slots); only literal `null` clears are spread — no request-shaped data or ownership/audit column.
          ...(departmentSlots.clearedPrimary ? { defaultPrimaryUserId: null } : {}),
          ...(departmentSlots.clearedChecker ? { defaultCheckerUserId: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sdDepartments.id, departmentId));
      // A cleared default slot changes the EFFECTIVE role for every client that
      // relied on it. Fan out to affected subjects inside this same tx.
      const changed: UniversalAssignmentResponsibility[] = [];
      if (departmentSlots.clearedPrimary) changed.push("doer");
      if (departmentSlots.clearedChecker) changed.push("checker");
      const fan = await fanOutDepartmentProjectionInTx(db, departmentId, changed);
      if (stagedRefsOut) for (const ref of fan.summary.stagedRefs) stagedRefsOut.push(ref);
    }
  }
  return { clientAssignments, departmentSlots };
}

export async function clearAssignmentsForMember(
  departmentId: string,
  userId: string,
): Promise<ClearedMemberAssignments> {
  const refs: ProjectionCommandRef[] = [];
  const result = await withDbAttribution("assignments:member:clear", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      await lockAssignmentDepartment(tx, departmentId);
      return clearAssignmentsForMemberUsing(tx, departmentId, userId, refs);
    });
  });
  // Member removal is a bounded set of exact clears — await immediate attempts
  // for a small set, else safe-kick (bulk fan-out).
  if (refs.length > 0) {
    await runBoundedImmediateAttemptsRefs(refs);
  } else if (result.clientAssignments.length > 0) {
    void kickClickUpRoleProjectionSafe();
  }
  return result;
}

export async function upsertDepartmentMember(args: {
  departmentId: string;
  userId: string;
  clickupUserId: string | null;
}): Promise<typeof sdDepartmentMembers.$inferSelect> {
  return withDbAttribution("assignments:member:upsert", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      await lockAssignmentDepartment(tx, args.departmentId);
      const [member] = await tx
        .insert(sdDepartmentMembers)
        .values({
          departmentId: args.departmentId,
          userId: args.userId,
          clickupUserId: args.clickupUserId,
          active: true,
        })
        .onConflictDoUpdate({
          target: [sdDepartmentMembers.departmentId, sdDepartmentMembers.userId],
          set: {
            active: true,
            clickupUserId: sql`COALESCE(${args.clickupUserId}, ${sdDepartmentMembers.clickupUserId})`,
            updatedAt: new Date(),
          },
        })
        .returning();
      return member;
    });
  });
}

export async function updateDepartmentMember(args: {
  memberId: string;
  active?: boolean;
  clickupUserId?: string;
}): Promise<{
  member: typeof sdDepartmentMembers.$inferSelect;
  cleared: ClearedMemberAssignments;
} | null> {
  const refs: ProjectionCommandRef[] = [];
  const result = await withDbAttribution("assignments:member:update", async () => {
    const db = getDb();
    const [candidate] = await db
      .select({ departmentId: sdDepartmentMembers.departmentId })
      .from(sdDepartmentMembers)
      .where(eq(sdDepartmentMembers.id, args.memberId))
      .limit(1);
    if (!candidate) return null;
    return db.transaction(async (tx) => {
      await lockAssignmentDepartment(tx, candidate.departmentId);
      const [existing] = await tx
        .select()
        .from(sdDepartmentMembers)
        .where(eq(sdDepartmentMembers.id, args.memberId))
        .limit(1);
      if (!existing) return null;
      const [member] = await tx
        .update(sdDepartmentMembers)
        .set({ // spread-write-approved: typed updateDepartmentMember args (only `active: boolean` and `clickupUserId: string` are whitelisted); no request-shaped object reaches this write and no ownership/audit/sync-state column is spread.
          ...(args.active !== undefined ? { active: args.active } : {}),
          ...(args.clickupUserId !== undefined ? { clickupUserId: args.clickupUserId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sdDepartmentMembers.id, args.memberId))
        .returning();
      if (args.active === false) {
        const cleared = await clearAssignmentsForMemberUsing(
          tx,
          existing.departmentId,
          existing.userId,
          refs,
        );
        return { member, cleared };
      }
      // ClickUp ID changed: re-stage affected commands with the new ID so the
      // projection worker picks up the updated identity.
      if (
        args.clickupUserId !== undefined &&
        args.clickupUserId !== existing.clickupUserId
      ) {
        const newCuId = args.clickupUserId ?? null;
        // Find all client assignments for this user in this department.
        const assignments = (await tx
          .select()
          .from(sdClientDeptAssignments)
          .where(
            and(
              eq(sdClientDeptAssignments.departmentId, existing.departmentId),
              or(
                eq(sdClientDeptAssignments.primaryUserId, existing.userId),
                eq(sdClientDeptAssignments.checkerUserId, existing.userId),
              ),
            ),
          )) as Array<typeof sdClientDeptAssignments.$inferSelect>;
        const projectionRoles: ProjectionRoleInput[] = [];
        for (const a of assignments) {
          if (a.primaryUserId === existing.userId) {
            projectionRoles.push({
              clientId: a.clientId,
              departmentId: existing.departmentId,
              responsibility: "doer",
              desiredUserId: existing.userId,
              desiredClickupUserId: newCuId,
            });
          }
          if (a.checkerUserId === existing.userId) {
            projectionRoles.push({
              clientId: a.clientId,
              departmentId: existing.departmentId,
              responsibility: "checker",
              desiredUserId: existing.userId,
              desiredClickupUserId: newCuId,
            });
          }
        }
        if (projectionRoles.length > 0) {
          const summary = await stageProjectionCommandsInTx(tx, projectionRoles);
          for (const ref of summary.stagedRefs) refs.push(ref);
        }
      }
      return { member, cleared: emptyClearedMemberAssignments() };
    });
  });
  // Post-commit: await immediate attempts for a bounded set, else safe-kick.
  if (result && refs.length > 0) {
    await runBoundedImmediateAttemptsRefs(refs);
  } else if (result && (result.cleared.clientAssignments.length > 0 || args.clickupUserId !== undefined)) {
    void kickClickUpRoleProjectionSafe();
  }
  return result;
}

export async function deleteDepartmentMember(memberId: string): Promise<{
  member: typeof sdDepartmentMembers.$inferSelect;
  cleared: ClearedMemberAssignments;
} | null> {
  const refs: ProjectionCommandRef[] = [];
  const result = await withDbAttribution("assignments:member:delete", async () => {
    const db = getDb();
    const [candidate] = await db
      .select({ departmentId: sdDepartmentMembers.departmentId })
      .from(sdDepartmentMembers)
      .where(eq(sdDepartmentMembers.id, memberId))
      .limit(1);
    if (!candidate) return null;
    return db.transaction(async (tx) => {
      await lockAssignmentDepartment(tx, candidate.departmentId);
      const [member] = await tx
        .delete(sdDepartmentMembers)
        .where(eq(sdDepartmentMembers.id, memberId))
        .returning();
      if (!member) return null;
      const cleared = await clearAssignmentsForMemberUsing(
        tx,
        member.departmentId,
        member.userId,
        refs,
      );
      return { member, cleared };
    });
  });
  // Post-commit: await immediate attempts for a bounded set, else safe-kick.
  if (result && refs.length > 0) {
    await runBoundedImmediateAttemptsRefs(refs);
  } else if (result && result.cleared.clientAssignments.length > 0) {
    void kickClickUpRoleProjectionSafe();
  }
  return result;
}

export interface ClientAssignmentSeedSelection {
  departmentId: string;
  primaryUserId?: string | null;
  checkerUserId?: string | null;
}

export interface PreparedClientAssignmentSeed {
  rows: Array<{
    departmentId: string;
    primaryUserId: string | null;
    checkerUserId: string | null;
  }>;
}

export type PrepareClientAssignmentSeedResult =
  | { ok: true; seed: PreparedClientAssignmentSeed }
  | { ok: false; status: 400 | 422; error: string };

const CLIENT_SEED_ROLE_FIELDS = ["primaryUserId", "checkerUserId"] as const;

/**
 * Build the canonical per-client assignment seed. Parsing belongs to the
 * compatibility API; scope, defaults, and membership eligibility belong here.
 */
export async function prepareClientAssignmentSeed(
  selections: ClientAssignmentSeedSelection[],
): Promise<PrepareClientAssignmentSeedResult> {
  const { departments, memberships } = await withDbAttribution(
    "assignments:clientSeed:prepare",
    async () => {
      const db = getDb();
      const [departments, memberships] = await Promise.all([
        db
          .select({
            id: sdDepartments.id,
            name: sdDepartments.name,
            active: sdDepartments.active,
            assignmentScope: sdDepartments.assignmentScope,
            defaultPrimaryUserId: sdDepartments.defaultPrimaryUserId,
            defaultCheckerUserId: sdDepartments.defaultCheckerUserId,
          })
          .from(sdDepartments),
        db
          .select({
            departmentId: sdDepartmentMembers.departmentId,
            userId: sdDepartmentMembers.userId,
          })
          .from(sdDepartmentMembers)
          .where(eq(sdDepartmentMembers.active, true)),
      ]);
      return { departments, memberships };
    },
  );

  const departmentById = new Map(departments.map((department) => [department.id, department]));
  const activeMembersByDepartment = new Map<string, Set<string>>();
  for (const membership of memberships) {
    const members =
      activeMembersByDepartment.get(membership.departmentId) ?? new Set<string>();
    members.add(membership.userId);
    activeMembersByDepartment.set(membership.departmentId, members);
  }

  const selectionByDepartment = new Map<string, ClientAssignmentSeedSelection>();
  for (const selection of selections) {
    const department = departmentById.get(selection.departmentId);
    if (!department || !department.active) {
      return {
        ok: false,
        status: 400,
        error: `Unknown or inactive department in teamAssignments: ${selection.departmentId}`,
      };
    }
    if (isCompanyScoped(department)) {
      return {
        ok: false,
        status: 400,
        error: `Department "${department.name}" holds its roles company-wide and cannot receive per-client assignments`,
      };
    }
    const activeMembers =
      activeMembersByDepartment.get(department.id) ?? new Set<string>();
    if (selection.checkerUserId && !departmentSupportsChecker(department.id)) {
      return {
        ok: false,
        status: 422,
        error: `Department "${department.name}" does not support the Checker role`,
      };
    }
    for (const field of CLIENT_SEED_ROLE_FIELDS) {
      const userId = selection[field];
      if (userId && !activeMembers.has(userId)) {
        return {
          ok: false,
          status: 422,
          error: `User set as ${field} for "${department.name}" is not an active member of that department`,
        };
      }
    }
    selectionByDepartment.set(selection.departmentId, selection);
  }

  const rows: PreparedClientAssignmentSeed["rows"] = [];
  for (const department of departments) {
    if (!department.active || isCompanyScoped(department)) continue;
    const activeMembers =
      activeMembersByDepartment.get(department.id) ?? new Set<string>();
    const selection = selectionByDepartment.get(department.id);
    const resolveRole = (
      field: (typeof CLIENT_SEED_ROLE_FIELDS)[number],
      departmentDefault: string | null,
    ): string | null => {
      if (selection && Object.prototype.hasOwnProperty.call(selection, field)) {
        return selection[field] ?? null;
      }
      return departmentDefault && activeMembers.has(departmentDefault)
        ? departmentDefault
        : null;
    };
    rows.push({
      departmentId: department.id,
      primaryUserId: resolveRole(
        "primaryUserId",
        department.defaultPrimaryUserId ?? null,
      ),
      checkerUserId: resolveRole(
        "checkerUserId",
        departmentSupportsChecker(department.id)
          ? department.defaultCheckerUserId ?? null
          : null,
      ),
    });
  }
  return { ok: true, seed: { rows } };
}

export async function seedClientAssignments(
  clientId: string,
  rows: Array<{
    departmentId: string;
    primaryUserId: string | null;
    checkerUserId: string | null;
  }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const count = await withDbAttribution("assignments:clientSeed:apply", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const departmentIds = [...new Set(rows.map((row) => row.departmentId))].sort();
      for (const departmentId of departmentIds) {
        await lockAssignmentDepartment(tx, departmentId);
      }
      for (const row of rows) {
        const eligibility = await validateAssignmentEligibilityUsing(
          tx,
          row.departmentId,
          {
            primaryUserId: row.primaryUserId,
            checkerUserId: row.checkerUserId,
          },
          { activeDepartmentOnly: true },
        );
        if (!eligibility.ok || isCompanyScoped(eligibility.department)) {
          throw new Error(
            `Client assignment seed became ineligible for department ${row.departmentId}`,
          );
        }
      }
      await tx
        .insert(sdClientDeptAssignments)
        .values(rows.map((row) => ({ clientId, ...row })))
        .onConflictDoNothing();

      // Stage projection commands for each seeded assignment.
      // Resolve ClickUp IDs from member records within the transaction.
      const projectionRoles: ProjectionRoleInput[] = [];
      for (const row of rows) {
        const roles = await buildClientProjectionRoles(
          tx,
          clientId,
          row.departmentId,
          row.primaryUserId ?? null,
          departmentSupportsChecker(row.departmentId) ? row.checkerUserId ?? null : undefined,
        );
        projectionRoles.push(...roles);
      }
      if (projectionRoles.length > 0) {
        await stageProjectionCommandsInTx(tx, projectionRoles);
      }

      return rows.length;
    });
  });
  // Post-commit: kick the projection worker.
  if (count > 0) {
    void kickClickUpRoleProjectionSafe();
  }
  return count;
}