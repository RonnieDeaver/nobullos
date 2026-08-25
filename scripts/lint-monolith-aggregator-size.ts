/**
 * lint-monolith-aggregator-size.ts
 *
 * Regrowth guard for the Task #3787 monolith split. The files below were
 * 2,300–5,300-line monoliths that most active tasks touched simultaneously,
 * making them the top source of whole-file merge conflicts. They were split
 * into per-feature modules (server/routes/serviceDesk/*, server/routes/comms/*,
 * server/storage/comms/*, client/src/components/comms/*, server/boot/*) with a
 * thin aggregator preserving each consumer-visible surface.
 *
 * The 2026-08 architecture program (Task #4161/F13, pre-registered by the
 * residual audit §12) added its six split composition roots — integration
 * routes (F6), the prod-actions registry barrel (F7), and four admin
 * page/panel roots (F11A–D) — under the same budget conventions. Dependency
 * direction + ownership for those surfaces: ARCHITECTURE_BOUNDARIES.md.
 *
 * This lint caps the aggregator line counts so new code lands in the feature
 * modules (or a new module) instead of silently regrowing the monolith.
 *
 * If this fires:
 *   - DO move your new routes/methods/components/boot wiring into the
 *     matching per-feature module directory listed above.
 *   - Do NOT raise the budget to make room for feature code. Raising it is
 *     only legitimate when the aggregator's own composition/wiring genuinely
 *     grew (e.g. a new feature module needs mounting/re-export lines).
 *
 * Exit 1 on any violation; 0 when all aggregators are within budget.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Budget {
  /** Repo-relative path of the aggregator file. */
  path: string;
  /** Maximum allowed physical line count. */
  maxLines: number;
  /** Where new code should go instead. */
  moduleDir: string;
}

/**
 * Budgets are set with headroom above the post-split size (see wc -l at
 * split time in the header) so routine wiring additions fit, while a
 * monolith-scale regrowth (hundreds of lines of feature code) fails fast.
 */
const BUDGETS: Budget[] = [
  // 307 lines at split time: orchestrator = imports + critical bootstrap
  // path + kick calls + failure tail.
  { path: "server/index.ts", maxLines: 400, moduleDir: "server/boot/" },
  // 36 lines at split time: router composition + cross-module re-exports.
  { path: "server/routes/serviceDesk.ts", maxLines: 80, moduleDir: "server/routes/serviceDesk/" },
  // 34 lines at split time: registerCommsRoutes composition.
  { path: "server/routes/comms.ts", maxLines: 80, moduleDir: "server/routes/comms/" },
  // 23 lines at split time: barrel re-exporting the per-domain storage modules.
  { path: "server/storage/commsStorage.ts", maxLines: 80, moduleDir: "server/storage/comms/" },
  // 763 lines at split time: the main <Comms> page component itself stays
  // here (state/composition root); extracted panels live in components/comms.
  { path: "client/src/pages/Comms.tsx", maxLines: 900, moduleDir: "client/src/components/comms/" },
  // 394 lines at split time (was a 10,797-line monolith): the main
  // <ClickUpModule> page component stays here (state/tab composition root);
  // extracted feature modules live in pages/adminClickUp.
  { path: "client/src/pages/admin/ClickUpModule.tsx", maxLines: 500, moduleDir: "client/src/pages/adminClickUp/" },
  // PR9 (Task f1425127): 209 lines at split time — imports + registerRoutes
  // composition (register-call sequence in the original inline mount order +
  // background-service starts). The former 6.4k lines of inline route
  // registrations live in per-feature modules under server/routes/.
  { path: "server/routes.ts", maxLines: 300, moduleDir: "server/routes/" },
  // ——— 2026-08 architecture program roots (Task #4161/F13; audit §12) ———
  // 45 lines at split time (F6; was a 7,869-line monolith registering 131
  // routes inline): registerIntegrationRoutes composition in original mount
  // order over the per-domain modules + shared helpers leaf.
  { path: "server/routes/integrations.ts", maxLines: 80, moduleDir: "server/routes/integrations/" },
  // 82 lines at split time (F7; was a 10,836-line monolith): the registry's
  // public re-export barrel — consumers keep this specifier; registration
  // order + the domain guard live in prodActions/composition.ts.
  { path: "server/services/prodActionsRegistry.ts", maxLines: 150, moduleDir: "server/services/prodActions/" },
  // 306 lines at split time (F11A; was 7,902 lines): panel composition root —
  // connection gating + section ordering; sections + useRecoveryJobs live in
  // front/recovery/.
  { path: "client/src/components/admin/FrontHistoricalRecoveryPanel.tsx", maxLines: 400, moduleDir: "client/src/components/admin/front/recovery/" },
  // 154 lines at split time (F11B; was 6,677 lines; 139 by F13 after the
  // Zoom comparative-card retirement): page orchestration container.
  { path: "client/src/pages/admin/MatchSettings.tsx", maxLines: 200, moduleDir: "client/src/pages/adminMatchSettings/" },
  // 615 lines at split time (F11C; was 5,898 lines): page composition root;
  // tab/section modules live in adminRateLimit/.
  { path: "client/src/pages/admin/RateLimitUsers.tsx", maxLines: 750, moduleDir: "client/src/pages/adminRateLimit/" },
  // 409 lines at split time (F11D; was 5,784 lines): orchestration root —
  // root-owned core queries + unconditional hook mount order (contract);
  // cards + use<X>Domain hooks live in health/dashboard/.
  { path: "client/src/components/admin/health/HealthDashboardSection.tsx", maxLines: 500, moduleDir: "client/src/components/admin/health/dashboard/" },
  // 312 lines at split time (Task #4271; was 4,577 lines): report page root —
  // data fetching + root hook mount order (contract) + slide composition;
  // per-slide modules + shared pieces live in publicReport/.
  { path: "client/src/pages/PublicReport.tsx", maxLines: 400, moduleDir: "client/src/pages/publicReport/" },
];

export function runLint(rootOverride?: string): { ok: boolean; message: string } {
  const root = rootOverride ?? ROOT;
  const violations: string[] = [];
  const summaries: string[] = [];

  for (const budget of BUDGETS) {
    let lineCount: number;
    try {
      const src = readFileSync(resolve(root, budget.path), "utf8");
      lineCount = src.split("\n").length;
    } catch (err) {
      violations.push(
        `${budget.path}: unreadable (${(err as Error).message}) — if the file moved, update BUDGETS in scripts/lint-monolith-aggregator-size.ts in the same change`,
      );
      continue;
    }
    summaries.push(`${budget.path} ${lineCount}/${budget.maxLines}`);
    if (lineCount > budget.maxLines) {
      violations.push(
        `${budget.path} is ${lineCount} lines (budget ${budget.maxLines}). ` +
          `This file is a thin aggregator by design (Task #3787 anti-merge-conflict split) — ` +
          `move feature code into ${budget.moduleDir} instead. Only raise the budget when ` +
          `aggregation/wiring itself legitimately grew.`,
      );
    }
  }

  if (violations.length > 0) {
    const msg =
      `lint-monolith-aggregator-size: ${violations.length} violation(s):\n` +
      violations.map((v) => `  ✗ ${v}`).join("\n");
    return { ok: false, message: msg };
  }

  return {
    ok: true,
    message: `lint-monolith-aggregator-size: OK (${summaries.join(", ")})`,
  };
}

/** Gate worker-pool entry (Task #3789 cliMain contract): prints and returns the exit code. */
export function cliMain(): number {
  const { ok, message } = runLint();
  if (ok) {
    console.log(message);
    return 0;
  }
  console.error(message);
  return 1;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exit(cliMain());
}
