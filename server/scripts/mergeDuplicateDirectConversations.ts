// Task #849 merge of duplicate direct (1:1) twilio_conversations.
// Run after backfillTwilioConversationNormalization.ts. Idempotent.
// Skips groups whose duplicates link to different clientIds.
// Usage: tsx server/scripts/mergeDuplicateDirectConversations.ts [--dry-run]

import {
  findDuplicateDirectGroups,
  mergeDirectConversationGroup,
  parseDirectThreadKey,
  type MergeAuditEntry,
} from "../services/conversationDedupe";

interface MergeReport {
  groupsConsidered: number;
  groupsMerged: number;
  groupsSkipped: number;
  totalRowsBefore: number;
  totalRowsAfter: number;
  audit: MergeAuditEntry[];
  dryRun: boolean;
}

export async function runMerge(opts: { dryRun?: boolean } = {}): Promise<MergeReport> {
  const groups = await findDuplicateDirectGroups();
  const report: MergeReport = {
    groupsConsidered: groups.length,
    groupsMerged: 0,
    groupsSkipped: 0,
    totalRowsBefore: groups.reduce((s, g) => s + g.rows.length, 0),
    totalRowsAfter: 0,
    audit: [],
    dryRun: !!opts.dryRun,
  };

  for (const group of groups) {
    const parsed = parseDirectThreadKey(group.key);
    if (!parsed) {
      console.warn(`[merge-direct] malformed key '${group.key}' — skipping`);
      report.groupsSkipped++;
      continue;
    }

    if (opts.dryRun) {
      const distinctClients = new Set(
        group.rows.map((r) => r.clientId).filter((id): id is string => Boolean(id)),
      );
      const skipReason = distinctClients.size > 1 ? "duplicate_direct_thread_conflict" : undefined;
      const survivor = group.rows[0];
      report.audit.push({
        timestamp: new Date().toISOString(),
        actor: "system:conversation-dedupe (dry-run)",
        survivorConversationId: skipReason ? "" : survivor.id,
        mergedConversationIds: skipReason
          ? group.rows.map((r) => r.id)
          : group.rows.filter((r) => r.id !== survivor.id).map((r) => r.id),
        contactPhoneKey: parsed.contactPhoneKey,
        twilioPhoneKey: parsed.twilioPhoneKey,
        movedMessageCount: 0,
        movedRawCommRecordCount: 0,
        skipReason,
        clientIdsInvolved: group.rows.map((r) => r.clientId),
      });
      if (skipReason) {
        report.groupsSkipped++;
      } else {
        report.groupsMerged++;
      }
      continue;
    }

    const result = await mergeDirectConversationGroup({
      conversations: group.rows,
      contactPhoneKey: parsed.contactPhoneKey,
      twilioPhoneKey: parsed.twilioPhoneKey,
      actor: "system:conversation-dedupe (merge-script)",
    });
    report.audit.push(result.entry);
    if (result.status === "merged") report.groupsMerged++;
    else if (result.status === "skipped_client_conflict") report.groupsSkipped++;
  }

  if (!opts.dryRun) {
    const remaining = await findDuplicateDirectGroups();
    report.totalRowsAfter = remaining.reduce((s, g) => s + g.rows.length, 0);
  } else {
    report.totalRowsAfter = report.totalRowsBefore;
  }

  return report;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`[merge-direct] starting (dryRun=${dryRun})`);
  const report = await runMerge({ dryRun });
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `[merge-direct] done — groupsConsidered=${report.groupsConsidered}, merged=${report.groupsMerged}, skipped=${report.groupsSkipped}, rowsBefore=${report.totalRowsBefore}, rowsAfter=${report.totalRowsAfter}`,
  );
  if (report.groupsSkipped > 0 && !dryRun) {
    console.warn(
      `[merge-direct] ${report.groupsSkipped} group(s) skipped — see audit entries with skipReason=duplicate_direct_thread_conflict for manual review`,
    );
  }
  process.exit(0);
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return argv1.endsWith("mergeDuplicateDirectConversations.ts") ||
           argv1.endsWith("mergeDuplicateDirectConversations.js");
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error("[merge-direct] fatal:", err);
    process.exit(1);
  });
}
