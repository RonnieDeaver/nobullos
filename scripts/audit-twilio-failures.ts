/**
 * Task #1618 — Read-only audit of all-time Twilio failures across every
 * surface the platform tracks:
 *
 *   1. Outbound SMS                        (twilio_messages)
 *   2. Outbound / inbound voice calls       (twilio_calls — status column)
 *   3. Call analysis jobs                   (call_analysis_jobs)
 *   4. Recording archive jobs               (twilio_calls — archive_* columns)
 *   5. Inbound voicemail transcription      (twilio_calls — voicemail_* columns)
 *
 * **All-time scope:** every query in this script scans the entire table
 * (no `created_at > NOW() - INTERVAL ...` filter). This is deliberate —
 * the task requires an all-time inventory.
 *
 * The script is strictly read-only — every statement is a SELECT and the
 * script never opens a transaction or issues a write. It is safe to run
 * against the deployed prod database (Neon) on demand.
 *
 * Output modes:
 *   (default) plain-text TSV sections on stdout — easy to skim, easy to
 *             redirect into a raw artifact.
 *   --markdown emits the same data as the markdown sections committed to
 *             `audits/twilio-failure-audit.md` § "Generated tables".
 *             Cluster prose / proposed code fixes in that report are
 *             hand-curated and live outside the script.
 *
 * The remediation companion (scripts/remediate-twilio-failures.ts) reads
 * the same column set so the numbers it dry-runs line up with what this
 * audit reports.
 *
 * Usage:
 *   tsx scripts/audit-twilio-failures.ts
 *   tsx scripts/audit-twilio-failures.ts --markdown > audits/twilio-failure-audit-raw.md
 *   tsx scripts/audit-twilio-failures.ts --surface=sms,calls,archive,analysis,voicemail
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

type Surface = "sms" | "calls" | "analysis" | "archive" | "voicemail";
const ALL_SURFACES: Surface[] = ["sms", "calls", "analysis", "archive", "voicemail"];

interface Args { surfaces: Surface[]; markdown: boolean; }

function parseArgs(argv: string[]): Args {
  const surfaces = new Set<Surface>();
  let markdown = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log("scripts/audit-twilio-failures.ts [--surface=sms,calls,analysis,archive,voicemail] [--markdown]");
      process.exit(0);
    } else if (a === "--markdown") {
      markdown = true;
    } else if (a.startsWith("--surface=")) {
      for (const s of a.slice("--surface=".length).split(",")) {
        if (!ALL_SURFACES.includes(s as Surface)) {
          console.error(`Unknown surface: ${s}`);
          process.exit(2);
        }
        surfaces.add(s as Surface);
      }
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return { surfaces: surfaces.size ? Array.from(surfaces) : ALL_SURFACES, markdown };
}

let MD = false;

function section(title: string): void {
  if (MD) console.log(`\n## ${title}\n`);
  else { console.log("\n" + "=".repeat(78)); console.log(title); console.log("=".repeat(78)); }
}

async function dump(label: string, query: any): Promise<void> {
  if (MD) console.log(`\n### ${label}\n`);
  else console.log(`\n--- ${label} ---`);

  const r = await db.execute(query);
  const rows = (r.rows ?? []) as any[];
  if (rows.length === 0) {
    console.log(MD ? "_(no rows)_" : "(no rows)");
    return;
  }
  const keys = Object.keys(rows[0]);
  if (MD) {
    console.log(`| ${keys.join(" | ")} |`);
    console.log(`| ${keys.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
      console.log(`| ${keys.map((k) => fmtMd(row[k])).join(" | ")} |`);
    }
  } else {
    console.log(keys.join("\t"));
    for (const row of rows) {
      console.log(keys.map((k) => fmt(row[k])).join("\t"));
    }
  }
}
function fmt(v: any): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v.replace(/\t/g, " ").replace(/\n/g, " ");
  return String(v);
}
function fmtMd(v: any): string {
  const s = fmt(v);
  if (!s) return "_null_";
  return s.replace(/\|/g, "\\|");
}

async function auditSms(): Promise<void> {
  section("1. Outbound SMS (twilio_messages) — all-time");
  await dump("status x direction breakdown",
    sql`SELECT status, direction, COUNT(*)::int AS n FROM twilio_messages GROUP BY 1,2 ORDER BY n DESC`);
  await dump("failed / undelivered: error_code distribution",
    sql`SELECT status, error_code, COUNT(*)::int AS n FROM twilio_messages
        WHERE status IN ('failed','undelivered')
        GROUP BY 1,2 ORDER BY n DESC LIMIT 100`);
  await dump("failed / undelivered: rows missing error_code",
    sql`SELECT COUNT(*)::int AS missing_error_code, COUNT(error_message)::int AS have_error_message
        FROM twilio_messages WHERE status IN ('failed','undelivered') AND error_code IS NULL`);
  await dump("non-terminal staleness (queued / sent / accepted older than 1h)",
    sql`SELECT status, COUNT(*)::int AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
        FROM twilio_messages
        WHERE status IN ('queued','sent','accepted','sending')
          AND created_at < NOW() - INTERVAL '1 hour'
        GROUP BY 1 ORDER BY n DESC`);
  await dump("monthly histogram of failed / undelivered (all-time)",
    sql`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS n
        FROM twilio_messages WHERE status IN ('failed','undelivered')
        GROUP BY 1 ORDER BY 1`);
}

async function auditCalls(): Promise<void> {
  section("2. Voice calls (twilio_calls.status) — all-time");
  await dump("status x direction breakdown",
    sql`SELECT status, direction, COUNT(*)::int AS n FROM twilio_calls GROUP BY 1,2 ORDER BY n DESC`);
  await dump("call failure terminals: busy / no-answer / failed / canceled",
    sql`SELECT status, COUNT(*)::int AS n FROM twilio_calls
        WHERE status IN ('busy','no-answer','failed','canceled')
        GROUP BY 1 ORDER BY n DESC`);
  await dump("non-terminal staleness (initiated / ringing / in-progress older than 1h)",
    sql`SELECT status, COUNT(*)::int AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
        FROM twilio_calls
        WHERE status IN ('initiated','ringing','in-progress')
          AND created_at < NOW() - INTERVAL '1 hour'
        GROUP BY 1 ORDER BY n DESC`);
  await dump("monthly histogram of failed-terminal calls (all-time)",
    sql`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS n
        FROM twilio_calls WHERE status IN ('busy','no-answer','failed','canceled')
        GROUP BY 1 ORDER BY 1`);
  await dump("calls with missing duration on completed-terminal status",
    sql`SELECT COUNT(*)::int AS n FROM twilio_calls
        WHERE status IN ('completed','failed','canceled','busy','no-answer') AND duration IS NULL`);
}

async function auditAnalysis(): Promise<void> {
  section("3. Call analysis jobs (call_analysis_jobs) — all-time");
  await dump("status breakdown",
    sql`SELECT status, COUNT(*)::int AS n FROM call_analysis_jobs GROUP BY 1 ORDER BY n DESC`);
  await dump("failed: failure_reason distribution",
    sql`SELECT COALESCE(failure_reason, '(null)') AS reason, COUNT(*)::int AS n
        FROM call_analysis_jobs WHERE status='failed' GROUP BY 1 ORDER BY n DESC`);
  await dump("failed: top error_message clusters",
    sql`SELECT COALESCE(failure_reason, '(null)') AS reason, LEFT(error_message, 80) AS msg, COUNT(*)::int AS n
        FROM call_analysis_jobs WHERE status='failed'
        GROUP BY 1,2 ORDER BY n DESC LIMIT 30`);
  await dump("failed: audio_url presence (recoverable vs not)",
    sql`SELECT COALESCE(failure_reason, '(null)') AS reason,
               (audio_url IS NOT NULL) AS has_audio,
               COUNT(*)::int AS n
        FROM call_analysis_jobs WHERE status='failed'
        GROUP BY 1,2 ORDER BY n DESC`);
  await dump("failed: monthly histogram (all-time)",
    sql`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
               COALESCE(failure_reason, '(null)') AS reason, COUNT(*)::int AS n
        FROM call_analysis_jobs WHERE status='failed'
        GROUP BY 1,2 ORDER BY 1 DESC, n DESC LIMIT 200`);
  await dump("stuck non-terminal jobs (queued/processing older than 2h)",
    sql`SELECT status, COUNT(*)::int AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
        FROM call_analysis_jobs
        WHERE status IN ('queued','processing')
          AND created_at < NOW() - INTERVAL '2 hours'
        GROUP BY 1 ORDER BY n DESC`);
}

async function auditArchive(): Promise<void> {
  section("4. Recording archive jobs (twilio_calls.archive_*) — all-time");
  await dump("archive_status breakdown",
    sql`SELECT archive_status, COUNT(*)::int AS n FROM twilio_calls GROUP BY 1 ORDER BY n DESC`);
  await dump("archive_status='failed': attempts breakdown",
    sql`SELECT archive_attempts, COUNT(*)::int AS n FROM twilio_calls
        WHERE archive_status='failed' GROUP BY 1 ORDER BY 1`);
  await dump("archive_status='failed': error pattern distribution",
    sql`SELECT LEFT(archive_last_error, 100) AS err, COUNT(*)::int AS n FROM twilio_calls
        WHERE archive_status='failed' GROUP BY 1 ORDER BY n DESC LIMIT 30`);
  await dump("archive_status='failed': recording metadata presence",
    sql`SELECT recording_status, (recording_url IS NOT NULL) AS has_url, COUNT(*)::int AS n
        FROM twilio_calls WHERE archive_status='failed' GROUP BY 1,2 ORDER BY n DESC`);
  await dump("stuck 'processing' rows past lock TTL (lease > 30 min ago)",
    sql`SELECT COUNT(*)::int AS n, MIN(archive_leased_at) AS oldest_lease
        FROM twilio_calls
        WHERE archive_status='processing'
          AND archive_leased_at IS NOT NULL
          AND archive_leased_at < NOW() - INTERVAL '30 minutes'`);
  await dump("archive_status='failed': monthly histogram (all-time)",
    sql`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS n
        FROM twilio_calls WHERE archive_status='failed'
        GROUP BY 1 ORDER BY 1`);
}

async function auditVoicemail(): Promise<void> {
  section("5. Inbound voicemail (twilio_calls.voicemail_*) — all-time");
  await dump("voicemail row counts (any voicemail field set)",
    sql`SELECT COUNT(*)::int AS total_calls,
               COUNT(voicemail_recording_sid)::int AS w_recording_sid,
               COUNT(voicemail_recording_url)::int AS w_recording_url,
               COUNT(voicemail_transcription_status)::int AS w_tx_status,
               COUNT(CASE WHEN voicemail_transcription_status='failed' THEN 1 END)::int AS failed_tx,
               COUNT(CASE WHEN voicemail_recording_url IS NOT NULL
                           AND voicemail_transcription_text IS NULL
                           AND voicemail_transcription_status IS DISTINCT FROM 'failed' THEN 1 END)::int AS missing_transcript
        FROM twilio_calls`);
  await dump("voicemail: transcription status breakdown",
    sql`SELECT voicemail_transcription_status, COUNT(*)::int AS n FROM twilio_calls
        WHERE voicemail_transcription_status IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
  await dump("voicemail: failed transcription with recording still present (re-pull candidates)",
    sql`SELECT COUNT(*)::int AS n_recoverable, MIN(created_at) AS oldest, MAX(created_at) AS newest
        FROM twilio_calls
        WHERE voicemail_transcription_status='failed'
          AND voicemail_recording_url IS NOT NULL`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  MD = args.markdown;
  if (MD) {
    console.log(`# Twilio failure audit — generated tables\n`);
    console.log(`> Generated: ${new Date().toISOString()}`);
    console.log(`> Surfaces: ${args.surfaces.join(", ")}`);
    console.log(`> All-time scope (no \`created_at\` window). Read-only.\n`);
  } else {
    console.log(`Twilio failure audit — ${new Date().toISOString()}`);
    console.log(`Surfaces: ${args.surfaces.join(", ")}  (all-time, read-only)`);
  }

  if (args.surfaces.includes("sms")) await auditSms();
  if (args.surfaces.includes("calls")) await auditCalls();
  if (args.surfaces.includes("analysis")) await auditAnalysis();
  if (args.surfaces.includes("archive")) await auditArchive();
  if (args.surfaces.includes("voicemail")) await auditVoicemail();

  if (!MD) console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[audit-twilio-failures] Fatal: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
