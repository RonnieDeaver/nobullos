// @db-pool-intent: worker
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  // Task #849 backfill: populate normalized columns on twilio_conversations.
// Idempotent. Skips groups and unnormalizable rows. Does not merge
// duplicates - run mergeDuplicateDirectConversations.ts for that.
// Usage: tsx server/scripts/backfillTwilioConversationNormalization.ts [--dry-run]

import { isNull, ne, and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { twilioConversations } from "@shared/schema";
import {
  buildNormalizedFields,
} from "../services/conversationDedupe";

interface BackfillReport {
  totalConsidered: number;
  updated: number;
  alreadyNormalized: number;
  skippedGroup: number;
  skippedNoKey: Array<{
    id: string;
    contactPhone: string;
    twilioPhoneNumber: string;
    reason: string;
  }>;
  errors: Array<{ id: string; error: string }>;
}

export async function runBackfill(opts: { dryRun?: boolean } = {}): Promise<BackfillReport> {
  const db = getDb();
  const report: BackfillReport = {
    totalConsidered: 0,
    updated: 0,
    alreadyNormalized: 0,
    skippedGroup: 0,
    skippedNoKey: [],
    errors: [],
  };

  const all = await db.select().from(twilioConversations);

  for (const row of all) {
    report.totalConsidered++;

    if (row.conversationType === "group") {
      report.skippedGroup++;
      continue;
    }

    const fields = buildNormalizedFields({
      contactPhone: row.contactPhone,
      twilioPhoneNumber: row.twilioPhoneNumber,
      conversationType: row.conversationType,
    });

    if (!fields.directThreadKey) {
      report.skippedNoKey.push({
        id: row.id,
        contactPhone: row.contactPhone ?? "",
        twilioPhoneNumber: row.twilioPhoneNumber ?? "",
        reason: !fields.contactPhoneNormalized
          ? "contact phone has fewer than 10 digits"
          : !fields.twilioPhoneNumberNormalized
            ? "twilio phone has fewer than 10 digits"
            : "unknown",
      });
      continue;
    }

    if (
      row.contactPhoneNormalized === fields.contactPhoneNormalized &&
      row.twilioPhoneNumberNormalized === fields.twilioPhoneNumberNormalized &&
      row.directThreadKey === fields.directThreadKey
    ) {
      report.alreadyNormalized++;
      continue;
    }

    if (opts.dryRun) {
      report.updated++;
      continue;
    }

    try {
      // Per-row tx becomes a SAVEPOINT when nested, so a 23505 here does
      // not abort an enclosing tx (e.g. test sandbox).
      await db.transaction(async (sp) => {
        await sp
          .update(twilioConversations)
          .set({
            contactPhoneNormalized: fields.contactPhoneNormalized,
            twilioPhoneNumberNormalized: fields.twilioPhoneNumberNormalized,
            directThreadKey: fields.directThreadKey,
            updatedAt: new Date(),
          })
          .where(eq(twilioConversations.id, row.id));
      });
      report.updated++;
    } catch (err: unknown) {
      // 23505 expected when two pre-existing rows share the same key;
      // operator should run mergeDuplicateDirectConversations next.
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push({ id: row.id, error: msg });
    }
  }

  return report;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`[backfill-twilio-conv-normalization] starting (dryRun=${dryRun})`);
  const report = await runBackfill({ dryRun });
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `[backfill-twilio-conv-normalization] done — considered=${report.totalConsidered}, updated=${report.updated}, alreadyNormalized=${report.alreadyNormalized}, skippedGroup=${report.skippedGroup}, skippedNoKey=${report.skippedNoKey.length}, errors=${report.errors.length}`,
  );
  if (report.errors.length > 0) {
    console.warn(
      `[backfill-twilio-conv-normalization] ${report.errors.length} row(s) errored — likely unique-key collisions. Run server/scripts/mergeDuplicateDirectConversations.ts to merge duplicates, then re-run this backfill.`,
    );
  }
  process.exit(0);
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return argv1.endsWith("backfillTwilioConversationNormalization.ts") ||
           argv1.endsWith("backfillTwilioConversationNormalization.js");
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error("[backfill-twilio-conv-normalization] fatal:", err);
    process.exit(1);
  });
}
