// @db-pool-intent: api
/**
 * Durable ClickUp webhook boundary for the canonical Client List.
 *
 * Verification uses the exact header-named active webhook. Canonical task
 * deliveries atomically persist a minimal receipt and the governed queue job
 * before the HTTP receiver acknowledges them. Raw vendor bodies and secrets
 * are never stored or logged.
 */

import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import {
  clickupWebhookReceipts,
  clickupWebhooks,
  workQueue,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { decryptToken } from "../utils/tokenCrypto";
import * as cu from "./clickUpClient";
import { enqueueJob } from "./workScheduler";
import { CANONICAL_PRODUCTION_LIST_ID } from "./adsOs/paidSearchRoleContract";

const MAX_CLICKUP_WEBHOOK_BYTES = 1_000_000;
const MAX_EVENT_TYPE_LENGTH = 80;
const MAX_EXTERNAL_ID_LENGTH = 160;

export interface VerifiedClickUpWebhookIdentity {
  webhookId: string;
  workspaceId: string;
  serviceUserId: string;
  locationType: string | null;
  locationId: string | null;
}

export interface ClickUpWebhookFacts {
  eventType: string;
  taskId: string | null;
  listId: string | null;
  workspaceId: string | null;
  providerEventId: string | null;
  actorClickupUserId: string | null;
  changedFieldIds: string[];
  bodySha256: string;
}

export class ClickUpWebhookInputError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "ClickUpWebhookInputError";
  }
}

function boundedExternalId(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > MAX_EXTERNAL_ID_LENGTH) return null;
  return normalized;
}

function firstProviderEventId(payload: Record<string, unknown>): string | null {
  const history = payload.history_items;
  if (!Array.isArray(history)) return null;
  for (const item of history.slice(0, 50)) {
    if (!item || typeof item !== "object") continue;
    const id = boundedExternalId((item as Record<string, unknown>).id);
    if (id) return id;
  }
  return null;
}

function webhookTransitionFacts(payload: Record<string, unknown>): {
  actorClickupUserId: string | null;
  changedFieldIds: string[];
} {
  const changed = new Set<string>();
  let actorClickupUserId: string | null = null;
  const history = Array.isArray(payload.history_items)
    ? payload.history_items.slice(0, 50)
    : [];
  for (const raw of history) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, any>;
    actorClickupUserId ??=
      boundedExternalId(item.user?.id) ??
      boundedExternalId(item.actor?.id) ??
      null;
    const candidates = [
      item.custom_field?.id,
      item.custom_field_id,
      item.field_id,
      item.field === "custom_field" ? item.data?.field_id : null,
    ];
    for (const candidate of candidates) {
      const id = boundedExternalId(candidate);
      if (id) changed.add(id);
    }
  }
  actorClickupUserId ??=
    boundedExternalId((payload.user as any)?.id) ??
    boundedExternalId(payload.user_id);
  return { actorClickupUserId, changedFieldIds: [...changed].sort() };
}

export function sha256ClickUpBody(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function verifyClickUpWebhookSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  return cu.verifyWebhookSignature(rawBody, signature, secret);
}

export function parseClickUpWebhookFacts(
  payload: unknown,
  rawBody: Buffer,
): ClickUpWebhookFacts {
  if (rawBody.length === 0) {
    throw new ClickUpWebhookInputError(400, "empty_body");
  }
  if (rawBody.length > MAX_CLICKUP_WEBHOOK_BYTES) {
    throw new ClickUpWebhookInputError(413, "body_too_large");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ClickUpWebhookInputError(400, "invalid_payload");
  }

  const record = payload as Record<string, unknown>;
  const eventType = typeof record.event === "string" ? record.event.trim() : "";
  if (!eventType || eventType.length > MAX_EVENT_TYPE_LENGTH) {
    throw new ClickUpWebhookInputError(400, "invalid_event");
  }

  const transition = webhookTransitionFacts(record);
  return {
    eventType,
    taskId: boundedExternalId(record.task_id),
    listId: boundedExternalId(record.list_id),
    workspaceId: boundedExternalId(record.team_id),
    providerEventId: firstProviderEventId(record),
    ...transition,
    bodySha256: sha256ClickUpBody(rawBody),
  };
}

export async function authenticateClickUpWebhook(
  rawBody: Buffer,
  signature: string,
  webhookId: string,
): Promise<VerifiedClickUpWebhookIdentity | null> {
  if (
    !signature ||
    signature.length > 256 ||
    !webhookId ||
    webhookId.length > MAX_EXTERNAL_ID_LENGTH
  ) {
    return null;
  }

  try {
    return await withDbAttribution(
      "clickup:webhook:verifyExact",
      async () => {
        const db = getDb();
        const [row] = await db
          .select({
            id: clickupWebhooks.id,
            workspaceId: clickupWebhooks.workspaceId,
            userId: clickupWebhooks.userId,
            locationType: clickupWebhooks.locationType,
            locationId: clickupWebhooks.locationId,
            secret: clickupWebhooks.secret,
          })
          .from(clickupWebhooks)
          .where(
            and(
              eq(clickupWebhooks.id, webhookId),
              eq(clickupWebhooks.status, "active"),
            ),
          )
          .limit(1);
        if (!row?.secret || !row.userId || !row.workspaceId) return null;

        const secret = decryptToken(row.secret);
        if (!verifyClickUpWebhookSignature(rawBody, signature, secret)) {
          return null;
        }
        return {
          webhookId: row.id,
          workspaceId: row.workspaceId,
          serviceUserId: row.userId,
          locationType: row.locationType,
          locationId: row.locationId,
        };
      },
    );
  } catch {
    return null;
  }
}

function deliveryKey(
  identity: VerifiedClickUpWebhookIdentity,
  facts: ClickUpWebhookFacts,
): string {
  return createHash("sha256")
    .update(
      [
        identity.webhookId,
        facts.eventType,
        facts.taskId ?? "",
        facts.listId ?? "",
        facts.providerEventId
          ? `event:${facts.providerEventId}`
          : `body:${facts.bodySha256}`,
      ].join("\n"),
    )
    .digest("hex");
}

export async function acceptVerifiedClickUpTaskEvent(
  identity: VerifiedClickUpWebhookIdentity,
  facts: ClickUpWebhookFacts,
): Promise<{
  scope: "canonical_client_list" | "generic_mirror";
  duplicate: boolean;
  receiptId: string | null;
  queueJobId: string;
}> {
  if (!facts.eventType.startsWith("task") || !facts.taskId) {
    throw new ClickUpWebhookInputError(400, "invalid_task_event");
  }
  if (facts.workspaceId && facts.workspaceId !== identity.workspaceId) {
    throw new ClickUpWebhookInputError(400, "workspace_mismatch");
  }

  const key = deliveryKey(identity, facts);
  if (
    facts.listId !== CANONICAL_PRODUCTION_LIST_ID ||
    identity.locationType !== "list" ||
    identity.locationId !== CANONICAL_PRODUCTION_LIST_ID
  ) {
    const queueJobId = await enqueueJob({
      queueName: "clickup_task_apply",
      workloadClass: "ingestion",
      payload: {
        taskId: facts.taskId,
        event: facts.eventType,
        userId: identity.serviceUserId,
        webhookId: identity.webhookId,
        workspaceId: identity.workspaceId,
        listId: facts.listId,
        scope: "generic_mirror",
      },
      dedupeKey: `clickup_task_apply:${key}`,
      maxAttempts: 3,
    });
    return {
      scope: "generic_mirror",
      duplicate: false,
      receiptId: null,
      queueJobId,
    };
  }

  return withDbAttribution("clickup:webhook:persistReceipt", async () => {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [insertedReceipt] = await tx
        .insert(clickupWebhookReceipts)
        .values({
          deliveryKey: key,
          webhookId: identity.webhookId,
          workspaceId: identity.workspaceId,
          serviceUserId: identity.serviceUserId,
          eventType: facts.eventType,
          providerEventId: facts.providerEventId,
          taskId: facts.taskId!,
          listId: CANONICAL_PRODUCTION_LIST_ID,
          bodySha256: facts.bodySha256,
          actorClickupUserId: facts.actorClickupUserId,
          changedFieldIds: facts.changedFieldIds,
        })
        .onConflictDoNothing()
        .returning({ id: clickupWebhookReceipts.id });

      if (!insertedReceipt) {
        const [existing] = await tx
          .select({
            id: clickupWebhookReceipts.id,
            queueJobId: clickupWebhookReceipts.queueJobId,
          })
          .from(clickupWebhookReceipts)
          .where(eq(clickupWebhookReceipts.deliveryKey, key))
          .limit(1);
        if (!existing?.queueJobId) {
          throw new Error("clickup_receipt_correlation_incomplete");
        }
        return {
          scope: "canonical_client_list" as const,
          duplicate: true,
          receiptId: existing.id,
          queueJobId: existing.queueJobId,
        };
      }

      const dedupeKey = `clickup_task_apply:${key}`;
      const [insertedJob] = await tx
        .insert(workQueue)
        .values({
          queueName: "clickup_task_apply",
          jobType: "clickup_task_apply",
          workloadClass: "ingestion",
          priority: 100,
          status: "pending",
          payload: {
            taskId: facts.taskId,
            event: facts.eventType,
            userId: identity.serviceUserId,
            webhookId: identity.webhookId,
            workspaceId: identity.workspaceId,
            listId: CANONICAL_PRODUCTION_LIST_ID,
            scope: "canonical_client_list",
            receiptId: insertedReceipt.id,
            actorClickupUserId: facts.actorClickupUserId,
            changedFieldIds: facts.changedFieldIds,
          },
          dedupeKey,
          maxAttempts: 3,
        })
        .onConflictDoNothing()
        .returning({ id: workQueue.id });

      let queueJobId = insertedJob?.id ?? null;
      if (!queueJobId) {
        const [existingJob] = await tx
          .select({ id: workQueue.id })
          .from(workQueue)
          .where(
            and(
              eq(workQueue.dedupeKey, dedupeKey),
              or(
                eq(workQueue.status, "pending"),
                eq(workQueue.status, "leased"),
                eq(workQueue.status, "processing"),
              ),
            ),
          )
          .limit(1);
        queueJobId = existingJob?.id ?? null;
      }
      if (!queueJobId) {
        throw new Error("clickup_queue_correlation_failed");
      }

      await tx
        .update(clickupWebhookReceipts)
        .set({ queueJobId })
        .where(eq(clickupWebhookReceipts.id, insertedReceipt.id));

      return {
        scope: "canonical_client_list" as const,
        duplicate: false,
        receiptId: insertedReceipt.id,
        queueJobId,
      };
    });
  });
}

export async function receiveClickUpWebhook(input: {
  rawBody: Buffer;
  payload: unknown;
  signature: string;
  webhookId: string;
}): Promise<{
  identity: VerifiedClickUpWebhookIdentity;
  facts: ClickUpWebhookFacts;
  accepted: Awaited<ReturnType<typeof acceptVerifiedClickUpTaskEvent>> | null;
}> {
  const identity = await authenticateClickUpWebhook(
    input.rawBody,
    input.signature,
    input.webhookId,
  );
  if (!identity) {
    throw new ClickUpWebhookInputError(401, "invalid_signature");
  }
  const facts = parseClickUpWebhookFacts(input.payload, input.rawBody);
  const accepted = facts.eventType.startsWith("task")
    ? await acceptVerifiedClickUpTaskEvent(identity, facts)
    : null;
  return { identity, facts, accepted };
}