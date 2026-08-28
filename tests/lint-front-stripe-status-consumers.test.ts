/* test-registration
{
  "name": "lint-front-stripe-status-consumers guard (Task #2831)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2831: the Front/Stripe dedicated status routes carry the Task #2811 status-unknown 503 contract but have NO client consumers yet (Hub cards read all-status). This guard's first assertion runs the lint over the REAL client/src tree, so a future console page that queries /api/integrations/front/status or /api/stripe/status without parseIntegrationStatusUnknownError (the #2820 neutral-\"Checking…\" pattern) fails the routine gate instead of shipping a false \"Not Connected\" on transient blips. The managed Long validation workflow runs the reviewed routine-gate profile, including this lint through gate.ts LINT_CHECKS and this SMOKE_FILES coverage. Fast, DB-free, deterministic (filesystem scan + tmpdir fixtures).",
  "tier": "small"
}
test-registration */
/**
 * Task #2831 — guard test for scripts/lint-front-stripe-status-consumers.ts.
 *
 * The lint flags any client file that consumes the dedicated
 * `/api/integrations/front/status` or `/api/stripe/status` routes without
 * referencing `parseIntegrationStatusUnknownError` — i.e. a future console
 * page that would flash a false "Not Connected" on a transient status-unknown
 * 503 (Task #2811 contract; Task #2820 client pattern).
 *
 * Proves:
 *   1. The REAL client/src tree is clean + the shared parser module still
 *      exports the parser (this assertion complements the managed Long validation
 *      workflow's reviewed routine-gate profile).
 *   2. A fixture consumer of the Front status route WITHOUT the parser is
 *      flagged, with the route + file/line in the message.
 *   3. A fixture consumer of the Stripe status route WITHOUT the parser is
 *      flagged too (both guarded routes enforce independently).
 *   4. A fixture consumer that references the parser passes.
 *   5. A fixture file that only touches the shared all-status endpoint is
 *      NOT a consumer of the guarded routes and passes untouched.
 *   6. A missing/renamed shared parser module (or a module that stopped
 *      exporting the parser) trips the lint loudly.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLint,
  GUARDED_ROUTES,
  REQUIRED_PARSER,
} from "../scripts/lint-front-stripe-status-consumers";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function fixture(): {
  root: string;
  sharedModulePath: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lint-front-stripe-status-"));
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  // A valid stand-in for shared/integrationStatusUnknown.ts so fixture runs
  // exercise the consumer scan, not the shared-module existence check.
  const sharedModulePath = join(root, "integrationStatusUnknown.ts");
  writeFileSync(
    sharedModulePath,
    `export function ${REQUIRED_PARSER}(error: unknown) { return null; }\n`,
  );
  return {
    root: src,
    sharedModulePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ── 1. Real tree is clean (this IS the enforcement) ─────────────────────
console.log("\n— real client/src tree —");
{
  const res = runLint();
  if (!res.ok) {
    for (const e of res.errors) console.error(`    ${e}`);
  }
  assert(
    res.ok,
    "real client/src tree: every guarded-route consumer handles the status-unknown contract, and the shared parser module exports it",
  );
  assert(
    res.filesScanned > 100,
    `real scan covered the client tree (${res.filesScanned} files)`,
  );
}

// ── 2. Front status consumer without the parser is flagged ──────────────
console.log("\n— fixture: Front status consumer without parser —");
{
  const { root, sharedModulePath, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "FrontIntegration.tsx"),
      [
        'import { useQuery } from "@tanstack/react-query";',
        "export default function FrontIntegration() {",
        "  const { data } = useQuery({",
        '    queryKey: ["/api/integrations/front/status"],',
        "  });",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    const res = runLint({ roots: [root], sharedModulePath });
    assert(!res.ok, "unhandled Front status consumer trips the lint");
    assert(
      res.violations.some(
        (v) =>
          v.route === "/api/integrations/front/status" &&
          v.file.endsWith("FrontIntegration.tsx") &&
          v.line === 4,
      ),
      "violation carries the Front route + file + line",
    );
    assert(
      res.errors.some(
        (e) =>
          e.includes(REQUIRED_PARSER) && e.includes("ZoomIntegration.tsx"),
      ),
      "error message points at the shared parser and the reference implementation",
    );
  } finally {
    cleanup();
  }
}

// ── 3. Stripe status consumer without the parser is flagged ─────────────
console.log("\n— fixture: Stripe status consumer without parser —");
{
  const { root, sharedModulePath, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "BillingStatusCard.tsx"),
      [
        'import { useQuery } from "@tanstack/react-query";',
        "export function BillingStatusCard() {",
        '  const { data } = useQuery({ queryKey: ["/api/stripe/status"] });',
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    const res = runLint({ roots: [root], sharedModulePath });
    assert(!res.ok, "unhandled Stripe status consumer trips the lint");
    assert(
      res.violations.some(
        (v) =>
          v.route === "/api/stripe/status" &&
          v.file.endsWith("BillingStatusCard.tsx"),
      ),
      "violation carries the Stripe route",
    );
  } finally {
    cleanup();
  }
}

// ── 4. Consumer that references the parser passes ───────────────────────
console.log("\n— fixture: consumer WITH the parser —");
{
  const { root, sharedModulePath, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "FrontIntegration.tsx"),
      [
        'import { useQuery } from "@tanstack/react-query";',
        `import { ${REQUIRED_PARSER} } from "@shared/integrationStatusUnknown";`,
        "export default function FrontIntegration() {",
        "  const { data, error } = useQuery({",
        '    queryKey: ["/api/integrations/front/status"],',
        "    refetchInterval: (query) =>",
        `      ${REQUIRED_PARSER}(query.state.error) ? 15_000 : false,`,
        "  });",
        `  const statusUnknown = !data && !!${REQUIRED_PARSER}(error);`,
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    const res = runLint({ roots: [root], sharedModulePath });
    assert(res.ok, "consumer referencing the parser passes");
    assert(res.consumerFiles === 1, "consumer file is counted as a consumer");
  } finally {
    cleanup();
  }
}

// ── 5. all-status-only file is not a guarded consumer ───────────────────
console.log("\n— fixture: all-status-only file —");
{
  const { root, sharedModulePath, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "IntegrationsHub.tsx"),
      [
        'import { useQuery } from "@tanstack/react-query";',
        "export function Hub() {",
        '  const { data } = useQuery({ queryKey: ["/api/integrations/all-status"] });',
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    const res = runLint({ roots: [root], sharedModulePath });
    assert(res.ok, "all-status-only file passes");
    assert(
      res.consumerFiles === 0,
      "all-status file is NOT counted as a guarded-route consumer",
    );
  } finally {
    cleanup();
  }
}

// ── 6. Missing / degraded shared parser module trips the lint ───────────
console.log("\n— fixture: shared parser module missing or degraded —");
{
  const { root, sharedModulePath, cleanup } = fixture();
  try {
    const missing = runLint({
      roots: [root],
      sharedModulePath: join(root, "does-not-exist.ts"),
    });
    assert(!missing.ok, "missing shared parser module trips the lint");
    assert(
      missing.errors.some((e) => e.includes("not found")),
      "missing-module error names the problem",
    );

    writeFileSync(
      sharedModulePath,
      "export function someOtherHelper() { return null; }\n",
    );
    const degraded = runLint({ roots: [root], sharedModulePath });
    assert(
      !degraded.ok,
      "shared module that stopped exporting the parser trips the lint",
    );
    assert(
      degraded.errors.some((e) => e.includes(REQUIRED_PARSER)),
      "degraded-module error names the required export",
    );
  } finally {
    cleanup();
  }
}

console.log(
  `\nlint-front-stripe-status-consumers guard: routes=[${GUARDED_ROUTES.join(", ")}] — passed: ${passed}, failed: ${failed}`,
);
if (failed > 0) process.exit(1);
