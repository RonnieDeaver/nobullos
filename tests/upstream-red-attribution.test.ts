/* test-registration
{
  "name": "Upstream red-manifest attribution + excusal rails (Task #3922)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3922: the attribution layer decides whether a smoke-gate failure may be excused as inherited from upstream; a bug here could excuse a task-caused failure (silent regression passthrough) or re-create the duplicate-fix storms it exists to stop. Fast fixture tests (tmpdir + fs/JSON, one esbuild trace): no DB, no spawned children, no network. Also in the always-run core (DEFAULT_CORE_RULES) because it pins run-all wiring via fs, invisible to import tracing.",
  "tier": "small"
}
test-registration */
/**
 * Task #3922 — Proves the safety rails of the upstream-health red manifest
 * and the automatic failure-attribution/excusal layer (tests/redManifest.ts):
 *
 *   1. Signature classes: exit codes compare exactly, hangs compare as a
 *      class, empty/garbage signatures never match anything.
 *   2. loadRedManifest discards WHOLESALE on any schema/algo/shape problem —
 *      partial trust is never extended.
 *   3. publishRedManifest: wholesale replace, firstRedAt carried while the
 *      same breakage persists (reset on signature change), a green run
 *      publishes an EMPTY manifest, and entries can never masquerade as
 *      green-baseline records (loadGreenBaseline rejects a red manifest).
 *   4. classifyFailure is CONSERVATIVE: the "inherited" verdict (the only
 *      excusable one) requires manifest hit + signature match + fingerprint
 *      equality; every weaker chain — and any classification error — falls
 *      open to "yours".
 *   5. attributeRunFailures: excusal respects the armed flag, blocking lists
 *      stay conservative, the machine-readable report lands with counts, and
 *      report-write failures degrade without throwing.
 *   6. Wiring pins (fs): run-all publishes the red manifest under the nightly
 *      publish flag with exactly one call site, arms excusal only for the
 *      smoke gate outside the publish arm with the TEST_ATTRIBUTION_EXCUSE
 *      kill switch, and the shim-tree hash excludes the committed manifest so
 *      nightly publishes never invalidate extraNodeArgs fingerprints.
 *   7. REPO INTEGRATION: the committed tests/red-manifest.json parses clean.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ATTRIBUTION_REPORT_PATH,
  DEFAULT_RED_MANIFEST_PATH,
  RED_MANIFEST_SCHEMA_VERSION,
  SUPPORTED_RED_MANIFEST_SCHEMA_VERSIONS,
  RED_MANIFEST_STALE_AFTER_DAYS,
  attributeRunFailures,
  classifyFailure,
  loadRedManifest,
  normalizeFailureSignature,
  publishRedManifest,
  signaturesMatch,
  type RedManifest,
} from "./redManifest";
import {
  FINGERPRINT_ALGO_VERSION,
  computeSuiteFingerprints,
  loadGreenBaseline,
  type SuiteLike,
} from "./suiteFingerprint";

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

const NOW = new Date("2026-08-06T03:30:00.000Z");
const LATER = new Date("2026-08-07T03:30:00.000Z");

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "red-manifest-"));
}

function validManifest(overrides?: Partial<RedManifest>): RedManifest {
  return {
    schemaVersion: RED_MANIFEST_SCHEMA_VERSION,
    fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
    publishedAt: NOW.toISOString(),
    commit: "aaaabbbbccccddddeeeeffff0000111122223333",
    entries: {
      "tests/red-suite.test.ts": {
        failureSignature: "exit 1",
        fingerprint: "fp-red-suite-at-main",
        firstRedAt: "2026-08-05T03:30:00.000Z",
        lastRedAt: NOW.toISOString(),
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Signature classes
// ---------------------------------------------------------------------------

test("failure signatures: exit codes compare exactly, hangs compare as a class", () => {
  assert.equal(normalizeFailureSignature("exit 1"), "exit 1");
  assert.equal(normalizeFailureSignature("hang 184s"), "hang");
  assert.equal(normalizeFailureSignature("  hang 240s "), "hang");
  assert.ok(signaturesMatch("exit 1", "exit 1"));
  assert.ok(signaturesMatch("hang 184s", "hang 240s"), "hang seconds vary with the configured timeout, not the breakage");
  assert.ok(!signaturesMatch("exit 1", "exit 2"), "different exit codes are different breakage");
  assert.ok(!signaturesMatch("exit 1", "hang 184s"));
  assert.ok(!signaturesMatch("", ""), "empty signatures never match");
  assert.ok(!signaturesMatch("   ", "   "));
});

// ---------------------------------------------------------------------------
// 2. Wholesale discard on load
// ---------------------------------------------------------------------------

test("loadRedManifest: missing file is silent-null; any schema/algo/shape problem discards WHOLESALE with a note", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "red-manifest.json");
    assert.deepEqual(loadRedManifest(p), { manifest: null, note: null }, "absent file is normal (pre-first-publish)");

    writeFileSync(p, "{not json");
    let res = loadRedManifest(p);
    assert.equal(res.manifest, null);
    assert.ok(res.note, "parse failure carries a note");

    writeFileSync(p, JSON.stringify(validManifest({ schemaVersion: 99 })));
    res = loadRedManifest(p);
    assert.equal(res.manifest, null);
    assert.match(res.note ?? "", /schemaVersion/);

    writeFileSync(p, JSON.stringify(validManifest({ fingerprintAlgo: "fp-v999" })));
    res = loadRedManifest(p);
    assert.equal(res.manifest, null);
    assert.match(res.note ?? "", /fingerprintAlgo/);

    const missingStamps = validManifest() as unknown as Record<string, unknown>;
    delete missingStamps.commit;
    writeFileSync(p, JSON.stringify(missingStamps));
    res = loadRedManifest(p);
    assert.equal(res.manifest, null);
    assert.match(res.note ?? "", /stamps/);

    // ONE malformed entry poisons the whole manifest — no partial trust.
    const badEntry = validManifest();
    (badEntry.entries as Record<string, unknown>)["tests/other.test.ts"] = { failureSignature: 42 };
    writeFileSync(p, JSON.stringify(badEntry));
    res = loadRedManifest(p);
    assert.equal(res.manifest, null);
    assert.match(res.note ?? "", /malformed/);

    writeFileSync(p, `${JSON.stringify(validManifest(), null, 2)}\n`);
    res = loadRedManifest(p);
    assert.ok(res.manifest, "valid manifest loads");
    assert.equal(res.note, null);
    assert.equal(res.manifest?.entries["tests/red-suite.test.ts"]?.failureSignature, "exit 1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Publish semantics
// ---------------------------------------------------------------------------

test("publishRedManifest: wholesale replace, firstRedAt carry/reset, empty publish on green, never green-record shaped", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "red-manifest.json");
    const first = publishRedManifest({
      manifestPath: p,
      commit: "commit-one",
      now: NOW,
      failures: [
        { file: "tests/x.test.ts", failureReason: "exit 1", fingerprint: "fp-x" },
        { file: "tests/y.test.ts", failureReason: "hang 184s", fingerprint: null },
      ],
    });
    assert.deepEqual(first, {
      published: true,
      count: 2,
      lintCount: 0,
      note: null,
      // Task #5030: both suites are newly red vs the (absent) prior manifest.
      newRedFiles: ["tests/x.test.ts", "tests/y.test.ts"],
      previousCommit: null,
    });
    const m1 = loadRedManifest(p).manifest!;
    assert.equal(m1.commit, "commit-one");
    assert.equal(m1.entries["tests/x.test.ts"].firstRedAt, NOW.toISOString());

    // Next night: x still red with the same breakage (carry firstRedAt even
    // though the hang seconds differ), y healed (drops out), z newly red.
    const second = publishRedManifest({
      manifestPath: p,
      commit: "commit-two",
      now: LATER,
      failures: [
        { file: "tests/x.test.ts", failureReason: "exit 1", fingerprint: "fp-x2" },
        { file: "tests/z.test.ts", failureReason: "hang 200s", fingerprint: "fp-z" },
      ],
    });
    assert.deepEqual(second, {
      published: true,
      count: 2,
      lintCount: 0,
      note: null,
      // Task #5030: x carries the same breakage (not new); z is new.
      newRedFiles: ["tests/z.test.ts"],
      previousCommit: "commit-one",
    });
    const m2 = loadRedManifest(p).manifest!;
    assert.deepEqual(Object.keys(m2.entries).sort(), ["tests/x.test.ts", "tests/z.test.ts"], "wholesale replace: healed suites drop out");
    assert.equal(m2.entries["tests/x.test.ts"].firstRedAt, NOW.toISOString(), "firstRedAt carried while the same breakage persists");
    assert.equal(m2.entries["tests/x.test.ts"].lastRedAt, LATER.toISOString());
    assert.equal(m2.entries["tests/z.test.ts"].firstRedAt, LATER.toISOString());

    // Signature CHANGE resets firstRedAt — different breakage, new clock.
    const third = publishRedManifest({
      manifestPath: p,
      commit: "commit-three",
      now: LATER,
      failures: [{ file: "tests/x.test.ts", failureReason: "exit 7", fingerprint: "fp-x3" }],
    });
    assert.equal(third.published, true);
    const m3 = loadRedManifest(p).manifest!;
    assert.equal(m3.entries["tests/x.test.ts"].firstRedAt, LATER.toISOString(), "signature change resets firstRedAt");

    // Green run → EMPTY manifest (stale reds clear), still a valid manifest.
    const green = publishRedManifest({ manifestPath: p, commit: "commit-four", now: LATER, failures: [] });
    assert.deepEqual(green, {
      published: true,
      count: 0,
      lintCount: 0,
      note: null,
      newRedFiles: [],
      previousCommit: "commit-three",
    });
    const m4 = loadRedManifest(p).manifest!;
    assert.deepEqual(m4.entries, {});

    // The red manifest can NEVER seed greens: pointed at as a baseline it is
    // rejected outright (no "records" array, entries carry no verdict).
    writeFileSync(p, `${JSON.stringify(validManifest(), null, 2)}\n`);
    const asBaseline = loadGreenBaseline(p);
    assert.equal(asBaseline.baseline, null, "loadGreenBaseline discards a red manifest wholesale");
    assert.ok(asBaseline.note, "with an explanatory note");
    assert.ok(!readFileSync(p, "utf8").includes('"verdict"'), "red entries never carry a verdict field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishRedManifest never throws: unwritable destination degrades to a note", () => {
  const root = tmpRoot();
  try {
    const fileAsDir = join(root, "occupied");
    writeFileSync(fileAsDir, "i am a file");
    const res = publishRedManifest({
      manifestPath: join(fileAsDir, "red-manifest.json"),
      commit: "c",
      now: NOW,
      failures: [],
    });
    assert.equal(res.published, false);
    assert.match(res.note ?? "", /publish failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Conservative classification
// ---------------------------------------------------------------------------

test("classifyFailure: 'inherited' requires manifest hit + signature match + fingerprint equality; every weaker chain is 'yours'", () => {
  const manifest = validManifest();
  const base = {
    file: "tests/red-suite.test.ts",
    failureReason: "exit 1",
    currentFingerprint: "fp-red-suite-at-main",
    manifest,
    // Task #4480: pin the clock so the fixture manifest reads as FRESH —
    // staleness behavior has its own dedicated tests below.
    now: NOW,
  };

  const full = classifyFailure(base);
  assert.equal(full.verdict, "inherited");
  assert.equal(full.excusable, true);
  assert.ok(full.evidence.some((e) => e.includes("red at upstream main since")), "evidence cites the manifest hit");
  assert.ok(full.evidence.some((e) => e.includes("fingerprint identical")), "evidence cites the fingerprint proof");

  assert.equal(classifyFailure({ ...base, manifest: null }).verdict, "yours", "no manifest → yours");
  assert.equal(
    classifyFailure({ ...base, file: "tests/unlisted.test.ts" }).verdict,
    "yours",
    "not listed (main green here) → yours",
  );
  assert.equal(classifyFailure({ ...base, failureReason: "exit 2" }).verdict, "yours", "signature mismatch → yours");
  assert.equal(
    classifyFailure({ ...base, currentFingerprint: "fp-DIFFERENT" }).verdict,
    "yours",
    "fingerprint mismatch (inputs changed — could be the task diff) → yours",
  );
  assert.equal(classifyFailure({ ...base, currentFingerprint: null }).verdict, "yours", "no local fingerprint → yours");

  const noMainFp = validManifest();
  noMainFp.entries["tests/red-suite.test.ts"].fingerprint = null;
  assert.equal(
    classifyFailure({ ...base, manifest: noMainFp }).verdict,
    "yours",
    "main recorded no fingerprint → disjointness unprovable → yours",
  );

  // Malformed entry reached classification anyway → error falls open to yours.
  const poisoned = validManifest();
  (poisoned.entries as Record<string, unknown>)["tests/red-suite.test.ts"] = { failureSignature: null };
  const errored = classifyFailure({ ...base, manifest: poisoned });
  assert.equal(errored.verdict, "yours");
  assert.equal(errored.excusable, false);
});

test("classifyFailure: flake-history is corroborating evidence only, never a proof path", () => {
  const res = classifyFailure({
    file: "tests/unlisted.test.ts",
    failureReason: "exit 1",
    currentFingerprint: "fp",
    manifest: validManifest(),
    now: NOW,
    priorRecords: [
      { at: "2026-08-04T03:30:00.000Z", outcome: "failed" },
      { at: "2026-08-05T03:30:00.000Z", outcome: "failed" },
    ],
  });
  assert.equal(res.verdict, "yours", "history alone cannot flip the verdict");
  assert.ok(res.evidence.some((e) => e.includes("flake-history") && e.includes("not proof")));
});

// ---------------------------------------------------------------------------
// 5. Run-level orchestration
// ---------------------------------------------------------------------------

test("Task #4480 — stale manifest: not-listed downgrades to UNATTRIBUTABLE (still blocking, never excusable); fresh manifest unchanged; proof-complete inheritance unaffected", () => {
  const manifest = validManifest(); // publishedAt = NOW
  const STALE_NOW = new Date(NOW.getTime() + (RED_MANIFEST_STALE_AFTER_DAYS + 1) * 86_400_000);

  // Fresh manifest ⇒ current behavior unchanged: not listed → "yours" with
  // the "main was green here" claim.
  const fresh = classifyFailure({
    file: "tests/unlisted.test.ts",
    failureReason: "exit 1",
    currentFingerprint: "fp",
    manifest,
    now: LATER, // 1d after publish — inside the threshold
  });
  assert.equal(fresh.verdict, "yours");
  assert.ok(fresh.evidence.some((e) => e.includes("main was green here")));

  // Stale manifest ⇒ downgraded verdict + honest evidence, never the false
  // green claim, and NEVER excusable.
  const stale = classifyFailure({
    file: "tests/unlisted.test.ts",
    failureReason: "exit 1",
    currentFingerprint: "fp",
    manifest,
    now: STALE_NOW,
  });
  assert.equal(stale.verdict, "unattributable");
  assert.equal(stale.excusable, false, "unattributable is NEVER excusable");
  assert.ok(stale.evidence.some((e) => e.includes("STALE")), "evidence names the staleness");
  assert.ok(
    stale.evidence.some((e) => e.includes("does NOT prove main is currently green")),
    "evidence is honest about what the manifest cannot prove",
  );
  assert.ok(
    !stale.evidence.some((e) => e.includes("main was green here")),
    "the false green claim is gone",
  );

  // Unparseable publishedAt counts as stale (freshness we cannot measure).
  const undated = validManifest({ publishedAt: "not-a-date" } as Partial<RedManifest>);
  const unparseable = classifyFailure({
    file: "tests/unlisted.test.ts",
    failureReason: "exit 1",
    currentFingerprint: "fp",
    manifest: undated,
    now: NOW,
  });
  assert.equal(unparseable.verdict, "unattributable");

  // The full inheritance proof (hit + signature + fingerprint equality) is
  // age-independent: byte-identical inputs prove disjointness regardless of
  // when main measured the red. Staleness must not break excusal.
  const inherited = classifyFailure({
    file: "tests/red-suite.test.ts",
    failureReason: "exit 1",
    currentFingerprint: "fp-red-suite-at-main",
    manifest,
    now: STALE_NOW,
  });
  assert.equal(inherited.verdict, "inherited");
  assert.equal(inherited.excusable, true);

  // A listed entry with a signature mismatch stays "yours" (its evidence was
  // already honest) but now carries a staleness note.
  const mismatch = classifyFailure({
    file: "tests/red-suite.test.ts",
    failureReason: "exit 2",
    currentFingerprint: "fp-red-suite-at-main",
    manifest,
    now: STALE_NOW,
  });
  assert.equal(mismatch.verdict, "yours");
  assert.ok(mismatch.evidence.some((e) => e.includes("STALE")), "stale note rides along on entry-hit paths");
});

test("Task #4480 — attributeRunFailures surfaces staleness: banner line, UNATTRIBUTABLE verdict lines, report fields; blocking set unchanged", () => {
  const root = tmpRoot();
  try {
    const manifestPath = join(root, "red-manifest.json");
    // The incident shape: an EMPTY manifest frozen days ago.
    writeFileSync(manifestPath, `${JSON.stringify(validManifest({ entries: {} }), null, 2)}\n`);
    const reportPath = join(root, "attribution-report.json");
    const STALE_NOW = new Date(NOW.getTime() + (RED_MANIFEST_STALE_AFTER_DAYS + 1.5) * 86_400_000);
    const res = attributeRunFailures({
      repoRoot: root,
      mode: "smoke",
      failures: [{ file: "tests/mine.test.ts", name: "my suite", failureReason: "exit 1" }],
      fingerprints: new Map([["tests/mine.test.ts", "fp-mine"]]),
      excusalArmed: true,
      manifestPath,
      reportPath,
      now: STALE_NOW,
    });
    assert.deepEqual(res.excusedFiles, [], "stale baseline excuses NOTHING");
    assert.deepEqual(res.blockingFiles, ["tests/mine.test.ts"], "unattributable still blocks");
    assert.ok(res.manifestStaleness?.stale, "result exposes staleness for run-all's summary callout");
    assert.ok(res.lines.some((l) => l.includes("⚠ STALE BASELINE")), "prominent banner under the header");
    assert.ok(res.lines.some((l) => l.includes("UNATTRIBUTABLE (stale baseline; still blocking)")));
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.manifest.stale, true);
    assert.equal(report.manifest.staleAfterDays, RED_MANIFEST_STALE_AFTER_DAYS);
    assert.equal(report.failures[0].verdict, "unattributable");
    assert.equal(report.failures[0].excused, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task #4480 — staleness threshold stays in lockstep with the nightly baseline-age alert, and run-all prints the final-summary callout", () => {
  // Text pin instead of an import: pulling the scheduler module into this
  // hermetic fixture suite would drag the server DB chain in.
  const scheduler = readFileSync("server/services/regressionSweepScheduler.ts", "utf8");
  const m = scheduler.match(/BASELINE_STALENESS_ALERT_DAYS\s*=\s*(\d+)/);
  assert.ok(m, "BASELINE_STALENESS_ALERT_DAYS found in the scheduler");
  assert.equal(Number(m![1]), RED_MANIFEST_STALE_AFTER_DAYS, "attribution staleness mirrors the nightly alert window");

  const runAll = readFileSync("tests/run-all.ts", "utf8");
  assert.ok(runAll.includes("staleBaselineSummary"), "run-all carries the staleness callout to the verdict lines");
  assert.ok(runAll.includes("manifestStaleness"), "run-all consumes the attribution staleness result");
});

test("attributeRunFailures: armed excusal splits excused/blocking, disarmed keeps everything blocking, report lands with counts", () => {
  const root = tmpRoot();
  try {
    const manifestPath = join(root, "red-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(validManifest(), null, 2)}\n`);
    const reportPath = join(root, "attribution-report.json");
    const failures = [
      { file: "tests/red-suite.test.ts", name: "red suite", failureReason: "exit 1" },
      { file: "tests/mine.test.ts", name: "my suite", failureReason: "exit 1" },
    ];
    const fingerprints = new Map<string, string | null>([
      ["tests/red-suite.test.ts", "fp-red-suite-at-main"],
      ["tests/mine.test.ts", "fp-mine"],
    ]);

    const armed = attributeRunFailures({
      repoRoot: root,
      mode: "smoke",
      failures,
      fingerprints,
      excusalArmed: true,
      manifestPath,
      reportPath,
      now: NOW,
    });
    assert.deepEqual(armed.excusedFiles, ["tests/red-suite.test.ts"]);
    assert.deepEqual(armed.blockingFiles, ["tests/mine.test.ts"]);
    assert.ok(armed.lines.some((l) => l.includes("INHERITED FROM UPSTREAM, excused")));
    assert.ok(armed.lines.some((l) => l.includes("tests/mine.test.ts — YOURS")));
    assert.equal(armed.reportPath, reportPath);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.schemaVersion, 4);
    assert.equal(report.manifest.stale, false, "fresh manifest reports stale:false");
    assert.equal(typeof report.manifest.ageDays, "number");
    assert.ok(
      report.failures.every((f: { historyKind: string }) => ["none", "flaky", "recovered"].includes(f.historyKind)),
      "every report failure carries a structured historyKind",
    );
    assert.equal(report.excusedCount, 1);
    assert.equal(report.blockingCount, 1);
    assert.equal(report.failures.find((f: { file: string }) => f.file === "tests/red-suite.test.ts").excused, true);
    assert.ok(Array.isArray(report.failures[0].evidence) && report.failures[0].evidence.length > 0, "report carries citable evidence");

    const disarmed = attributeRunFailures({
      repoRoot: root,
      mode: "regression",
      failures,
      fingerprints,
      excusalArmed: false,
      manifestPath,
      reportPath,
      now: NOW,
    });
    assert.deepEqual(disarmed.excusedFiles, [], "disarmed → nothing excused");
    assert.deepEqual(disarmed.blockingFiles.sort(), ["tests/mine.test.ts", "tests/red-suite.test.ts"]);
    assert.ok(
      disarmed.lines.some((l) => l.includes("INHERITED FROM UPSTREAM (excusal not armed")),
      "inherited verdict still surfaces for visibility",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attributeRunFailures: absent manifest and null fingerprints mean every failure blocks; report-write failure degrades without throwing", () => {
  const root = tmpRoot();
  try {
    const failures = [{ file: "tests/a.test.ts", name: "a", failureReason: "exit 1" }];
    const res = attributeRunFailures({
      repoRoot: root,
      mode: "smoke",
      failures,
      fingerprints: null,
      excusalArmed: true,
      manifestPath: join(root, "does-not-exist.json"),
      reportPath: join(root, "report.json"),
      now: NOW,
    });
    assert.deepEqual(res.excusedFiles, []);
    assert.deepEqual(res.blockingFiles, ["tests/a.test.ts"]);
    assert.ok(res.lines.some((l) => l.includes("manifest absent")), "absence is stated, not hidden");

    const fileAsDir = join(root, "occupied");
    writeFileSync(fileAsDir, "file");
    const degraded = attributeRunFailures({
      repoRoot: root,
      mode: "smoke",
      failures,
      fingerprints: null,
      excusalArmed: true,
      manifestPath: join(root, "does-not-exist.json"),
      reportPath: join(fileAsDir, "report.json"),
      now: NOW,
    });
    assert.equal(degraded.reportPath, null);
    assert.ok(degraded.lines.some((l) => l.includes("report write failed")));
    assert.deepEqual(degraded.blockingFiles, ["tests/a.test.ts"], "verdicts unaffected by report-write failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Wiring pins (fs — this suite is in the always-run core for this reason)
// ---------------------------------------------------------------------------

test("run-all wiring: single red-publish call site under the nightly flag, and excusal armed only for the non-publishing smoke gate", () => {
  const runAll = readFileSync("tests/run-all.ts", "utf8");
  assert.ok(runAll.includes("publishRedManifest({"), "run-all is the red-manifest publish call site");
  assert.equal(
    runAll.indexOf("publishRedManifest({"),
    runAll.lastIndexOf("publishRedManifest({"),
    "exactly one red-publish call site in run-all",
  );
  const redBlock = runAll.slice(runAll.indexOf("Task #3922: the RED sibling"), runAll.indexOf("publishRedManifest({"));
  assert.ok(
    redBlock.includes('process.env.TEST_GREEN_BASELINE_PUBLISH === "1"'),
    "red publish is gated on the same nightly publish flag as the green baseline",
  );
  assert.ok(
    runAll.includes('sweepMode === "smoke" &&') &&
      runAll.includes('process.env.TEST_GREEN_BASELINE_PUBLISH !== "1"') &&
      runAll.includes('process.env.TEST_ATTRIBUTION_EXCUSE !== "0"'),
    "excusal arms only for the smoke gate, never on the publish arm, with the TEST_ATTRIBUTION_EXCUSE kill switch",
  );
  assert.ok(
    !readFileSync("tests/redManifest.ts", "utf8").includes("TEST_GREEN_BASELINE_PUBLISH"),
    "tests/redManifest.ts stays out of the publish-flag writer chain (receives booleans instead)",
  );
});

test("Task #4501 canary wiring: upsertRedManifestEntries has exactly one call site and it is in scripts/post-merge-canary.ts, which does not contain TEST_GREEN_BASELINE_PUBLISH", () => {
  // Verify that the ONLY call site of upsertRedManifestEntries is the post-merge canary.
  // run-all.ts uses publishRedManifest (single-writer wholesale); the canary uses upsert
  // (partial update that preserves publishedAt so staleness verdicts stay meaningful).
  const canarySource = readFileSync("scripts/post-merge-canary.ts", "utf8");
  const runAllSource = readFileSync("tests/run-all.ts", "utf8");
  const redManifestSource = readFileSync("tests/redManifest.ts", "utf8");

  assert.ok(
    canarySource.includes("upsertRedManifestEntries("),
    "scripts/post-merge-canary.ts must call upsertRedManifestEntries",
  );
  assert.ok(
    !runAllSource.includes("upsertRedManifestEntries("),
    "tests/run-all.ts must NOT call upsertRedManifestEntries (it uses publishRedManifest)",
  );
  // The canary must never advance publishedAt — verify it does not call publishRedManifest.
  assert.ok(
    !canarySource.includes("publishRedManifest("),
    "scripts/post-merge-canary.ts must NOT call publishRedManifest (partial upsert only)",
  );
  // The canary must not reference the nightly publish flag (it is a separate code path).
  assert.ok(
    !canarySource.includes("TEST_GREEN_BASELINE_PUBLISH"),
    "scripts/post-merge-canary.ts must not reference TEST_GREEN_BASELINE_PUBLISH (that flag belongs to run-all's nightly publish arm)",
  );
  // redManifest.ts still stays out of the publish-flag chain.
  assert.ok(
    !redManifestSource.includes("TEST_GREEN_BASELINE_PUBLISH"),
    "tests/redManifest.ts must not reference TEST_GREEN_BASELINE_PUBLISH",
  );
  // The canary must always exit 0 — check it ends with process.exit(0).
  assert.ok(
    canarySource.includes("process.exit(0)"),
    "scripts/post-merge-canary.ts must call process.exit(0) (always exits 0, never blocks post-merge)",
  );
});

test("REPO INTEGRATION: the committed red manifest parses clean under the current schema/algo versions", () => {
  const res = loadRedManifest(DEFAULT_RED_MANIFEST_PATH);
  assert.equal(res.note, null, `committed manifest must load cleanly (note: ${res.note})`);
  assert.ok(res.manifest, "committed tests/red-manifest.json exists and is valid");
  // Task #4491 — the committed manifest may still be v1 until the next
  // nightly publish rewrites it as v2; the loader accepts both (v1 ⇒ lints {}).
  assert.ok(
    SUPPORTED_RED_MANIFEST_SCHEMA_VERSIONS.includes(res.manifest?.schemaVersion ?? -1),
    `committed manifest schemaVersion ${res.manifest?.schemaVersion} must be a supported version`,
  );
  assert.ok(res.manifest && typeof res.manifest.lints === "object", "loader always materializes a lints record");
  assert.equal(res.manifest?.fingerprintAlgo, FINGERPRINT_ALGO_VERSION);
  assert.equal(DEFAULT_RED_MANIFEST_PATH, "tests/red-manifest.json");
  assert.equal(DEFAULT_ATTRIBUTION_REPORT_PATH, ".local/runs/attribution-report.json");
});

// ---------------------------------------------------------------------------
// 7. Shim-tree exclusion (fingerprint round-trip survives a publish)
// ---------------------------------------------------------------------------

test("publishing the red manifest does not invalidate extraNodeArgs fingerprints (shim-tree exclusion)", async () => {
  const root = mkdtempSync(join(tmpdir(), "red-shim-fixture-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests", "helpers"), { recursive: true });
    mkdirSync(join(root, "migrations"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(root, "migrations", "0001_init.sql"), "CREATE TABLE IF NOT EXISTS t (id int);\n");
    writeFileSync(join(root, "tests", "b.test.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "tests", "helpers", "setup.mjs"), 'const stub = "./stub.mjs";\nexport {};\n');
    writeFileSync(join(root, "tests", "helpers", "stub.mjs"), "export const stubbed = true;\n");
    const suite: SuiteLike = {
      file: "tests/b.test.ts",
      extraNodeArgs: ["--import", "./tests/helpers/setup.mjs"],
    };

    const before = await computeSuiteFingerprints([suite], root);
    assert.equal(before.ok, true, `trace ok (${before.error})`);
    const fpBefore = before.bySuite.get("tests/b.test.ts")?.fingerprint;
    assert.ok(fpBefore, "fixture suite fingerprints");

    publishRedManifest({
      manifestPath: join(root, "tests", "red-manifest.json"),
      commit: "fixture-commit",
      now: NOW,
      failures: [{ file: "tests/b.test.ts", failureReason: "exit 1", fingerprint: fpBefore ?? null }],
    });
    const afterPublish = await computeSuiteFingerprints([suite], root);
    assert.equal(
      afterPublish.bySuite.get("tests/b.test.ts")?.fingerprint,
      fpBefore,
      "red-manifest publish must NOT change extraNodeArgs fingerprints (else inherited reds could never match)",
    );

    // Sanity: the shim tree still detects REAL loader-adjacent additions.
    writeFileSync(join(root, "tests", "helpers", "extra.mjs"), "export const extra = 1;\n");
    const afterRealShim = await computeSuiteFingerprints([suite], root);
    assert.notEqual(
      afterRealShim.bySuite.get("tests/b.test.ts")?.fingerprint,
      fpBefore,
      "a genuine new shim file still re-fingerprints",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. v2 `lints` section (Task #4533 — guard slate for the Task #4491 rails)
// ---------------------------------------------------------------------------

function validLintEntry() {
  return { failureSignature: "exit 1", firstRedAt: NOW.toISOString(), lastRedAt: NOW.toISOString() };
}

test("v2 lints fixtures: a malformed lints section discards the manifest WHOLESALE (partial trust never extended)", () => {
  const root = tmpRoot();
  try {
    const path = join(root, "red-manifest.json");
    const write = (lints: unknown) => writeFileSync(path, JSON.stringify({ ...validManifest(), lints }));

    // Healthy v2 with a valid lint entry loads.
    write({ "lint-foo": validLintEntry() });
    const ok = loadRedManifest(path);
    assert.equal(ok.note, null);
    assert.deepEqual(Object.keys(ok.manifest?.lints ?? {}), ["lint-foo"]);

    // lints not a record → wholesale discard (suite entries are NOT salvaged).
    for (const bad of [[], "nope", 42]) {
      write(bad);
      const res = loadRedManifest(path);
      assert.equal(res.manifest, null, `lints=${JSON.stringify(bad)} must discard wholesale`);
      assert.ok(res.note, "discard is stated, never silent");
    }

    // ONE malformed entry among valid ones → wholesale discard.
    for (const badEntry of [
      null,
      "red",
      {},
      { failureSignature: 1, firstRedAt: NOW.toISOString(), lastRedAt: NOW.toISOString() },
      { failureSignature: "exit 1", firstRedAt: NOW.toISOString() }, // missing lastRedAt
    ]) {
      write({ "lint-good": validLintEntry(), "lint-bad": badEntry });
      const res = loadRedManifest(path);
      assert.equal(res.manifest, null, `entry ${JSON.stringify(badEntry)} must discard the WHOLE manifest`);
    }

    // v1 manifest (no lints key) still loads, lints materialized as {}.
    writeFileSync(path, JSON.stringify(validManifest()));
    const v1 = loadRedManifest(path);
    assert.equal(v1.note, null, "v1 (no lints key) stays loadable");
    assert.deepEqual(v1.manifest?.lints, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishRedManifest lintFailures semantics: array publishes (firstRedAt carry/reset), empty array clears, null carries VERBATIM", () => {
  const root = tmpRoot();
  try {
    const path = join(root, "red-manifest.json");
    const publish = (lintFailures: Array<{ name: string; failureReason: string }> | null | undefined, now: Date) =>
      publishRedManifest({
        manifestPath: path,
        commit: "fixture-commit",
        now,
        failures: [],
        ...(lintFailures === undefined ? {} : { lintFailures }),
      });

    // Measured red publish.
    const first = publish([{ name: "lint-a", failureReason: "exit 1" }], NOW);
    assert.equal(first.lintCount, 1);
    const m1 = loadRedManifest(path).manifest!;
    assert.equal(m1.lints["lint-a"].firstRedAt, NOW.toISOString());

    // Same signature class next night → firstRedAt carried, lastRedAt bumped.
    publish([{ name: "lint-a", failureReason: "exit 1" }], LATER);
    const m2 = loadRedManifest(path).manifest!;
    assert.equal(m2.lints["lint-a"].firstRedAt, NOW.toISOString(), "firstRedAt carried while the breakage persists");
    assert.equal(m2.lints["lint-a"].lastRedAt, LATER.toISOString());

    // Unmeasured run (lintFailures null/omitted) → previous lints carried VERBATIM.
    for (const unmeasured of [null, undefined] as const) {
      const res = publish(unmeasured, new Date("2026-08-08T03:30:00.000Z"));
      assert.equal(res.lintCount, 1, "an unmeasured run never clears lints");
      const carried = loadRedManifest(path).manifest!;
      assert.deepEqual(carried.lints["lint-a"], m2.lints["lint-a"], "carried verbatim — lastRedAt NOT bumped");
    }

    // Signature class change → firstRedAt resets.
    publish([{ name: "lint-a", failureReason: "exit 2" }], LATER);
    assert.equal(loadRedManifest(path).manifest!.lints["lint-a"].firstRedAt, LATER.toISOString());

    // Measured green (empty array) → clears.
    const cleared = publish([], LATER);
    assert.equal(cleared.lintCount, 0);
    assert.deepEqual(loadRedManifest(path).manifest!.lints, {}, "only an actual lint-green measurement clears");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lint entries are structurally unable to seed greens: no fingerprints, and the manifest still never parses as a green baseline", () => {
  const root = tmpRoot();
  try {
    const path = join(root, "red-manifest.json");
    publishRedManifest({
      manifestPath: path,
      commit: "fixture-commit",
      now: NOW,
      failures: [],
      lintFailures: [{ name: "lint-a", failureReason: "exit 1" }],
    });
    const raw = JSON.parse(readFileSync(path, "utf8"));
    // RedLintEntry carries NO fingerprint and NO verdict/records fields — the
    // green-baseline skip machinery keys on suite fingerprints, so a lint
    // entry has no handle it could ever be skipped (or seeded green) by.
    assert.deepEqual(
      Object.keys(raw.lints["lint-a"]).sort(),
      ["failureSignature", "firstRedAt", "lastRedAt"],
      "lint entries carry signature + red timestamps ONLY",
    );
    assert.ok(!JSON.stringify(raw.lints).includes("fingerprint"), "no fingerprint anywhere in the lints section");
    // And the manifest as a whole still cannot masquerade as a green baseline.
    const green = loadGreenBaseline(path);
    assert.equal(green.baseline, null, "loadGreenBaseline rejects a red manifest carrying lints");
    assert.ok(green.note, "rejection is stated (fall open to executing), never silent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} upstream-red-attribution tests passed`);
process.exit(failures > 0 ? 1 : 0);
