import { storage } from "../storage";
import type { ClientAgentMemory } from "@shared/schema";
import {
  isBlockedSeedIdentifier,
  isGenericShortAlias,
  shouldAllowCooccurrenceSignal,
  isCommonSurname,
  getContaminationRiskScore,
  isSystemNotificationEmail,
  isVendorPlatformDomain,
} from "./seedingTrustPolicy";
import {
  isCompanyEmail,
  isCompanyDomain,
  isCompanyRelatedName,
  extractDomain,
  isPublicEmailDomain,
} from "./companyIdentity";

export type ResetMode = "learned_only_reset" | "full_rebuild";

export interface MemoryBackup {
  clientId: string;
  timestamp: string;
  memories: ClientAgentMemory[];
  memoryCount: number;
}

export interface DryRunReport {
  clientId: string;
  clientName: string;
  mode: ResetMode;
  currentMemoryCount: number;
  wouldRemove: Array<{ id: string; type: string; value: string; source: string; reason: string }>;
  wouldPreserve: Array<{ id: string; type: string; value: string; source: string }>;
  wouldRebuild: number;
  blockedIdentifiersFound: number;
  genericAliasesFound: number;
  blockedCoOccurrencesFound: number;
  contaminationRisk: { risk: string; score: number };
}

export interface ResetResult {
  clientId: string;
  mode: ResetMode;
  removed: number;
  preserved: number;
  rebuilt: number;
  errors: string[];
  backup: MemoryBackup;
}


function classifyMemoryForRemoval(
  mem: ClientAgentMemory,
  mode: ResetMode
): { shouldRemove: boolean; reason: string } {
  if (isBlockedSeedIdentifier(mem.identifierType, mem.identifierValue)) {
    return { shouldRemove: true, reason: "blocked_identifier" };
  }

  if ((mem.identifierType === "keyword" || mem.identifierType === "alias" || mem.identifierType === "sender_name") &&
      isCompanyRelatedName(mem.identifierValue)) {
    return { shouldRemove: true, reason: "company_related_name" };
  }

  if (mem.identifierType === "alias" && isGenericShortAlias(mem.identifierValue)) {
    return { shouldRemove: true, reason: "generic_short_alias" };
  }

  if (mem.identifierType === "co_occurrence" && !shouldAllowCooccurrenceSignal(mem.identifierValue)) {
    return { shouldRemove: true, reason: "blocked_cooccurrence" };
  }

  if (mode === "full_rebuild") {
    return { shouldRemove: true, reason: "full_rebuild" };
  }

  if (mode === "learned_only_reset") {
    if (mem.source === "learned" && !mem.manuallyAdded) {
      return { shouldRemove: true, reason: "learned_non_manual" };
    }
  }

  return { shouldRemove: false, reason: "" };
}

// Task #4087: no longer exported — its only external caller was the removed
// memory-reset/backup route (the "backup" was response-body-only JSON). Kept
// internal because resetClientMemory snapshots memory through it.
async function backupClientMemory(clientId: string): Promise<MemoryBackup> {
  const memories = await storage.getClientAgentMemory(clientId);
  return {
    clientId,
    timestamp: new Date().toISOString(),
    memories,
    memoryCount: memories.length,
  };
}

export async function dryRunReport(
  clientId: string,
  mode: ResetMode
): Promise<DryRunReport> {
  const client = await storage.getClient(clientId);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const memories = await storage.getClientAgentMemory(clientId);

  const wouldRemove: DryRunReport["wouldRemove"] = [];
  const wouldPreserve: DryRunReport["wouldPreserve"] = [];
  let blockedIdentifiersFound = 0;
  let genericAliasesFound = 0;
  let blockedCoOccurrencesFound = 0;

  for (const mem of memories) {
    const { shouldRemove, reason } = classifyMemoryForRemoval(mem, mode);

    if (shouldRemove) {
      wouldRemove.push({
        id: mem.id,
        type: mem.identifierType,
        value: mem.identifierValue,
        source: mem.source,
        reason,
      });
      if (reason === "blocked_identifier") blockedIdentifiersFound++;
      if (reason === "generic_short_alias") genericAliasesFound++;
      if (reason === "blocked_cooccurrence") blockedCoOccurrencesFound++;
    } else {
      wouldPreserve.push({
        id: mem.id,
        type: mem.identifierType,
        value: mem.identifierValue,
        source: mem.source,
      });
    }
  }

  const learnedCount = memories.filter(m => m.source === "learned").length;
  const coOccurrenceCount = memories.filter(m => m.identifierType === "co_occurrence").length;
  const contaminationRisk = getContaminationRiskScore(memories.length, learnedCount, coOccurrenceCount);

  const wouldRebuild = mode === "full_rebuild" ? await estimateRebuildCount(clientId) : 0;

  return {
    clientId,
    clientName: client.firmName || client.contactName || clientId,
    mode,
    currentMemoryCount: memories.length,
    wouldRemove,
    wouldPreserve,
    wouldRebuild,
    blockedIdentifiersFound,
    genericAliasesFound,
    blockedCoOccurrencesFound,
    contaminationRisk,
  };
}

async function estimateRebuildCount(clientId: string): Promise<number> {
  let count = 0;
  const client = await storage.getClient(clientId);
  if (!client) return 0;

  if (client.contactEmail) {
    const emails = client.contactEmail.split(",").map(e => e.trim()).filter(Boolean);
    for (const email of emails) {
      if (!isBlockedSeedIdentifier("email", email.toLowerCase())) count++;
    }
  }
  if (client.contactPhone) count++;
  if (client.firmName) count += 3;
  if (client.clientCode) count++;
  if (client.contactName) {
    const parts = client.contactName.trim().split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 1].length > 2) count++;
  }

  const contacts = await storage.getClientContacts(clientId);
  for (const contact of contacts) {
    if (contact.emails) count += contact.emails.filter(e => e && !isBlockedSeedIdentifier("email", e.toLowerCase())).length;
    if (contact.phones) count += contact.phones.filter(Boolean).length;
  }

  return count;
}

export async function resetClientMemory(
  clientId: string,
  mode: ResetMode
): Promise<ResetResult> {
  const backup = await backupClientMemory(clientId);
  const memories = await storage.getClientAgentMemory(clientId);

  let removed = 0;
  let preserved = 0;
  const errors: string[] = [];

  for (const mem of memories) {
    const { shouldRemove } = classifyMemoryForRemoval(mem, mode);
    if (shouldRemove) {
      try {
        await storage.deleteClientAgentMemory(mem.id);
        removed++;
      } catch (err: any) {
        errors.push(`Failed to delete memory ${mem.id}: ${err.message}`);
      }
    } else {
      preserved++;
    }
  }

  let rebuilt = 0;
  if (mode === "full_rebuild") {
    // Task #2637 (T2): the agent matching engine has been removed, so
    // there is no longer an automatic seeding step to rebuild client
    // memory. A "full_rebuild" now removes contaminated/learned memory
    // and leaves rebuild (rebuilt=0) to deterministic/operator flows.

    try {
      const postRebuildMemory = await storage.getClientAgentMemory(clientId);
      for (const mem of postRebuildMemory) {
        if (mem.identifierType === "co_occurrence") {
          if (!shouldAllowCooccurrenceSignal(mem.identifierValue)) {
            await storage.deleteClientAgentMemory(mem.id);
          }
        }
        if (mem.identifierType === "alias" && isGenericShortAlias(mem.identifierValue)) {
          await storage.deleteClientAgentMemory(mem.id);
        }
      }
    } catch (err: any) {
      errors.push(`Post-rebuild cluster cleanup failed: ${err.message}`);
    }
  }

  console.log(`[MemoryReset] Client ${clientId}: mode=${mode}, removed=${removed}, preserved=${preserved}, rebuilt=${rebuilt}, errors=${errors.length}`);

  return {
    clientId,
    mode,
    removed,
    preserved,
    rebuilt,
    errors,
    backup,
  };
}

export async function releaseContaminatedClaims(
  clientId: string,
  dryRun = false
): Promise<{
  released: number;
  examined: number;
  dryRun: boolean;
  releasedItems: Array<{ communicationId: string; communicationType: string; reason: string }>;
}> {
  const decisions = await storage.listAgentMatchDecisions({
    clientId,
    status: "claimed",
    limit: 2000,
  });

  const currentMemory = await storage.getClientAgentMemory(clientId);
  const memoryValues = new Set(currentMemory.map(m => `${m.identifierType}:${m.identifierValue}`));

  let released = 0;
  const releasedItems: Array<{ communicationId: string; communicationType: string; reason: string }> = [];

  for (const decision of decisions) {
    if (decision.reviewedByHuman || decision.correctedByHuman) continue;

    const signals = (decision.supportingSignalsJson as Array<{ type: string; value: string; weight: number }>) || [];
    if (signals.length === 0) continue;

    let validSignalWeight = 0;
    let totalSignalWeight = 0;
    let contaminatedSignalCount = 0;

    for (const signal of signals) {
      totalSignalWeight += signal.weight;

      const isContaminated =
        isBlockedSeedIdentifier(signal.type, signal.value) ||
        (signal.type === "alias" && isGenericShortAlias(signal.value)) ||
        (signal.type === "co_occurrence" && !shouldAllowCooccurrenceSignal(signal.value));

      if (isContaminated) {
        contaminatedSignalCount++;
        continue;
      }

      const key = `${signal.type}:${signal.value}`;
      if (memoryValues.has(key)) {
        validSignalWeight += signal.weight;
      }
    }

    const confidenceCollapses = totalSignalWeight > 0 && (validSignalWeight / totalSignalWeight) < 0.4;
    const shouldRelease = contaminatedSignalCount > 0 && confidenceCollapses;

    if (shouldRelease) {
      const reason = `Contaminated signals removed: valid weight ${validSignalWeight.toFixed(2)}/${totalSignalWeight.toFixed(2)}`;

      if (!dryRun) {
        let sourceUnmatched = false;
        let sourceError: string | null = null;

        try {
          if (decision.communicationType === "front_email") {
            const { getFrontSyncEmailByConversationId } = await import("../storage/communicationStorage");
            let email = await storage.getFrontSyncEmail(decision.communicationId);
            if (!email) {
              email = (await getFrontSyncEmailByConversationId(decision.communicationId)) ?? undefined;
            }
            if (email && email.matchedClientId === clientId) {
              await storage.updateFrontSyncEmail(email.id, {
                matchedClientId: null,
                matchStatus: "unmatched",
                matchConfidence: null,
                matchReason: `Released: ${reason}`,
              });
              sourceUnmatched = true;
            } else if (!email) {
              sourceError = "front_email record not found by id or conversationId";
            }
          } else {
            const { getRawCommunication } = await import("../storage/communicationStorage");
            let rawComm = await getRawCommunication(decision.communicationId);
            if (!rawComm) {
              rawComm = await storage.findRawCommunicationByExternalSourceId(decision.communicationId) || undefined;
            }
            if (rawComm && rawComm.clientId === clientId) {
              await storage.updateRawCommunication(rawComm.id, {
                clientId: null,
                matchMethod: "released",
                matchConfidence: null,
              });
              sourceUnmatched = true;
            } else if (!rawComm) {
              sourceError = "raw communication not found by id or externalSourceId";
            }
          }
        } catch (unmatchErr: any) {
          sourceError = unmatchErr.message;
          console.error(`[MemoryReset] Failed to unmatch source for decision ${decision.id}:`, unmatchErr.message);
        }

        if (sourceUnmatched || sourceError === null) {
          await storage.updateAgentMatchDecision(decision.id, {
            status: "not_claimed",
            explanationSummary: `Released: ${reason}. Original: ${decision.explanationSummary}`,
          });
        } else {
          console.warn(`[MemoryReset] Skipping decision ${decision.id} release: ${sourceError}`);
          continue;
        }
      }

      releasedItems.push({
        communicationId: decision.communicationId,
        communicationType: decision.communicationType,
        reason,
      });
      released++;
    }
  }

  console.log(`[MemoryReset] Release claims for ${clientId}: examined=${decisions.length}, released=${released}, dryRun=${dryRun}`);

  return {
    released,
    examined: decisions.length,
    dryRun,
    releasedItems,
  };
}

const JONES_CLIENT_ID = "fff49295-9494-4136-9137-2eb2073d8b5b";

export async function remediateJones(): Promise<{
  dryRunReport: DryRunReport;
  resetResult: ResetResult;
  releaseResult: Awaited<ReturnType<typeof releaseContaminatedClaims>>;
  postRebuildInventory: { memoryCount: number; byType: Record<string, number>; bySource: Record<string, number> };
  rematchEnqueued: boolean;
}> {
  console.log("[MemoryReset] Starting Jones remediation via canonical workflow...");

  const report = await dryRunReport(JONES_CLIENT_ID, "full_rebuild");
  console.log(`[MemoryReset] Jones dry-run: ${report.wouldRemove.length} to remove, ${report.wouldPreserve.length} to preserve, risk=${report.contaminationRisk.risk}`);

  const result = await resetClientMemory(JONES_CLIENT_ID, "full_rebuild");
  console.log(`[MemoryReset] Jones reset: removed=${result.removed}, preserved=${result.preserved}, rebuilt=${result.rebuilt}`);

  const release = await releaseContaminatedClaims(JONES_CLIENT_ID, false);
  console.log(`[MemoryReset] Jones claim release: examined=${release.examined}, released=${release.released}`);

  const postMemory = await storage.getClientAgentMemory(JONES_CLIENT_ID);
  const byType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const mem of postMemory) {
    byType[mem.identifierType] = (byType[mem.identifierType] || 0) + 1;
    bySource[mem.source] = (bySource[mem.source] || 0) + 1;
  }

  console.log(`[MemoryReset] Jones post-rebuild inventory: ${postMemory.length} entries, types=${JSON.stringify(byType)}, sources=${JSON.stringify(bySource)}`);

  let rematchEnqueued = false;
  if (release.released > 0) {
    try {
      // Task #1025: per-client ceiling.
      const { enqueueRetroactiveReprocessSafe } = await import(
        "./retroactiveReprocessControl"
      );
      const r = await enqueueRetroactiveReprocessSafe({
        clientId: JONES_CLIENT_ID,
        source: "memory_reset_remediation",
        workloadClass: "interactive_repair",
        payload: { maxItems: release.released },
        maxAttempts: 2,
      });
      rematchEnqueued = r.enqueued;
      console.log(`[MemoryReset] Jones rematch enqueued for ${release.released} released claims`);
    } catch (rematchErr: any) {
      console.error("[MemoryReset] Jones rematch enqueue failed:", rematchErr.message);
    }
  }

  return {
    dryRunReport: report,
    resetResult: result,
    releaseResult: release,
    postRebuildInventory: { memoryCount: postMemory.length, byType, bySource },
    rematchEnqueued,
  };
}

// Task #4087: globalContaminationScan (and its GlobalContaminationScan
// interface) were removed — the only caller was the removed
// GET /api/agent-engine/contamination-scan route, and the client_agent_memory
// population it scanned has been frozen since the Task #2637 learning-engine
// removal.
