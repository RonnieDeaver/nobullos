/**
 * Canonical ClickUp Client List identity and read-only preflight.
 *
 * Stable IDs are the only persisted/write-addressing contract. Normalized
 * names are used solely to surface review candidates and duplicate warnings.
 */

// @db-pool-intent: api

import { and, asc, eq, sql } from "drizzle-orm";
import {
  clients,
  cuClientListMappings,
  cuRoleProjectionDestinations,
  sdDepartments,
  type CuClientListMapping,
  type CuRoleProjectionDestination,
} from "@shared/schema";
import {
  getDepartmentRoleCapabilities,
  type DepartmentRoleCapabilities,
} from "@shared/departmentRoleCapabilities";
import { getDb, withDbAttribution } from "../db";
import {
  fetchDirectoryEvidence,
  normClientName,
  type CanonicalListFieldEvidence,
  type DirectoryEvidence,
  type ParentEvidence,
} from "./adsOs/clickUpDirectory";
import { CANONICAL_PRODUCTION_LIST_ID } from "./adsOs/paidSearchRoleContract";
import { enqueueProjectionWakesInTx } from "./clickUpRoleProjectionKick";
import { stageClientMirrorIntentInTx } from "./clickUpClientMirrorKick";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const INTERNAL_SCAN_LIMIT = 5_000;
const PEOPLE_FIELD_TYPES = new Set(["users", "people"]);

export type ClientListMappingSource = "manual_review" | "name_adoption";

export interface LocalClientFact {
  id: string;
  name: string;
}

export interface DepartmentFact {
  id: string;
  name: string;
  active: boolean;
  assignmentScope: string;
}

export interface RequiredRoleColumn {
  departmentId: string;
  departmentName: string;
  responsibility: "doer" | "checker";
  /** Human setup label; stable department UUID remains the write identity. */
  expectedLabel: string;
  capabilities: DepartmentRoleCapabilities;
}

export type RoleColumnIssue =
  | "missing_mapping"
  | "wrong_target_kind"
  | "wrong_list"
  | "missing_expected_type"
  | "missing_field"
  | "wrong_type"
  | "duplicate_field_id"
  | "invalid_cardinality";

export interface RoleColumnPreflight extends RequiredRoleColumn {
  destination: CuRoleProjectionDestination | null;
  field: CanonicalListFieldEvidence | null;
  duplicateLabelFieldIds: string[];
  issues: RoleColumnIssue[];
  ready: boolean;
}

export interface ClientMappingPreflight {
  mapping: CuClientListMapping;
  localClientName: string | null;
  remoteTaskName: string | null;
  nameChangedSinceLink: boolean;
  observedSyncState: "verified" | "conflict" | "stale";
  issues: string[];
}

export interface NameAdoptionCandidate {
  clientId: string;
  localClientName: string;
  taskId: string;
  remoteTaskName: string;
}

export interface DuplicateClientRows {
  normalizedName: string;
  rows: Array<{ taskId: string; name: string; excluded: boolean }>;
}

export interface CanonicalClientListPreflight {
  available: true;
  canonicalListId: string;
  fetchedAt: number;
  fields: Array<CanonicalListFieldEvidence & { duplicateLabelFieldIds: string[] }>;
  roleColumns: RoleColumnPreflight[];
  mappings: ClientMappingPreflight[];
  duplicateClientRows: DuplicateClientRows[];
  unmappedClickUpRows: Array<{ taskId: string; name: string; remoteRevision: string | null }>;
  unmappedNoBullClients: LocalClientFact[];
  nameOnlyAdoptionCandidates: NameAdoptionCandidate[];
  totals: {
    fields: number;
    roleColumns: number;
    mappings: number;
    duplicateClientGroups: number;
    unmappedClickUpRows: number;
    unmappedNoBullClients: number;
    nameOnlyAdoptionCandidates: number;
  };
  truncated: boolean;
}

export interface CanonicalClientListPreflightUnavailable {
  available: false;
  canonicalListId: string;
  reason: "clickup_unconfigured_or_unreachable";
}

export interface BindCanonicalClientTaskInput {
  clientId: string;
  taskId: string;
  source: ClientListMappingSource;
  note?: string | null;
  actorId: string;
}

export interface CanonicalClientListConfiguration {
  canonicalListId: string;
  mappings: CuClientListMapping[];
  roleFields: CuRoleProjectionDestination[];
  limit: number;
  truncated: boolean;
}

function boundedLimit(limit?: number): number {
  return Math.min(Math.max(1, Math.trunc(limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
}

export function deriveRequiredRoleColumns(
  departments: DepartmentFact[],
): RequiredRoleColumn[] {
  const rows: RequiredRoleColumn[] = [];
  for (const department of departments) {
    if (!department.active || department.assignmentScope !== "per_client") continue;
    const capabilities = getDepartmentRoleCapabilities(department.id);
    rows.push({
      departmentId: department.id,
      departmentName: department.name,
      responsibility: "doer",
      expectedLabel: getRoleColumnLabel(department.name, "doer"),
      capabilities,
    });
    if (capabilities.checker) {
      rows.push({
        departmentId: department.id,
        departmentName: department.name,
        responsibility: "checker",
        expectedLabel: getRoleColumnLabel(department.name, "checker"),
        capabilities,
      });
    }
  }
  return rows;
}

/**
 * Human-readable setup labels are deliberately derived, while stable department
 * UUIDs and ClickUp field IDs remain the persisted identities. A department
 * rename therefore makes the setup review visibly stale instead of silently
 * repointing a destination by display name.
 */
export function getRoleColumnLabel(
  departmentName: string,
  responsibility: "doer" | "checker",
): string {
  return `${departmentName} ${responsibility === "doer" ? "Doer" : "Checker"}`;
}

export function findCanonicalMappingConflict(
  mappings: Array<Pick<CuClientListMapping, "clientId" | "listId" | "taskId">>,
  clientId: string,
  taskId: string,
): { kind: "task_bound_to_other_client"; otherClientId: string } | null {
  const conflict = mappings.find(
    (mapping) =>
      mapping.listId === CANONICAL_PRODUCTION_LIST_ID &&
      mapping.taskId === taskId &&
      mapping.clientId !== clientId,
  );
  return conflict
    ? { kind: "task_bound_to_other_client", otherClientId: conflict.clientId }
    : null;
}

function classifyRoleColumns(
  departments: DepartmentFact[],
  destinations: CuRoleProjectionDestination[],
  fields: CanonicalListFieldEvidence[],
): RoleColumnPreflight[] {
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const fieldsByLabel = new Map<string, CanonicalListFieldEvidence[]>();
  for (const field of fields) {
    const rows = fieldsByLabel.get(field.label) ?? [];
    rows.push(field);
    fieldsByLabel.set(field.label, rows);
  }
  const destinationsByFieldId = new Map<string, CuRoleProjectionDestination[]>();
  for (const destination of destinations) {
    if (
      destination.environment !== "production" ||
      destination.listId !== CANONICAL_PRODUCTION_LIST_ID
    ) continue;
    const rows = destinationsByFieldId.get(destination.peopleFieldId) ?? [];
    rows.push(destination);
    destinationsByFieldId.set(destination.peopleFieldId, rows);
  }

  return deriveRequiredRoleColumns(departments).map((required) => {
    const destination =
      destinations.find(
        (row) =>
          row.departmentId === required.departmentId &&
          row.responsibility === required.responsibility &&
          row.environment === "production",
      ) ?? null;
    const field = destination ? fieldById.get(destination.peopleFieldId) ?? null : null;
    const issues: RoleColumnIssue[] = [];
    if (!destination) {
      issues.push("missing_mapping");
    } else {
      if (destination.targetKind !== "client_list_parent") issues.push("wrong_target_kind");
      if (destination.listId !== CANONICAL_PRODUCTION_LIST_ID) issues.push("wrong_list");
      if (!destination.peopleFieldType) issues.push("missing_expected_type");
      if (!field) {
        issues.push("missing_field");
      } else {
        const expectedType = destination.peopleFieldType?.toLowerCase() ?? null;
        if (
          !PEOPLE_FIELD_TYPES.has(field.type.toLowerCase()) ||
          (expectedType !== null && field.type.toLowerCase() !== expectedType)
        ) {
          issues.push("wrong_type");
        }
        if (
          field.observedMaxCardinality !== null &&
          field.observedMaxCardinality > destination.maxPeople
        ) {
          issues.push("invalid_cardinality");
        }
      }
      const duplicateFieldMapping = (destinationsByFieldId.get(destination.peopleFieldId) ?? []).some(
        (row) =>
          row.departmentId !== destination.departmentId ||
          row.responsibility !== destination.responsibility,
      );
      if (duplicateFieldMapping) issues.push("duplicate_field_id");
    }
    const duplicateLabelFieldIds =
      field
        ? (fieldsByLabel.get(field.label) ?? []).map((row) => row.id)
        : [];
    return {
      ...required,
      destination,
      field,
      duplicateLabelFieldIds,
      issues,
      ready: issues.length === 0,
    };
  });
}

export function classifyCanonicalClientListPreflight(args: {
  evidence: DirectoryEvidence;
  localClients: LocalClientFact[];
  departments: DepartmentFact[];
  destinations: CuRoleProjectionDestination[];
  mappings: CuClientListMapping[];
  limit?: number;
}): CanonicalClientListPreflight {
  const limit = boundedLimit(args.limit);
  const liveParents = args.evidence.parents.filter((parent) => !parent.excluded);
  const parentByTaskId = new Map(args.evidence.parents.map((parent) => [parent.taskId, parent]));
  const localById = new Map(args.localClients.map((client) => [client.id, client]));
  const mappingByClientId = new Map(args.mappings.map((mapping) => [mapping.clientId, mapping]));
  const mappingByTaskId = new Map(
    args.mappings
      .filter((mapping) => mapping.listId === CANONICAL_PRODUCTION_LIST_ID)
      .map((mapping) => [mapping.taskId, mapping]),
  );

  const fieldsByLabel = new Map<string, CanonicalListFieldEvidence[]>();
  for (const field of args.evidence.fields) {
    const sameLabel = fieldsByLabel.get(field.label) ?? [];
    sameLabel.push(field);
    fieldsByLabel.set(field.label, sameLabel);
  }
  const fields = args.evidence.fields.map((field) => ({
    ...field,
    duplicateLabelFieldIds: (fieldsByLabel.get(field.label) ?? []).map((row) => row.id),
  }));

  const roleColumns = classifyRoleColumns(
    args.departments,
    args.destinations,
    args.evidence.fields,
  );

  const mappings = args.mappings.map((mapping): ClientMappingPreflight => {
    const local = localById.get(mapping.clientId) ?? null;
    const remote = parentByTaskId.get(mapping.taskId) ?? null;
    const issues: string[] = [];
    if (mapping.listId !== CANONICAL_PRODUCTION_LIST_ID) issues.push("wrong_list");
    if (!local) issues.push("missing_nobull_client");
    if (!remote) issues.push("missing_clickup_task");
    if (remote?.excluded) issues.push("clickup_task_excluded");
    const observedSyncState =
      !remote ? "stale" : issues.length > 0 ? "conflict" : "verified";
    return {
      mapping,
      localClientName: local?.name ?? null,
      remoteTaskName: remote?.name ?? null,
      nameChangedSinceLink:
        !!remote &&
        !!mapping.remoteTaskName &&
        remote.name !== mapping.remoteTaskName,
      observedSyncState,
      issues,
    };
  });

  const duplicateClientRows = Object.entries(args.evidence.normNameToTaskIds)
    .filter(([, taskIds]) => taskIds.length > 1)
    .map(([normalizedName, taskIds]) => ({
      normalizedName,
      rows: taskIds
        .map((taskId) => parentByTaskId.get(taskId))
        .filter((parent): parent is ParentEvidence => !!parent)
        .map((parent) => ({
          taskId: parent.taskId,
          name: parent.name,
          excluded: parent.excluded,
        })),
    }));

  const unmappedClickUpRows = liveParents
    .filter((parent) => !mappingByTaskId.has(parent.taskId))
    .map((parent) => ({
      taskId: parent.taskId,
      name: parent.name,
      remoteRevision: parent.remoteRevision,
    }));
  const unmappedNoBullClients = args.localClients.filter(
    (client) => !mappingByClientId.has(client.id),
  );

  const availableRemoteByNorm = new Map<string, ParentEvidence[]>();
  for (const parent of liveParents) {
    if (mappingByTaskId.has(parent.taskId)) continue;
    const rows = availableRemoteByNorm.get(parent.normName) ?? [];
    rows.push(parent);
    availableRemoteByNorm.set(parent.normName, rows);
  }
  const nameOnlyAdoptionCandidates = unmappedNoBullClients.flatMap((client) => {
    const matches = availableRemoteByNorm.get(normClientName(client.name)) ?? [];
    if (matches.length !== 1) return [];
    return [{
      clientId: client.id,
      localClientName: client.name,
      taskId: matches[0].taskId,
      remoteTaskName: matches[0].name,
    }];
  });

  const totals = {
    fields: fields.length,
    roleColumns: roleColumns.length,
    mappings: mappings.length,
    duplicateClientGroups: duplicateClientRows.length,
    unmappedClickUpRows: unmappedClickUpRows.length,
    unmappedNoBullClients: unmappedNoBullClients.length,
    nameOnlyAdoptionCandidates: nameOnlyAdoptionCandidates.length,
  };
  const truncated = Object.values(totals).some((total) => total > limit);

  return {
    available: true,
    canonicalListId: args.evidence.canonicalListId,
    fetchedAt: args.evidence.fetchedAt,
    fields: fields.slice(0, limit),
    roleColumns: roleColumns.slice(0, limit),
    mappings: mappings.slice(0, limit),
    duplicateClientRows: duplicateClientRows.slice(0, limit),
    unmappedClickUpRows: unmappedClickUpRows.slice(0, limit),
    unmappedNoBullClients: unmappedNoBullClients.slice(0, limit),
    nameOnlyAdoptionCandidates: nameOnlyAdoptionCandidates.slice(0, limit),
    totals,
    truncated,
  };
}

async function loadConfigurationFacts(limit: number): Promise<{
  localClients: LocalClientFact[];
  departments: DepartmentFact[];
  destinations: CuRoleProjectionDestination[];
  mappings: CuClientListMapping[];
  sourceTruncated: boolean;
}> {
  return withDbAttribution("cuClientList:loadPreflightFacts", async () => {
    const db = getDb();
    const [localClientRows, departmentRows, destinationRows, mappingRows] = await Promise.all([
      db
        .select({ id: clients.id, name: clients.firmName })
        .from(clients)
        .where(and(eq(clients.isArchived, false), eq(clients.lifecycleStage, "customer")))
        .orderBy(asc(clients.firmName))
        .limit(INTERNAL_SCAN_LIMIT + 1),
      db
        .select({
          id: sdDepartments.id,
          name: sdDepartments.name,
          active: sdDepartments.active,
          assignmentScope: sdDepartments.assignmentScope,
        })
        .from(sdDepartments)
        .orderBy(asc(sdDepartments.sortOrder))
        .limit(INTERNAL_SCAN_LIMIT + 1),
      db
        .select()
        .from(cuRoleProjectionDestinations)
        .orderBy(asc(cuRoleProjectionDestinations.departmentId))
        .limit(INTERNAL_SCAN_LIMIT + 1),
      db
        .select()
        .from(cuClientListMappings)
        .orderBy(asc(cuClientListMappings.updatedAt))
        .limit(INTERNAL_SCAN_LIMIT + 1),
    ]);
    const sourceTruncated = [
      localClientRows,
      departmentRows,
      destinationRows,
      mappingRows,
    ].some((rows) => rows.length > INTERNAL_SCAN_LIMIT);
    return {
      localClients: localClientRows.slice(0, INTERNAL_SCAN_LIMIT),
      departments: departmentRows.slice(0, INTERNAL_SCAN_LIMIT),
      destinations: destinationRows.slice(0, INTERNAL_SCAN_LIMIT),
      mappings: mappingRows.slice(0, INTERNAL_SCAN_LIMIT),
      sourceTruncated,
    };
  });
}

export async function getCanonicalClientListPreflight(
  requestedLimit?: number,
): Promise<CanonicalClientListPreflight | CanonicalClientListPreflightUnavailable> {
  const limit = boundedLimit(requestedLimit);
  const evidence = await evidenceLoader();
  if (!evidence) {
    return {
      available: false,
      canonicalListId: CANONICAL_PRODUCTION_LIST_ID,
      reason: "clickup_unconfigured_or_unreachable",
    };
  }
  const facts = await loadConfigurationFacts(limit);
  const { sourceTruncated, ...classificationFacts } = facts;
  const result = classifyCanonicalClientListPreflight({
    evidence,
    ...classificationFacts,
    limit,
  });
  return sourceTruncated ? { ...result, truncated: true } : result;
}

export async function listCanonicalClientListConfiguration(
  requestedLimit?: number,
): Promise<CanonicalClientListConfiguration> {
  const limit = boundedLimit(requestedLimit);
  return withDbAttribution("cuClientList:listConfiguration", async () => {
    const db = getDb();
    const [mappingRows, roleFieldRows] = await Promise.all([
      db
        .select()
        .from(cuClientListMappings)
        .orderBy(asc(cuClientListMappings.updatedAt))
        .limit(limit + 1),
      db
        .select()
        .from(cuRoleProjectionDestinations)
        .where(eq(cuRoleProjectionDestinations.targetKind, "client_list_parent"))
        .orderBy(asc(cuRoleProjectionDestinations.departmentId))
        .limit(limit + 1),
    ]);
    return {
      canonicalListId: CANONICAL_PRODUCTION_LIST_ID,
      mappings: mappingRows.slice(0, limit),
      roleFields: roleFieldRows.slice(0, limit),
      limit,
      truncated: mappingRows.length > limit || roleFieldRows.length > limit,
    };
  });
}

function isUniqueViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; cursor && depth < 4; depth++) {
    if ((cursor as { code?: string }).code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

export async function bindCanonicalClientTask(
  input: BindCanonicalClientTaskInput,
): Promise<
  | { ok: true; mapping: CuClientListMapping }
  | { ok: false; errors: string[] }
> {
  const evidence = await evidenceLoader();
  if (!evidence || evidence.canonicalListId !== CANONICAL_PRODUCTION_LIST_ID) {
    return { ok: false, errors: ["Canonical ClickUp Client List is unavailable"] };
  }
  const remote = evidence.parents.find((parent) => parent.taskId === input.taskId);
  if (!remote) {
    return {
      ok: false,
      errors: [`Task ${input.taskId} was not returned by canonical list ${CANONICAL_PRODUCTION_LIST_ID}`],
    };
  }
  if (remote.excluded) {
    return { ok: false, errors: [`Task ${input.taskId} is excluded/offboarded`] };
  }
  const now = new Date();

  try {
    return await withDbAttribution("cuClientList:bindClientTask", async () => {
      const db = getDb();
      return db.transaction(async (tx) => {
        const [client] = await tx
          .select({
            id: clients.id,
            firmName: clients.firmName,
            isArchived: clients.isArchived,
            lifecycleStage: clients.lifecycleStage,
          })
          .from(clients)
          .where(eq(clients.id, input.clientId))
          .limit(1)
          .for("update");
        if (!client || client.isArchived || client.lifecycleStage !== "customer") {
          return {
            ok: false as const,
            errors: [`Client ${input.clientId} is not an active customer`],
          };
        }

        const existingTaskBindings = await tx
          .select({
            clientId: cuClientListMappings.clientId,
            listId: cuClientListMappings.listId,
            taskId: cuClientListMappings.taskId,
          })
          .from(cuClientListMappings)
          .where(
            and(
              eq(cuClientListMappings.listId, CANONICAL_PRODUCTION_LIST_ID),
              eq(cuClientListMappings.taskId, input.taskId),
            ),
          )
          .for("update");
        const conflict = findCanonicalMappingConflict(
          existingTaskBindings,
          input.clientId,
          input.taskId,
        );
        if (conflict) {
          return {
            ok: false as const,
            errors: [`Task ${input.taskId} is already bound to another NoBull client`],
          };
        }

        const [mapping] = await tx
          .insert(cuClientListMappings)
          .values({
            clientId: input.clientId,
            listId: CANONICAL_PRODUCTION_LIST_ID,
            taskId: input.taskId,
            remoteTaskName: remote.name,
            remoteRevision: remote.remoteRevision,
            provenance: {
              source: input.source,
              actorId: input.actorId,
              note: input.note ?? null,
              linkedAt: now.toISOString(),
              ownershipProof: "canonical_list_enumeration",
            },
            syncState: "verified",
            conflictEvidence:
              remote.duplicateNormNameTaskIds.length > 0
                ? { duplicateNormNameTaskIds: remote.duplicateNormNameTaskIds }
                : null,
            ownershipVerifiedAt: now,
          })
          .onConflictDoUpdate({
            target: cuClientListMappings.clientId,
            set: {
              listId: CANONICAL_PRODUCTION_LIST_ID,
              taskId: input.taskId,
              remoteTaskName: remote.name,
              remoteRevision: remote.remoteRevision,
              provenance: {
                source: input.source,
                actorId: input.actorId,
                note: input.note ?? null,
                linkedAt: now.toISOString(),
                ownershipProof: "canonical_list_enumeration",
              },
              syncState: "verified",
              conflictEvidence:
                remote.duplicateNormNameTaskIds.length > 0
                  ? { duplicateNormNameTaskIds: remote.duplicateNormNameTaskIds }
                  : null,
              ownershipVerifiedAt: now,
              lastError: null,
              updatedAt: now,
            },
          })
          .returning();

        // A reviewed mapping repair must also re-stage the current client
        // lifecycle intent. This is the canonical rebinding seam: future
        // client-mirror work addresses the reviewed task, while the queue wake
        // remains atomic with the mapping write. It does not call ClickUp or
        // override a pending/ambiguous command unless the client truth changed.
        await stageClientMirrorIntentInTx(tx, {
          clientId: client.id,
          desiredName: client.firmName,
          desiredArchived: false,
        });

        // Existing client-list projection commands become runnable against the
        // newly reviewed canonical parent immediately. The canonical mapping
        // remains authoritative; legacy per-destination target rows are not
        // created or consulted for the production Client List.
        const rebound = await tx.execute<{
          id: string;
          revision: string;
          attempt_count: number;
        }>(sql`
          UPDATE cu_role_projection_commands AS command
          SET target_snapshot = jsonb_build_object(
                'targetId', CAST(${input.taskId} AS text),
                'resolvedListId', CAST(${CANONICAL_PRODUCTION_LIST_ID} AS text),
                'listId', CAST(${CANONICAL_PRODUCTION_LIST_ID} AS text),
                'peopleFieldId', destination.people_field_id,
                'targetKind', 'client_list_parent'
              ),
              status = 'pending',
              attempt_count = 0,
              mutation_attempts = 0,
              next_attempt_at = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              last_error_code = NULL,
              verified_at = NULL,
              drift_detected_at = NULL,
              terminal_at = NULL,
              updated_at = now()
          FROM cu_role_projection_destinations AS destination
          WHERE command.client_id = ${input.clientId}
            AND command.destination_id = destination.id
            AND destination.target_kind = 'client_list_parent'
            AND destination.list_id = ${CANONICAL_PRODUCTION_LIST_ID}
            AND destination.environment = 'production'
          RETURNING command.id, command.revision, command.attempt_count
        `);
        const wakeRefs = (rebound.rows ?? []).map((row) => ({
          commandId: String(row.id),
          revision: String(row.revision),
          attemptCount: Number(row.attempt_count ?? 0),
        }));
        if (wakeRefs.length > 0) {
          await enqueueProjectionWakesInTx(tx, new Date(), wakeRefs);
        }
        return { ok: true as const, mapping };
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        errors: [`Task ${input.taskId} is already bound to another NoBull client`],
      };
    }
    throw err;
  }
}

let evidenceLoader: () => Promise<DirectoryEvidence | null> = fetchDirectoryEvidence;

export function __setCanonicalClientListEvidenceLoaderForTest(
  loader: (() => Promise<DirectoryEvidence | null>) | null,
): void {
  evidenceLoader = loader ?? fetchDirectoryEvidence;
}