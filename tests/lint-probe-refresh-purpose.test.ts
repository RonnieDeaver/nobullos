/* test-registration
{
  "name": "Probe-refresh-purpose guardrail lint (Task #2285)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2285 — Regression test for the probe-refresh-purpose guardrail.
 *
 * Proves:
 *   1. The real `server/` tree passes (the five registered integrations are
 *      correctly tagged + gated; Google Calendar is registered as of
 *      Task #2358, no longer allowlisted).
 *   2. A fixture integration that issues a refresh_token POST but has NO
 *      registry entry is flagged (new-integration regression).
 *   3. A registered probe purpose the real classifier treats as
 *      AUTHORITATIVE is flagged.
 *   4. A registered probe purpose that never appears in the source is
 *      flagged (registry drift).
 *   5. A registered integration that never references the classifier is
 *      flagged (unguarded terminal branch).
 *   6. A stale registry entry (file gone / no longer posts) is flagged.
 *   7. The allowlist suppresses an otherwise-flagged file.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-probe-refresh-purpose";

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

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-probe-purpose-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const REFRESH_POST_SNIPPET = [
  "async function refresh(token: string) {",
  "  await fetch(URL, { method: 'POST', body: new URLSearchParams({",
  "    grant_type: 'refresh_token', refresh_token: token,",
  "  }).toString() });",
  "}",
].join("\n");

// 1. Real server/ tree passes.
{
  const res = runLint();
  if (!res.ok) {
    for (const v of res.violations) console.error(`    ${v.file}: ${v.reason}`);
  }
  assert(res.ok, "real server/ tree passes the lint");
}

// 2. New integration with a refresh POST but no registry entry is flagged.
{
  const { root, cleanup } = fixture();
  try {
    const file = join(root, "newIntegration.ts");
    writeFileSync(file, REFRESH_POST_SNIPPET + "\n");
    const res = runLint({ scanRoot: root, registry: new Map(), allowlist: new Set() });
    assert(!res.ok, "unregistered refresh-token integration trips the lint");
    assert(
      res.violations.some((v) => v.file === file && /no PROBE_PURPOSE_REGISTRY entry/.test(v.reason)),
      "reports the missing registry entry",
    );
  } finally {
    cleanup();
  }
}

// 3. Authoritative probe purpose is flagged.
{
  const { root, cleanup } = fixture();
  try {
    const file = join(root, "badPurpose.ts");
    writeFileSync(
      file,
      [
        "import { isAuthoritativeRefreshPurpose } from './x';",
        "// purpose: 'expiry' is authoritative — must not be a probe purpose",
        "const p = { purpose: 'expiry' };",
        REFRESH_POST_SNIPPET,
      ].join("\n") + "\n",
    );
    const res = runLint({
      scanRoot: root,
      registry: new Map([[file, ["expiry"]]]),
      allowlist: new Set(),
    });
    assert(!res.ok, "authoritative probe purpose trips the lint");
    assert(
      res.violations.some((v) => v.file === file && /classified AUTHORITATIVE/.test(v.reason)),
      "reports the authoritative purpose",
    );
  } finally {
    cleanup();
  }
}

// 4. Registered purpose absent from source is flagged (registry drift).
{
  const { root, cleanup } = fixture();
  try {
    const file = join(root, "drift.ts");
    writeFileSync(
      file,
      ["import { isAuthoritativeRefreshPurpose } from './x';", REFRESH_POST_SNIPPET].join("\n") + "\n",
    );
    const res = runLint({
      scanRoot: root,
      registry: new Map([[file, ["my_probe"]]]),
      allowlist: new Set(),
    });
    assert(!res.ok, "purpose missing from source trips the lint");
    assert(
      res.violations.some((v) => v.file === file && /never appears as a `purpose` literal/.test(v.reason)),
      "reports the registry drift",
    );
  } finally {
    cleanup();
  }
}

// 5. Registered integration that never references the classifier is flagged.
{
  const { root, cleanup } = fixture();
  try {
    const file = join(root, "ungated.ts");
    writeFileSync(
      file,
      ["const p = { purpose: 'my_probe' };", REFRESH_POST_SNIPPET].join("\n") + "\n",
    );
    const res = runLint({
      scanRoot: root,
      registry: new Map([[file, ["my_probe"]]]),
      allowlist: new Set(),
    });
    assert(!res.ok, "integration not referencing the classifier trips the lint");
    assert(
      res.violations.some(
        (v) => v.file === file && /does not reference isAuthoritativeRefreshPurpose/.test(v.reason),
      ),
      "reports the unguarded terminal branch",
    );
  } finally {
    cleanup();
  }
}

// 6. Stale registry entry (file does not exist) is flagged.
{
  const { root, cleanup } = fixture();
  try {
    const ghost = join(root, "ghost.ts");
    const res = runLint({
      scanRoot: root,
      registry: new Map([[ghost, ["probe"]]]),
      allowlist: new Set(),
    });
    assert(!res.ok, "stale registry entry trips the lint");
    assert(
      res.violations.some((v) => v.file === ghost && /does not exist/.test(v.reason)),
      "reports the stale registry entry",
    );
  } finally {
    cleanup();
  }
}

// 7. Allowlist suppresses an otherwise-flagged file.
{
  const { root, cleanup } = fixture();
  try {
    const file = join(root, "allowed.ts");
    writeFileSync(file, REFRESH_POST_SNIPPET + "\n");
    const res = runLint({
      scanRoot: root,
      registry: new Map(),
      allowlist: new Set([file]),
    });
    assert(res.ok, "allowlisted file is not flagged");
  } finally {
    cleanup();
  }
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
