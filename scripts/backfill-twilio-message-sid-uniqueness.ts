/**
 * Task #857 — Backfill `twilio_messages.twilio_sid` uniqueness for older
 * inbound rows that pre-date Task #849.
 *
 * Background
 * ----------
 * Task #849 added a partial unique index `twilio_msg_twilio_sid_uniq` on
 * `twilio_messages(twilio_sid) WHERE twilio_sid IS NOT NULL`. Postgres
 * will happily build that index over an existing table that already
 * contains duplicate values (the unique constraint only blocks *new*
 * inserts) — but the next time a Twilio webhook retry fires for a SID
 * that already has two rows, the INSERT will collide with itself and
 * surface as a 23505 in the logs even though our app treats the retry
 * as a no-op.
 *
 * This script finds any pre-existing duplicate `twilio_sid` groups in
 * `twilio_messages`, keeps the oldest row in each group (earliest
 * `created_at`, `id` as tiebreaker), and removes the newer duplicate
 * rows so the partial unique index becomes fully consistent.
 *
 * Behaviour
 * ---------
 * Default mode is dry-run: it reports the duplicate groups it found and
 * prints, for each group, which row would be kept and which would be
 * deleted. `--apply` performs the deletes inside a transaction. The
 * script logs every kept/deleted row to stdout so the cleanup can be
 * captured in the audit trail (redirect to a file when running with
 * `--apply`).
 *
 * Idempotent — once duplicates are gone the dry-run reports
 * "no duplicates" and the script is a no-op.
 *
 * Notes
 * -----
 * - Rows with `twilio_sid IS NULL` are ignored (the partial index
 *   excludes them too).
 * - No other table in `shared/` has a foreign key into
 *   `twilio_messages.id`, so deleting a duplicate row is safe — there
 *   is nothing downstream to repoint. The kept row preserves the
 *   `raw_communication_record_id` of the surviving (oldest) row, which
 *   matches what the webhook would have produced if the retry had been
 *   correctly de-duped at insert time.
 *
 * Usage:
 *   tsx scripts/backfill-twilio-message-sid-uniqueness.ts
 *   tsx scripts/backfill-twilio-message-sid-uniqueness.ts --apply
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { bindArrayParam } from "../server/utils/sqlArray";
import { twilioMessages } from "@shared/schema";

type Args = { apply: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "scripts/backfill-twilio-message-sid-uniqueness.ts [--apply]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

type DupRow = {
  id: string;
  twilioSid: string;
  conversationId: string;
  direction: string;
  status: string;
  createdAt: Date | null;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const tag = "[backfill-twilio-message-sid-uniqueness]";

  // Find every twilio_sid value that has more than one row.
  const dupSidsResult = await db.execute<{ twilio_sid: string; n: number }>(sql`
    SELECT twilio_sid, COUNT(*)::int AS n
    FROM twilio_messages
    WHERE twilio_sid IS NOT NULL
    GROUP BY twilio_sid
    HAVING COUNT(*) > 1
    ORDER BY twilio_sid
  `);

  const dupSids = (dupSidsResult.rows ?? []).map((r) => r.twilio_sid);

  if (dupSids.length === 0) {
    console.log(
      `${tag} No duplicate twilio_sid values found in twilio_messages. Nothing to do.`,
    );
    return;
  }

  console.log(
    `${tag} Found ${dupSids.length} twilio_sid value(s) with duplicate rows.`,
  );

  // Pull every row in those duplicate groups so we can decide which to
  // keep deterministically and log the cleanup for the audit trail.
  const rowsResult = await db.execute<{
    id: string;
    twilio_sid: string;
    conversation_id: string;
    direction: string;
    status: string;
    created_at: Date | null;
  }>(sql`
    SELECT id, twilio_sid, conversation_id, direction, status, created_at
    FROM twilio_messages
    WHERE twilio_sid = ANY(${bindArrayParam(dupSids, "text")})
    ORDER BY twilio_sid, created_at NULLS LAST, id
  `);

  const groups = new Map<string, DupRow[]>();
  for (const r of rowsResult.rows ?? []) {
    const row: DupRow = {
      id: r.id,
      twilioSid: r.twilio_sid,
      conversationId: r.conversation_id,
      direction: r.direction,
      status: r.status,
      createdAt: r.created_at,
    };
    const list = groups.get(row.twilioSid) ?? [];
    list.push(row);
    groups.set(row.twilioSid, list);
  }

  const toDelete: DupRow[] = [];
  let crossConversationGroups = 0;

  for (const [sid, rows] of groups.entries()) {
    // ORDER BY above already puts the oldest first.
    const [keep, ...drop] = rows;
    const distinctConversations = new Set(rows.map((r) => r.conversationId));
    const crossConv = distinctConversations.size > 1;
    if (crossConv) crossConversationGroups += 1;

    console.log(
      `${tag} sid=${sid} group_size=${rows.length}` +
        (crossConv ? " cross_conversation=true" : ""),
    );
    console.log(
      `${tag}   KEEP    id=${keep.id} conv=${keep.conversationId} dir=${keep.direction} status=${keep.status} created_at=${keep.createdAt?.toISOString?.() ?? keep.createdAt}`,
    );
    for (const d of drop) {
      console.log(
        `${tag}   DELETE  id=${d.id} conv=${d.conversationId} dir=${d.direction} status=${d.status} created_at=${d.createdAt?.toISOString?.() ?? d.createdAt}`,
      );
      toDelete.push(d);
    }
  }

  console.log(
    `${tag} Summary: ${groups.size} duplicate group(s), ${toDelete.length} row(s) planned for deletion, ${crossConversationGroups} cross-conversation group(s).`,
  );

  if (crossConversationGroups > 0) {
    console.log(
      `${tag} WARNING: ${crossConversationGroups} group(s) span multiple conversation_id values. Review the KEEP/DELETE log above before running with --apply; a manual merge may be preferable to an automated delete.`,
    );
  }

  if (!args.apply) {
    console.log(
      `${tag} Dry-run. Re-run with --apply to delete ${toDelete.length} row(s).`,
    );
    return;
  }

  if (toDelete.length === 0) {
    console.log(`${tag} Nothing to delete.`);
    return;
  }

  const ids = toDelete.map((r) => r.id);
  const deleted = await db.transaction(async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      DELETE FROM ${twilioMessages}
      WHERE id = ANY(${bindArrayParam(ids, "text")})
      RETURNING id
    `);
    return result.rows?.length ?? 0;
  });
  console.log(`${tag} Done. deleted=${deleted} of planned=${toDelete.length}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      `[backfill-twilio-message-sid-uniqueness] Fatal: ${err?.stack || err?.message || err}`,
    );
    process.exit(1);
  });
