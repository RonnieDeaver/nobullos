/**
 * Task #1618 — Safe, idempotent remediation script for the all-time
 * Twilio failure inventory produced by `scripts/audit-twilio-failures.ts`.
 *
 * Per-surface flags let an operator drain one surface at a time so the
 * blast radius stays small and the dry-run output can be diffed against
 * the audit report numbers before any write happens.
 *
 * Safety contract
 * ---------------
 *   - DEFAULT MODE IS --dry-run. Writes are gated on the explicit
 *     `--apply` flag.
 *   - Batch size is bounded with `--batch-size=N` (default 50, max 500).
 *   - A kill-switch check reads `system_settings.twilio_remediation_kill_switch`
 *     and refuses to write when the value is anything other than null /
 *     empty / "false". Operator can pause an in-flight run by setting
 *     the row.
 *   - Writes are scoped to *our* database (Neon prod). The script never
 *     calls the Twilio API to *send* a new message / start a new call —
 *     it only pulls the *current* state of an existing Twilio resource
 *     (Message / Call / Recording / Transcription) and reconciles our
 *     row with what Twilio says. We are reconciling our DB with
 *     Twilio's, not re-attempting the original customer-facing action.
 *   - All writes are idempotent. Re-running a surface after a partial
 *     success skips rows that were already reconciled.
 *
 * Per-surface remediation rules
 * -----------------------------
 *   --sms             Outbound `twilio_messages` rows that are still
 *                     `queued` / `sent` past 1h, OR whose status is
 *                     `failed` / `undelivered` and missing
 *                     `error_code` / `error_message`. We pull the
 *                     Message resource by SID, persist its current
 *                     `status` + `errorCode` + `errorMessage`.
 *
 *   --calls           Two candidate sets, both pulled from the Twilio
 *                     Call resource by SID:
 *                       (a) rows stuck in `initiated` / `ringing` /
 *                           `in-progress` past 1h — backfill terminal
 *                           `status` + `duration`.
 *                       (b) rows already in a terminal status
 *                           (`completed`/`failed`/`canceled`/`busy`/
 *                           `no-answer`) whose `duration` is NULL —
 *                           backfill duration from the Twilio resource.
 *
 *                     **Documented deviation re: Twilio Call.price.** The
 *                     code review for Task #1618 asked that we also
 *                     reconcile the Twilio Call resource's `price` /
 *                     `priceUnit` fields. The `twilio_calls` schema (see
 *                     `shared/models/communications.ts`) does NOT define a
 *                     `price` column today, so there is nowhere to persist
 *                     it. We log the value Twilio returns (visible in
 *                     dry-run output) so an operator can spot whether a
 *                     follow-up schema/migration task is warranted, but we
 *                     do not invent a column. See §7 of the audit report
 *                     for the recommended follow-up.
 *
 *   --call-analysis   `call_analysis_jobs` rows in `failed` whose
 *                     `failure_reason` is in the safely-retryable set
 *                     (`download_failed`, `cpu_starved`, OR
 *                     `ffmpeg_timeout` where the audio_url is still
 *                     populated). Re-queues them (status='queued',
 *                     clears error fields, resets attempt_count). Non-
 *                     retryable reasons (`ffmpeg_invalid_audio`,
 *                     `file_too_large`) are reported and left alone.
 *
 *   --archive         `twilio_calls.archive_*` recovery:
 *                       a. `processing` rows past the lock TTL (30 min
 *                          since archive_leased_at) — reset to `queued`
 *                          with archive_attempts unchanged so the next
 *                          worker tick can reclaim them. Mirrors the
 *                          existing `init-stuck-call-archive-rows.ts`
 *                          semantics.
 *                       b. `failed` rows with `archive_attempts <
 *                          MAX_ATTEMPTS` (6) and a transient-looking
 *                          `archive_last_error` (timeout / 5xx / EAI) —
 *                          re-queue.
 *                       c. `failed` rows that exhausted attempts AND
 *                          whose Twilio recording no longer exists
 *                          (404 from Twilio) — mark `skipped` with a
 *                          reason. Twilio retains recordings for a long
 *                          time so this only fires when Twilio truly
 *                          has nothing left to fetch.
 *
 *   --voicemail       `twilio_calls` rows with
 *                     `voicemail_transcription_status='failed'` but
 *                     `voicemail_recording_url IS NOT NULL`. We pull
 *                     Twilio's Transcription resource for the recording
 *                     SID; if Twilio has a finished transcription, we
 *                     persist it. Otherwise the row is left alone.
 *
 * Out of scope (documented for the audit follow-up tasks, NOT done here):
 *   - Re-sending the original SMS / re-placing the original call.
 *   - Refunding or notifying end recipients.
 *   - Changing live webhook handlers / retry ladders / worker code.
 *
 * Usage:
 *   tsx scripts/remediate-twilio-failures.ts                # dry-run, all surfaces
 *   tsx scripts/remediate-twilio-failures.ts --sms          # dry-run, SMS only
 *   tsx scripts/remediate-twilio-failures.ts --sms --apply  # write
 *   tsx scripts/remediate-twilio-failures.ts --archive --apply --batch-size=20
 */
import { and, eq, isNull, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../server/db";
import { bindArrayParam } from "../server/utils/sqlArray";
import {
  callAnalysisJobs,
  systemSettings,
  twilioCalls,
  twilioMessages,
} from "@shared/schema";
// Mirror of MAX_ATTEMPTS in server/services/callArchivePipeline.ts. Duplicated
// here (rather than imported) so this script does not load the archive pipeline
// module and its external client initialization side effects. If the pipeline
// constant changes, update this value too — `scripts/lint-sql-array-bindings.ts`
// CI run will not catch the drift.
const MAX_ATTEMPTS = 6;

type Surface = "sms" | "calls" | "call-analysis" | "archive" | "voicemail";
const ALL_SURFACES: Surface[] = ["sms", "calls", "call-analysis", "archive", "voicemail"];
const KILL_SWITCH_KEY = "twilio_remediation_kill_switch";
const DEFAULT_BATCH = 50;
const MAX_BATCH = 500;
const STALE_HOURS = 1;
const ARCHIVE_LOCK_STALE_MIN = 30;

interface Args {
  surfaces: Surface[];
  apply: boolean;
  batchSize: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { surfaces: [], apply: false, batchSize: DEFAULT_BATCH };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else if (a === "--apply") out.apply = true;
    else if (a === "--sms") out.surfaces.push("sms");
    else if (a === "--calls") out.surfaces.push("calls");
    else if (a === "--call-analysis") out.surfaces.push("call-analysis");
    else if (a === "--archive") out.surfaces.push("archive");
    else if (a === "--voicemail") out.surfaces.push("voicemail");
    else if (a.startsWith("--batch-size=")) {
      const n = parseInt(a.slice("--batch-size=".length), 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_BATCH) {
        console.error(`--batch-size must be 1..${MAX_BATCH}`);
        process.exit(2);
      }
      out.batchSize = n;
    } else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (out.surfaces.length === 0) out.surfaces = [...ALL_SURFACES];
  return out;
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/remediate-twilio-failures.ts [flags]
Flags:
  --sms                   Remediate outbound twilio_messages
  --calls                 Remediate twilio_calls stuck in non-terminal status
  --call-analysis         Re-queue safely retryable call_analysis_jobs
  --archive               Reset stuck archive rows + re-queue transient failures
  --voicemail             Re-pull failed voicemail transcriptions
  --apply                 Actually write (default is dry-run)
  --batch-size=N          Bound per-surface batch (default ${DEFAULT_BATCH}, max ${MAX_BATCH})

Default surface set: every surface above.
Default mode: --dry-run (no writes).
Kill switch: set system_settings.${KILL_SWITCH_KEY} to a truthy value to refuse all writes.`);
}

async function checkKillSwitch(): Promise<void> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KILL_SWITCH_KEY));
  const v = (row?.value ?? "").trim().toLowerCase();
  if (v && v !== "false" && v !== "0" && v !== "off") {
    console.error(`[remediate] Kill switch ${KILL_SWITCH_KEY}="${row?.value}" — refusing to apply.`);
    process.exit(3);
  }
}

// In-flight re-check used by per-row write loops. The startup check guards
// the run from starting; this guard lets an operator toggle the kill switch
// mid-run to halt subsequent writes within the current invocation. Polled
// every KILL_SWITCH_POLL_ROWS writes to avoid hammering systemSettings.
const KILL_SWITCH_POLL_ROWS = 25;
async function assertKillSwitchLive(ctx: SurfaceCtx): Promise<void> {
  if (!ctx.args.apply) return;
  if (ctx.written === 0 || ctx.written % KILL_SWITCH_POLL_ROWS !== 0) return;
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KILL_SWITCH_KEY));
  const v = (row?.value ?? "").trim().toLowerCase();
  if (v && v !== "false" && v !== "0" && v !== "off") {
    console.error(`[remediate] Kill switch ${KILL_SWITCH_KEY}="${row?.value}" engaged mid-run after ${ctx.written} writes — halting surface ${ctx.tag}.`);
    process.exit(3);
  }
}

interface SurfaceCtx { args: Args; tag: string; written: number; }

function log(ctx: SurfaceCtx, msg: string): void {
  console.log(`[remediate:${ctx.tag}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Twilio client — only used to read existing resources, never to send /
// originate. Lazy-import so the script can be invoked with --dry-run in
// an environment that doesn't have Twilio configured (it will just skip
// surfaces that actually need the client).
// ---------------------------------------------------------------------------
let twilioClientCache: any = null;
async function getTwilioClient(): Promise<any | null> {
  if (twilioClientCache) return twilioClientCache;
  const [sid] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_account_sid"));
  const [tok] = await db.select().from(systemSettings).where(eq(systemSettings.key, "twilio_auth_token"));
  if (!sid?.value || !tok?.value) return null;
  const twilio = await import("twilio");
  twilioClientCache = (twilio.default ?? twilio)(sid.value, tok.value);
  return twilioClientCache;
}

function isTransientArchiveError(err: string | null | undefined): boolean {
  if (!err) return false;
  const s = err.toLowerCase();
  return (
    s.includes("timeout") || s.includes("timed out") ||
    s.includes("etimedout") || s.includes("econnreset") ||
    s.includes("eai_again") || s.includes("enotfound") ||
    s.includes("fetch failed") || s.includes("socket hang up") ||
    /\bhttp 5\d\d\b/.test(s) || s.includes("rate limit") ||
    s.includes("ratelimit") || s.includes("503") || s.includes("502") ||
    s.includes("recording metadata not yet present")
  );
}

// ---------------------------------------------------------------------------
// 1. SMS
// ---------------------------------------------------------------------------
async function remediateSms(ctx: SurfaceCtx): Promise<void> {
  log(ctx, "scanning outbound twilio_messages …");
  const rows = await db.select({
    id: twilioMessages.id,
    twilioSid: twilioMessages.twilioSid,
    status: twilioMessages.status,
    errorCode: twilioMessages.errorCode,
    errorMessage: twilioMessages.errorMessage,
    createdAt: twilioMessages.createdAt,
  }).from(twilioMessages).where(
    and(
      eq(twilioMessages.direction, "outbound"),
      isNotNull(twilioMessages.twilioSid),
      or(
        // Stale non-terminal — terminal status never arrived via webhook.
        and(
          sql`${twilioMessages.status} IN ('queued','sent','accepted','sending')`,
          sql`${twilioMessages.createdAt} < NOW() - INTERVAL '${sql.raw(String(STALE_HOURS))} hour'`,
        ),
        // Terminal failure missing diagnostic fields.
        and(
          sql`${twilioMessages.status} IN ('failed','undelivered')`,
          isNull(twilioMessages.errorCode),
        ),
      ),
    ),
  ).limit(ctx.args.batchSize);

  log(ctx, `candidates: ${rows.length}`);
  if (rows.length === 0) return;
  const client = await getTwilioClient();
  if (!client) {
    log(ctx, "Twilio client unavailable (account_sid/auth_token not configured) — skipping SMS surface.");
    return;
  }

  for (const r of rows) {
    try {
      const msg = await client.messages(r.twilioSid).fetch();
      const next = {
        status: String(msg.status || r.status),
        errorCode: msg.errorCode != null ? String(msg.errorCode) : r.errorCode,
        errorMessage: msg.errorMessage ?? r.errorMessage,
      };
      const changed =
        next.status !== r.status ||
        next.errorCode !== r.errorCode ||
        next.errorMessage !== r.errorMessage;
      if (!changed) { log(ctx, `sid=${r.twilioSid} no change`); continue; }
      log(ctx, `sid=${r.twilioSid} ${r.status}→${next.status} code=${next.errorCode ?? "null"}`);
      if (ctx.args.apply) {
        await db.update(twilioMessages).set({
          status: next.status,
          errorCode: next.errorCode,
          errorMessage: next.errorMessage,
          updatedAt: new Date(),
        }).where(eq(twilioMessages.id, r.id));
        ctx.written++;
        await assertKillSwitchLive(ctx);
      }
    } catch (err: any) {
      log(ctx, `sid=${r.twilioSid} ERR ${err?.code ?? ""} ${err?.message ?? err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Voice calls
// ---------------------------------------------------------------------------
async function remediateCalls(ctx: SurfaceCtx): Promise<void> {
  log(ctx, "scanning twilio_calls (stuck non-terminal + terminal-missing-duration) …");
  // Candidate set (a) stuck-non-terminal + (b) terminal-with-NULL-duration.
  const rows = await db.select({
    id: twilioCalls.id,
    twilioSid: twilioCalls.twilioSid,
    status: twilioCalls.status,
    duration: twilioCalls.duration,
    createdAt: twilioCalls.createdAt,
  }).from(twilioCalls).where(
    and(
      isNotNull(twilioCalls.twilioSid),
      or(
        // (a) stuck non-terminal past 1h
        and(
          sql`${twilioCalls.status} IN ('initiated','ringing','in-progress')`,
          sql`${twilioCalls.createdAt} < NOW() - INTERVAL '${sql.raw(String(STALE_HOURS))} hour'`,
        ),
        // (b) terminal with NULL duration
        and(
          sql`${twilioCalls.status} IN ('completed','failed','canceled','busy','no-answer')`,
          isNull(twilioCalls.duration),
        ),
      ),
    ),
  ).limit(ctx.args.batchSize);

  log(ctx, `candidates: ${rows.length}`);
  if (rows.length === 0) return;
  const client = await getTwilioClient();
  if (!client) { log(ctx, "Twilio client unavailable — skipping calls surface."); return; }

  for (const r of rows) {
    try {
      const call = await client.calls(r.twilioSid).fetch();
      const dur = call.duration != null ? parseInt(String(call.duration), 10) : null;
      const next = {
        status: String(call.status || r.status),
        duration: Number.isFinite(dur as number) ? (dur as number) : r.duration,
      };
      // Price visibility — see header comment about the deliberate schema gap.
      const priceLog = call.price != null
        ? ` price=${call.price}${call.priceUnit ? ` ${call.priceUnit}` : ""} (NOT persisted — no column)`
        : "";
      if (next.status === r.status && next.duration === r.duration) {
        log(ctx, `sid=${r.twilioSid} no change${priceLog}`);
        continue;
      }
      log(ctx, `sid=${r.twilioSid} ${r.status}→${next.status} dur=${next.duration ?? "null"}${priceLog}`);
      if (ctx.args.apply) {
        await db.update(twilioCalls).set({
          status: next.status,
          duration: next.duration,
          updatedAt: new Date(),
        }).where(eq(twilioCalls.id, r.id));
        ctx.written++;
        await assertKillSwitchLive(ctx);
      }
    } catch (err: any) {
      log(ctx, `sid=${r.twilioSid} ERR ${err?.code ?? ""} ${err?.message ?? err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Call analysis jobs
// ---------------------------------------------------------------------------
const RETRYABLE_ANALYSIS_REASONS = new Set(["download_failed", "cpu_starved", "ffmpeg_timeout", "whisper_timeout"]);

// In-script mirror of server/services/callAnalysis.ts::classifyFailure.
// Kept narrow on purpose: importing the live function would pull the
// whole call-analysis service (OpenAI, ffmpeg, …) into this script.
// The remediation report (audit §7 follow-up #2) tracks the leftover
// patterns this regex set still misses.
function classifyErrorMessage(msg: string | null | undefined): string {
  const s = String(msg || "").toLowerCase();
  if (!s) return "unknown";
  if (s.includes("ffmpeg") && s.includes("timed out")) return "ffmpeg_timeout";
  if (s.includes("ffmpeg") && (s.includes("exited with code") || s.includes("invalid"))) return "ffmpeg_invalid_audio";
  if (s.includes("whisper") && s.includes("timed out")) return "whisper_timeout";
  if (s.includes("timed out before whisper")) return "whisper_timeout";
  if (s.includes("timed out during audio processing")) return "cpu_starved";
  if (s.includes("failed to download audio")) return "download_failed";
  if (s.includes("file too large")) return "file_too_large";
  return "unknown";
}

async function remediateCallAnalysis(ctx: SurfaceCtx): Promise<void> {
  log(ctx, "scanning failed call_analysis_jobs (end-to-end: classify + re-queue) …");

  // Phase A: classify NULL failure_reason rows in-script.
  const nullRows = await db.execute(sql`
    SELECT analysis_id, error_message
    FROM call_analysis_jobs
    WHERE status='failed' AND failure_reason IS NULL
    LIMIT ${ctx.args.batchSize}
  `);
  const nullArr = (nullRows.rows ?? []) as any[];
  log(ctx, `phase A: NULL failure_reason candidates: ${nullArr.length}`);
  const classified: { id: string; reason: string }[] = nullArr.map((r) => ({
    id: r.analysis_id,
    reason: classifyErrorMessage(r.error_message),
  }));
  // Tally for visibility.
  const tally: Record<string, number> = {};
  for (const c of classified) tally[c.reason] = (tally[c.reason] ?? 0) + 1;
  for (const [k, v] of Object.entries(tally)) log(ctx, `phase A class tally: ${k}=${v}`);
  if (ctx.args.apply && classified.length) {
    // Per-id update so each row gets its own typed reason. Bounded by batch size.
    for (const c of classified) {
      await db.execute(sql`
        UPDATE call_analysis_jobs
        SET failure_reason = ${c.reason}
        WHERE analysis_id = ${c.id} AND status='failed' AND failure_reason IS NULL
      `);
      ctx.written++;
      await assertKillSwitchLive(ctx);
    }
  }

  // Phase B: re-queue retryable + audio-still-present.
  const retryArr = await db.select({
    analysisId: callAnalysisJobs.analysisId,
    failureReason: callAnalysisJobs.failureReason,
    audioUrl: callAnalysisJobs.audioUrl,
    attemptCount: callAnalysisJobs.attemptCount,
  }).from(callAnalysisJobs).where(
    and(
      eq(callAnalysisJobs.status, "failed"),
      isNotNull(callAnalysisJobs.failureReason),
      sql`${callAnalysisJobs.failureReason} = ANY(${bindArrayParam(Array.from(RETRYABLE_ANALYSIS_REASONS), "text")})`,
      isNotNull(callAnalysisJobs.audioUrl),
    ),
  ).limit(ctx.args.batchSize);
  log(ctx, `phase B: retryable + audio present candidates: ${retryArr.length}`);

  const blocked = await db.execute(sql`
    SELECT failure_reason, COUNT(*)::int AS n FROM call_analysis_jobs
    WHERE status='failed' AND failure_reason IN ('ffmpeg_invalid_audio','file_too_large')
    GROUP BY 1 ORDER BY n DESC
  `);
  for (const b of (blocked.rows ?? []) as any[]) {
    log(ctx, `non-retryable reported only: reason=${b.failure_reason} n=${b.n}`);
  }

  for (const r of retryArr) {
    log(ctx, `phase B re-queue analysisId=${r.analysisId} reason=${r.failureReason} attempts=${r.attemptCount}`);
    if (ctx.args.apply) {
      await db.update(callAnalysisJobs).set({
        status: "queued",
        errorMessage: null,
        failureReason: null,
        resultJson: null,
        attemptCount: 0,
      }).where(and(eq(callAnalysisJobs.analysisId, r.analysisId), eq(callAnalysisJobs.status, "failed")));
      ctx.written++;
      await assertKillSwitchLive(ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Recording archive
// ---------------------------------------------------------------------------
async function remediateArchive(ctx: SurfaceCtx): Promise<void> {
  log(ctx, "scanning twilio_calls.archive_* …");

  // 4a. Stuck 'processing' past lock TTL — reset to 'queued'.
  const stuckProcessing = await db.execute(sql`
    SELECT id, twilio_sid, archive_attempts, archive_leased_at
    FROM twilio_calls
    WHERE archive_status='processing'
      AND archive_leased_at IS NOT NULL
      AND archive_leased_at < NOW() - INTERVAL '${sql.raw(String(ARCHIVE_LOCK_STALE_MIN))} minutes'
    ORDER BY archive_leased_at ASC
    LIMIT ${ctx.args.batchSize}
  `);
  const stuckRows = (stuckProcessing.rows ?? []) as any[];
  log(ctx, `stuck 'processing' candidates: ${stuckRows.length}`);
  for (const r of stuckRows) {
    log(ctx, `id=${r.id} sid=${r.twilio_sid} leased_at=${r.archive_leased_at} → reset to queued`);
  }
  if (ctx.args.apply && stuckRows.length) {
    const ids = stuckRows.map((r) => r.id);
    const result = await db.execute(sql`
      UPDATE twilio_calls
      SET archive_status='queued',
          archive_locked_until=NULL,
          archive_leased_at=NULL,
          archive_next_attempt_at=NOW(),
          updated_at=NOW()
      WHERE id = ANY(${bindArrayParam(ids, "text")}) AND archive_status='processing'
    `);
    ctx.written += result.rowCount ?? 0;
  }

  // 4b. 'failed' with attempts < MAX_ATTEMPTS and transient-looking error — re-queue.
  const transient = await db.execute(sql`
    SELECT id, twilio_sid, archive_attempts, LEFT(archive_last_error, 100) AS err
    FROM twilio_calls
    WHERE archive_status='failed'
      AND COALESCE(archive_attempts, 0) < ${MAX_ATTEMPTS}
    ORDER BY created_at ASC
    LIMIT ${ctx.args.batchSize}
  `);
  const transRows = ((transient.rows ?? []) as any[]).filter((r) => isTransientArchiveError(r.err));
  log(ctx, `'failed' (attempts<${MAX_ATTEMPTS}) transient candidates: ${transRows.length}`);
  for (const r of transRows) {
    log(ctx, `id=${r.id} sid=${r.twilio_sid} attempts=${r.archive_attempts} err=${JSON.stringify(r.err)} → re-queue`);
  }
  if (ctx.args.apply && transRows.length) {
    const ids = transRows.map((r) => r.id);
    const result = await db.execute(sql`
      UPDATE twilio_calls
      SET archive_status='queued',
          archive_locked_until=NULL,
          archive_leased_at=NULL,
          archive_last_error=NULL,
          archive_next_attempt_at=NOW(),
          updated_at=NOW()
      WHERE id = ANY(${bindArrayParam(ids, "text")}) AND archive_status='failed'
    `);
    ctx.written += result.rowCount ?? 0;
  }

  // 4c. 'failed' attempts==MAX and recording-not-present pattern — verify with Twilio,
  // mark 'skipped' if Twilio also has no recording. Pure DB inspection here; the
  // Twilio probe is best-effort and only used to choose between 'skipped' and 'queued'.
  const exhausted = await db.execute(sql`
    SELECT id, twilio_sid, recording_sid, recording_url, recording_status, archive_last_error
    FROM twilio_calls
    WHERE archive_status='failed'
      AND COALESCE(archive_attempts, 0) >= ${MAX_ATTEMPTS}
      AND recording_url IS NULL
    ORDER BY created_at ASC
    LIMIT ${ctx.args.batchSize}
  `);
  const exhaustedRows = (exhausted.rows ?? []) as any[];
  log(ctx, `'failed' max-attempts + no-recording candidates: ${exhaustedRows.length}`);
  const client = await getTwilioClient();
  for (const r of exhaustedRows) {
    let twilioHas = false;
    if (client && r.twilio_sid) {
      try {
        const recs = await client.recordings.list({ callSid: r.twilio_sid, limit: 1 });
        twilioHas = Array.isArray(recs) && recs.length > 0;
      } catch (err: any) {
        log(ctx, `id=${r.id} sid=${r.twilio_sid} Twilio probe ERR ${err?.message ?? err} — leaving as 'failed'`);
        continue;
      }
    }
    if (twilioHas) {
      log(ctx, `id=${r.id} sid=${r.twilio_sid} Twilio still has recording → re-queue`);
      if (ctx.args.apply) {
        await db.execute(sql`
          UPDATE twilio_calls
          SET archive_status='queued',
              archive_attempts=0,
              archive_locked_until=NULL,
              archive_leased_at=NULL,
              archive_last_error=NULL,
              archive_next_attempt_at=NOW(),
              updated_at=NOW()
          WHERE id = ${r.id} AND archive_status='failed'
        `);
        ctx.written++;
        await assertKillSwitchLive(ctx);
      }
    } else {
      log(ctx, `id=${r.id} sid=${r.twilio_sid} no recording at Twilio → mark 'skipped'`);
      if (ctx.args.apply) {
        await db.execute(sql`
          UPDATE twilio_calls
          SET archive_status='skipped',
              archive_last_error=COALESCE(archive_last_error, '') || ' [remediate: no recording at Twilio]',
              archive_locked_until=NULL,
              updated_at=NOW()
          WHERE id = ${r.id} AND archive_status='failed'
        `);
        ctx.written++;
        await assertKillSwitchLive(ctx);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Voicemail transcription re-pull
// ---------------------------------------------------------------------------
async function remediateVoicemail(ctx: SurfaceCtx): Promise<void> {
  log(ctx, "scanning twilio_calls.voicemail_* failed-transcription rows …");
  const rows = await db.execute(sql`
    SELECT id, twilio_sid, voicemail_recording_sid, voicemail_recording_url
    FROM twilio_calls
    WHERE voicemail_transcription_status='failed'
      AND voicemail_recording_url IS NOT NULL
      AND voicemail_recording_sid IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ${ctx.args.batchSize}
  `);
  const candidates = (rows.rows ?? []) as any[];
  log(ctx, `candidates: ${candidates.length}`);
  if (candidates.length === 0) return;
  const client = await getTwilioClient();
  if (!client) { log(ctx, "Twilio client unavailable — skipping voicemail surface."); return; }

  for (const r of candidates) {
    try {
      const txs = await client.recordings(r.voicemail_recording_sid).transcriptions.list({ limit: 1 });
      const t = Array.isArray(txs) && txs.length > 0 ? txs[0] : null;
      if (!t || !t.transcriptionText) {
        log(ctx, `id=${r.id} sid=${r.voicemail_recording_sid} no transcription at Twilio — leaving as 'failed'`);
        continue;
      }
      log(ctx, `id=${r.id} sid=${r.voicemail_recording_sid} re-pull transcription (${t.transcriptionText.length} chars)`);
      if (ctx.args.apply) {
        await db.execute(sql`
          UPDATE twilio_calls
          SET voicemail_transcription_text=${t.transcriptionText},
              voicemail_transcription_status='completed',
              updated_at=NOW()
          WHERE id = ${r.id}
        `);
        ctx.written++;
        await assertKillSwitchLive(ctx);
      }
    } catch (err: any) {
      log(ctx, `id=${r.id} ERR ${err?.code ?? ""} ${err?.message ?? err}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`[remediate] mode=${args.apply ? "APPLY" : "DRY-RUN"} batch=${args.batchSize} surfaces=${args.surfaces.join(",")}`);
  if (args.apply) {
    await checkKillSwitch();
  } else {
    console.log("[remediate] dry-run — no writes. Re-run with --apply when ready.");
  }

  const totals: Record<string, number> = {};
  for (const surface of args.surfaces) {
    const ctx: SurfaceCtx = { args, tag: surface, written: 0 };
    try {
      if (surface === "sms") await remediateSms(ctx);
      else if (surface === "calls") await remediateCalls(ctx);
      else if (surface === "call-analysis") await remediateCallAnalysis(ctx);
      else if (surface === "archive") await remediateArchive(ctx);
      else if (surface === "voicemail") await remediateVoicemail(ctx);
    } catch (err: any) {
      console.error(`[remediate:${surface}] Fatal: ${err?.stack || err?.message || err}`);
    }
    totals[surface] = ctx.written;
  }

  console.log("\n[remediate] Summary:");
  for (const s of args.surfaces) {
    console.log(`  ${s}: writes=${totals[s] ?? 0}${args.apply ? "" : " (dry-run)"}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[remediate] Fatal: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
