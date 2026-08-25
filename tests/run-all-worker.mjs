/**
 * run-all-worker.mjs — persistent batch child for tests/run-all.ts (Task #3809).
 *
 * Task #3789's instrumentation showed the full sweep pays ~4s of process
 * startup (npx + tsx boot + import graph) PER suite because run-all spawned
 * one `npx tsx` process per test file — roughly doubling wall time versus
 * summed suite time. This child amortizes that cost: run-all spawns one of
 * these per batch group (same extraEnv / tsconfig class, no extraNodeArgs)
 * and feeds it suites one at a time over IPC. tsx registers once, and the
 * shared import graph (server/db, drizzle, …) stays warm across suites.
 *
 * The file is plain .mjs living inside the workspace so it needs no loader
 * itself and can resolve the workspace's `tsx` package (see
 * .agents/memory/tsx-worker-pool.md — execArgv does NOT propagate tsx).
 *
 * Isolation contract with the parent (tests/run-all.ts):
 *   - Suites run strictly sequentially; the parent sends the next `run`
 *     message only after receiving the previous suite's `result`.
 *   - A suite's completion is signalled by its first `process.exit(code)`
 *     call (the dominant convention — exit is patched to capture the code
 *     and unwind via a marker error), or by its top-level import settling
 *     and the event loop draining (`beforeExit` with the IPC channel
 *     unref'd) for suites that finish without calling exit.
 *   - First exit wins: later exit calls / errors from the same suite are
 *     ignored so a catch block that swallows the marker error cannot flip
 *     a recorded result.
 *   - Any non-zero result, uncaught error, or crash makes the parent
 *     discard this whole process and respawn, so a misbehaving suite can
 *     pollute at most itself — never a later sibling's result.
 *   - Per-suite timeouts stay parent-side: the parent SIGKILLs this
 *     process group and respawns for the remaining suites.
 *
 * Task #4652 — cross-suite jsdom realm contamination. The recycle-on-failure
 * contract above left two holes, and both produced the audit-recorded ghost
 * failure `TypeError: activeElement$1.detachEvent is not a function` on an
 * innocent suite (a leftover focus listener bound to a dead JSDOM realm from
 * an earlier suite in the same child):
 *   1. A suite that SETTLES GREEN but leaves its jsdom realm installed on
 *      globalThis (window/document/listeners) is not recycled, so the next
 *      suite inherits the dead realm. Fixed by scrubbing the realm back to
 *      this process's boot-time globals before every run (scrubJsdomRealm).
 *   2. A suite that settles and THEN crashes asynchronously (straggler
 *      uncaughtException/unhandledRejection) used to be logged and ignored —
 *      leaving a provably-poisoned process alive to host the next suite.
 *      Fixed by hard-exiting via the REAL process.exit: the parent's
 *      `!child.connected` check respawns a fresh child for the next suite.
 * Task #4672 — straggler attribution quiet-period. Task #4652 left a residual:
 * a straggler that fired after the parent had already dispatched the NEXT
 * suite was indistinguishable from that suite's own error, failing the
 * innocent active suite (solo re-verify restored the verdict, but the suite
 * burned a solo run and polluted journal/repeat-offender stats). Now a `run`
 * message that arrives within STRAGGLER_QUIET_MS of the previous result being
 * sent is HELD (not imported) until the quiet window elapses. A straggler
 * firing while a run is held is provably the predecessor's: the worker sends
 * `{ type: "predecessor-straggler", seq }` so the parent can re-dispatch the
 * innocent suite in a fresh child without recording a failure, then hard-exits
 * as before. Residual (accepted, now much narrower): a straggler that fires
 * after the next suite's import has actually begun still fails the active
 * suite with recycle=true; the parent's solo re-verify restores the honest
 * verdict.
 */
import { register } from "tsx/esm/api";
import { pathToFileURL } from "node:url";
import { Agent, setGlobalDispatcher } from "undici";

register();

// The per-run process.exit patch below replaces process.exit; keep the real
// one for the poisoned-process hard exit (hole #2 above).
const REAL_PROCESS_EXIT = process.exit.bind(process);
// A healthy worker normally stays well below this. The parent still retains
// its conservative suite-count cap; this only asks it to recycle a child that
// has demonstrably exceeded a bounded process-memory envelope after a suite.
const DEFAULT_MAX_RSS_BYTES = 512 * 1024 * 1024;
const configuredMaxRss = Number(process.env.RUN_ALL_BATCH_WORKER_MAX_RSS_BYTES);
const MAX_RSS_BYTES =
  Number.isFinite(configuredMaxRss) && configuredMaxRss > 0
    ? configuredMaxRss
    : DEFAULT_MAX_RSS_BYTES;

// Snapshot process-level globals that suites legitimately tear down or
// replace on their way out (fine when the process dies with the suite,
// poisonous when a sibling runs next). Restored before every run.
const ORIGINAL_FETCH = globalThis.fetch;

// Task #4652: the jsdom mount kits (tests/helpers/installJsdomGlobals.ts and
// the per-suite --import setup files) install a suite's JSDOM realm directly
// on globalThis. When a suite finishes (even green) without tearing that
// down, the next suite in this warm process would see a DEAD realm — whose
// leftover focus/document listeners produce ghost failures like
// `activeElement$1.detachEvent is not a function`. Snapshot the boot-time
// descriptors of every global the mount kits touch and restore them before
// each run. Keep this key list a superset of installJsdomGlobals.
const JSDOM_GLOBAL_KEYS = [
  "window", "document", "navigator", "location", "history",
  "addEventListener", "removeEventListener", "dispatchEvent",
  "HTMLElement", "HTMLDivElement", "HTMLInputElement", "HTMLButtonElement",
  "HTMLAnchorElement", "HTMLImageElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "SVGElement", "Element", "Node", "DocumentFragment",
  "ShadowRoot", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent",
  "FocusEvent", "PointerEvent", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "matchMedia",
  "ResizeObserver", "IntersectionObserver", "MutationObserver",
  "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "confirm",
];
const ORIGINAL_GLOBAL_DESCRIPTORS = new Map(
  JSDOM_GLOBAL_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
);

function scrubJsdomRealm() {
  // Close a leftover jsdom window first: close() tears the realm down and
  // cancels its window-scheduled timers/rAFs so they cannot detonate under a
  // later suite.
  const w = globalThis.window;
  if (w && typeof w.close === "function" && w.document) {
    try {
      w.close();
    } catch {}
  }
  for (const [key, original] of ORIGINAL_GLOBAL_DESCRIPTORS) {
    try {
      const current = Object.getOwnPropertyDescriptor(globalThis, key);
      if (original === undefined) {
        if (current) delete globalThis[key];
      } else if (
        !current ||
        current.value !== original.value ||
        current.get !== original.get ||
        current.set !== original.set
      ) {
        Object.defineProperty(globalThis, key, original);
      }
    } catch (err) {
      console.error(`[run-all-worker] failed to restore global "${key}":`, err);
    }
  }
}

function restoreSharedGlobals() {
  scrubJsdomRealm();
  globalThis.fetch = ORIGINAL_FETCH;
  // Route suites close the global undici dispatcher to let the loop drain
  // (route-test-undici-drain-hang); give the next suite a fresh one. The
  // npm undici package shares the global-dispatcher slot with Node's
  // built-in fetch.
  try {
    setGlobalDispatcher(new Agent());
  } catch {}
  // Task #4097: reset module-global caches registered by server modules
  // (see server/services/moduleStateReset.ts — keep the global name and
  // Map<string, () => void> shape in sync). Only modules a previous suite
  // actually imported have registered, so this never forces imports; a
  // broken reset is logged loudly but must not fail the next suite.
  const resets = globalThis.__runAllModuleStateResets;
  if (resets instanceof Map) {
    for (const [name, fn] of resets) {
      try {
        fn();
      } catch (err) {
        console.error(`[run-all-worker] module-state reset "${name}" threw:`, err);
      }
    }
  }
}

/** @type {{ seq: number, exitCode: number | null, settled: boolean, beforeExitHandler: (() => void) | null } | null} */
let active = null;

// Task #4672: quiet window after a result send during which a dispatched
// next run is HELD so a predecessor straggler cannot be blamed on it.
const STRAGGLER_QUIET_MS = Number(process.env.RUN_ALL_STRAGGLER_QUIET_MS) || 120;
let quietUntil = 0;
/** @type {{ msg: any, timer: NodeJS.Timeout } | null} */
let pendingRun = null;

const EXIT_MARKER = "__runAllSuiteExit";

function isSuiteExitError(err) {
  return Boolean(err && typeof err === "object" && err[EXIT_MARKER] === true);
}

function readHealth() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    resourcePressure: usage.rss >= MAX_RSS_BYTES,
  };
}

function complete(run, code, recycle = false) {
  if (!run || run.settled || run !== active) return;
  run.settled = true;
  if (run.beforeExitHandler) {
    process.removeListener("beforeExit", run.beforeExitHandler);
    run.beforeExitHandler = null;
  }
  // Re-ref the IPC channel so the worker stays alive while idle.
  if (process.channel && typeof process.channel.ref === "function") {
    process.channel.ref();
  }
  active = null;
  process.send({ type: "result", seq: run.seq, code, recycle, ...readHealth() });
  // Task #4672: open the straggler-attribution quiet window. Only a PASS can
  // be followed by another dispatch to this child (the parent recycles on
  // failures), but setting it unconditionally is harmless.
  quietUntil = Date.now() + STRAGGLER_QUIET_MS;
}

// Suite-scope error handlers: a genuine uncaught error fails the active
// suite (and asks the parent to recycle this process — its state is
// suspect); the marker error thrown by the patched process.exit is expected
// to surface here when a suite calls exit inside a .then()/timer.
function onUncaught(err) {
  if (isSuiteExitError(err)) return;
  const run = active;
  if (run && !run.settled) {
    console.error("[run-all-worker] uncaught error in suite:", err);
    complete(run, run.exitCode ?? 1, true);
  } else {
    // Task #4652: straggler from an already-settled suite (this only happens
    // after a PASS — the parent recycles on failures). This process is
    // provably poisoned: a suite crashed AFTER its result was recorded, so
    // its leaked state must never host the next sibling. Hard-exit via the
    // real process.exit — the parent sees `!child.connected` on the next
    // dispatch and respawns a fresh child (already-recorded results are
    // unaffected).
    //
    // Task #4672: if the parent already dispatched the next suite but it is
    // still HELD in the quiet window (import not begun), this error is
    // provably the PREVIOUS suite's — tell the parent so it can re-dispatch
    // the innocent suite in a fresh child instead of recording a failure.
    if (pendingRun) {
      clearTimeout(pendingRun.timer);
      const seq = pendingRun.msg.seq;
      pendingRun = null;
      try {
        process.send({ type: "predecessor-straggler", seq });
      } catch {}
    }
    console.error(
      "[run-all-worker] uncaught straggler error from an already-settled suite — exiting this poisoned batch child so the parent respawns fresh:",
      err,
    );
    REAL_PROCESS_EXIT(1);
  }
}
process.on("uncaughtException", onUncaught);
process.on("unhandledRejection", onUncaught);

process.on("message", (msg) => {
  if (!msg || msg.type !== "run" || typeof msg.file !== "string") return;
  // Task #4672: hold a dispatch that arrives inside the straggler quiet
  // window — a predecessor straggler firing before the hold expires is then
  // attributable to the previous suite instead of this one.
  const holdMs = quietUntil - Date.now();
  if (holdMs > 0) {
    pendingRun = {
      msg,
      timer: setTimeout(() => {
        pendingRun = null;
        void startRun(msg);
      }, holdMs),
    };
    return;
  }
  void startRun(msg);
});

async function startRun(msg) {
  const run = { seq: msg.seq, exitCode: null, settled: false, beforeExitHandler: null };
  active = run;
  process.exitCode = undefined;
  restoreSharedGlobals();

  // Patch process.exit per-run: capture the first code, then unwind the
  // caller with a marker error (exit must not return — falling through
  // would run the code after an error-branch `process.exit(1)`).
  process.exit = (code) => {
    if (run === active && !run.settled) {
      if (run.exitCode === null) {
        run.exitCode = typeof code === "number" ? code : code ? 1 : 0;
      }
      complete(run, run.exitCode);
    }
    const err = new Error(
      `[run-all-worker] expected control-flow unwind after process.exit(${String(code)}) — the suite's result (${run.exitCode ?? "already recorded"}) is unaffected; a suite catch block logging this error is harmless`,
    );
    err[EXIT_MARKER] = true;
    throw err;
  };

  let importSettled = false;
  try {
    // Cache-bust the entry module so a repeated dispatch of the same file
    // (never expected — retries use the parent's solo path — but defensive)
    // re-executes instead of resolving instantly from the ESM cache.
    await import(`${pathToFileURL(msg.file).href}?runAllSeq=${msg.seq}`);
    importSettled = true;
  } catch (err) {
    if (!isSuiteExitError(err) && !run.settled) {
      console.error(`[run-all-worker] suite threw during import: ${msg.file}`, err);
      complete(run, 1, true);
    }
  }

  if (importSettled && !run.settled && msg.completeOnImport === true) {
    // The parent statically determined this suite never calls process.exit:
    // its top-level import settling IS completion (under the solo runner it
    // relied purely on event-loop drain to exit). Completing here avoids
    // waiting on a drain that an earlier suite's leaked handle could block.
    complete(run, typeof process.exitCode === "number" ? process.exitCode : 0);
  }

  if (importSettled && !run.settled) {
    // Top-level import finished without an exit call yet — the suite kicked
    // off `main().then(() => process.exit(...))` without awaiting. Unref the
    // IPC channel so the event loop draining fires `beforeExit` = "suite is
    // done"; an async exit call still wins if it comes first.
    run.beforeExitHandler = () => {
      complete(run, run.exitCode ?? (typeof process.exitCode === "number" ? process.exitCode : 0));
    };
    process.once("beforeExit", run.beforeExitHandler);
    if (process.channel && typeof process.channel.unref === "function") {
      process.channel.unref();
    }
  }
}
