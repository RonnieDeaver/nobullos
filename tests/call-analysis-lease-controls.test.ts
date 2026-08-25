/* test-registration
{
  "name": "Call-analysis claim/lease/kill-switch controls (workers parity E-F01/E-F02/E-F05)",
  "regression": true,
  "sweepOnlyReason": "DB-heavy focused worker-reliability suite (claim races, lease-guarded finalization, stale recovery) in the style of the other custom-table worker suites; runs in the full suite and the nightly --regression sweep rather than the routine TEST_SMOKE gate.",
  "tier": "small"
}
test-registration */
/**
 * Workers/queues parity (E-F01/E-F02/E-F05) — focused suite for the
 * call-analysis custom-table pipeline's new operational controls:
 *
 *  - atomic claim (claimNextQueuedJob / processJob) with in-row lease
 *    (locked_until/leased_at) and attempt-epoch bump;
 *  - one owner under concurrent claims (FOR UPDATE SKIP LOCKED);
 *  - unexpired leases are not stolen; expired leases are reclaimed by
 *    recoverStaleJobs (requeue under the retry cap, typed cpu_starved
 *    terminal failure past it);
 *  - a former owner cannot finalize (complete OR fail) after lease loss
 *    (attempt-epoch guard);
 *  - processing windows sourced from the canonical queueMaxProcessing
 *    lanes (override changes recovery behavior without code changes);
 *  - kill switch stops new claims (processNextJob) and clears for resume;
 *  - typed failure-reason behavior preserved (classifyFailure);
 *  - ffmpeg transcode contract (Task #4144): convertToWav spawns the
 *    PATH-resolved "ffmpeg" (Nix binary; bundled-binary dep removed) with the
 *    unchanged argument/naming/timeout contract, and a missing PATH
 *    binary rejects loudly through the classified ffmpeg_* taxonomy —
 *    never a silent skip or a bundled-binary fallback.
 *
 * Hermetic: every row carries a unique random external_id/idempotency_key
 * and is deleted in finally; system-setting writes are pinned and
 * restored; the kill switch is restored to OFF.
 */
// fs-scan-fixture-only -- the ffmpeg transcode section (10) reads only the
// WAV/AIFF artifacts it synthesizes under os.tmpdir(); this suite performs no
// repo-source fs reads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sql } from "drizzle-orm";
import { workerDb } from "../server/db";
import { storage } from "../server/storage";
import {
  claimNextQueuedJob,
  processJob,
  processNextJob,
  recoverStaleJobs,
  finalizeJobComplete,
  finalizeJobFailed,
  classifyFailure,
  convertToWav,
  ffmpegTimeoutForOutputSeconds,
} from "../server/services/callAnalysis";
import { setKillSwitch } from "../server/services/killSwitches";
import {
  QUEUE_MAX_PROCESSING_KEY,
  invalidateQueueMaxProcessingCache,
  getMaxProcessingMs,
} from "../server/services/queueMaxProcessing";

const MARKER = `t_ca_lease_${process.pid}_${Date.now()}`;

interface JobRow {
  analysis_id: string;
  status: string;
  attempt_count: number | null;
  locked_until: Date | null;
  leased_at: Date | null;
  started_at: Date | null;
  error_message: string | null;
  failure_reason: string | null;
  result_json: unknown;
  lane: string;
}

async function insertJob(opts: {
  status?: string;
  lane?: string;
  attemptCount?: number;
  lockedUntilOffsetMs?: number | null; // relative to now; null = NULL column
  leasedAtOffsetMs?: number | null;
  startedAtOffsetMs?: number | null;
  createdAtOffsetMs?: number;
}): Promise<string> {
  const id = randomUUID();
  const status = opts.status ?? "queued";
  const lane = opts.lane ?? "normal";
  const attempts = opts.attemptCount ?? 0;
  const iv = (ms: number | null | undefined) =>
    ms == null ? sql`NULL` : sql`NOW() + (${Math.round(ms / 1000)} || ' seconds')::interval`;
  await workerDb.execute(sql`
    INSERT INTO call_analysis_jobs
      (analysis_id, external_id, idempotency_key, status, lane, attempt_count,
       locked_until, leased_at, started_at, created_at)
    VALUES
      (${id}, ${`${MARKER}_ext_${id.slice(0, 8)}`}, ${`${MARKER}_idem_${id}`},
       ${status}, ${lane}, ${attempts},
       ${iv(opts.lockedUntilOffsetMs)}, ${iv(opts.leasedAtOffsetMs)}, ${iv(opts.startedAtOffsetMs)},
       NOW() + (${Math.round((opts.createdAtOffsetMs ?? 0) / 1000)} || ' seconds')::interval)
  `);
  return id;
}

async function getRow(id: string): Promise<JobRow> {
  const r = await workerDb.execute(sql`
    SELECT analysis_id, status, attempt_count, locked_until, leased_at, started_at,
           error_message, failure_reason, result_json, lane
    FROM call_analysis_jobs WHERE analysis_id = ${id}
  `);
  const row = r.rows?.[0] as unknown as JobRow | undefined;
  assert.ok(row, `job row ${id} should exist`);
  return row;
}

async function cleanup(): Promise<void> {
  await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE external_id LIKE ${`${MARKER}%`}`);
  try { await storage.deleteSystemSetting(QUEUE_MAX_PROCESSING_KEY); } catch {}
  try { await storage.deleteSystemSetting("kill_switch_call_analysis"); } catch {}
  invalidateQueueMaxProcessingCache();
}

const RESULT_FIXTURE = {
  classification: "human",
  pickupTimeSeconds: 2,
  evidence: "test fixture",
} as any;

/**
 * Minimal RIFF/WAVE reader for the Task #4144 transcode assertions:
 * returns the fmt-chunk fields plus the data-chunk byte length. Walks
 * the chunk list so an ffmpeg-inserted LIST/INFO chunk cannot break
 * fixed offsets.
 */
function parseWavHeader(buf: Buffer): {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
} {
  assert.equal(buf.toString("ascii", 0, 4), "RIFF", "RIFF magic");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE", "WAVE magic");
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataBytes = -1;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === "data") {
      dataBytes = size;
    }
    off += 8 + size + (size % 2);
  }
  assert.ok(fmt, "fmt chunk present");
  assert.ok(dataBytes >= 0, "data chunk present");
  return { ...fmt!, dataBytes };
}

async function main(): Promise<void> {
  // Pre-existing rows could satisfy the claim's ORDER BY before ours.
  // The hermetic per-run DB starts empty, but a SIGKILL'd earlier suite
  // in the same run can leave litter — prune claimable rows first.
  await cleanup();
  await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE status IN ('queued', 'processing')`);

  try {
    // ------------------------------------------------------------------
    // 1. Atomic claim: claimNextQueuedJob stamps lease + bumps epoch.
    // ------------------------------------------------------------------
    {
      const id = await insertJob({});
      const claimed = await claimNextQueuedJob("normal");
      assert.ok(claimed, "claim should return the queued job");
      assert.equal(claimed!.analysisId, id);
      const row = await getRow(id);
      assert.equal(row.status, "processing");
      assert.equal(Number(row.attempt_count), 1, "claim bumps the attempt epoch");
      assert.ok(row.locked_until, "claim stamps locked_until");
      assert.ok(row.leased_at, "claim stamps leased_at");
      assert.ok(
        new Date(row.locked_until!).getTime() > Date.now(),
        "lease expiry is in the future",
      );
      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id = ${id}`);
      console.log("PASS: atomic claim stamps lease + epoch");
    }

    // ------------------------------------------------------------------
    // 2. Two concurrent claims, one queued row -> exactly one owner.
    // ------------------------------------------------------------------
    {
      const id = await insertJob({});
      const [a, b] = await Promise.all([
        claimNextQueuedJob("normal"),
        claimNextQueuedJob("normal"),
      ]);
      const winners = [a, b].filter(Boolean);
      assert.equal(winners.length, 1, `exactly one concurrent claim wins (got ${winners.length})`);
      assert.equal(winners[0]!.analysisId, id);
      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id = ${id}`);
      console.log("PASS: concurrent claims produce one owner");
    }

    // ------------------------------------------------------------------
    // 3. Unexpired lease is not stolen: not claimable, not recovered.
    // ------------------------------------------------------------------
    {
      const id = await insertJob({
        status: "processing",
        attemptCount: 1,
        lockedUntilOffsetMs: 5 * 60_000,
        leasedAtOffsetMs: -60_000,
        startedAtOffsetMs: -60_000,
      });
      const claimed = await claimNextQueuedJob("normal");
      assert.equal(claimed, undefined, "a processing row is not claimable");
      await recoverStaleJobs();
      const row = await getRow(id);
      assert.equal(row.status, "processing", "unexpired lease survives recovery");
      assert.ok(row.locked_until, "lease column untouched");
      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id = ${id}`);
      console.log("PASS: unexpired lease cannot be stolen");
    }

    // ------------------------------------------------------------------
    // 4. Expired lease reclaim: attempts<2 -> requeued (lease cleared);
    //    attempts>=2 -> terminal failed with typed cpu_starved reason.
    // ------------------------------------------------------------------
    {
      const retryable = await insertJob({
        status: "processing",
        attemptCount: 1,
        lockedUntilOffsetMs: -60_000,
        leasedAtOffsetMs: -10 * 60_000,
        startedAtOffsetMs: -10 * 60_000,
      });
      const exhausted = await insertJob({
        status: "processing",
        attemptCount: 2,
        lockedUntilOffsetMs: -60_000,
        leasedAtOffsetMs: -10 * 60_000,
        startedAtOffsetMs: -10 * 60_000,
      });
      await recoverStaleJobs();
      const r1 = await getRow(retryable);
      assert.equal(r1.status, "queued", "expired lease under the retry cap requeues");
      assert.equal(r1.locked_until, null, "requeue releases the lease");
      assert.equal(r1.leased_at, null, "requeue clears leased_at");
      assert.equal(r1.error_message, null);
      const r2 = await getRow(exhausted);
      assert.equal(r2.status, "failed", "expired lease past the retry cap fails terminally");
      assert.equal(r2.failure_reason, "cpu_starved", "typed stale-reclaim reason");
      assert.match(String(r2.error_message), /timed out/i);
      assert.equal(r2.locked_until, null, "terminal row carries no lock");
      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id IN (${retryable}, ${exhausted})`);
      console.log("PASS: expired-lease reclaim (requeue + typed terminal failure)");
    }

    // ------------------------------------------------------------------
    // 5. Legacy NULL-lease rows: staleness cutoff comes from the CANONICAL
    //    queueMaxProcessing lane, not a hard-coded constant (E-F02).
    // ------------------------------------------------------------------
    {
      assert.equal(await getMaxProcessingMs("call_analysis"), 5 * 60_000, "default lane ceiling = legacy 5min");
      assert.equal(await getMaxProcessingMs("call_analysis_slow"), 16 * 60_000, "default slow ceiling = legacy 16min");

      // 2-minute-old legacy row: NOT stale under the default 5min cap.
      const id = await insertJob({
        status: "processing",
        attemptCount: 1,
        lockedUntilOffsetMs: null,
        leasedAtOffsetMs: null,
        startedAtOffsetMs: -2 * 60_000,
      });
      await recoverStaleJobs();
      assert.equal((await getRow(id)).status, "processing", "2min-old legacy row not stale at default 5min cap");

      // Override the lane ceiling down to 30s (the module minimum) — the
      // SAME row is now past the cap and gets recovered. Proves the
      // recovery window is sourced from queueMaxProcessing.
      await storage.setSystemSetting(QUEUE_MAX_PROCESSING_KEY, JSON.stringify({ call_analysis: 30_000 }), "test");
      invalidateQueueMaxProcessingCache();
      assert.equal(await getMaxProcessingMs("call_analysis"), 30_000, "override visible after cache invalidation");
      await recoverStaleJobs();
      const row = await getRow(id);
      assert.equal(row.status, "queued", "same row recovered once the canonical lane ceiling shrank");
      await storage.deleteSystemSetting(QUEUE_MAX_PROCESSING_KEY);
      invalidateQueueMaxProcessingCache();
      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id = ${id}`);
      console.log("PASS: staleness window sourced from canonical queueMaxProcessing lanes");
    }

    // ------------------------------------------------------------------
    // 6. Former owner cannot finalize after lease loss (epoch guard).
    // ------------------------------------------------------------------
    {
      const id = await insertJob({});
      const claimed = await claimNextQueuedJob("normal");
      assert.equal(claimed!.analysisId, id);
      const myEpoch = claimed!.attemptCount ?? 0;
      // Simulate stale recovery + re-claim by another worker: epoch moves on.
      await workerDb.execute(sql`
        UPDATE call_analysis_jobs
        SET attempt_count = ${myEpoch + 1}, leased_at = NOW(), locked_until = NOW() + interval '2 minutes'
        WHERE analysis_id = ${id}
      `);
      const completeOk = await finalizeJobComplete(id, myEpoch, RESULT_FIXTURE);
      assert.equal(completeOk, false, "stale owner cannot complete");
      const failOk = await finalizeJobFailed(id, myEpoch, new Error("stale failure attempt"));
      assert.equal(failOk, false, "stale owner cannot fail the row either");
      const row = await getRow(id);
      assert.equal(row.status, "processing", "new owner's in-flight state untouched");
      assert.equal(row.result_json, null);
      assert.equal(row.error_message, null);

      // The CURRENT owner (new epoch) finalizes normally — business
      // output (result_json write + terminal status) unchanged.
      const currentOk = await finalizeJobComplete(id, myEpoch + 1, RESULT_FIXTURE);
      assert.equal(currentOk, true, "current owner completes");
      const done = await getRow(id);
      assert.equal(done.status, "complete");
      assert.ok(done.result_json, "analysis result persisted exactly as before");
      assert.equal(done.locked_until, null, "terminal write releases the lease");
      assert.equal(done.leased_at, null);
      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id = ${id}`);
      console.log("PASS: epoch guard blocks stale finalization; current owner unaffected");
    }

    // ------------------------------------------------------------------
    // 7. Typed failure reasons preserved on the failure path.
    // ------------------------------------------------------------------
    {
      const id = await insertJob({});
      const claimed = await claimNextQueuedJob("normal");
      const epoch = claimed!.attemptCount ?? 0;
      const taggedErr: any = new Error("download exploded");
      taggedErr.failureReason = "download_failed";
      assert.equal(await finalizeJobFailed(id, epoch, taggedErr), true);
      const row = await getRow(id);
      assert.equal(row.status, "failed");
      assert.equal(row.failure_reason, "download_failed", "tagged reason honored");
      assert.equal(row.error_message, "download exploded", "human-readable detail preserved");
      assert.equal(row.locked_until, null);

      // Classifier mapping (pure): known classes + unknown fallback.
      assert.equal(classifyFailure(new Error("ffmpeg timed out after 60s")), "ffmpeg_timeout");
      assert.equal(classifyFailure(new Error("Whisper timed out")), "whisper_timeout");
      assert.equal(classifyFailure(new Error("File too large: 300 MB")), "file_too_large");
      assert.equal(classifyFailure(new Error("completely novel explosion")), "unknown");
      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id = ${id}`);
      console.log("PASS: typed failure reasons (tagged + classified + unknown fallback)");
    }

    // ------------------------------------------------------------------
    // 8. processJob (claim-by-id) refuses non-queued rows.
    // ------------------------------------------------------------------
    {
      const id = await insertJob({ status: "processing", attemptCount: 1, lockedUntilOffsetMs: 2 * 60_000, leasedAtOffsetMs: -1000 });
      await assert.rejects(
        () => processJob(id),
        /not claimable/,
        "processJob must refuse a row another worker owns",
      );
      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id = ${id}`);
      console.log("PASS: claim-by-id refuses non-queued rows");
    }

    // ------------------------------------------------------------------
    // 9. Kill switch: ON blocks new claims via the poller path; OFF
    //    resumes claiming.
    // ------------------------------------------------------------------
    {
      const id = await insertJob({});
      await setKillSwitch("call_analysis", true, "test");
      try {
        const ran = await processNextJob("normal");
        assert.equal(ran, false, "poller refuses to claim while the switch is on");
        const row = await getRow(id);
        assert.equal(row.status, "queued", "queued row untouched during operator stop");
        assert.equal(Number(row.attempt_count ?? 0), 0, "no attempt burned");
      } finally {
        await setKillSwitch("call_analysis", false, "test");
      }
      // Switch off -> claiming resumes (claim directly; processNextJob
      // would run the full analysis pipeline).
      const claimed = await claimNextQueuedJob("normal");
      assert.equal(claimed?.analysisId, id, "claiming resumes after the switch clears");
      await workerDb.execute(sql`DELETE FROM call_analysis_jobs WHERE analysis_id = ${id}`);
      console.log("PASS: kill switch gates new claims and clears for resume");
    }

    // ------------------------------------------------------------------
    // 10. FFmpeg transcode contract (Task #4144): PATH-resolved binary,
    //     unchanged argument/naming behavior, classified spawn failure.
    //     The static-binary npm dep is removed — convertToWav must spawn the Nix/PATH
    //     "ffmpeg" (same strategy as ffprobe and every other media
    //     consumer), and a missing binary must reject loudly through the
    //     existing ffmpeg_* failure taxonomy, never silently skip.
    // ------------------------------------------------------------------
    {
      // Timeout buckets (Task #1049 contract) — unchanged by the binary
      // resolution switch.
      assert.equal(ffmpegTimeoutForOutputSeconds(), 90_000);
      assert.equal(ffmpegTimeoutForOutputSeconds(90), 90_000);
      assert.equal(ffmpegTimeoutForOutputSeconds(180), 180_000);
      assert.equal(ffmpegTimeoutForOutputSeconds(300), 300_000);
      assert.equal(ffmpegTimeoutForOutputSeconds(301), 600_000);

      const tmpBase = path.join(os.tmpdir(), `${MARKER}_ffmpeg`);
      const inputPath = `${tmpBase}_in.aif`;
      const fullOut = `${tmpBase}_in.wav`;
      const clippedOut = `${tmpBase}_in_1s.wav`;
      const savedPath = process.env.PATH ?? "";
      try {
        // Synthesize a 2 s 44.1 kHz stereo tone with the PATH ffmpeg —
        // doubles as proof the Nix binary is present in this environment.
        await new Promise<void>((resolve, reject) => {
          const synth = spawn("ffmpeg", [
            "-y", "-f", "lavfi",
            "-i", "sine=frequency=440:sample_rate=44100:duration=2",
            "-ac", "2", inputPath,
          ]);
          const t = setTimeout(() => {
            synth.kill("SIGKILL");
            reject(new Error("fixture synth timed out"));
          }, 60_000);
          synth.on("error", (e) => { clearTimeout(t); reject(e); });
          synth.on("close", (code) => {
            clearTimeout(t);
            if (code === 0) resolve();
            else reject(new Error(`fixture synth exited ${code}`));
          });
        });

        // (a) Full conversion: output lands next to the input with the
        // exact legacy naming, as 16 kHz mono s16le PCM — i.e. the
        // '-ar 16000 -ac 1 -acodec pcm_s16le' argument list behaved.
        const out1 = await convertToWav(inputPath);
        assert.equal(out1, fullOut, "output naming contract unchanged");
        const wav1 = parseWavHeader(fs.readFileSync(out1)); // fs-scan-inputs-ignore -- reads the WAV convertToWav just wrote under os.tmpdir(); never repo source
        assert.equal(wav1.format, 1, "PCM output (pcm_s16le)");
        assert.equal(wav1.channels, 1, "-ac 1 preserved");
        assert.equal(wav1.sampleRate, 16000, "-ar 16000 preserved");
        assert.equal(wav1.bitsPerSample, 16, "s16le preserved");
        assert.ok(
          wav1.dataBytes > 55_000 && wav1.dataBytes < 75_000,
          `~2s of 16k mono s16 audio expected, got ${wav1.dataBytes} bytes`,
        );

        // (b) maxSeconds path: '-t 1' truncation + '_1s' output suffix;
        // pre-create the output with junk to prove '-y' still overwrites
        // without prompting.
        fs.writeFileSync(clippedOut, "junk that -y must overwrite");
        const out2 = await convertToWav(inputPath, 1);
        assert.equal(out2, clippedOut, "maxSeconds suffix naming unchanged");
        const wav2 = parseWavHeader(fs.readFileSync(out2)); // fs-scan-inputs-ignore -- reads the WAV convertToWav just wrote under os.tmpdir(); never repo source
        assert.equal(wav2.sampleRate, 16000);
        assert.equal(wav2.channels, 1);
        assert.ok(
          wav2.dataBytes > 24_000 && wav2.dataBytes < 40_000,
          `-t 1 must clip to ~1s (~32000 bytes), got ${wav2.dataBytes}`,
        );

        // (c) Missing PATH binary: spawn ENOENT must reject loudly with
        // the classified ffmpeg taxonomy (existing 'error' handler) —
        // not hang, not silently succeed. Emptying PATH also proves the
        // binary is resolved BY NAME through PATH: a bundled absolute
        // path (the removed bundled-binary strategy) would still spawn.
        process.env.PATH = "/nonexistent_t4144";
        await assert.rejects(
          () => convertToWav(inputPath, 1),
          (err: any) => {
            assert.equal(err.code, "ENOENT", "spawn failure surfaces ENOENT");
            assert.equal(
              err.failureReason,
              "ffmpeg_invalid_audio",
              "classified through the existing ffmpeg failure taxonomy",
            );
            assert.match(String(err.message), /ffmpeg/i, "diagnostic names the binary");
            return true;
          },
        );
      } finally {
        process.env.PATH = savedPath;
        for (const f of [inputPath, fullOut, clippedOut]) {
          try { fs.unlinkSync(f); } catch {}
        }
      }
      console.log("PASS: PATH ffmpeg transcode contract + classified ENOENT failure");
    }

    console.log("ALL call-analysis lease-control tests passed");
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("FAIL:", err);
    process.exit(1);
  },
);
