#!/usr/bin/env npx tsx
/**
 * Completion/merge-boundary adapter for task-gate provenance.
 *
 * Inputs are environment-only so task/delivery correlation data does not
 * appear in shell history or process arguments. The adapter never infers a
 * task or commit from prose, timestamps, branch names, or commit messages.
 */
import { attachTaskGateDelivery } from "./taskGateEvidence";

export function cliMain(env: NodeJS.ProcessEnv = process.env): number {
  const ok = attachTaskGateDelivery({
    observationId: env.TASK_GATE_OBSERVATION_ID ?? "",
    taskRef: env.TASK_GATE_TASK_REF ?? "",
    validatedCommit: env.TASK_GATE_VALIDATED_COMMIT ?? "",
    validatedTree: env.TASK_GATE_VALIDATED_TREE ?? "",
    deliveryCommit: env.TASK_GATE_DELIVERY_COMMIT ?? "",
  }, {
    ledgerPath: env.TASK_GATE_EVIDENCE_PATH,
    repoRoot: env.TASK_GATE_REPO_ROOT,
  });
  if (!ok) {
    console.error(
      "[task-gate-provenance] delivery link not attached: missing, malformed, stale, or conflicting provenance",
    );
    return 1;
  }
  console.log("[task-gate-provenance] delivery link attached");
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("scripts/link-task-gate-delivery.ts") ?? false);

if (isMain) process.exit(cliMain());