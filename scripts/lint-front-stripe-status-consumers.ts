/**
 * Drift guard: any NEW client consumer of the Front / Stripe dedicated status
 * routes must handle the status-unknown 503 contract (Task #2831).
 *
 * Background
 * ----------
 * Task #2811 gave `/api/integrations/front/status` and `/api/stripe/status`
 * the status-unknown 503 contract (`503 { statusUnknown: true, probeFailed:
 * true, connected/configured: null, reason }` when the credential/settings
 * read THROWS). Task #2820 taught the existing console pages (Zoom / Slack)
 * to recognize that shape via `parseIntegrationStatusUnknownError`
 * (shared/integrationStatusUnknown.ts) and render a neutral "Checking…"
 * state instead of a false "Not Connected".
 *
 * As of Task #2820 NO client screen queries these two routes directly (the
 * Integrations Hub cards read `/api/integrations/all-status`). If a future
 * console page starts querying them without the parser, a transient DB blip
 * will render a false "Not Connected" — the exact bug class Task #2811/#2820
 * eliminated. This lint makes that regression fail the routine gate instead
 * of rotting silently.
 *
 * What this lint asserts
 * ----------------------
 * 1. Every file under client/src that mentions `/api/integrations/front/status`
 *    or `/api/stripe/status` must ALSO reference
 *    `parseIntegrationStatusUnknownError` — i.e. a new consumer must wire the
 *    neutral-state + toast-suppression + refetch pattern (see
 *    client/src/pages/admin/ZoomIntegration.tsx as the reference
 *    implementation, and tests/client/integration-status-unknown-neutral.test.tsx
 *    for the rendered contract).
 * 2. The shared parser module still exists and still exports
 *    `parseIntegrationStatusUnknownError` — so a rename/move breaks this
 *    guard loudly instead of leaving it pointing at nothing.
 *
 * Referencing the parser is a heuristic, not a proof of correct wiring — but
 * it forces the author to the shared module, whose header documents the full
 * pattern. `/api/semrush/status` is deliberately NOT guarded here: its
 * existing consumers predate the contract and use their own handling
 * (custom queryFn in LocalDominanceDashboard, hub-side handling in
 * IntegrationsHub); adding them would flag shipped code, not drift.
 *
 * Exit code: 0 — clean; 1 — a consumer of a guarded route lacks the parser,
 * or the shared parser module is missing/renamed.
 *
 * Gate: scripts/gate.ts LINT_CHECKS plus
 * tests/lint-front-stripe-status-consumers.test.ts (SMOKE_FILES); `.replit`
 * `Validate` runs `npm run gate`.
 *
 * Emergency escape hatch: LINT_FRONT_STRIPE_STATUS_SKIP=1.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Status routes with the Task #2811 contract and (as of #2820) no client consumers. */
export const GUARDED_ROUTES = [
  "/api/integrations/front/status",
  "/api/stripe/status",
] as const;

/** The shared handler every new consumer must reference. */
export const REQUIRED_PARSER = "parseIntegrationStatusUnknownError";

/** Where the shared parser lives (checked so a rename breaks this lint loudly). */
export const SHARED_MODULE_PATH = "shared/integrationStatusUnknown.ts";

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

interface Violation {
  file: string;
  line: number;
  route: string;
}

export interface LintResult {
  ok: boolean;
  errors: string[];
  violations: Violation[];
  filesScanned: number;
  consumerFiles: number;
}

export interface LintOptions {
  /** Directories to scan recursively (defaults to ["client/src"]). For fixture testing. */
  roots?: string[];
  /** Path of the shared parser module (defaults to SHARED_MODULE_PATH). For fixture testing. */
  sharedModulePath?: string;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (st.isFile()) {
      const dot = entry.lastIndexOf(".");
      if (dot !== -1 && SCANNED_EXTENSIONS.has(entry.slice(dot))) {
        out.push(full);
      }
    }
  }
}

export function runLint(opts: LintOptions = {}): LintResult {
  const roots = opts.roots ?? ["client/src"];
  const sharedModulePath = opts.sharedModulePath ?? SHARED_MODULE_PATH;
  const errors: string[] = [];
  const violations: Violation[] = [];
  let filesScanned = 0;
  let consumerFiles = 0;

  // 2. The shared parser module must exist and export the required function.
  if (!existsSync(sharedModulePath)) {
    errors.push(
      `${sharedModulePath}: shared status-unknown parser module not found — if it moved/renamed, ` +
        `update SHARED_MODULE_PATH in scripts/lint-front-stripe-status-consumers.ts AND every consumer import.`,
    );
  } else {
    const sharedText = readFileSync(sharedModulePath, "utf8");
    if (
      !new RegExp(`export\\s+function\\s+${REQUIRED_PARSER}\\b`).test(sharedText)
    ) {
      errors.push(
        `${sharedModulePath}: no longer exports ${REQUIRED_PARSER}() — the status-unknown ` +
          `handling pattern this lint points new consumers at has been renamed/removed. Update ` +
          `REQUIRED_PARSER in scripts/lint-front-stripe-status-consumers.ts to the new name.`,
      );
    }
  }

  // 1. Scan client files for guarded-route mentions without the parser.
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      errors.push(
        `${root}: scan root not found — if the client tree moved, update the roots default in ` +
          `scripts/lint-front-stripe-status-consumers.ts.`,
      );
      continue;
    }
    walk(root, files);
  }

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      errors.push(`could not read ${file}: ${(err as Error).message}`);
      continue;
    }
    filesScanned += 1;

    const hitRoutes = GUARDED_ROUTES.filter((r) => text.includes(r));
    if (hitRoutes.length === 0) continue;
    consumerFiles += 1;
    if (text.includes(REQUIRED_PARSER)) continue;

    const lines = text.split("\n");
    for (const route of hitRoutes) {
      let reported = false;
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes(route)) {
          violations.push({ file, line: i + 1, route });
          reported = true;
          break; // one violation per (file, route) is enough signal
        }
      }
      if (!reported) violations.push({ file, line: 0, route });
    }
  }

  for (const v of violations) {
    errors.push(
      `${v.file}:${v.line}: consumes ${v.route} without referencing ${REQUIRED_PARSER} — ` +
        `this route answers a status-unknown 503 (Task #2811) on transient credential-read blips, ` +
        `and without the shared parser the screen will flash a false "Not Connected". Reuse the ` +
        `neutral-state + toast-suppression + refetch pattern from ` +
        `client/src/pages/admin/ZoomIntegration.tsx (parser: ${SHARED_MODULE_PATH}; rendered ` +
        `contract: tests/client/integration-status-unknown-neutral.test.tsx).`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    violations,
    filesScanned,
    consumerFiles,
  };
}

function main(): void {
  if (process.env.LINT_FRONT_STRIPE_STATUS_SKIP === "1") {
    console.log(
      "lint-front-stripe-status-consumers: SKIPPED (LINT_FRONT_STRIPE_STATUS_SKIP=1)",
    );
    process.exit(0);
  }

  const result = runLint();

  if (!result.ok) {
    console.error("");
    console.error(
      "✗ lint-front-stripe-status-consumers: a client consumer of a dedicated Front/Stripe status route does not handle the status-unknown 503 contract",
    );
    console.error("");
    for (const e of result.errors) {
      console.error(`  - ${e}`);
    }
    console.error("");
    console.error(
      "  Emergency override (with a fix landing in the same change): LINT_FRONT_STRIPE_STATUS_SKIP=1.",
    );
    console.error("");
    process.exit(1);
  }

  console.log(
    `lint-front-stripe-status-consumers: OK (${result.filesScanned} client file(s) scanned, ` +
      `${result.consumerFiles} guarded-route consumer(s) — all handle the status-unknown contract)`,
  );
  process.exit(0);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-front-stripe-status-consumers.ts");

if (isMain) {
  main();
}
