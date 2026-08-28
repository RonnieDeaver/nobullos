// @db-pool-intent: worker

import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  cuClientListMappings,
  cuRoleProjectionCommands,
  cuRoleProjectionDestinations,
  cuRoleSyncContracts,
  cuRoleSyncTransitionEvidence,
  sdClientDeptAssignments,
  sdDepartmentMembers,
  sdDepartments,
} from "@shared/schema";
import { departmentSupportsChecker } from "@shared/departmentRoleCapabilities";
import { getDb, withDbAttribution } from "../db";
import { setClientDepartmentAssignmentNoProjection } from "./assignmentBoundary";
import {
  extractPeopleField,
  isValidClickUpUserId,
  validatePeopleFieldShape,
} from "./clickUpRoleProjectionClient";
import { CANONICAL_PRODUCTION_LIST_ID } from "./adsOs/paidSearchRoleContract";

export interface InboundRoleEvent {
  receiptId: string;
  taskId: string;
  actorClickupUserId: string | null;
  changedFieldIds: string[];
  eventType: string;
}

type AssignmentSnapshot = {
  primaryUserId: string | null;
  checkerUserId: string | null;
};

function vendorRevision(task: any, fieldId: string, userIds: string[]): string {
  return crypto
    .createHash("sha256")
    .update(
      [
        String(task?.id ?? ""),
        String(task?.date_updated ?? ""),
        fieldId,
        ...userIds,
      ].join("\x00"),
    )
    .digest("hex")
    .slice(0, 32);
}

async function recordBlocked(args: {
  event: InboundRoleEvent;
  clientId: string;
  destinationId: string | null;
  departmentId?: string | null;
  responsibility?: string | null;
  localRevision?: number;
  vendorRevision?: string | null;
  outcome: string;
  details: Record<string, unknown>;
}): Promise<void> {
  await withDbAttribution("clickup:roleInbound:block", async () => {
    const db = getDb();
    await db.transaction(async (tx) => {
      if (args.destinationId) {
        await tx
          .insert(cuRoleSyncContracts)
          .values({
            clientId: args.clientId,
            destinationId: args.destinationId,
            vendorRevision: args.vendorRevision ?? null,
            conflictState: "review_required",
            conflictEvidence: args.details,
            lastObservedClickupUserIds:
              (args.details.observedClickupUserIds as string[] | undefined) ?? null,
          })
          .onConflictDoUpdate({
            target: [
              cuRoleSyncContracts.clientId,
              cuRoleSyncContracts.destinationId,
            ],
            set: {
              vendorRevision: args.vendorRevision ?? null,
              conflictState: "review_required",
              conflictEvidence: args.details,
              lastObservedClickupUserIds:
                (args.details.observedClickupUserIds as string[] | undefined) ??
                null,
              updatedAt: new Date(),
            },
          });
      }
      await tx
        .insert(cuRoleSyncTransitionEvidence)
        .values({
          receiptId: args.event.receiptId,
          clientId: args.clientId,
          destinationId: args.destinationId,
          departmentId: args.departmentId ?? null,
          responsibility: args.responsibility ?? null,
          actorType: "clickup_member",
          actorId: args.event.actorClickupUserId,
          source: "clickup_webhook",
          beforeAssignment: null,
          afterAssignment: null,
          localRevision: args.localRevision ?? 0,
          vendorRevision: args.vendorRevision ?? null,
          outcome: args.outcome,
          details: args.details,
        })
        .onConflictDoNothing();
    });
  });
}

/**
 * Applies only fields explicitly named by a verified canonical webhook. The
 * supplied task must be the authoritative task returned by GET /task/:id.
 */
export async function applyInboundClickUpRoleChanges(
  event: InboundRoleEvent,
  task: any,
): Promise<void> {
  const owningListId = String(task?.list?.id ?? "");
  if (String(task?.id ?? "") !== event.taskId) return;

  const context = await withDbAttribution("clickup:roleInbound:resolve", async () => {
    const db = getDb();
    const [mapping] = await db
      .select()
      .from(cuClientListMappings)
      .where(
        and(
          eq(cuClientListMappings.taskId, event.taskId),
          eq(cuClientListMappings.listId, CANONICAL_PRODUCTION_LIST_ID),
          eq(cuClientListMappings.syncState, "verified"),
        ),
      )
      .limit(1);
    if (!mapping) return null;
    const destinations =
      event.changedFieldIds.length === 0
        ? []
        : await db
            .select()
            .from(cuRoleProjectionDestinations)
            .where(
              and(
                eq(
                  cuRoleProjectionDestinations.listId,
                  CANONICAL_PRODUCTION_LIST_ID,
                ),
                eq(cuRoleProjectionDestinations.environment, "production"),
                inArray(
                  cuRoleProjectionDestinations.peopleFieldId,
                  event.changedFieldIds,
                ),
              ),
            );
    return { mapping, destinations };
  });
  if (!context) return;

  if (owningListId !== CANONICAL_PRODUCTION_LIST_ID) {
    await recordBlocked({
      event,
      clientId: context.mapping.clientId,
      destinationId: null,
      outcome: "blocked_wrong_list",
      details: {
        observedListId: owningListId,
        expectedListId: CANONICAL_PRODUCTION_LIST_ID,
      },
    });
    return;
  }

  if (event.changedFieldIds.length === 0 || context.destinations.length === 0) {
    await recordBlocked({
      event,
      clientId: context.mapping.clientId,
      destinationId: null,
      outcome: "blocked_wrong_field",
      details: {
        eventType: event.eventType,
        changedFieldIds: event.changedFieldIds,
        reason: "webhook did not identify an exactly mapped role field",
      },
    });
    return;
  }

  for (const destination of context.destinations) {
    const responsibility = destination.responsibility;
    const people = extractPeopleField(task, destination.peopleFieldId);
    const shapeError = validatePeopleFieldShape(task, destination.peopleFieldId);
    const observedIds = people?.userIds ?? [];
    const remoteRevision = vendorRevision(
      task,
      destination.peopleFieldId,
      observedIds,
    );
    const base = {
      event,
      clientId: context.mapping.clientId,
      destinationId: destination.id,
      departmentId: destination.departmentId,
      responsibility,
      vendorRevision: remoteRevision,
    };

    if (
      !destination.enabled ||
      destination.maxPeople !== 1 ||
      !destination.sandboxExitApprovedAt ||
      !destination.ownerApprovedAt
    ) {
      await recordBlocked({
        ...base,
        outcome: "blocked_unapproved_destination",
        details: {
          observedClickupUserIds: observedIds,
          enabled: destination.enabled,
          maxPeople: destination.maxPeople,
        },
      });
      continue;
    }

    const [department] = await withDbAttribution(
      "clickup:roleInbound:departmentValidation",
      async () =>
        getDb()
          .select()
          .from(sdDepartments)
          .where(eq(sdDepartments.id, destination.departmentId))
          .limit(1),
    );
    if (
      !department ||
      department.assignmentScope !== "per_client" ||
      destination.targetKind !== "client_list_parent"
    ) {
      await recordBlocked({
        ...base,
        outcome: "blocked_company_scope",
        details: { observedClickupUserIds: observedIds },
      });
      continue;
    }
    if (
      responsibility !== "doer" &&
      !(
        responsibility === "checker" &&
        departmentSupportsChecker(destination.departmentId)
      )
    ) {
      await recordBlocked({
        ...base,
        outcome: "blocked_unsupported_responsibility",
        details: { observedClickupUserIds: observedIds },
      });
      continue;
    }
    if (shapeError || !people) {
      await recordBlocked({
        ...base,
        outcome: "blocked_invalid_field",
        details: {
          observedClickupUserIds: observedIds,
          error: shapeError ?? "field extraction failed",
        },
      });
      continue;
    }
    if (observedIds.length > 1) {
      await recordBlocked({
        ...base,
        outcome: "blocked_multi_person",
        details: { observedClickupUserIds: observedIds },
      });
      continue;
    }

    let inboundUserId: string | null = null;
    if (observedIds.length === 1) {
      const clickupUserId = observedIds[0];
      if (!isValidClickUpUserId(clickupUserId)) {
        await recordBlocked({
          ...base,
          outcome: "blocked_unmapped_identity",
          details: { observedClickupUserIds: observedIds },
        });
        continue;
      }
      const members = await withDbAttribution(
        "clickup:roleInbound:memberValidation",
        async () =>
          getDb()
            .select({ userId: sdDepartmentMembers.userId })
            .from(sdDepartmentMembers)
            .where(
              and(
                eq(sdDepartmentMembers.departmentId, destination.departmentId),
                eq(sdDepartmentMembers.clickupUserId, clickupUserId),
                eq(sdDepartmentMembers.active, true),
              ),
            )
            .limit(2),
      );
      if (members.length !== 1) {
        await recordBlocked({
          ...base,
          outcome: "blocked_unmapped_identity",
          details: {
            observedClickupUserIds: observedIds,
            matchingActiveMembers: members.length,
          },
        });
        continue;
      }
      inboundUserId = members[0].userId;
    }

    const snapshot = await withDbAttribution(
      "clickup:roleInbound:snapshot",
      async () => {
        const db = getDb();
        const [assignment] = await db
          .select({
            primaryUserId: sdClientDeptAssignments.primaryUserId,
            checkerUserId: sdClientDeptAssignments.checkerUserId,
          })
          .from(sdClientDeptAssignments)
          .where(
            and(
              eq(sdClientDeptAssignments.clientId, context.mapping.clientId),
              eq(
                sdClientDeptAssignments.departmentId,
                destination.departmentId,
              ),
            ),
          )
          .limit(1);
        const [contract] = await db
          .select()
          .from(cuRoleSyncContracts)
          .where(
            and(
              eq(cuRoleSyncContracts.clientId, context.mapping.clientId),
              eq(cuRoleSyncContracts.destinationId, destination.id),
            ),
          )
          .limit(1);
        const [command] = await db
          .select()
          .from(cuRoleProjectionCommands)
          .where(
            and(
              eq(cuRoleProjectionCommands.clientId, context.mapping.clientId),
              eq(cuRoleProjectionCommands.destinationId, destination.id),
            ),
          )
          .limit(1);
        return { assignment: assignment ?? null, contract, command };
      },
    );
    const before: AssignmentSnapshot = snapshot.assignment ?? {
      primaryUserId: null,
      checkerUserId: null,
    };
    const currentRoleUserId =
      responsibility === "doer" ? before.primaryUserId : before.checkerUserId;
    const activePending =
      snapshot.command &&
      snapshot.command.terminalAt === null &&
      ["pending", "ambiguous", "failed", "drift"].includes(
        snapshot.command.status,
      );
    const commandMatchesRemote =
      (snapshot.command?.desiredClickupUserId ?? null) ===
      (observedIds[0] ?? null);

    if (snapshot.contract?.conflictState === "review_required") {
      await recordBlocked({
        ...base,
        localRevision: snapshot.contract.localRevision,
        outcome: "conflict_review_required",
        details: {
          observedClickupUserIds: observedIds,
          existingConflict: snapshot.contract.conflictEvidence,
        },
      });
      continue;
    }

    if (
      snapshot.command &&
      commandMatchesRemote &&
      currentRoleUserId === snapshot.command.desiredUserId
    ) {
      await withDbAttribution("clickup:roleInbound:echo", async () => {
        const db = getDb();
        await db.transaction(async (tx) => {
          const localRevision = snapshot.contract?.localRevision ?? 0;
          await tx
            .insert(cuRoleSyncContracts)
            .values({
              clientId: context.mapping.clientId,
              destinationId: destination.id,
              localRevision,
              vendorRevision: remoteRevision,
              lastObservedClickupUserIds: observedIds,
              conflictState: "none",
            })
            .onConflictDoUpdate({
              target: [
                cuRoleSyncContracts.clientId,
                cuRoleSyncContracts.destinationId,
              ],
              set: {
                vendorRevision: remoteRevision,
                lastObservedClickupUserIds: observedIds,
                conflictState: "none",
                conflictEvidence: null,
                updatedAt: new Date(),
              },
            });
          await tx
            .insert(cuRoleSyncTransitionEvidence)
            .values({
              receiptId: event.receiptId,
              commandId: snapshot.command.id,
              clientId: context.mapping.clientId,
              destinationId: destination.id,
              departmentId: destination.departmentId,
              responsibility,
              actorType: "clickup_member",
              actorId: event.actorClickupUserId,
              source: "clickup_webhook",
              beforeAssignment: before,
              afterAssignment: before,
              localRevision,
              vendorRevision: remoteRevision,
              outcome: "outbound_echo_noop",
              details: { observedClickupUserIds: observedIds },
            })
            .onConflictDoNothing();
        });
      });
      continue;
    }

    if (activePending && !commandMatchesRemote) {
      await withDbAttribution("clickup:roleInbound:conflictStop", () =>
        getDb()
          .update(cuRoleProjectionCommands)
          .set({
            status: "blocked",
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            lastError: "Concurrent divergent ClickUp role edit requires review",
            lastErrorCode: "config_mismatch",
            terminalAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(cuRoleProjectionCommands.id, snapshot.command!.id)),
      );
      await recordBlocked({
        ...base,
        localRevision: snapshot.contract?.localRevision ?? 0,
        outcome: "conflict_pending_outbound",
        details: {
          observedClickupUserIds: observedIds,
          pendingDesiredClickupUserId:
            snapshot.command!.desiredClickupUserId,
          pendingCommandRevision: snapshot.command!.revision,
          before,
        },
      });
      continue;
    }

    const after: AssignmentSnapshot = {
      primaryUserId:
        responsibility === "doer" ? inboundUserId : before.primaryUserId,
      checkerUserId:
        responsibility === "checker" ? inboundUserId : before.checkerUserId,
    };
    const mutation = await setClientDepartmentAssignmentNoProjection({
      clientId: context.mapping.clientId,
      departmentId: destination.departmentId,
      primaryUserId: after.primaryUserId,
      checkerUserId: after.checkerUserId,
      expectedAssignment: snapshot.assignment,
      afterAssignmentWriteInTransaction: async (tx) => {
        const nextLocalRevision = (snapshot.contract?.localRevision ?? 0) + 1;
        await tx
          .insert(cuRoleSyncContracts)
          .values({
            clientId: context.mapping.clientId,
            destinationId: destination.id,
            localRevision: nextLocalRevision,
            vendorRevision: remoteRevision,
            lastObservedClickupUserIds: observedIds,
            conflictState: "none",
          })
          .onConflictDoUpdate({
            target: [
              cuRoleSyncContracts.clientId,
              cuRoleSyncContracts.destinationId,
            ],
            set: {
              localRevision: nextLocalRevision,
              vendorRevision: remoteRevision,
              lastObservedClickupUserIds: observedIds,
              conflictState: "none",
              conflictEvidence: null,
              updatedAt: new Date(),
            },
          });
        if (snapshot.command && !commandMatchesRemote) {
          await tx
            .update(cuRoleProjectionCommands)
            .set({
              status: "blocked",
              leaseOwner: null,
              leaseToken: null,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              terminalAt: new Date(),
              lastError: "Superseded by accepted authoritative ClickUp edit",
              lastErrorCode: null,
              updatedAt: new Date(),
            })
            .where(eq(cuRoleProjectionCommands.id, snapshot.command.id));
        }
        await tx
          .insert(cuRoleSyncTransitionEvidence)
          .values({
            receiptId: event.receiptId,
            commandId: snapshot.command?.id ?? null,
            clientId: context.mapping.clientId,
            destinationId: destination.id,
            departmentId: destination.departmentId,
            responsibility,
            actorType: "clickup_member",
            actorId: event.actorClickupUserId,
            source: "clickup_webhook",
            beforeAssignment: before,
            afterAssignment: after,
            localRevision: nextLocalRevision,
            vendorRevision: remoteRevision,
            outcome:
              currentRoleUserId === inboundUserId
                ? "inbound_noop"
                : observedIds.length === 0
                  ? "inbound_cleared"
                  : "inbound_applied",
            details: { observedClickupUserIds: observedIds },
          })
          .onConflictDoNothing();
      },
    });
    if (!mutation.ok) {
      await recordBlocked({
        ...base,
        localRevision: snapshot.contract?.localRevision ?? 0,
        outcome:
          mutation.kind === "concurrent_conflict"
            ? "conflict_local_cas"
            : `blocked_${mutation.kind}`,
        details: { observedClickupUserIds: observedIds, before },
      });
    }
  }
}