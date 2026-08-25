/* test-registration
{
  "name": "lint-vendor-confinement guard",
  "regression": true,
  "smoke": true,
  "smokeReason": "Architecture Governor first-wave guard (Task #4180, host-mode Task #4193): vendor SDK sprawl (OpenAI had 17 direct importers) is frozen — net-new direct importers outside the owning adapter must fail the gate, and fetch-based vendors (Front, Zoom) are confined the same way via API-host detection, and env-built vendor URLs (Task #4249: Slack webhook / LiveKit env vars) via env-var detection. Task #5008: baseline GROWTH is itself gated — every files/hosts/envVars entry needs a per-entry approval record, so a regenerated baseline that absorbed a net-new caller fails until explicitly blessed (shrinks stay free). This proves the intentional-failure cases (a new file importing a vendor SDK or fetching a vendor API host ⇒ fail; unapproved baseline growth ⇒ fail; approved growth ⇒ pass) and that the committed baseline exactly matches the live caller set. Fast, DB-free, deterministic (line-level source scan + injected fixtures).",
  "tier": "medium"
}
test-registration */
/**
 * Guard test for scripts/lint-vendor-confinement.ts.
 *
 * Proves:
 *   1. REAL state: the committed frozen baseline exactly matches today's
 *      direct importers of every listed vendor SDK.
 *   2. Intentional failure: a net-new file importing a vendor SDK ⇒ fail,
 *      naming the file and vendor, pointing to the owning adapter.
 *   3. Stale baseline entry (file stopped importing / deleted) ⇒ fail.
 *   4. Import detection covers static, subpath, type-only, dynamic import()
 *      and require() forms — and does NOT false-positive on prefixed
 *      package names or relative paths.
 *   5. Wiring lockstep: gate.ts LINT_CHECKS registers it and the drift guard
 *      defines `VALIDATION_WORKFLOW` with command `npm run gate`.
 *   6. Host-mode vendors (Task #4193, Front/Zoom): host detection matches
 *      code strings (incl. subdomains/paths), ignores comments and
 *      look-alike domains; net-new host caller ⇒ fail; stale entry ⇒ fail;
 *      host mode without hosts list ⇒ fail loudly.
 *   8. Growth approvals (Task #5008): a baseline entry (file/host/envVar)
 *      without a matching per-entry approval record ⇒ fail (blocked
 *      unapproved growth); with the approval ⇒ pass (approved growth);
 *      orphan approval (entry removed, approval kept) ⇒ fail; the
 *      committed baseline carries an approval for every entry.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectVendorConfinementVerdictInputs,
  runLint,
  runLintCached,
  importsPackage,
  referencesHost,
  referencesEnvVar,
  REMEDIATION,
  type VendorBaseline,
} from "../scripts/lint-vendor-confinement";

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

// 1. Real committed state.
const real = runLint();
assert(
  real.ok,
  `REAL committed baseline matches live importers (${real.vendorCount} vendors, ${real.scannedFileCount} files)`,
);
if (!real.ok) for (const p of real.problems) console.error(`    real problem: ${p}`);

// 1b. Green-only exact-input verdict cache (Task #5139). The fixture lives in
// its own temporary repository, so it exercises the SAME full-tree discovery
// path the gate uses without changing a tracked source file or the real cache.
{
  const fixtureRoot = mkdtempSync(join(tmpdir(), "vendor-confinement-cache-"));
  const cacheFile = join(
    fixtureRoot,
    ".local/state/lint-verdict-cache/lint-vendor-confinement.json",
  );
  const originalCacheFlag = process.env.LINT_VERDICT_CACHE;
  try {
    mkdirSync(join(fixtureRoot, "server/services"), { recursive: true });
    mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
    writeFileSync(join(fixtureRoot, "package.json"), '{"name":"vendor-cache-fixture"}\n');
    writeFileSync(join(fixtureRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
    writeFileSync(join(fixtureRoot, "tsconfig.json"), '{"compilerOptions":{}}\n');
    writeFileSync(
      join(fixtureRoot, "scripts/vendor-importer-baseline.json"),
      JSON.stringify({
        vendors: {
          fakevendor: {
            adapter: "server/services/fakeAdapter.ts",
            files: ["server/services/fakeAdapter.ts"],
            approvals: { "file:server/services/fakeAdapter.ts": "fixture approval" },
          },
        },
      }),
    );
    writeFileSync(
      join(fixtureRoot, "server/services/fakeAdapter.ts"),
      'import Fake from "fakevendor";\nvoid Fake;\n',
    );

    const inputs = collectVendorConfinementVerdictInputs(fixtureRoot);
    assert(
      inputs !== null &&
        inputs.some((p) => p.endsWith("server/services/fakeAdapter.ts")) &&
        inputs.some((p) => p.endsWith("scripts/vendor-importer-baseline.json")) &&
        inputs.some((p) => p.endsWith("lint-work-queue-producer-handlers.ts")) &&
        inputs.some((p) => p.endsWith("lintVerdictCache.ts")),
      "cache key includes discovered source membership, baseline, scanner helper, and cache contract",
    );

    const uncachedGreen = runLint({ cwd: fixtureRoot });
    const firstGreen = runLintCached({ cwd: fixtureRoot });
    const secondGreen = runLintCached({ cwd: fixtureRoot });
    assert(
      uncachedGreen.ok &&
        firstGreen.ok &&
        !firstGreen.fromCache &&
        firstGreen.vendorCount === uncachedGreen.vendorCount &&
        firstGreen.scannedFileCount === uncachedGreen.scannedFileCount,
      "first cache-path green has the same verdict and findings summary as the uncached path",
    );
    assert(
      secondGreen.ok &&
        secondGreen.fromCache === true &&
        secondGreen.vendorCount === uncachedGreen.vendorCount &&
        secondGreen.scannedFileCount === uncachedGreen.scannedFileCount,
      "unchanged second green run honestly reuses the cached verdict",
    );
    const fixtureBaselinePath = join(fixtureRoot, "scripts/vendor-importer-baseline.json");
    const originalBaseline = readFileSync(fixtureBaselinePath, "utf8");
    writeFileSync(fixtureBaselinePath, `${originalBaseline}\n`);
    const baselineChangedGreen = runLintCached({ cwd: fixtureRoot });
    assert(
      baselineChangedGreen.ok && !baselineChangedGreen.fromCache,
      "a baseline-only byte change rotates the key and forces a real green scan",
    );
    writeFileSync(fixtureBaselinePath, originalBaseline);

    writeFileSync(
      join(fixtureRoot, "server/services/sneaky.ts"),
      'import Fake from "fakevendor";\nvoid Fake;\n',
    );
    const uncachedRed = runLint({ cwd: fixtureRoot });
    const cachedPathRed = runLintCached({ cwd: fixtureRoot });
    assert(
      !uncachedRed.ok &&
        !cachedPathRed.ok &&
        !cachedPathRed.fromCache &&
        JSON.stringify(cachedPathRed.problems) === JSON.stringify(uncachedRed.problems),
      "a seeded net-new importer rotates the key and returns byte-equivalent uncached red findings",
    );
    const greenCacheBefore = readFileSync(cacheFile, "utf8");
    runLintCached({ cwd: fixtureRoot });
    assert(
      readFileSync(cacheFile, "utf8") === greenCacheBefore,
      "red verdicts are never written over the prior green cache entry",
    );

    writeFileSync(
      join(fixtureRoot, "server/services/sneaky.ts"),
      'export const safe = true;\n',
    );
    mkdirSync(join(fixtureRoot, ".local/state/lint-verdict-cache"), { recursive: true });
    writeFileSync(cacheFile, "{not valid JSON");
    const recoveredGreen = runLintCached({ cwd: fixtureRoot });
    assert(
      recoveredGreen.ok && !recoveredGreen.fromCache && existsSync(cacheFile),
      "a corrupt cache falls open to a real green scan and is repaired",
    );

    const cacheBeforeDisabledRun = readFileSync(cacheFile, "utf8");
    process.env.LINT_VERDICT_CACHE = "0";
    const disabled = runLintCached({ cwd: fixtureRoot });
    assert(
      disabled.ok &&
        !disabled.fromCache &&
        readFileSync(cacheFile, "utf8") === cacheBeforeDisabledRun,
      "LINT_VERDICT_CACHE=0 disables cache reads and writes",
    );
  } finally {
    if (originalCacheFlag === undefined) delete process.env.LINT_VERDICT_CACHE;
    else process.env.LINT_VERDICT_CACHE = originalCacheFlag;
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// 4. Detection forms. Fixtures use a fake package name on purpose: literal
// real vendor names here would make THIS file scan as a direct importer and
// force it into the frozen baselines (Task #4191 shrank openai to just the
// adapter). importsPackage() is generic over the package name, so fake-name
// fixtures exercise exactly the same regex paths.
assert(importsPackage(`import Fake from "fakevendor";`, "fakevendor"), "detects default import");
assert(importsPackage(`import type { Foo } from "fakevendor";`, "fakevendor"), "detects type-only import");
assert(importsPackage(`import "fakevendor/shims/node";`, "fakevendor"), "detects bare subpath import");
assert(importsPackage(`const x = await import("fakevendor");`, "fakevendor"), "detects dynamic import()");
assert(importsPackage(`const t = require("fakevendor")`, "fakevendor"), "detects require()");
assert(
  importsPackage(`export { Storage } from "@fake-scope/fakevendor";`, "@fake-scope/fakevendor"),
  "detects export-from of scoped package",
);
assert(!importsPackage(`import x from "fakevendor-tokenizer";`, "fakevendor"), "no FP on prefixed package name");
assert(!importsPackage(`import x from "./fakevendor";`, "fakevendor"), "no FP on relative path");

// 2 + 3. Fixture baseline.
const baseline: VendorBaseline = {
  vendors: {
    fakevendor: {
      adapter: "server/services/fakeAdapter.ts",
      files: ["server/services/fakeAdapter.ts"],
      approvals: { "file:server/services/fakeAdapter.ts": "fixture-approved (fake vendor)" },
    },
  },
};
const okRun = runLint({
  baseline,
  files: [
    { path: "server/services/fakeAdapter.ts", source: `import Fake from "fakevendor";` },
    { path: "server/routes/other.ts", source: `import { adapter } from "../services/fakeAdapter";` },
  ],
});
assert(okRun.ok, "baseline importer + non-importer pass");

const netNew = runLint({
  baseline,
  files: [
    { path: "server/services/fakeAdapter.ts", source: `import Fake from "fakevendor";` },
    { path: "server/routes/sneaky.ts", source: `import Fake from "fakevendor";` },
  ],
});
assert(!netNew.ok, "net-new direct importer FAILS");
assert(
  netNew.problems.some(
    (p) => p.includes("server/routes/sneaky.ts") && p.includes("fakevendor") && p.includes("fakeAdapter"),
  ),
  "failure names the file, vendor, and owning adapter",
);
assert(REMEDIATION.includes("owner approval"), "remediation states owner approval (L3)");

const stale = runLint({
  baseline,
  files: [{ path: "server/services/fakeAdapter.ts", source: `// no longer imports it` }],
});
assert(
  !stale.ok && stale.problems.some((p) => p.includes("stale baseline entry")),
  "stale baseline entry FAILS with shrink-only remediation",
);

// 6. Host-mode detection (Task #4193) — fake vendor host so this test file
// itself never references a real vendor API host.
const HOST = "api.fakevendor.example";
assert(referencesHost(`const B = "https://${HOST}/v2";`, HOST), "host: detects string literal");
assert(
  referencesHost(`fetch(\`https://sub.${HOST}/x\`)`, "fakevendor.example"),
  "host: detects subdomain via template literal",
);
assert(
  referencesHost(`const u = "https://${HOST}/oauth/token";`, `${HOST}/oauth`),
  "host: detects host+path pattern",
);
assert(!referencesHost(`// docs: https://${HOST}/reference`, HOST), "host: ignores line comments");
assert(!referencesHost(`/* see ${HOST} */ const x = 1;`, HOST), "host: ignores block comments");
assert(
  !referencesHost(`const u = "https://my${HOST}/v2";`, HOST),
  "host: no FP on look-alike domain prefix",
);
assert(
  !referencesHost(`const u = "https://${HOST}ple.com";`, HOST),
  "host: no FP on look-alike domain suffix",
);

const hostBaseline: VendorBaseline = {
  vendors: {
    fakevendor: {
      adapter: "server/services/fakeHostAdapter.ts",
      detection: "host",
      hosts: [HOST],
      files: ["server/services/fakeHostAdapter.ts"],
      approvals: {
        "file:server/services/fakeHostAdapter.ts": "fixture-approved (fake vendor)",
        [`host:${HOST}`]: "fixture-approved (fake vendor)",
      },
    },
  },
};

const hostOk = runLint({
  baseline: hostBaseline,
  files: [
    { path: "server/services/fakeHostAdapter.ts", source: `fetch("https://${HOST}/v2/me");` },
    { path: "server/routes/other.ts", source: `// mentions ${HOST} only in a comment` },
  ],
});
assert(hostOk.ok, "host: baseline caller + comment-only file pass");
if (!hostOk.ok) for (const p of hostOk.problems) console.error(`    host problem: ${p}`);

const hostNetNew = runLint({
  baseline: hostBaseline,
  files: [
    { path: "server/services/fakeHostAdapter.ts", source: `fetch("https://${HOST}/v2/me");` },
    { path: "server/routes/sneaky.ts", source: `fetch("https://${HOST}/v2/steal");` },
  ],
});
assert(!hostNetNew.ok, "host: net-new vendor-host caller FAILS (intentional-failure)");
assert(
  hostNetNew.problems.some(
    (p) =>
      p.includes("server/routes/sneaky.ts") && p.includes(HOST) && p.includes("fakeHostAdapter"),
  ),
  "host: failure names the file, host, and owning adapter",
);

const hostStale = runLint({
  baseline: hostBaseline,
  files: [{ path: "server/services/fakeHostAdapter.ts", source: `// no longer calls it` }],
});
assert(
  !hostStale.ok && hostStale.problems.some((p) => p.includes("stale baseline entry")),
  "host: stale baseline entry FAILS",
);

// Per-vendor scanRoots (Task #4223): a vendor listing "client/src" sees
// client callers; vendors on the default roots never see client files.
const scanRootsBaseline: VendorBaseline = {
  vendors: {
    fakevendor: {
      adapter: null,
      detection: "host",
      hosts: [HOST],
      scanRoots: ["server", "client/src"],
      files: ["client/src/components/FakeMap.tsx"],
      approvals: {
        "file:client/src/components/FakeMap.tsx": "fixture-approved (fake vendor)",
        [`host:${HOST}`]: "fixture-approved (fake vendor)",
      },
    },
    otherfake: {
      adapter: null,
      detection: "host",
      hosts: ["api.otherfake.example"],
      files: [],
      approvals: { "host:api.otherfake.example": "fixture-approved (fake vendor)" },
    },
  },
};
const scanRootsRun = runLint({
  baseline: scanRootsBaseline,
  files: [
    { path: "client/src/components/FakeMap.tsx", source: `fetch("https://${HOST}/tiles");` },
    // References the default-roots vendor's host but sits under client/ — must be invisible to it.
    { path: "client/src/lib/ignored.ts", source: `const u = "https://api.otherfake.example/x";` },
  ],
});
assert(scanRootsRun.ok, "scanRoots: client caller frozen for opted-in vendor; default-roots vendor blind to client");
if (!scanRootsRun.ok) for (const p of scanRootsRun.problems) console.error(`    scanRoots problem: ${p}`);
const scanRootsNetNew = runLint({
  baseline: scanRootsBaseline,
  files: [
    { path: "client/src/components/FakeMap.tsx", source: `fetch("https://${HOST}/tiles");` },
    { path: "client/src/components/Sneaky.tsx", source: `fetch("https://${HOST}/steal");` },
  ],
});
assert(
  !scanRootsNetNew.ok && scanRootsNetNew.problems.some((p) => p.includes("client/src/components/Sneaky.tsx")),
  "scanRoots: net-new client caller FAILS for opted-in vendor",
);

// 7. Env-var detection (Task #4249) — vendors whose URLs are built from
// env vars (no literal host in code) declare envVars; a file referencing
// the env-var name in code is confined too. Fake env-var name on purpose so
// THIS file never joins a real vendor's frozen baseline.
const ENVVAR = "FAKEVENDOR_WEBHOOK_URL";
assert(
  referencesEnvVar(`const u = process.env.${ENVVAR};`, ENVVAR),
  "envVar: detects process.env read",
);
assert(
  referencesEnvVar(`const u = process.env["${ENVVAR}"] ?? "";`, ENVVAR),
  "envVar: detects bracket/string form",
);
assert(!referencesEnvVar(`// set ${ENVVAR} in secrets`, ENVVAR), "envVar: ignores comments");
assert(
  !referencesEnvVar(`const u = process.env.MY_${ENVVAR};`, ENVVAR),
  "envVar: no FP on prefixed name",
);
assert(
  !referencesEnvVar(`const u = process.env.${ENVVAR}_BACKUP;`, ENVVAR),
  "envVar: no FP on suffixed name",
);

const envBaseline: VendorBaseline = {
  vendors: {
    fakevendor: {
      adapter: "server/services/fakeEnvAdapter.ts",
      detection: "host",
      hosts: [HOST],
      envVars: [ENVVAR],
      files: ["server/services/fakeEnvAdapter.ts"],
      approvals: {
        "file:server/services/fakeEnvAdapter.ts": "fixture-approved (fake vendor)",
        [`host:${HOST}`]: "fixture-approved (fake vendor)",
        [`env:${ENVVAR}`]: "fixture-approved (fake vendor)",
      },
    },
  },
};
const envOk = runLint({
  baseline: envBaseline,
  files: [
    // Adapter hits via env var only — no literal host anywhere.
    { path: "server/services/fakeEnvAdapter.ts", source: `fetch(process.env.${ENVVAR}!);` },
    { path: "server/routes/other.ts", source: `// mentions ${ENVVAR} only in a comment` },
  ],
});
assert(envOk.ok, "envVar: baseline env-var reader + comment-only file pass");
if (!envOk.ok) for (const p of envOk.problems) console.error(`    envVar problem: ${p}`);

const envNetNew = runLint({
  baseline: envBaseline,
  files: [
    { path: "server/services/fakeEnvAdapter.ts", source: `fetch(process.env.${ENVVAR}!);` },
    { path: "server/routes/sneaky.ts", source: `await fetch(process.env.${ENVVAR} + "/x");` },
  ],
});
assert(!envNetNew.ok, "envVar: net-new env-var reader FAILS (intentional-failure)");
assert(
  envNetNew.problems.some(
    (p) =>
      p.includes("server/routes/sneaky.ts") &&
      p.includes(ENVVAR) &&
      p.includes("env var") &&
      p.includes("fakeEnvAdapter"),
  ),
  "envVar: failure names the file, env var, and owning adapter",
);

const envStale = runLint({
  baseline: envBaseline,
  files: [{ path: "server/services/fakeEnvAdapter.ts", source: `// no longer reads it` }],
});
assert(
  !envStale.ok &&
    envStale.problems.some(
      (p) => p.includes("stale baseline entry") && p.includes("env var"),
    ),
  "envVar: stale baseline entry FAILS naming the env-var facet",
);

// envVars compose with import-mode vendors too (LiveKit: SDK import + env URL).
const envImportBaseline: VendorBaseline = {
  vendors: {
    fakevendor: {
      adapter: "server/services/fakeAdapter.ts",
      envVars: [ENVVAR],
      files: ["server/services/fakeAdapter.ts", "server/services/urlOnly.ts"],
      approvals: {
        "file:server/services/fakeAdapter.ts": "fixture-approved (fake vendor)",
        "file:server/services/urlOnly.ts": "fixture-approved (fake vendor)",
        [`env:${ENVVAR}`]: "fixture-approved (fake vendor)",
      },
    },
  },
};
const envImportRun = runLint({
  baseline: envImportBaseline,
  files: [
    { path: "server/services/fakeAdapter.ts", source: `import Fake from "fakevendor";` },
    // No SDK import, but reads the vendor URL env var — still a confined caller.
    { path: "server/services/urlOnly.ts", source: `const u = process.env.${ENVVAR};` },
  ],
});
assert(envImportRun.ok, "envVar: composes with import-mode detection (either facet keeps entry live)");
if (!envImportRun.ok) for (const p of envImportRun.problems) console.error(`    envVar+import problem: ${p}`);

// 8. Growth approvals (Task #5008) — blocked-unapproved-growth vs
// approved-growth, with FAKE vendor fixtures (existing convention). A
// "regenerated" baseline that grew by one net-new caller file must FAIL
// until the addition carries an explicit approval record; the same grown
// baseline WITH the approval passes; an orphan approval (shrink that kept
// its approval line) fails too.
const grownFiles = [
  { path: "server/services/fakeHostAdapter.ts", source: `fetch("https://${HOST}/v2/me");` },
  { path: "tests/fake-vendor-growth.test.ts", source: `fetch("https://${HOST}/v2/new");` },
];
const unapprovedGrowth = runLint({
  baseline: {
    vendors: {
      fakevendor: {
        adapter: "server/services/fakeHostAdapter.ts",
        detection: "host",
        hosts: [HOST],
        // Grown files list — but only the original entry is approved.
        files: ["server/services/fakeHostAdapter.ts", "tests/fake-vendor-growth.test.ts"],
        approvals: {
          "file:server/services/fakeHostAdapter.ts": "fixture-approved (fake vendor)",
          [`host:${HOST}`]: "fixture-approved (fake vendor)",
        },
      },
    },
  },
  files: grownFiles,
});
assert(!unapprovedGrowth.ok, "growth: UNAPPROVED baseline growth FAILS (blocked-unapproved-growth)");
assert(
  unapprovedGrowth.problems.some(
    (p) =>
      p.includes("UNAPPROVED baseline entry") &&
      p.includes("file:tests/fake-vendor-growth.test.ts") &&
      p.includes("L3"),
  ),
  "growth: failure names the unapproved entry key and states L3 owner approval",
);
assert(
  !unapprovedGrowth.problems.some((p) => p.includes("file:server/services/fakeHostAdapter.ts")),
  "growth: already-approved entries are not flagged",
);

const approvedGrowth = runLint({
  baseline: {
    vendors: {
      fakevendor: {
        adapter: "server/services/fakeHostAdapter.ts",
        detection: "host",
        hosts: [HOST],
        files: ["server/services/fakeHostAdapter.ts", "tests/fake-vendor-growth.test.ts"],
        approvals: {
          "file:server/services/fakeHostAdapter.ts": "fixture-approved (fake vendor)",
          "file:tests/fake-vendor-growth.test.ts": "owner-approved growth (fixture)",
          [`host:${HOST}`]: "fixture-approved (fake vendor)",
        },
      },
    },
  },
  files: grownFiles,
});
assert(approvedGrowth.ok, "growth: the SAME grown baseline WITH per-entry approval passes (approved-growth)");
if (!approvedGrowth.ok) for (const p of approvedGrowth.problems) console.error(`    growth problem: ${p}`);

// Empty/whitespace approval strings do not count as a bless.
const blankApproval = runLint({
  baseline: {
    vendors: {
      fakevendor: {
        adapter: null,
        detection: "host",
        hosts: [HOST],
        files: ["server/services/fakeHostAdapter.ts"],
        approvals: {
          "file:server/services/fakeHostAdapter.ts": "   ",
          [`host:${HOST}`]: "fixture-approved (fake vendor)",
        },
      },
    },
  },
  files: [{ path: "server/services/fakeHostAdapter.ts", source: `fetch("https://${HOST}/v2/me");` }],
});
assert(
  !blankApproval.ok && blankApproval.problems.some((p) => p.includes("UNAPPROVED baseline entry")),
  "growth: blank approval string FAILS (no empty-string bless)",
);

// Orphan approval: entry shrunk away but approval line kept ⇒ fail.
const orphanApproval = runLint({
  baseline: {
    vendors: {
      fakevendor: {
        adapter: null,
        detection: "host",
        hosts: [HOST],
        files: ["server/services/fakeHostAdapter.ts"],
        approvals: {
          "file:server/services/fakeHostAdapter.ts": "fixture-approved (fake vendor)",
          "file:tests/removed-long-ago.test.ts": "fixture-approved (fake vendor)",
          [`host:${HOST}`]: "fixture-approved (fake vendor)",
        },
      },
    },
  },
  files: [{ path: "server/services/fakeHostAdapter.ts", source: `fetch("https://${HOST}/v2/me");` }],
});
assert(
  !orphanApproval.ok &&
    orphanApproval.problems.some(
      (p) => p.includes("stale approval record") && p.includes("file:tests/removed-long-ago.test.ts"),
    ),
  "growth: orphan approval (entry removed, approval kept) FAILS as stale",
);
assert(REMEDIATION.includes("approvals"), "remediation explains the per-entry approvals mechanism");

const hostMisconfig = runLint({
  baseline: { vendors: { fakevendor: { adapter: null, detection: "host", files: [] } } },
  files: [],
});
assert(
  !hostMisconfig.ok && hostMisconfig.problems.some((p) => p.includes('no "hosts" list')),
  "host: detection 'host' without hosts list FAILS loudly",
);

// Real committed state includes the host-mode vendors.
{
  const baselineJson = JSON.parse(
    readFileSync("scripts/vendor-importer-baseline.json", "utf-8"),
  ) as VendorBaseline;
  assert(
    baselineJson.vendors["front"]?.detection === "host" &&
      baselineJson.vendors["zoom"]?.detection === "host",
    "committed baseline covers front + zoom in host mode",
  );
  // Task #4223 — remaining fetch-based vendors confined the same way.
  for (const v of ["semrush", "clickup", "rev.ai", "google-ads", "maptiler", "slack-webhook"]) {
    const entry = baselineJson.vendors[v];
    assert(
      entry?.detection === "host" &&
        Array.isArray(entry.hosts) &&
        entry.hosts.length > 0 &&
        entry.files.length > 0,
      `committed baseline covers ${v} in host mode with a frozen caller set`,
    );
  }
  // Task #4249 — env-built vendor URLs (Slack webhook, LiveKit REST) are
  // confined via envVars. Assert presence/shape only: naming the real
  // env-var strings here would put THIS file into those baselines.
  // Task #4341 adds the AI-gateway base-URL env var to the openai entry so a
  // raw fetch against the gateway (no SDK import, no literal host) is caught.
  for (const v of ["slack-webhook", "livekit-server-sdk", "openai"]) {
    const entry = baselineJson.vendors[v];
    assert(
      Array.isArray(entry?.envVars) && entry.envVars.length > 0 && entry.files.length > 0,
      `committed baseline confines ${v} vendor-URL env var(s) with a frozen caller set`,
    );
  }
  // Task #5008 — every committed entry carries a per-entry approval record
  // (and no orphans), so any future growth diff must add an approval line.
  let missingApprovals = 0;
  let orphanApprovals = 0;
  for (const [, entry] of Object.entries(baselineJson.vendors)) {
    const approvals = entry.approvals ?? {};
    const liveKeys = new Set<string>([
      ...entry.files.map((f) => `file:${f}`),
      ...(entry.hosts ?? []).map((h) => `host:${h}`),
      ...(entry.envVars ?? []).map((n) => `env:${n}`),
    ]);
    for (const k of liveKeys) {
      if (typeof approvals[k] !== "string" || approvals[k].trim() === "") missingApprovals++;
    }
    for (const k of Object.keys(approvals)) if (!liveKeys.has(k)) orphanApprovals++;
  }
  assert(
    missingApprovals === 0 && orphanApprovals === 0,
    "committed baseline: every files/hosts/envVars entry has an approval record and no orphans",
  );
}

// 5. Wiring lockstep.
const gate = readFileSync("scripts/gate.ts", "utf-8");
const drift = readFileSync("scripts/lint-gate-workflow-drift.ts", "utf-8");
assert(
  gate.includes("scripts/lint-vendor-confinement.ts"),
  "gate.ts LINT_CHECKS registers lint-vendor-confinement",
);
assert(
  /export const VALIDATION_WORKFLOW\s*=\s*\{[\s\S]*?command:\s*"npm run gate"/.test(drift),
  "VALIDATION_WORKFLOW uses command npm run gate",
);

console.log(`\nlint-vendor-confinement guard: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
