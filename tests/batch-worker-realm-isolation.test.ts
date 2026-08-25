/* test-registration
{
  "name": "Batch child realm isolation — a crashing/leaky jsdom suite cannot poison the next suite (Task #4652)",
  "regression": true,
  "smoke": true,
  "smokeReason": "DB-free, fast (<15s); guards the batched-runner cross-suite jsdom realm contamination class (detachEvent ghost failures) that corrupts sibling verdicts and journal stats.",
   "scanPaths": [
     "tests/run-all-worker.mjs",
     "server/services/moduleStateReset.ts",
     "tests/fixtures/batch-realm-leak"
   ],
  "tier": "small"
}
test-registration */
/**
 * Task #4652 — Stop one crashing test from making unrelated tests look
 * broken in the same batched run.
 *
 * Drives tests/run-all-worker.mjs exactly the way tests/run-all.ts does
 * (IPC `run` messages, one suite at a time) with synthetic fixtures:
 *
 *   1. Crash case: suite A installs a global focus listener bound to its own
 *      JSDOM realm and crashes at import. The worker must report a non-zero
 *      result (parent contract: recycle), and suite B run in a FRESH worker
 *      must pass — the "done looks like" scenario from the task.
 *   2. Quiet-leak case: suite A settles GREEN but leaves its realm installed
 *      on globalThis. Suite B dispatched to the SAME worker must still pass —
 *      pre-fix it inherited A's dead window/document and failed.
 *   3. Straggler case: suite A settles green, then crashes asynchronously.
 *      The worker must hard-exit (poisoned process) instead of hosting the
 *      next suite; the parent's `!child.connected` check then respawns.
 *   4. Task #4672 — straggler AFTER the next suite is dispatched: suite A
 *      settles green, the parent immediately dispatches suite B (inside the
 *      worker's quiet window), then A's straggler fires. The worker must
 *      attribute it to A — sending `predecessor-straggler` for B's seq (so
 *      the parent re-dispatches B in a fresh child, no failure recorded for
 *      the innocent suite) — and then hard-exit. Pre-fix, B was failed with
 *      recycle=true.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const WORKER = resolve(process.cwd(), "tests/run-all-worker.mjs");
const FIX = (f: string) => resolve(process.cwd(), "tests/fixtures/batch-realm-leak", f);

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`✓ ${name}`);
  } else {
    failures++;
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function spawnWorker(extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, [WORKER], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, NODE_ENV: "test", RUN_ALL_BATCH_WORKER: "1", ...extraEnv },
  });
}

function runSuite(
  worker: ChildProcess,
  file: string,
  seq: number,
  timeoutMs = 20_000,
): Promise<
  { code: number; recycle: boolean; resourcePressure: boolean } | "worker-exited" | "timeout"
> {
  return new Promise((resolveP) => {
    const timer = setTimeout(() => {
      cleanup();
      resolveP("timeout");
    }, timeoutMs);
    const onMessage = (msg: any) => {
      if (!msg || msg.type !== "result" || msg.seq !== seq) return;
      cleanup();
      resolveP({
        code: typeof msg.code === "number" ? msg.code : 1,
        recycle: msg.recycle === true,
        resourcePressure: msg.resourcePressure === true,
      });
    };
    const onExit = () => {
      cleanup();
      resolveP("worker-exited");
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("exit", onExit);
    worker.send({ type: "run", file, seq, completeOnImport: true });
  });
}

async function killWorker(w: ChildProcess) {
  if (w.exitCode === null && w.signalCode === null) {
    w.kill("SIGKILL");
    await once(w, "exit").catch(() => {});
  }
}

async function main() {
  // ── Case 1: crashing suite → non-zero result; sibling passes in fresh child.
  {
    const w1 = spawnWorker();
    const rA = await runSuite(w1, FIX("suite-a-crash.ts"), 1);
    check(
      "crashing suite reports failure to the parent",
      typeof rA === "object" && rA.code !== 0,
      `got ${JSON.stringify(rA)}`,
    );
    // Parent contract on failure: discard this child, respawn fresh.
    await killWorker(w1);
    const w2 = spawnWorker();
    const rB = await runSuite(w2, FIX("suite-b-innocent.ts"), 2);
    check(
      "innocent suite passes in the fresh child after a sibling crash",
      typeof rB === "object" && rB.code === 0,
      `got ${JSON.stringify(rB)}`,
    );
    await killWorker(w2);
  }

  // ── Case 2: quiet realm leak from a GREEN suite; same worker must scrub.
  {
    const w = spawnWorker();
    const rA = await runSuite(w, FIX("suite-a-leak-quiet.ts"), 1);
    check(
      "quiet-leak suite settles green",
      typeof rA === "object" && rA.code === 0,
      `got ${JSON.stringify(rA)}`,
    );
    const rB = await runSuite(w, FIX("suite-b-innocent.ts"), 2);
    check(
      "innocent suite passes in the SAME worker after a green-but-leaky sibling (realm scrub)",
      typeof rB === "object" && rB.code === 0,
      `got ${JSON.stringify(rB)}`,
    );
    await killWorker(w);
  }

  // ── Case 3: post-settle straggler crash → worker hard-exits (poisoned).
  {
    const w = spawnWorker();
    const rA = await runSuite(w, FIX("suite-a-straggler.ts"), 1);
    check(
      "straggler suite settles green before its async crash",
      typeof rA === "object" && rA.code === 0,
      `got ${JSON.stringify(rA)}`,
    );
    // The armed Node timer fires ~60ms after settle; the poisoned worker
    // must exit instead of staying alive to host the next suite.
    const exited = await Promise.race([
      once(w, "exit").then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
    ]);
    check(
      "worker hard-exits after a post-settle straggler crash (parent respawns via !connected)",
      exited,
      "worker still alive 5s after the straggler fired",
    );
    await killWorker(w);
  }

  // ── Case 4: registered module state is reset before a sibling starts.
  {
    const w = spawnWorker();
    const rA = await runSuite(w, FIX("suite-a-module-state.ts"), 1);
    check(
      "module-state fixture settles green after registering its reset",
      typeof rA === "object" && rA.code === 0,
      `got ${JSON.stringify(rA)}`,
    );
    const rB = await runSuite(w, FIX("suite-b-module-state.ts"), 2);
    check(
      "canonical module-state reset runs before the next suite in the SAME worker",
      typeof rB === "object" && rB.code === 0,
      `got ${JSON.stringify(rB)}`,
    );
    await killWorker(w);
  }

  // ── Case 5: bounded worker health is surfaced to the parent.
  {
    // One byte is an intentionally tiny test-only ceiling. The production
    // ceiling remains the worker's conservative 512 MiB default.
    const w = spawnWorker({ RUN_ALL_BATCH_WORKER_MAX_RSS_BYTES: "1" });
    const result = await runSuite(w, FIX("suite-b-innocent.ts"), 1);
    check(
      "worker reports resource pressure after a completed suite so the parent can recycle it before reuse",
      typeof result === "object" && result.code === 0 && result.resourcePressure,
      `got ${JSON.stringify(result)}`,
    );
    await killWorker(w);
  }

  // ── Case 6 (Task #4672): straggler fires AFTER the next suite is dispatched.
  {
    const w = spawnWorker();
    const rA = await runSuite(w, FIX("suite-a-straggler.ts"), 1);
    check(
      "straggler suite settles green before its async crash (dispatch-race case)",
      typeof rA === "object" && rA.code === 0,
      `got ${JSON.stringify(rA)}`,
    );
    // Dispatch B immediately — inside the worker's quiet window (default
    // 120ms; the fixture's straggler fires ~60ms after settle).
    const outcome = await new Promise<string>((resolveP) => {
      const timer = setTimeout(() => {
        cleanup();
        resolveP("timeout");
      }, 10_000);
      const onMessage = (msg: any) => {
        if (!msg || msg.seq !== 2) return;
        if (msg.type === "predecessor-straggler") {
          cleanup();
          resolveP("predecessor-straggler");
        } else if (msg.type === "result") {
          cleanup();
          resolveP(`result:${msg.code}:recycle=${msg.recycle === true}`);
        }
      };
      const onExit = () => {
        cleanup();
        resolveP("worker-exited-without-attribution");
      };
      const cleanup = () => {
        clearTimeout(timer);
        w.off("message", onMessage);
        w.off("exit", onExit);
      };
      w.on("message", onMessage);
      w.on("exit", onExit);
      w.send({ type: "run", file: FIX("suite-b-innocent.ts"), seq: 2, completeOnImport: true });
    });
    check(
      "straggler firing after the next dispatch is attributed to the PREVIOUS suite (predecessor-straggler, no failure for the innocent suite)",
      outcome === "predecessor-straggler",
      `got ${outcome}`,
    );
    // The poisoned worker must still hard-exit after attribution.
    const exited = await Promise.race([
      once(w, "exit").then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5_000)),
    ]);
    check(
      "worker hard-exits after attributing the straggler (parent respawns a fresh child for the retry)",
      exited,
      "worker still alive 5s after the attributed straggler",
    );
    await killWorker(w);
    // Parent-contract half of the retry: the innocent suite passes cleanly in
    // a fresh child (mirrors runOneBatched's re-dispatch).
    const w2 = spawnWorker();
    const rB = await runSuite(w2, FIX("suite-b-innocent.ts"), 3);
    check(
      "innocent suite passes when re-dispatched to a fresh child after attribution",
      typeof rB === "object" && rB.code === 0,
      `got ${JSON.stringify(rB)}`,
    );
    await killWorker(w2);
  }

  console.log(failures === 0 ? "\nAll batch-realm-isolation checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[batch-worker-realm-isolation] harness error:", err);
  process.exit(1);
});
