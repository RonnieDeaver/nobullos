/* test-registration
{
  "name": "ClickUp webhook durability — exact-secret auth, canonical list receipts, dedupe/reorder/restart recovery, redacted terminal failure, replay linkage, mutable task refresh (Task #5244)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Exercises the real receipt+work_queue transaction and task mirror conflict update in an isolated schema. Vendor auth/fetch and notification delivery are injected or locally signed; no network egress.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small",
  "tierReason": "One isolated schema with compact indexed writes and in-process injected ClickUp boundaries; no browser, child process, external network, or timers."
}
test-registration */

import "./helpers/forceTestEnv";

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  clickupTasks,
  clickupWebhookReceipts,
  clickupWebhooks,
  workQueue,
  type WorkQueueJob,
} from "@shared/schema";
import { getDb } from "../server/db";
import { encryptToken } from "../server/utils/tokenCrypto";
import {
  acceptVerifiedClickUpTaskEvent,
  authenticateClickUpWebhook,
  parseClickUpWebhookFacts,
  receiveClickUpWebhook,
  type VerifiedClickUpWebhookIdentity,
} from "../server/services/clickUpWebhookInbox";
import {
  __test_setClickUpTaskApplyDeps,
  handleClickUpTaskApply,
} from "../server/services/clickUpWorkerHandlers";
import { __test_dequeueFromQueueUsingCurrentDb } from "../server/services/workQueueLease";
import { CANONICAL_PRODUCTION_LIST_ID } from "../server/services/adsOs/paidSearchRoleContract";
import { runInIsolatedSchema } from "./db-sandbox";

const TABLES = [
  "clickup_webhooks",
  "clickup_webhook_receipts",
  "clickup_tasks",
  "work_queue",
  "sd_list_mapping",
] as const;

function sign(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function raw(payload: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

async function loadJob(jobId: string): Promise<WorkQueueJob> {
  const [job] = await getDb()
    .select()
    .from(workQueue)
    .where(eq(workQueue.id, jobId))
    .limit(1);
  assert.ok(job, `expected work_queue row ${jobId}`);
  return job as WorkQueueJob;
}

async function main(): Promise<void> {
  await runInIsolatedSchema(
    async ({ db }) => {
      const secretA = "clickup-webhook-secret-A";
      const secretB = "clickup-webhook-secret-B";
      await db.insert(clickupWebhooks).values([
        {
          id: "wh-exact-a",
          workspaceId: "workspace-1",
          userId: "service-user-1",
          endpoint: "https://example.invalid/api/webhooks/clickup",
          secret: encryptToken(secretA),
          locationType: "list",
          locationId: CANONICAL_PRODUCTION_LIST_ID,
          status: "active",
        },
        {
          id: "wh-exact-b",
          workspaceId: "workspace-1",
          userId: "service-user-2",
          endpoint: "https://example.invalid/api/webhooks/clickup",
          secret: encryptToken(secretB),
          locationType: "list",
          locationId: CANONICAL_PRODUCTION_LIST_ID,
          status: "active",
        },
      ]);

      const basePayload = {
        event: "taskUpdated",
        task_id: "task-canonical-1",
        list_id: CANONICAL_PRODUCTION_LIST_ID,
        team_id: "workspace-1",
        history_items: [{ id: "history-1" }],
      };
      const baseRaw = raw(basePayload);

      const wrongSecretIdentity = await authenticateClickUpWebhook(
        baseRaw,
        sign(baseRaw, secretB),
        "wh-exact-a",
      );
      assert.equal(
        wrongSecretIdentity,
        null,
        "header-named webhook A must not authenticate with webhook B's secret",
      );
      assert.equal(
        await authenticateClickUpWebhook(
          baseRaw,
          sign(baseRaw, secretA),
          "wh-unknown",
        ),
        null,
        "unknown webhook IDs fail closed",
      );

      const identity = await authenticateClickUpWebhook(
        baseRaw,
        sign(baseRaw, secretA),
        "wh-exact-a",
      );
      assert.deepEqual(identity, {
        webhookId: "wh-exact-a",
        workspaceId: "workspace-1",
        serviceUserId: "service-user-1",
        locationType: "list",
        locationId: CANONICAL_PRODUCTION_LIST_ID,
      });

      await assert.rejects(
        receiveClickUpWebhook({
          rawBody: baseRaw,
          payload: basePayload,
          signature: sign(baseRaw, secretB),
          webhookId: "wh-exact-a",
        }),
        (err: any) => err?.statusCode === 401 && err?.code === "invalid_signature",
      );
      const firstReceived = await receiveClickUpWebhook({
        rawBody: baseRaw,
        payload: basePayload,
        signature: sign(baseRaw, secretA),
        webhookId: "wh-exact-a",
      });
      const first = firstReceived.accepted!;
      assert.equal(first.scope, "canonical_client_list");
      assert.equal(first.duplicate, false);
      assert.ok(first.receiptId);

      const [atomicCorrelation] = await db.execute(sql`
        SELECT r.id AS receipt_id, r.queue_job_id, q.id AS job_id,
               q.payload->>'userId' AS service_user_id,
               q.payload->>'scope' AS scope
        FROM clickup_webhook_receipts r
        JOIN work_queue q ON q.id = r.queue_job_id
        WHERE r.id = ${first.receiptId}
      `).then((result) => result.rows as Array<Record<string, unknown>>);
      assert.equal(atomicCorrelation.queue_job_id, atomicCorrelation.job_id);
      assert.equal(atomicCorrelation.service_user_id, "service-user-1");
      assert.equal(atomicCorrelation.scope, "canonical_client_list");

      // Simulate interruption after the worker started. The existing lease
      // recovery query must reclaim the same persisted job after restart.
      await db
        .update(workQueue)
        .set({
          status: "processing",
          leaseOwner: "dead-process",
          leasedAt: new Date(Date.now() - 120_000),
          leaseExpiresAt: new Date(Date.now() - 60_000),
        })
        .where(eq(workQueue.id, first.queueJobId));
      const reclaimed = await __test_dequeueFromQueueUsingCurrentDb(
        "ingestion",
        "restart-worker",
        30_000,
        { queueName: "clickup_task_apply" },
      );
      assert.equal(
        reclaimed?.id,
        first.queueJobId,
        "expired processing work survives process interruption and is reclaimed",
      );

      const duplicateAfterRestart = await acceptVerifiedClickUpTaskEvent(
        identity!,
        parseClickUpWebhookFacts(basePayload, baseRaw),
      );
      assert.equal(duplicateAfterRestart.duplicate, true);
      assert.equal(duplicateAfterRestart.receiptId, first.receiptId);
      assert.equal(duplicateAfterRestart.queueJobId, first.queueJobId);

      const wrongListPayload = {
        ...basePayload,
        task_id: "task-generic-1",
        list_id: "unrelated-list",
        history_items: [{ id: "history-generic" }],
      };
      const wrongListRaw = raw(wrongListPayload);
      const wrongList = await acceptVerifiedClickUpTaskEvent(
        identity!,
        parseClickUpWebhookFacts(wrongListPayload, wrongListRaw),
      );
      assert.equal(wrongList.scope, "generic_mirror");
      assert.equal(wrongList.receiptId, null);
      const wrongListJob = await loadJob(wrongList.queueJobId);
      assert.equal((wrongListJob.payload as any)?.scope, "generic_mirror");
      assert.equal(
        await db
          .select({ id: clickupWebhookReceipts.id })
          .from(clickupWebhookReceipts)
          .where(eq(clickupWebhookReceipts.taskId, "task-generic-1"))
          .then((rows) => rows.length),
        0,
        "unrelated lists never enter the canonical receipt/apply scope",
      );

      // Distinct events can arrive out of order. Each is durable, while the
      // worker's fetch-current-state model makes both converge on current facts.
      const laterPayload = {
        ...basePayload,
        event: "taskCustomFieldUpdated",
        history_items: [{ id: "history-later" }],
      };
      const earlierPayload = {
        ...basePayload,
        event: "taskStatusUpdated",
        history_items: [{ id: "history-earlier" }],
      };
      const later = await acceptVerifiedClickUpTaskEvent(
        identity!,
        parseClickUpWebhookFacts(laterPayload, raw(laterPayload)),
      );
      const earlier = await acceptVerifiedClickUpTaskEvent(
        identity!,
        parseClickUpWebhookFacts(earlierPayload, raw(earlierPayload)),
      );
      assert.notEqual(later.receiptId, earlier.receiptId);
      assert.equal(
        await db
          .select({ id: clickupWebhookReceipts.id })
          .from(clickupWebhookReceipts)
          .where(eq(clickupWebhookReceipts.taskId, "task-canonical-1"))
          .then((rows) => rows.length),
        3,
        "duplicate retry is collapsed while reordered distinct events remain durable",
      );

      const taskSnapshot = (fieldValue: string) => ({
        id: "task-canonical-1",
        name: `Canonical task ${fieldValue}`,
        description: `description ${fieldValue}`,
        status: { status: fieldValue, color: "#123456", type: "custom" },
        priority: { id: "2", priority: "high" },
        date_created: "1",
        date_updated: fieldValue === "old" ? "2" : "3",
        due_date: fieldValue === "old" ? "4" : "5",
        time_estimate: fieldValue === "old" ? 60 : 120,
        time_spent: fieldValue === "old" ? 10 : 20,
        custom_fields: [{ id: "field-1", value: fieldValue }],
        assignees: [{ id: 9, username: fieldValue }],
        watchers: [{ id: 10, username: fieldValue }],
        tags: [{ name: fieldValue }],
        custom_type: `type-${fieldValue}`,
        archived: false,
        url: `https://app.clickup.com/t/${fieldValue}`,
        list: { id: CANONICAL_PRODUCTION_LIST_ID },
        space: { id: "space-1" },
        folder: { id: "folder-1" },
        team_id: "workspace-1",
      });

      let currentSnapshot = taskSnapshot("old");
      __test_setClickUpTaskApplyDeps({
        getAccessToken: async () => "test-token",
        getTask: async () => currentSnapshot as any,
        notifyTerminal: async () => ({ attempted: false, delivered: false, skipped: true, status: "skipped_no_channel" }) as any,
      });
      try {
        const canonicalJob = await loadJob(first.queueJobId);
        await handleClickUpTaskApply(canonicalJob);
        currentSnapshot = taskSnapshot("new");
        await handleClickUpTaskApply(canonicalJob);
      } finally {
        __test_setClickUpTaskApplyDeps(null);
      }

      const [mirrored] = await db
        .select()
        .from(clickupTasks)
        .where(eq(clickupTasks.id, "task-canonical-1"))
        .limit(1);
      assert.deepEqual(mirrored.customFields, [{ id: "field-1", value: "new" }]);
      assert.equal(mirrored.description, "description new");
      assert.equal(mirrored.timeEstimate, 120);
      assert.equal(mirrored.customType, "type-new");
      assert.deepEqual(mirrored.watchers, [{ id: 10, username: "new" }]);

      const terminalJob = await loadJob(later.queueJobId);
      const notices: unknown[] = [];
      const unsafeVendorText =
        "ClickUp GET /task/x failed (503): token=never-log raw vendor body";
      let thrown = "";
      __test_setClickUpTaskApplyDeps({
        getAccessToken: async () => "test-token",
        getTask: async () => {
          throw new Error(unsafeVendorText);
        },
        notifyTerminal: (async (...args: unknown[]) => {
          notices.push(args);
          return {
            attempted: true,
            delivered: true,
            skipped: false,
            status: "success",
          };
        }) as any,
      });
      try {
        await handleClickUpTaskApply({
          ...terminalJob,
          attemptCount: terminalJob.maxAttempts - 1,
        });
      } catch (err) {
        thrown = err instanceof Error ? err.message : String(err);
      } finally {
        __test_setClickUpTaskApplyDeps(null);
      }
      assert.equal(thrown, "clickup_task_fetch_http_503");
      assert.equal(notices.length, 1, "final canonical failure is operator-visible");
      assert.ok(
        !JSON.stringify(notices).includes("never-log") &&
          !JSON.stringify(notices).includes("token="),
        "terminal observability contains only bounded correlation facts",
      );

      notices.length = 0;
      __test_setClickUpTaskApplyDeps({
        getAccessToken: async () => null,
        notifyTerminal: (async (...args: unknown[]) => {
          notices.push(args);
          return {
            attempted: true,
            delivered: true,
            skipped: false,
            status: "success",
          };
        }) as any,
      });
      try {
        await assert.rejects(
          handleClickUpTaskApply({
            ...terminalJob,
            attemptCount: terminalJob.maxAttempts - 1,
          }),
          /clickup_service_identity_unavailable/,
        );
      } finally {
        __test_setClickUpTaskApplyDeps(null);
      }
      assert.equal(
        notices.length,
        1,
        "service-identity terminal failure uses the same operator signal",
      );

      await db
        .update(workQueue)
        .set({
          status: "dead_letter",
          attemptCount: terminalJob.maxAttempts,
          errorCode: "handler_error",
          errorMessage: thrown,
          completedAt: new Date(),
        })
        .where(eq(workQueue.id, terminalJob.id));
      const [terminalEvidence] = await db.execute(sql`
        SELECT r.queue_job_id, q.status, q.error_message
        FROM clickup_webhook_receipts r
        JOIN work_queue q ON q.id = r.queue_job_id
        WHERE r.id = ${later.receiptId}
      `).then((result) => result.rows as Array<Record<string, unknown>>);
      assert.equal(terminalEvidence.status, "dead_letter");
      assert.equal(terminalEvidence.error_message, "clickup_task_fetch_http_503");

      // Manual replay resets the same governed row. The immutable receipt keeps
      // pointing at it, so no delivery or correlation evidence is forked.
      await db
        .update(workQueue)
        .set({
          status: "pending",
          attemptCount: 0,
          errorCode: null,
          errorMessage: null,
          completedAt: null,
          retryAt: null,
        })
        .where(
          and(
            eq(workQueue.id, terminalJob.id),
            eq(workQueue.status, "dead_letter"),
          ),
        );
      const [replayEvidence] = await db.execute(sql`
        SELECT r.queue_job_id, q.status, q.attempt_count
        FROM clickup_webhook_receipts r
        JOIN work_queue q ON q.id = r.queue_job_id
        WHERE r.id = ${later.receiptId}
      `).then((result) => result.rows as Array<Record<string, unknown>>);
      assert.equal(replayEvidence.queue_job_id, terminalJob.id);
      assert.equal(replayEvidence.status, "pending");
      assert.equal(Number(replayEvidence.attempt_count), 0);

      const persistedFacts = await db
        .select()
        .from(clickupWebhookReceipts);
      const serializedFacts = JSON.stringify(persistedFacts);
      assert.ok(!serializedFacts.includes(secretA));
      assert.ok(!serializedFacts.includes(secretB));
      assert.ok(!serializedFacts.includes("raw vendor body"));
    },
    { tables: TABLES },
  );

  console.log("clickup-webhook-durability: verified");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});