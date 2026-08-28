// @db-pool-intent: ambient
import crypto from "crypto";
import { sql } from "drizzle-orm";
import { workQueue } from "@shared/schema";
import type { ProjectionTx } from "./clickUpRoleProjectionKick";

export const CLICKUP_CLIENT_MIRROR_QUEUE = "clickup_client_mirror";

export interface ClientMirrorIntent {
  clientId: string;
  desiredName: string;
  desiredArchived: boolean;
  mergedIntoClientId?: string | null;
}

export function clientMirrorRevision(intent: ClientMirrorIntent): string {
  return crypto.createHash("sha256").update([
    intent.clientId,
    intent.desiredName,
    intent.desiredArchived ? "1" : "0",
    intent.mergedIntoClientId ?? "",
  ].join("\x00")).digest("hex");
}

/** Stages desired state and its first wake atomically. Contains no network I/O. */
export async function stageClientMirrorIntentInTx(
  tx: ProjectionTx,
  intent: ClientMirrorIntent,
): Promise<void> {
  const revision = clientMirrorRevision(intent);
  const result = await tx.execute(sql`
    INSERT INTO cu_client_mirror_commands (
      client_id, desired_name, desired_archived, merged_into_client_id, revision
    ) VALUES (
      ${intent.clientId}, ${intent.desiredName}, ${intent.desiredArchived},
      ${intent.mergedIntoClientId ?? null}, ${revision}
    )
    ON CONFLICT (client_id) DO UPDATE SET
      desired_name = EXCLUDED.desired_name,
      desired_archived = EXCLUDED.desired_archived,
      merged_into_client_id = EXCLUDED.merged_into_client_id,
      revision = EXCLUDED.revision,
      status = 'pending', attempt_count = 0, next_attempt_at = NULL,
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
      last_error_code = NULL, last_error = NULL, terminal_at = NULL,
      verified_at = NULL, updated_at = now()
    WHERE cu_client_mirror_commands.revision IS DISTINCT FROM EXCLUDED.revision
    RETURNING id
  `);
  if (((result as any).rowCount ?? 0) === 0) return;
  await tx.insert(workQueue).values({
    queueName: CLICKUP_CLIENT_MIRROR_QUEUE,
    jobType: CLICKUP_CLIENT_MIRROR_QUEUE,
    workloadClass: "maintenance",
    status: "pending",
    maxAttempts: 3,
    retryAt: new Date(),
    dedupeKey: `clickup_client_mirror:${intent.clientId}:${revision}:0`,
  }).onConflictDoNothing();
}
