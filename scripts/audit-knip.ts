/**
 * scripts/audit-knip.ts — F12 (Task #4162): periodic repository-aware Knip
 * audit. Run with `npm run audit:knip`.
 *
 * WARNING-ONLY BY DESIGN. This command is NOT part of the merge gate
 * (scripts/gate.ts) and must not be added there: unused-file/unused-export
 * findings require human validation and were deliberately kept informational
 * (accepted process #3894; program spec F12). Exit-code policy:
 *   - findings NEVER fail the command (`--no-exit-code`);
 *   - only an inability to run knip at all (spawn failure / knip crash)
 *     exits non-zero, loudly — no silent fallback.
 *
 * Never run knip with `--fix` or `--allow-remove-files`; nothing here writes,
 * deletes, or rewrites baselines. Deletion protocol, expected steady-state
 * output, and per-finding classifications: KNIP_AUDIT.md.
 *
 * The version is exact-pinned and executed via deterministic `npx` (accepted
 * repo policy: no knip devDependency, zero lockfile footprint; upgrading the
 * pin is a deliberate task with a fresh validation run, never routine).
 */
import { spawnSync } from "node:child_process";

const PINNED_KNIP = "knip@6.32.0";
const CONFIG = "knip.jsonc";

function runPass(label: string, extraArgs: string[]): boolean {
  const args = ["--yes", PINNED_KNIP, "--config", CONFIG, "--no-exit-code", ...extraArgs];
  console.log(`\n=== ${label}: npx ${args.join(" ")} ===`);
  const res = spawnSync("npx", args, { stdio: "inherit" });
  if (res.error || res.status !== 0) {
    const why = res.error ? String(res.error) : `exit code ${res.status}`;
    console.error(`[audit-knip] FAILED to execute the ${label} (${why}).`);
    return false;
  }
  return true;
}

function main(): number {
  console.log("Periodic Knip audit — warning-only; the merge gate is unchanged by anything printed below.");
  console.log(`Pinned version: ${PINNED_KNIP} | config: ${CONFIG} | policy: KNIP_AUDIT.md`);

  const mainOk = runPass("main report", []);
  const cyclesOk = runPass("cycles report", ["--include", "cycles"]);

  console.log("\n--- Interpretation policy (full details: KNIP_AUDIT.md) ---");
  console.log("All findings are informational and require manual validation before any action.");
  console.log("Expected steady state: 0 unused files, 0 unused dependencies, 0 unresolved");
  console.log("imports, 0 cycles; 1 documented unlisted dependency (express-serve-static-core,");
  console.log("type-only via @types/express), environment-provided binaries (ffmpeg/ffprobe/");
  console.log("psql from .replit), and informational unused exports/types (accepted #3894).");
  console.log("Configuration hints are expected: explicit entry modeling is preferred over");
  console.log("knip's implicit defaults, and the sanctioned ignore list is kept verbatim.");
  console.log("Deletions are NEVER authorized by this output alone — follow the KNIP_AUDIT.md");
  console.log("deletion protocol (trace the load mechanism, then disposition).");

  if (!mainOk || !cyclesOk) {
    console.error("[audit-knip] knip could not be executed — this is an infrastructure failure, not a finding.");
    return 1;
  }
  return 0;
}

process.exitCode = main();
