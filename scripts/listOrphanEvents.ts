/**
 * Task #966 — CLI report for the structured orphan-event audit log.
 *
 * Answers operator questions like:
 *   - "How many records were orphaned in the last 30 days?"
 *   - "Which deletion event produced this orphan?"
 *   - "Show every orphaning event for client X."
 *
 * Reads from `communication_orphan_events` (written by deleteClient
 * and the task-902 sweep). Read-only — no mutations.
 *
 * Usage:
 *   tsx scripts/listOrphanEvents.ts                       # last 30 days summary
 *   tsx scripts/listOrphanEvents.ts --days 7              # last 7 days summary + rows
 *   tsx scripts/listOrphanEvents.ts --since 2026-05-01    # since explicit date
 *   tsx scripts/listOrphanEvents.ts --cause client_deleted
 *   tsx scripts/listOrphanEvents.ts --client <clientId>
 *   tsx scripts/listOrphanEvents.ts --record <recordId>
 *   tsx scripts/listOrphanEvents.ts --limit 200
 *   tsx scripts/listOrphanEvents.ts --json out.json
 *   tsx scripts/listOrphanEvents.ts --summary-only
 */

import * as fs from "fs";
import * as path from "path";
import {
  countCommunicationOrphanEvents,
  listCommunicationOrphanEvents,
  type ListOrphanEventOptions,
} from "../server/storage/communicationStorage";

interface Args {
  days?: number;
  since?: Date;
  until?: Date;
  cause?: "client_deleted" | "sweep_backfill";
  clientId?: string;
  recordId?: string;
  limit: number;
  jsonPath?: string;
  summaryOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 100, summaryOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) {
        console.error(`${a} requires a value`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case "--days":
        out.days = Number(next());
        if (!Number.isFinite(out.days) || out.days <= 0) {
          console.error("--days must be a positive number");
          process.exit(2);
        }
        break;
      case "--since":
        out.since = new Date(next());
        if (Number.isNaN(out.since.valueOf())) {
          console.error("--since must be a valid ISO date");
          process.exit(2);
        }
        break;
      case "--until":
        out.until = new Date(next());
        if (Number.isNaN(out.until.valueOf())) {
          console.error("--until must be a valid ISO date");
          process.exit(2);
        }
        break;
      case "--cause": {
        const v = next();
        if (v !== "client_deleted" && v !== "sweep_backfill") {
          console.error(`--cause must be client_deleted or sweep_backfill`);
          process.exit(2);
        }
        out.cause = v;
        break;
      }
      case "--client":
        out.clientId = next();
        break;
      case "--record":
        out.recordId = next();
        break;
      case "--limit":
        out.limit = Number(next());
        if (!Number.isFinite(out.limit) || out.limit <= 0) {
          console.error("--limit must be a positive number");
          process.exit(2);
        }
        break;
      case "--json":
        out.jsonPath = next();
        break;
      case "--summary-only":
        out.summaryOnly = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "listOrphanEvents.ts [--days N] [--since ISO] [--until ISO] [--cause C] [--client ID] [--record ID] [--limit N] [--json PATH] [--summary-only]",
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown arg: ${a}`);
        process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  // Default window: last 30 days unless caller passed --since/--until/--days.
  let since = args.since;
  if (!since) {
    const days = args.days ?? 30;
    since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  const baseFilter = {
    cause: args.cause,
    priorClientId: args.clientId,
    rawCommunicationRecordId: args.recordId,
    since,
    until: args.until,
  } satisfies Omit<ListOrphanEventOptions, "limit">;

  const summary = await countCommunicationOrphanEvents(baseFilter);

  console.log(`[task-966] orphan-event report`);
  console.log(`  since:  ${since.toISOString()}`);
  if (args.until) console.log(`  until:  ${args.until.toISOString()}`);
  if (args.cause) console.log(`  cause:  ${args.cause}`);
  if (args.clientId) console.log(`  client: ${args.clientId}`);
  if (args.recordId) console.log(`  record: ${args.recordId}`);
  console.log(`  total:  ${summary.total}`);
  for (const [cause, count] of Object.entries(summary.byCause)) {
    console.log(`    ${cause.padEnd(20)} = ${count}`);
  }

  let rows: Awaited<ReturnType<typeof listCommunicationOrphanEvents>> = [];
  if (!args.summaryOnly) {
    rows = await listCommunicationOrphanEvents({ ...baseFilter, limit: args.limit });
    console.log(`\n  showing ${rows.length} most recent (limit=${args.limit}):`);
    for (const r of rows) {
      const ts = r.occurredAt instanceof Date ? r.occurredAt.toISOString() : String(r.occurredAt);
      console.log(
        `    ${ts}  ${r.cause.padEnd(16)}  src=${r.source.padEnd(20)}  rec=${r.rawCommunicationRecordId}  priorClient=${r.priorClientId ?? "-"}  priorStatus=${r.priorMatchStatus ?? "-"}${r.reason ? `  reason=${r.reason}` : ""}`,
      );
    }
  }

  if (args.jsonPath) {
    const abs = path.resolve(process.cwd(), args.jsonPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      JSON.stringify(
        {
          filters: {
            since: since.toISOString(),
            until: args.until?.toISOString(),
            cause: args.cause,
            clientId: args.clientId,
            recordId: args.recordId,
            limit: args.limit,
          },
          summary,
          rows: args.summaryOnly ? undefined : rows,
        },
        null,
        2,
      ),
    );
    console.log(`\n[task-966] JSON written to ${abs}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[task-966] Failed:", err);
    process.exit(1);
  });
