/**
 * gate-lint-ab-capture.mjs — subprocess capture CLI for the gate's base-tree
 * lint A/B attribution (Task #4604, fixing the Task #4491 rails).
 *
 * Problem it solves: the HEAD-side lint output is captured by
 * scripts/gate-lint-worker.mjs (console.* patch → ordered {stream, text}
 * lines), while the base-side A/B run used to capture a raw
 * `npx tsx <script>` subprocess's `stdout + "\n" + stderr`. Those are
 * different channels: the subprocess re-groups streams (all stdout, then all
 * stderr) and picks up node/npm/tsx boot noise ("npm notice …") that the
 * worker capture never sees — so byte-identical offenses hashed to different
 * signatures and genuinely inherited reds were blamed on the task
 * ("offense signature differs at base").
 *
 * This CLI mirrors the worker's capture contract exactly: register tsx,
 * patch console BEFORE importing the lint module, run `cliMain()`, and write
 * `{ code, lines }` JSON to the result-file path given as argv[3]. Runner
 * noise goes to the real stdout/stderr and never reaches the comparison.
 * scripts/gateLintAttribution.ts (runBaseTreeLints) composes the comparable
 * output the same way scripts/gate.ts composes the head side:
 * `lines.map(l => l.text).join("\n")`.
 *
 * Failure semantics stay conservative: if this process dies before writing
 * the result file (import-time process.exit, crash, OOM), the runner records
 * spawn-error and the verdict falls open to "yours".
 *
 * Usage: node scripts/gate-lint-ab-capture.mjs <lint-script> <result-json>
 */
import { register } from "tsx/esm/api";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { format } from "node:util";

const [script, resultPath] = process.argv.slice(2);
if (!script || !resultPath) {
  process.stderr.write("usage: node scripts/gate-lint-ab-capture.mjs <lint-script> <result-json>\n");
  process.exit(2);
}

register();

/** @type {{ stream: "stdout" | "stderr", text: string }[]} */
const lines = [];
for (const method of ["log", "info", "debug"]) {
  console[method] = (...args) => lines.push({ stream: "stdout", text: format(...args) });
}
for (const method of ["error", "warn"]) {
  console[method] = (...args) => lines.push({ stream: "stderr", text: format(...args) });
}

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

writeFileSync(resultPath, JSON.stringify({ code, lines }));
process.exit(0);
