/* test-registration
{
  "name": "lint-test-fs-scan-inputs guard — fs-scanning tests must declare scanPaths (Task #4103)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4103: guards the green-skip/related-selection blindness class — a test that fs-reads repo source outside its import closure can stay green-skipped while its subject changes. Proves the lint flags undeclared repo-source fs scans, honors scanPaths coverage / lint-* core naming / ignore markers, rejects dead scanPaths, and that scanPaths actually flow into the fingerprint and selector. Fast, DB-free, tmp-fixture only.",
  "tier": "small"
}
test-registration */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runLint,
  collectStringLiterals,
  collectDynamicFsReadCalls,
  normalizeRepoSourceLiteral,
  markerHasReason,
} from "../scripts/lint-test-fs-scan-inputs.ts";
import { scanPathHit } from "./relatedSmokeSelection.ts";
import { computeSuiteFingerprints } from "./suiteFingerprint.ts";

// ---------------------------------------------------------------------------
// Fixture repo helpers (runLint takes an injectable repoRoot)
// ---------------------------------------------------------------------------

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "fs-scan-lint-fixture-"));
  mkdirSync(join(root, "tests"), { recursive: true });
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, "server/subject.ts"), "export const S = 1;\n");
  return root;
}

function writeTest(root: string, rel: string, reg: Record<string, unknown>, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const registration = { tier: "small", ...reg };
  writeFileSync(abs, `/* test-registration\n${JSON.stringify(registration, null, 2)}\ntest-registration */\n${body}`);
}

const FS_BODY = (lit: string) =>
  `import { readFileSync } from "node:fs";\nconst src = readFileSync(${JSON.stringify(lit)}, "utf8");\nconsole.log(src.length);\n`;

// ---------------------------------------------------------------------------
// The lint itself
// ---------------------------------------------------------------------------

test("undeclared repo-source fs scan in a non-core test is a violation (negative EXECUTES)", () => {
  const root = makeRepo();
  try {
    writeTest(root, "tests/guard.test.ts", { name: "g" }, FS_BODY("server/subject.ts"));
    const { ok, violations } = runLint(root);
    assert.equal(ok, false);
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /server\/subject\.ts/);
    assert.match(violations[0].message, /scanPaths/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declared scanPaths cover the scan — exact file and ancestor directory", () => {
  const root = makeRepo();
  try {
    writeTest(root, "tests/exact.test.ts", { name: "e", scanPaths: ["server/subject.ts"] }, FS_BODY("server/subject.ts"));
    writeTest(root, "tests/dir.test.ts", { name: "d", scanPaths: ["server"] }, FS_BODY("server/subject.ts"));
    const { ok, violations } = runLint(root);
    assert.equal(ok, true, JSON.stringify(violations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lint-*.test.ts naming (always-run core) is exempt; ignore marker suppresses a literal", () => {
  const root = makeRepo();
  try {
    writeTest(root, "tests/lint-something.test.ts", { name: "core" }, FS_BODY("server/subject.ts"));
    writeTest(
      root,
      "tests/marker.test.ts",
      { name: "m" },
      `// fs-scan-fixture-only -- only reads tests/fixture.json\n` +
        `import { readFileSync } from "node:fs";\n` +
        `const marker = "server/subject.ts"; // fs-scan-inputs-ignore -- assert-marker string, not an fs target\n` +
        `const fixture = readFileSync("tests/fixture.json", "utf8");\nconsole.log(marker, fixture);\n`,
    );
    writeFileSync(join(root, "tests/fixture.json"), "{}");
    const { ok, violations } = runLint(root);
    assert.equal(ok, true, JSON.stringify(violations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared scanPath that does not exist on disk is a violation (rename rot)", () => {
  const root = makeRepo();
  try {
    writeTest(root, "tests/dead.test.ts", { name: "dead", scanPaths: ["server/renamed-away.ts"] }, "console.log(1);\n");
    const { ok, violations } = runLint(root);
    assert.equal(ok, false);
    assert.match(violations[0].message, /does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture-only fs reads need the fs-scan-fixture-only marker; import specifiers are not scan targets", () => {
  const root = makeRepo();
  try {
    writeFileSync(join(root, "tests/data.json"), "{}");
    const body =
      `import { readFileSync } from "node:fs";\n` +
      `import { S } from "../server/subject.ts";\n` + // specifier — traced, not a scan
      `const data = readFileSync("tests/data.json", "utf8");\nconsole.log(S, data);\n`;
    writeTest(root, "tests/fixture-only.test.ts", { name: "f" }, body);
    const bare = runLint(root);
    assert.equal(bare.ok, false, "fs read without scanPaths or marker must violate (conservative closure)");
    assert.match(bare.violations[0].message, /fs-scan-fixture-only/);

    writeTest(
      root,
      "tests/fixture-only.test.ts",
      { name: "f" },
      `// fs-scan-fixture-only -- only reads tests/data.json fixture\n${body}`,
    );
    const marked = runLint(root);
    assert.equal(marked.ok, true, JSON.stringify(marked.violations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wholly computed repo-source path cannot slip through: scanPaths or marker is mandatory", () => {
  const root = makeRepo();
  try {
    const body =
      `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\n` +
      `const parts = ["server", "subject.ts"];\n// fs-scan-inputs-ignore -- path segments, not repo-source literals (neither matches the repo prefix regex anyway)\n` +
      `const src = readFileSync(join(process.cwd(), ...parts), "utf8");\nconsole.log(src.length);\n`;
    writeTest(root, "tests/computed.test.ts", { name: "c" }, body);
    const bare = runLint(root);
    assert.equal(bare.ok, false, "computed-path scan with no declaration must violate");
    assert.match(bare.violations[0].message, /scanPaths/);

    writeTest(root, "tests/computed.test.ts", { name: "c", scanPaths: ["server/subject.ts"] }, body);
    const declared = runLint(root);
    assert.equal(declared.ok, true, JSON.stringify(declared.violations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task #4113: wholly dynamic path evades literals but NOT the per-call check — fixture-only marker alone does not bless it", () => {
  const root = makeRepo();
  try {
    const body =
      `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\n` +
      `const segs = JSON.parse(process.env.SCAN_SEGS ?? "[]") as string[];\n` +
      `const src = readFileSync(join(process.cwd(), ...segs), "utf8");\nconsole.log(src.length);\n`;
    // fixture-only marker present: old closure passes, dynamic-call check must still fire.
    writeTest(root, "tests/dyn.test.ts", { name: "dyn" }, `// fs-scan-fixture-only -- claims fixtures only\n${body}`);
    const bare = runLint(root);
    assert.equal(bare.ok, false, "dynamic-path fs read under a fixture-only marker must violate");
    assert.match(bare.violations[0].message, /wholly dynamic path/);
    assert.match(bare.violations[0].message, /readFileSync \(line \d+\)/);

    // scanPaths declaration satisfies the requirement.
    writeTest(root, "tests/dyn.test.ts", { name: "dyn", scanPaths: ["server/subject.ts"] }, body);
    const declared = runLint(root);
    assert.equal(declared.ok, true, JSON.stringify(declared.violations));

    // Per-line ignore justification satisfies it too.
    const ignored = body.replace(
      `readFileSync(join(process.cwd(), ...segs), "utf8");`,
      `readFileSync(join(process.cwd(), ...segs), "utf8"); // fs-scan-inputs-ignore -- segs come from a tmp fixture manifest`,
    );
    writeTest(root, "tests/dyn.test.ts", { name: "dyn" }, `// fs-scan-fixture-only -- fixtures only\n${ignored}`);
    const marked = runLint(root);
    assert.equal(marked.ok, true, JSON.stringify(marked.violations));

    // Core naming stays exempt.
    writeTest(root, "tests/lint-dyn.test.ts", { name: "core-dyn" }, body);
    rmSync(join(root, "tests/dyn.test.ts"));
    const core = runLint(root);
    assert.equal(core.ok, true, JSON.stringify(core.violations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectDynamicFsReadCalls: literal-bearing args are not dynamic; bare-variable and spread args are", () => {
  const src = [
    `import { readFileSync, readdirSync } from "node:fs";`,
    `import fs from "node:fs";`,
    `const p = process.env.P!;`,
    `readFileSync(p, "utf8");`, // dynamic
    `fs.readdirSync(someDir);`, // dynamic (property access)
    `readFileSync(join(root, "server/x.ts"), "utf8");`, // literal inside → not dynamic
    `readFileSync("tests/data.json", "utf8");`, // literal → not dynamic
    `readFileSync(\`\${root}/server/x.ts\`, "utf8");`, // template chunk text → not dynamic
    `readFileSync(\`\${a}\${b}\`, "utf8");`, // no literal text anywhere → dynamic
    `const s = "readFileSync(evade)";`, // string content, not a call
  ].join("\n");
  const calls = collectDynamicFsReadCalls(src);
  assert.deepEqual(
    calls.map((c) => c.line).sort((a, b) => a - b),
    [4, 5, 9],
    JSON.stringify(calls),
  );
});

test("Task #4117: bare escape-hatch markers without a -- <reason> tail are violations and do not suppress", () => {
  const root = makeRepo();
  try {
    // Bare ignore marker: violation for the bare marker AND the literal is NOT suppressed.
    writeTest(
      root,
      "tests/bare-ignore.test.ts",
      { name: "bi" },
      `import { readFileSync } from "node:fs";\n` +
        `const src = readFileSync("server/subject.ts", "utf8"); // fs-scan-inputs-ignore\n` +
        `console.log(src.length);\n`,
    );
    const ig = runLint(root);
    assert.equal(ig.ok, false);
    assert.ok(
      ig.violations.some((v) => /bare "fs-scan-inputs-ignore" marker/.test(v.message)),
      JSON.stringify(ig.violations),
    );
    assert.ok(
      ig.violations.some((v) => /server\/subject\.ts/.test(v.message)),
      "bare marker must not suppress the repo-source literal: " + JSON.stringify(ig.violations),
    );
    rmSync(join(root, "tests/bare-ignore.test.ts"));

    // Bare fixture-only marker: violation, and the conservative closure still fires.
    writeFileSync(join(root, "tests/data.json"), "{}");
    writeTest(
      root,
      "tests/bare-fixture.test.ts",
      { name: "bf" },
      `// fs-scan-fixture-only\n` +
        `import { readFileSync } from "node:fs";\n` +
        `const data = readFileSync("tests/data.json", "utf8");\nconsole.log(data);\n`,
    );
    const fo = runLint(root);
    assert.equal(fo.ok, false);
    assert.ok(
      fo.violations.some((v) => /bare "fs-scan-fixture-only" marker/.test(v.message)),
      JSON.stringify(fo.violations),
    );
    assert.ok(
      fo.violations.some((v) => /carries no/.test(v.message)),
      "bare fixture-only marker must not satisfy the conservative closure: " + JSON.stringify(fo.violations),
    );
    rmSync(join(root, "tests/bare-fixture.test.ts"));

    // Marker with an empty reason ("-- " and nothing after) is still bare.
    writeTest(
      root,
      "tests/empty-reason.test.ts",
      { name: "er" },
      `// fs-scan-fixture-only -- \n` +
        `import { readFileSync } from "node:fs";\n` +
        `const data = readFileSync("tests/data.json", "utf8");\nconsole.log(data);\n`,
    );
    const er = runLint(root);
    assert.equal(er.ok, false);
    assert.ok(
      er.violations.some((v) => /bare "fs-scan-fixture-only" marker/.test(v.message)),
      JSON.stringify(er.violations),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task #4117: markerHasReason unit — reason required, whitespace-only rejected", () => {
  assert.equal(markerHasReason(`// fs-scan-inputs-ignore -- real reason`, "fs-scan-inputs-ignore"), true);
  assert.equal(markerHasReason(`// fs-scan-inputs-ignore`, "fs-scan-inputs-ignore"), false);
  assert.equal(markerHasReason(`// fs-scan-inputs-ignore --`, "fs-scan-inputs-ignore"), false);
  assert.equal(markerHasReason(`// fs-scan-inputs-ignore --   `, "fs-scan-inputs-ignore"), false);
  assert.equal(markerHasReason(`no marker here`, "fs-scan-inputs-ignore"), false);
});

test("../-relative fs-read literals normalize against the test file's directory", () => {
  const root = makeRepo();
  try {
    writeTest(root, "tests/rel.test.ts", { name: "r" }, FS_BODY("../server/subject.ts"));
    const { ok, violations } = runLint(root);
    assert.equal(ok, false);
    assert.match(violations[0].message, /server\/subject\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Literal collection + normalization units
// ---------------------------------------------------------------------------

test("collectStringLiterals skips comments, regexes, dynamic templates and import specifiers", () => {
  const src = [
    `// "server/in-comment.ts"`,
    `/* "server/in-block.ts" */`,
    `const re = /server\\/in-regex\\.ts/;`,
    `const dyn = \`server/boot/\${name}.ts\`;`,
    `import x from "server/spec.ts";`,
    `const real = "server/real.ts";`,
  ].join("\n");
  const values = collectStringLiterals(src).map((l) => l.value);
  assert.ok(values.includes("server/real.ts"));
  assert.ok(!values.some((v) => v.includes("in-comment") || v.includes("in-block") || v.includes("in-regex")));
  assert.ok(!values.includes("server/spec.ts"));
  assert.ok(!values.some((v) => v.startsWith("server/boot/")));
});

test("normalizeRepoSourceLiteral: repo prefixes, .replit, relative resolution, junk rejection", () => {
  assert.equal(normalizeRepoSourceLiteral("server/foo.ts", "tests/x.test.ts"), "server/foo.ts");
  assert.equal(normalizeRepoSourceLiteral("../server/foo.ts", "tests/x.test.ts"), "server/foo.ts");
  assert.equal(normalizeRepoSourceLiteral("../../client/src/App.tsx", "tests/client/x.test.tsx"), "client/src/App.tsx");
  assert.equal(normalizeRepoSourceLiteral(".replit", "tests/x.test.ts"), ".replit");
  assert.equal(normalizeRepoSourceLiteral("tests/fixture.json", "tests/x.test.ts"), null);
  assert.equal(normalizeRepoSourceLiteral("server/foo.ts(12,3): error", "tests/x.test.ts"), null);
  assert.equal(normalizeRepoSourceLiteral("not a path", "tests/x.test.ts"), null);
});

test("scanPathHit: exact file, directory prefix, non-hit", () => {
  assert.equal(scanPathHit("server/foo.ts", ["server/foo.ts"]), "server/foo.ts");
  assert.equal(scanPathHit("server/boot/init.ts", ["server/boot"]), "server/boot");
  assert.equal(scanPathHit("server/bootstrap.ts", ["server/boot"]), null);
  assert.equal(scanPathHit("server/foo.ts", undefined), null);
});

// ---------------------------------------------------------------------------
// End-to-end: scanPaths flow into the green-skip fingerprint
// ---------------------------------------------------------------------------

test("editing a declared scanPath target flips the fingerprint; undeclared suites are untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "fs-scan-fp-fixture-"));
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server/subject.ts"), "export const S = 1;\n");
    writeFileSync(join(root, "tests/scan.test.ts"), "console.log('scan');\n");
    writeFileSync(join(root, "tests/other.test.ts"), "console.log('other');\n");

    const suites = [
      { file: "tests/scan.test.ts", scanPaths: ["server/subject.ts"] },
      { file: "tests/other.test.ts" },
    ];
    const before = await computeSuiteFingerprints(suites, root);
    assert.equal(before.ok, true, before.error ?? "");
    const scanBefore = before.bySuite.get("tests/scan.test.ts")!.fingerprint;
    const otherBefore = before.bySuite.get("tests/other.test.ts")!.fingerprint;
    assert.ok(scanBefore && otherBefore);

    writeFileSync(join(root, "server/subject.ts"), "export const S = 2; // edited\n");
    const after = await computeSuiteFingerprints(suites, root);
    assert.equal(after.ok, true, after.error ?? "");
    assert.notEqual(after.bySuite.get("tests/scan.test.ts")!.fingerprint, scanBefore, "scanned-subject edit must invalidate the declaring suite");
    assert.equal(after.bySuite.get("tests/other.test.ts")!.fingerprint, otherBefore, "non-declaring suite must be unaffected");

    // Deleting the subject also flips (hashes as <missing>) but stays skippable.
    rmSync(join(root, "server/subject.ts"));
    const gone = await computeSuiteFingerprints(suites, root);
    assert.equal(gone.ok, true, gone.error ?? "");
    const rec = gone.bySuite.get("tests/scan.test.ts")!;
    assert.ok(rec.fingerprint, "missing scanPath still fingerprints");
    assert.notEqual(rec.fingerprint, after.bySuite.get("tests/scan.test.ts")!.fingerprint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Live-repo invariant: the shipped lint passes against HEAD
// ---------------------------------------------------------------------------

test("the real repository passes the lint (and actually checked files)", () => {
  const { ok, violations, checked } = runLint();
  assert.equal(ok, true, violations.map((v) => `${v.file}: ${v.message}`).join("\n"));
  assert.ok(checked > 50, `expected the live repo to have many fs-reading test files, got ${checked}`);
});
