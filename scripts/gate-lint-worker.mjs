/**
 * gate-lint-worker.mjs — worker-thread bootstrap for the gate's
 * single-process concurrent lint phase (Task #3789).
 *
 * scripts/gate.ts runs every LINT_CHECKS script by spawning one of these
 * workers per check (bounded pool) instead of one `npx tsx` process per
 * check, which used to pay ~0.7s interpreter boot per lint serially.
 *
 * The file is plain .mjs (no TypeScript) so a worker thread can load it
 * without a loader; it registers tsx's ESM hooks itself, imports the lint
 * module, buffers its console output, runs the exported `cliMain()`, and
 * posts `{ code, lines, durationMs }` back to the gate.
 *
 * Contract with lint scripts (enforced by tests/gate-lint-phase.test.ts):
 *   - importing the module must have no side effects (no scanning, no
 *     output, no process.exit at import time);
 *   - it must export `cliMain(): number` printing via console.log/error
 *     and returning the exit code.
 * A module that violates the contract fails its check loudly here (a
 * process.exit at import time kills only this worker; the gate reports
 * the check as failed with a hint).
 */
import { register } from "tsx/esm/api";
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { format } from "node:util";

const { script } = workerData;

register();

/** @type {{ stream: "stdout" | "stderr", text: string }[]} */
const lines = [];
for (const method of ["log", "info", "debug"]) {
  console[method] = (...args) => lines.push({ stream: "stdout", text: format(...args) });
}
for (const method of ["error", "warn"]) {
  console[method] = (...args) => lines.push({ stream: "stderr", text: format(...args) });
}

const startedAt = Date.now();
let code;
try {
  const mod = await import(pathToFileURL(script).href);
  if (typeof mod.cliMain !== "function") {
    lines.push({
      stream: "stderr",
      text: `[gate] ${script} does not export cliMain() — every LINT_CHECKS script must export a side-effect-free cliMain(): number (see scripts/gate.ts header).`,
    });
    code = 97;
  } else {
    const returned = await mod.cliMain();
    if (typeof returned === "number" && Number.isFinite(returned)) {
      code = returned;
    } else {
      lines.push({
        stream: "stderr",
        text: `[gate] ${script} cliMain() returned ${String(returned)} instead of a numeric exit code.`,
      });
      code = 96;
    }
  }
} catch (err) {
  lines.push({
    stream: "stderr",
    text: `[gate] ${script} threw during import/cliMain(): ${err?.stack ?? String(err)}`,
  });
  code = 98;
}

parentPort.postMessage({ code, lines, durationMs: Date.now() - startedAt });
