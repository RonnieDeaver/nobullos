/**
 * Task #3922 — Upstream-health (RED) manifest + automatic failure attribution.
 *
 * The committed green baseline (tests/green-baseline.json, Task #3872) lets a
 * task environment inherit main's proven GREENS. This module adds the red
 * sibling: `tests/red-manifest.json` snapshots the suites currently FAILING
 * at main — failure signature, per-suite input fingerprint, and commit stamp —
 * published by the SAME single writer (main's nightly sweep through
 * tests/run-all.ts, armed by the same nightly publish env flag; the flag
 * literal deliberately lives only in run-all/scheduler, pinned by the
 * single-writer test in tests/incremental-green-skip.test.ts).
 *
 * Why: parallel tasks repeatedly lose hours re-deriving the same innocence
 * proofs (git-stash runs, HEAD-worktree reruns, `git log -1` archaeology)
 * when a sibling merge delivers a red suite mid-session — on 2026-08-05 four
 * tasks independently diagnosed the SAME three inherited reds. With the
 * manifest, the runner attributes every failure automatically and the smoke
 * gate can excuse — with audited evidence — exactly those failures that are
 * provably main's, never the task's.
 *
 * Attribution verdicts (classifyFailure):
 *   - "inherited" — the suite is listed red at main, the local failure
 *     signature matches, AND the suite's current input fingerprint equals the
 *     fingerprint main recorded when it measured the red. Byte-identical
 *     inputs mean the task's diff is provably disjoint from the suite's
 *     fingerprinted input closure — the exact trust model green-baseline
 *     inheritance already uses, mirrored to red. Only this verdict is
 *     excusable.
 *   - "yours" — everything else: manifest absent/unusable, suite not listed,
 *     signature mismatch, fingerprint mismatch or unavailable, or ANY error
 *     during classification. Attribution always falls open to "yours"; a bug
 *     here can only under-excuse, never hide a task-caused failure.
 *
 * Task #5318 — live-tip fallback: when a failure's STATIC verdict above is
 * "yours" or "unattributable" (the manifest proof could not settle it —
 * stale/absent/mismatched manifest, or a fingerprint shift from an unrelated
 * blast-radius touch), `attributeRunFailures` may additionally reproduce
 * that one suite against a resolved clean upstream base commit in a
 * disposable worktree (tests/liveTipAttribution.ts) — mechanizing the exact
 * manual git-stash/worktree innocence ritual an agent would otherwise run by
 * hand. This is a SECOND, additive proof source, never a replacement: it can
 * only upgrade a verdict to "inherited" (proofStatus "proven-inherited-live-tip")
 * when the failure reproduces at the base with a matching signature, is
 * bounded by a small per-run wall-clock budget and suite cap, is armed only
 * for the same excusal-eligible smoke lane as manifest-based excusal (never
 * nightly publish, full/regression sweeps, or isolated-evidence runs), and
 * any inability to reproduce, a timeout, an error, or an exhausted budget
 * leaves the static verdict exactly as it was.
 *
 * Rails mirrored from the green baseline:
 *   - single writer: the ONLY publishRedManifest call site is tests/run-all.ts
 *     under the nightly publish flag (guard: tests/upstream-red-attribution.test.ts);
 *   - schema/algo version stamped; any mismatch or parse problem discards the
 *     manifest wholesale (no partial trust);
 *   - excluded from the shim-tree fingerprint hash (tests/suiteFingerprint.ts)
 *     so publishing never invalidates extraNodeArgs suites or breaks the
 *     red-side fingerprint round-trip;
 *   - the manifest NEVER seeds or overrides green records: entries carry no
 *     "verdict"/"records" fields, so even a red manifest mistakenly pointed
 *     at as a green baseline seeds nothing (loadGreenBaseline discards it).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DEFAULT_RED_MANIFEST_PATH, FINGERPRINT_ALGO_VERSION } from "./suiteFingerprint";
import { classifyRecentFailureHistory, RECOVERY_GREENS, type SuiteHistoryFile } from "./flakeHistory";
// Task #4491 — freshness window for carrying the gate-written `lints` section
// of the attribution report forward (single source; import is side-effect-free).
import { ATTRIBUTION_REPORT_LINTS_FRESH_MS } from "../scripts/gateLintAttribution";
// Task #5318 — type-only: erased at compile time, so this does not create a
// runtime import cycle with tests/liveTipAttribution.ts (which imports
// value-level helpers FROM this module). The real runner is loaded via a
// dynamic import() inside attributeRunFailures, only when armed.
import type { LiveTipCandidate, LiveTipRunner, LiveTipRunResult } from "./liveTipAttribution";

export { DEFAULT_RED_MANIFEST_PATH };

/**
 * v2 (Task #4491): the manifest gains a `lints` section — gate lint reds
 * observed at main by the nightly publish run (report-only lint phase in
 * tests/run-all.ts). The reader accepts BOTH v1 and v2 (v1 ⇒ lints: {}), so
 * the committed manifest needs no migration and there is no degradation
 * window; the writer always publishes v2. Lint entries mirror the suite
 * rails: structurally unable to seed greens (no verdict/records fields).
 */
export const RED_MANIFEST_SCHEMA_VERSION = 2;
export const SUPPORTED_RED_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1, 2];
export const DEFAULT_ATTRIBUTION_REPORT_PATH = ".local/runs/attribution-report.json";

/**
 * The red-manifest proof may be evaluated in every runner mode for visibility,
 * but only a non-publishing smoke gate may turn that proof into a
 * non-blocking result. Keep this decision beside the shared classifier so a
 * future runner caller cannot accidentally arm excusal for regression,
 * nightly, or isolated evidence lanes.
 */
export function isExcusalEligibleLane(mode: string, publishing = false): boolean {
  return mode === "smoke" && !publishing;
}

/**
 * Task #4480 — a manifest older than this is STALE: the nightly publisher has
 * not run since, so "not listed red" no longer proves main is green (the
 * 2026-08-11 incident: main went red, the publisher froze the manifest at an
 * empty entry set, and 223 pre-existing upstream failures were all blamed on
 * an unrelated task). Mirrors BASELINE_STALENESS_ALERT_DAYS in
 * server/services/regressionSweepScheduler.ts — the SAME window the nightly
 * baseline-age alert uses; lockstep pinned by
 * tests/upstream-red-attribution.test.ts.
 */
export const RED_MANIFEST_STALE_AFTER_DAYS = 2;

export interface ManifestStaleness {
  /** Age in days, or null when publishedAt is unparseable. */
  ageDays: number | null;
  /** True when older than RED_MANIFEST_STALE_AFTER_DAYS OR unparseable. */
  stale: boolean;
}

/** Task #4480 — never throws; unparseable publishedAt counts as stale (we
 * cannot honestly claim freshness we cannot measure). */
export function computeManifestStaleness(manifest: RedManifest, now: Date): ManifestStaleness {
  const publishedMs = parseCanonicalUtcTimestamp(manifest.publishedAt);
  if (publishedMs === null) return { ageDays: null, stale: true };
  const ageDays = (now.getTime() - publishedMs) / 86_400_000;
  return { ageDays, stale: ageDays < 0 || ageDays > RED_MANIFEST_STALE_AFTER_DAYS };
}

function parseCanonicalUtcTimestamp(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

/** Task #4501 — post-merge canary culprit stamp attached to new red entries.
 * Carries the merge commit + task identifier that first introduced the red
 * so downstream attribution evidence can cite "broken by merge X, tracked in Y"
 * instead of claiming main was green. */
export interface CulpritStamp {
  /** Short git commit hash (7–10 hex chars) of the merge that introduced the red. */
  commit: string;
  /** Task/PR identifier if known (e.g. "4501"); null when unavailable. */
  task: string | null;
  /** ISO timestamp of the merge that introduced this red. */
  mergedAt: string;
}

export interface RedManifestEntry {
  /** run-all failureReason at main, e.g. "exit 1" / "hang 184s". */
  failureSignature: string;
  /** Suite input fingerprint at the run that measured the failure (null when
   * the planner could not fingerprint the suite that night). */
  fingerprint: string | null;
  /** ISO — first publish at which this suite was red with this signature
   * class; carried across consecutive publishes while it stays red. */
  firstRedAt: string;
  /** ISO — the most recent publishing run that saw it red. */
  lastRedAt: string;
  /** Task #4501 — culprit merge that introduced this red (set by the
   * post-merge canary; null/absent for entries measured by the nightly sweep).
   * Carried unchanged on subsequent publishes (nightly wholesale or partial). */
  culprit?: CulpritStamp | null;
}

/** v2 (Task #4491) — a gate lint red at main, as observed by the nightly
 * report-only lint phase. No fingerprint: task-side lint attribution uses a
 * LIVE base-tree A/B (scripts/gateLintAttribution.ts), not this manifest —
 * these entries exist so main-side lint reds are VISIBLE (staleness/alert
 * channels) and get their ONE fix on main instead of persisting invisibly. */
export interface RedLintEntry {
  /** Lint failure signature at main, e.g. "exit 1". */
  failureSignature: string;
  /** ISO — first publish at which this lint was red with this signature
   * class; carried across consecutive publishes while it stays red. */
  firstRedAt: string;
  /** ISO — the most recent publishing run that saw it red. */
  lastRedAt: string;
}

export interface RedManifest {
  schemaVersion: number;
  fingerprintAlgo: string;
  publishedAt: string;
  /** Commit main's worktree was at when the publishing sweep ran. */
  commit: string;
  entries: Record<string, RedManifestEntry>;
  /** v2 (Task #4491) — gate lints red at main (lint name → entry). Loader
   * defaults to {} for v1 manifests. Like `entries`, carries no
   * verdict/records fields so it can never seed green records. */
  lints: Record<string, RedLintEntry>;
  /** Task #4501 — ISO timestamp of the last PARTIAL manifest update written
   * by the post-merge canary. NOT the same as `publishedAt` (which only
   * advances on full nightly sweeps). Absent on manifests that have never
   * received a partial canary update. */
  lastPartialUpdateAt?: string | null;
}

// ---------------------------------------------------------------------------
// Failure signatures
// ---------------------------------------------------------------------------

/**
 * Normalize a run-all failureReason into a comparable signature class.
 * Exit codes compare exactly ("exit 1" ≠ "exit 2"); hangs compare as a class
 * ("hang 184s" ≈ "hang 240s") because the measured seconds vary with the
 * configured per-file timeout, not with the breakage.
 */
export function normalizeFailureSignature(reason: string): string {
  const trimmed = String(reason ?? "").trim();
  if (/^hang\b/.test(trimmed)) return "hang";
  return trimmed;
}

export function signaturesMatch(a: string, b: string): boolean {
  const na = normalizeFailureSignature(a);
  const nb = normalizeFailureSignature(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb;
}

// ---------------------------------------------------------------------------
// Load / publish
// ---------------------------------------------------------------------------

function isRedEntryShape(value: unknown): value is RedManifestEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.failureSignature === "string" &&
    v.failureSignature.length > 0 &&
    (v.fingerprint === null || typeof v.fingerprint === "string") &&
    typeof v.firstRedAt === "string" &&
    typeof v.lastRedAt === "string"
  );
}

function isRedLintEntryShape(value: unknown): value is RedLintEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.failureSignature === "string" &&
    v.failureSignature.length > 0 &&
    typeof v.firstRedAt === "string" &&
    typeof v.lastRedAt === "string"
  );
}

/**
 * Load the committed red manifest. Missing file → `{ manifest: null, note:
 * null }` (normal in environments predating the first publish). Any parse
 * problem, schema/algo mismatch, or malformed entry discards the manifest
 * WHOLESALE with a note — partial trust is never extended, matching the
 * green-baseline rails.
 */
export function loadRedManifest(absPath: string): { manifest: RedManifest | null; note: string | null } {
  if (!existsSync(absPath)) return { manifest: null, note: null };
  try {
    const parsed = JSON.parse(readFileSync(absPath, "utf8")) as Partial<RedManifest> | null;
    if (typeof parsed !== "object" || parsed === null) {
      return { manifest: null, note: "red manifest is not an object — discarded wholesale" };
    }
    if (!SUPPORTED_RED_MANIFEST_SCHEMA_VERSIONS.includes(parsed.schemaVersion as number)) {
      return {
        manifest: null,
        note: `red manifest schemaVersion ${String(parsed.schemaVersion)} not in supported [${SUPPORTED_RED_MANIFEST_SCHEMA_VERSIONS.join(", ")}] — discarded wholesale`,
      };
    }
    if (parsed.fingerprintAlgo !== FINGERPRINT_ALGO_VERSION) {
      return {
        manifest: null,
        note: `red manifest fingerprintAlgo ${String(parsed.fingerprintAlgo)} != ${FINGERPRINT_ALGO_VERSION} — discarded wholesale`,
      };
    }
    if (typeof parsed.publishedAt !== "string" || typeof parsed.commit !== "string") {
      return { manifest: null, note: "red manifest missing publishedAt/commit stamps — discarded wholesale" };
    }
    if (typeof parsed.entries !== "object" || parsed.entries === null || Array.isArray(parsed.entries)) {
      return { manifest: null, note: "red manifest entries is not a record — discarded wholesale" };
    }
    for (const [file, entry] of Object.entries(parsed.entries)) {
      if (typeof file !== "string" || !isRedEntryShape(entry)) {
        return { manifest: null, note: `red manifest entry for ${String(file)} malformed — discarded wholesale` };
      }
    }
    // v2 (Task #4491) — `lints` section; absent on v1 manifests → {}.
    let lints: Record<string, RedLintEntry> = {};
    const rawLints = (parsed as Partial<RedManifest>).lints;
    if (rawLints !== undefined) {
      if (typeof rawLints !== "object" || rawLints === null || Array.isArray(rawLints)) {
        return { manifest: null, note: "red manifest lints is not a record — discarded wholesale" };
      }
      for (const [name, entry] of Object.entries(rawLints)) {
        if (typeof name !== "string" || !isRedLintEntryShape(entry)) {
          return { manifest: null, note: `red manifest lint entry for ${String(name)} malformed — discarded wholesale` };
        }
      }
      lints = rawLints as Record<string, RedLintEntry>;
    }
    return { manifest: { ...(parsed as RedManifest), lints }, note: null };
  } catch (err) {
    return { manifest: null, note: `red manifest unreadable (${(err as Error).message}) — discarded wholesale` };
  }
}

/** Best-effort HEAD commit for the evidence stamp; never throws. */
export function resolveHeadCommit(repoRoot: string): string {
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", timeout: 10_000 });
    const out = (res.stdout ?? "").trim();
    if (res.status === 0 && /^[0-9a-f]{7,40}$/i.test(out)) return out;
  } catch {
    /* fall through */
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Task #5030 — culprit merge-window resolution
// ---------------------------------------------------------------------------

export interface MergeWindowCommit {
  commit: string;
  /** Task ref parsed from the commit subject ("#NNNN"), null when absent. */
  task: string | null;
  subject: string;
  /** Committer date (ISO) — used as the culprit `mergedAt` stamp. */
  committedAt: string;
}

/**
 * The window of commits that landed on main between two evidence stamps —
 * `fromCommit` (exclusive; the previous red manifest's commit) and
 * `toCommit` (inclusive; the run that observed the new red). When a nightly
 * sweep or the deferred full lane reds a suite that was green at
 * `fromCommit`, the culprit merge is IN this window by construction.
 */
export interface MergeWindow {
  fromCommit: string;
  toCommit: string;
  /** Newest first (git log order), capped by `maxCommits`. */
  commits: MergeWindowCommit[];
  /** True when the walk hit the cap — the window is a prefix, not the whole range. */
  truncated: boolean;
}

/**
 * Resolve the merge window `fromCommit..toCommit` via a bounded `git log`
 * walk. Returns null — never throws — when the window cannot be honestly
 * named: missing/unknown endpoints, identical endpoints, git failure
 * (e.g. rewritten history), or an empty range. Attribution machinery treats
 * null as "window unresolvable", which callers must surface as such rather
 * than guessing.
 */
export function resolveMergeWindow(opts: {
  fromCommit: string | null;
  toCommit: string;
  repoRoot?: string;
  maxCommits?: number;
}): MergeWindow | null {
  const maxCommits = Math.max(1, opts.maxCommits ?? 50);
  const from = (opts.fromCommit ?? "").trim();
  const to = opts.toCommit.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(from) || !/^[0-9a-f]{7,40}$/i.test(to)) return null;
  if (from === to) return null;
  try {
    const res = spawnSync(
      "git",
      ["log", "--format=%H%x1f%cI%x1f%s", `--max-count=${maxCommits + 1}`, `${from}..${to}`],
      { cwd: opts.repoRoot ?? process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    if (res.status !== 0) return null;
    const lines = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (lines.length === 0) return null;
    const truncated = lines.length > maxCommits;
    const commits: MergeWindowCommit[] = [];
    for (const line of lines.slice(0, maxCommits)) {
      const [commit, committedAt, ...rest] = line.split("\x1f");
      if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) continue;
      const subject = rest.join("\x1f") ?? "";
      const taskMatch = subject.match(/#(\d{2,6})\b/);
      commits.push({
        commit,
        task: taskMatch ? `#${taskMatch[1]}` : null,
        subject,
        committedAt: committedAt ?? "",
      });
    }
    if (commits.length === 0) return null;
    return { fromCommit: from, toCommit: to, commits, truncated };
  } catch {
    return null;
  }
}

export interface PublishRedManifestOptions {
  manifestPath: string;
  failures: Array<{ file: string; failureReason: string; fingerprint: string | null }>;
  /** Task #4491 — gate lint reds observed by the nightly report-only lint
   * phase (tests/run-all.ts). Recorded under `lints` with firstRedAt carry.
   * Semantics: an ARRAY means the lint phase RAN — publish exactly these
   * (empty array = measured green, clears stale lint reds); undefined/null
   * means the phase did NOT run (budget/error) — the previous manifest's
   * lints are carried unchanged (lastRedAt not bumped) so an unmeasured run
   * can never fake a lint-green main. */
  lintFailures?: Array<{ name: string; failureReason: string }> | null;
  /** Evidence stamp; resolved from repoRoot's HEAD when omitted. */
  commit?: string;
  repoRoot?: string;
  now?: Date;
  /** Task #5030 — the resolved merge window since the PREVIOUS manifest's
   * commit stamp (resolveMergeWindow). Used to stamp `culprit` on NEW red
   * entries — only when the window contains exactly ONE candidate commit
   * (never guess among several). Null/omitted = no stamping. */
  mergeWindow?: MergeWindow | null;
}

// ---------------------------------------------------------------------------
// Task #4501 — partial manifest upsert (post-merge canary)
// ---------------------------------------------------------------------------

export interface UpsertRedManifestOptions {
  manifestPath: string;
  /** Suites the canary actually ran and found FAILING. */
  newReds: Array<{ file: string; failureReason: string; fingerprint: string | null }>;
  /** Suites the canary ran and found PASSING — their red entries are cleared. */
  clearedFiles: string[];
  /** Culprit stamp to attach to newly-added red entries (null/omit when unknown). */
  culprit?: CulpritStamp | null;
  /** Evidence stamp; resolved from repoRoot's HEAD when omitted. */
  commit?: string;
  repoRoot?: string;
  now?: Date;
}

/**
 * Task #4501 — partial manifest upsert for the post-merge canary.
 * Adds new red entries (with culprit stamp), clears re-verified greens, and
 * updates `lastPartialUpdateAt` WITHOUT advancing `publishedAt` (which only
 * the nightly full sweep advances — preserving staleness-verdict semantics).
 * Entries the canary did NOT re-verify are left untouched. Never throws.
 *
 * Single call site: scripts/post-merge-canary.ts (guard test pins this).
 */
export function upsertRedManifestEntries(opts: UpsertRedManifestOptions): {
  upserted: boolean;
  addedReds: number;
  clearedReds: number;
  note: string | null;
} {
  try {
    const now = (opts.now ?? new Date()).toISOString();
    const commit = opts.commit ?? resolveHeadCommit(opts.repoRoot ?? process.cwd());
    const previous = loadRedManifest(opts.manifestPath).manifest;
    // Start from the previous manifest's entries; apply the canary's delta.
    const entries: Record<string, RedManifestEntry> = { ...(previous?.entries ?? {}) };
    let addedReds = 0;
    for (const failure of [...opts.newReds].sort((a, b) => a.file.localeCompare(b.file))) {
      const prior = entries[failure.file];
      const sameBreakage = prior ? signaturesMatch(prior.failureSignature, failure.failureReason) : false;
      const isNewRed = !prior;
      if (isNewRed) addedReds++;
      entries[failure.file] = {
        failureSignature: failure.failureReason,
        fingerprint: failure.fingerprint,
        firstRedAt: sameBreakage && prior ? prior.firstRedAt : now,
        lastRedAt: now,
        // Carry existing culprit if the same breakage persists; stamp new entries.
        culprit: sameBreakage && prior?.culprit ? prior.culprit : (opts.culprit ?? null),
      };
    }
    // Clear re-verified greens (canary confirmed them passing this run).
    let clearedCount = 0;
    for (const file of opts.clearedFiles) {
      if (entries[file]) {
        delete entries[file];
        clearedCount++;
      }
    }
    // publishedAt is NOT advanced (staleness semantics: only the nightly full
    // publish advances it). lastPartialUpdateAt records the canary run time.
    const manifest: RedManifest = {
      schemaVersion: previous?.schemaVersion ?? RED_MANIFEST_SCHEMA_VERSION,
      fingerprintAlgo: previous?.fingerprintAlgo ?? FINGERPRINT_ALGO_VERSION,
      publishedAt: previous?.publishedAt ?? now,
      commit: previous?.commit ?? commit,
      entries,
      lints: previous?.lints ?? {},
      lastPartialUpdateAt: now,
    };
    mkdirSync(dirname(opts.manifestPath), { recursive: true });
    const tmp = `${opts.manifestPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmp, opts.manifestPath);
    return { upserted: true, addedReds, clearedReds: clearedCount, note: null };
  } catch (err) {
    return { upserted: false, addedReds: 0, clearedReds: 0, note: `upsert failed: ${(err as Error).message}` };
  }
}

/**
 * Wholesale-publish the current red set. A fully green run publishes an EMPTY
 * manifest so stale reds clear. `firstRedAt` is carried from the previous
 * manifest while a suite stays red with the same signature class; a signature
 * change resets it (different breakage). Never throws.
 */
export function publishRedManifest(opts: PublishRedManifestOptions): {
  published: boolean;
  count: number;
  /** Task #4491 — number of lint reds recorded in the `lints` section. */
  lintCount: number;
  note: string | null;
  /** Task #5030 — files newly red (or red with a NEW breakage signature)
   * relative to the previous manifest: the set culprit attribution names.
   * Aligned with the firstRedAt-reset condition. Empty on failure. */
  newRedFiles: string[];
  /** Task #5030 — the previous manifest's commit stamp (the merge-window
   * "from" endpoint), null when there was no previous manifest. */
  previousCommit: string | null;
} {
  try {
    const now = (opts.now ?? new Date()).toISOString();
    const commit = opts.commit ?? resolveHeadCommit(opts.repoRoot ?? process.cwd());
    const previous = loadRedManifest(opts.manifestPath).manifest;
    const entries: Record<string, RedManifestEntry> = {};
    const newRedFiles: string[] = [];
    // Task #5030 — culprit stamp policy: stamp ONLY when the resolved merge
    // window contains exactly one candidate commit (and is complete). With
    // several commits in the window we report the window, never guess one.
    const windowCulprit: CulpritStamp | null =
      opts.mergeWindow && opts.mergeWindow.commits.length === 1 && !opts.mergeWindow.truncated
        ? {
            commit: opts.mergeWindow.commits[0].commit,
            task: opts.mergeWindow.commits[0].task,
            mergedAt: opts.mergeWindow.commits[0].committedAt,
          }
        : null;
    for (const failure of [...opts.failures].sort((a, b) => a.file.localeCompare(b.file))) {
      const prior = previous?.entries[failure.file];
      const sameBreakage = prior ? signaturesMatch(prior.failureSignature, failure.failureReason) : false;
      if (!sameBreakage) newRedFiles.push(failure.file);
      entries[failure.file] = {
        failureSignature: failure.failureReason,
        fingerprint: failure.fingerprint,
        firstRedAt: sameBreakage && prior ? prior.firstRedAt : now,
        lastRedAt: now,
        // Task #5030 — carry the culprit while the same breakage persists
        // (the wholesale publish used to DROP canary-stamped culprits);
        // stamp NEW breakages under the exactly-one-candidate rule.
        culprit: sameBreakage && prior?.culprit ? prior.culprit : windowCulprit,
      };
    }
    // Task #4491 — lint reds mirror the suite entries: wholesale publish,
    // firstRedAt carried while the signature class holds. An unmeasured run
    // (lintFailures undefined/null) carries the previous lints VERBATIM —
    // clearing requires an actual lint-green measurement (empty array).
    let lints: Record<string, RedLintEntry> = {};
    if (opts.lintFailures == null) {
      lints = { ...(previous?.lints ?? {}) };
    } else {
      for (const lf of [...opts.lintFailures].sort((a, b) => a.name.localeCompare(b.name))) {
        const prior = previous?.lints?.[lf.name];
        const sameBreakage = prior ? signaturesMatch(prior.failureSignature, lf.failureReason) : false;
        lints[lf.name] = {
          failureSignature: lf.failureReason,
          firstRedAt: sameBreakage && prior ? prior.firstRedAt : now,
          lastRedAt: now,
        };
      }
    }
    const manifest: RedManifest = {
      schemaVersion: RED_MANIFEST_SCHEMA_VERSION,
      fingerprintAlgo: FINGERPRINT_ALGO_VERSION,
      publishedAt: now,
      commit,
      entries,
      lints,
    };
    mkdirSync(dirname(opts.manifestPath), { recursive: true });
    const tmp = `${opts.manifestPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmp, opts.manifestPath);
    return {
      published: true,
      count: Object.keys(entries).length,
      lintCount: Object.keys(lints).length,
      note: null,
      newRedFiles,
      previousCommit: previous?.commit ?? null,
    };
  } catch (err) {
    return {
      published: false,
      count: 0,
      lintCount: 0,
      note: `red manifest publish failed: ${(err as Error).message}`,
      newRedFiles: [],
      previousCommit: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface FailureAttribution {
  file: string;
  failureReason: string;
  /** "inherited" ⟺ full proof held (manifest hit + signature match +
   * fingerprint equality); "unattributable" (Task #4480) ⟺ the manifest is
   * STALE and cannot honestly assert main was green here (still BLOCKING,
   * never excusable — it only replaces a false "main was green" claim with
   * honest evidence); anything else is "yours" (conservative). */
  verdict: "inherited" | "yours" | "unattributable";
  /** Mirrors verdict === "inherited"; whether the run treats it as
   * non-blocking additionally requires run-level excusal to be armed. */
  excusable: boolean;
  evidence: string[];
  /** Task #4238 — structured mirror of the flake-history evidence line
   * (classifyRecentFailureHistory over the same recent window): "recovered"
   * = contiguous failure burst followed by ≥RECOVERY_GREENS greens,
   * "flaky" = intermittent, "none" = no recorded failures in the window.
   * Corroborating only — never affects verdict/excusable. */
  historyKind: "none" | "flaky" | "recovered";
  /**
   * Bounded reason for a non-proof result. This is diagnostic metadata only:
   * verdict and excusability remain governed by the existing proof rails.
   */
  proofStatus:
    | "proven-inherited"
    | "proven-inherited-live-tip"
    | "task-caused"
    | "manifest-unavailable"
    | "manifest-malformed"
    | "manifest-stale"
    | "signature-mismatch"
    | "fingerprint-missing"
    | "fingerprint-changed"
    | "classification-error";
}

export interface ClassifyFailureInput {
  file: string;
  failureReason: string;
  /** This run's fingerprint for the suite (null = planner had none). */
  currentFingerprint: string | null;
  manifest: RedManifest | null;
  manifestNote?: string | null;
  /** Prior flake-history records for this suite (evidence only, no proof). */
  priorRecords?: Array<{ at: string; outcome: string }> | null;
  /** Task #4480 — clock used for manifest staleness (defaults to wall time). */
  now?: Date;
}

/** Task #4217 — evidence and classification share ONE window (matches the
 * repeat-offender report's default in tests/flakeHistory.ts). */
export const HISTORY_EVIDENCE_WINDOW = 10;

function shortCommit(commit: string): string {
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 10) : commit;
}

/**
 * Pure, conservative classification of one hard failure. Any thrown error is
 * converted into a "yours" verdict with the error recorded as evidence —
 * attribution mistakes must inflate the task's blame, never excuse it.
 */
export function classifyFailure(input: ClassifyFailureInput): FailureAttribution {
  const base: FailureAttribution = {
    file: input.file,
    failureReason: input.failureReason,
    verdict: "yours",
    excusable: false,
    evidence: [],
    historyKind: "none",
    proofStatus: "task-caused",
  };
  try {
    const evidence: string[] = [];
    // Task #4217 — consume the flaky-vs-recovered burst classification
    // (tests/flakeHistory.ts) instead of describing raw failure counts
    // uniformly: a just-fixed deterministic burst must not read as a
    // chronic flake in the evidence agents cite. Every reported number,
    // timestamp, and contiguity claim is derived from the SAME recent
    // window the classifier inspects, so the evidence can never assert
    // contiguity over aged-out records it did not classify. Corroborating
    // only — the verdict still rests solely on the manifest+fingerprint
    // proof.
    const history = Array.isArray(input.priorRecords) ? input.priorRecords : [];
    const recent = history.slice(-HISTORY_EVIDENCE_WINDOW);
    const recentFails = recent.filter((r) => r && r.outcome === "failed");
    if (recentFails.length > 0) {
      const last = recentFails[recentFails.length - 1];
      const historyKind = classifyRecentFailureHistory(recent, { window: HISTORY_EVIDENCE_WINDOW });
      base.historyKind = historyKind;
      if (historyKind === "recovered") {
        evidence.push(
          `flake-history: recovered deterministic burst — ${recentFails.length} failed run(s) in the last ${recent.length} recorded formed one contiguous block followed by ≥${RECOVERY_GREENS} consecutive greens in this environment's inherited journal (last failed ${last.at}); consistent with an already-fixed base-drift burst, NOT a chronic flake — corroborating only, not proof`,
        );
      } else {
        evidence.push(
          `flake-history: intermittent — ${recentFails.length} failed run(s) in the last ${recent.length} recorded in this environment's inherited journal do NOT form a recovered contiguous burst (last failed ${last.at}) — corroborating only, not proof`,
        );
      }
    }
    if (!input.manifest) {
      base.proofStatus = input.manifestNote ? "manifest-malformed" : "manifest-unavailable";
      const why = input.manifestNote
        ? `upstream red manifest unusable (${input.manifestNote})`
        : "no upstream red manifest available (predates the first nightly publish, or file absent)";
      base.evidence = [`${why} — failure attributed to this task (conservative default)`, ...evidence];
      return base;
    }
    const stamp = `manifest published ${input.manifest.publishedAt} @ ${shortCommit(input.manifest.commit)}`;
    // Task #4480 — a stale manifest cannot prove main is CURRENTLY green:
    // the nightly publisher has not run within the staleness alert window
    // (typically because main itself is red, freezing the manifest — the
    // exact 2026-08-11 incident). "Not listed" then downgrades from a false
    // "main was green here" claim to an explicit unattributable verdict.
    // Still BLOCKING (never excusable) — honesty, not leniency.
    const staleness = computeManifestStaleness(input.manifest, input.now ?? new Date());
    const staleDesc =
      staleness.ageDays === null
        ? "publishedAt unparseable"
        : `${staleness.ageDays.toFixed(1)}d old > ${RED_MANIFEST_STALE_AFTER_DAYS}d staleness threshold`;
    const entry = input.manifest.entries[input.file];
    if (!entry) {
      if (staleness.stale) {
        base.verdict = "unattributable";
        base.proofStatus = "manifest-stale";
        base.evidence = [
          `upstream red manifest is STALE (${staleDesc}; ${stamp}) — the nightly publisher has not run since, so "not listed red" does NOT prove main is currently green here; verdict UNATTRIBUTABLE — stale baseline (still blocking, not excused). Rebut/verify via a worktree-at-HEAD repro if you believe this failure is main's.`,
          ...evidence,
        ];
        return base;
      }
      base.evidence = [`not red at upstream main (${stamp}; ${Object.keys(input.manifest.entries).length} red suite(s) listed) — main was green here, failure attributed to this task`, ...evidence];
      return base;
    }
    if (staleness.stale) {
      // Entry exists but the measurement is stale: the honest "cannot prove"
      // evidence below still holds, but flag the staleness alongside it.
      evidence.push(`note: upstream red manifest is STALE (${staleDesc}) — main's state may have changed since this measurement`);
    }
    if (!signaturesMatch(entry.failureSignature, input.failureReason)) {
      base.proofStatus = "signature-mismatch";
      base.evidence = [
        `listed red at upstream main since ${entry.firstRedAt} but with a DIFFERENT signature (main: "${entry.failureSignature}", here: "${input.failureReason}") — cannot prove same breakage, attributed to this task (${stamp})`,
        ...evidence,
      ];
      return base;
    }
    const inheritedLine = `red at upstream main since ${entry.firstRedAt} with matching signature "${normalizeFailureSignature(entry.failureSignature)}" (${stamp})`;
    if (entry.fingerprint === null) {
      base.proofStatus = "fingerprint-missing";
      base.evidence = [
        `${inheritedLine}, but main recorded NO input fingerprint for it — disjointness from the task diff cannot be proven, attributed to this task`,
        ...evidence,
      ];
      return base;
    }
    if (input.currentFingerprint === null) {
      base.proofStatus = "fingerprint-missing";
      base.evidence = [
        `${inheritedLine}, but this run has NO input fingerprint for it (planning unavailable) — disjointness cannot be proven, attributed to this task`,
        ...evidence,
      ];
      return base;
    }
    if (entry.fingerprint !== input.currentFingerprint) {
      base.proofStatus = "fingerprint-changed";
      base.evidence = [
        `${inheritedLine}, but the suite's inputs CHANGED since main's measurement (fingerprint ${entry.fingerprint.slice(0, 12)}… → ${input.currentFingerprint.slice(0, 12)}…) — the change set could include this task's diff, attributed to this task`,
        ...evidence,
      ];
      return base;
    }
    return {
      file: input.file,
      failureReason: input.failureReason,
      verdict: "inherited",
      excusable: true,
      historyKind: base.historyKind,
        proofStatus: "proven-inherited",
      evidence: [
        inheritedLine,
        `input fingerprint identical to main's red measurement (${entry.fingerprint.slice(0, 12)}…) — the task diff is provably disjoint from this suite's fingerprinted input closure`,
        ...evidence,
      ],
    };
  } catch (err) {
    base.proofStatus = "classification-error";
    base.evidence = [
      `attribution error (${(err as Error).message}) — falling open to "yours" (conservative)`,
    ];
    return base;
  }
}

// ---------------------------------------------------------------------------
// Run-level orchestration (called from tests/run-all.ts)
// ---------------------------------------------------------------------------

export interface RunFailureInput {
  file: string;
  name: string;
  failureReason: string;
  /** Task #5318 — the suite's registered run flags, needed only if the
   * live-tip fallback ends up re-running this exact suite at a resolved
   * upstream base commit (same invocation shape tests/run-all.ts uses). */
  extraNodeArgs?: string[];
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunAttributionOptions {
  repoRoot: string;
  mode: string;
  failures: RunFailureInput[];
  fingerprints: ReadonlyMap<string, string | null> | null;
  /** True only for the smoke gate in non-publishing environments with the
   * TEST_ATTRIBUTION_EXCUSE kill switch not set to "0" (decided by run-all). */
  excusalArmed: boolean;
  /** True for the single main-side publishing lane. Publishing truth must
   * remain blocking even if a caller accidentally requests an excusal. */
  publishing?: boolean;
  priorHistory?: SuiteHistoryFile | null;
  manifestPath?: string;
  reportPath?: string;
  now?: Date;
  /**
   * Task #5318 — live-tip fallback arming. True only for the same
   * excusal-eligible smoke lane as `excusalArmed`, with its own
   * TEST_LIVE_TIP_ATTRIBUTION kill switch (decided by run-all, mirroring how
   * excusalArmed is decided there and never read from this module).
   */
  liveTipArmed?: boolean;
  /** Injection point for tests; defaults to the real worktree-based runner
   * (tests/liveTipAttribution.ts), loaded via dynamic import only when armed. */
  liveTip?: LiveTipRunner;
  liveTipBudgetMs?: number;
  liveTipMaxSuites?: number;
}

export interface RunAttributionResult {
  attributions: FailureAttribution[];
  /** Files whose failure is treated as non-blocking this run. */
  excusedFiles: string[];
  blockingFiles: string[];
  /** Ready-to-print console lines (verdicts + evidence + report pointer). */
  lines: string[];
  /** Repo-relative report path, or null when the write failed. */
  reportPath: string | null;
  manifest: RedManifest | null;
  manifestNote: string | null;
  /** Task #4480 — staleness of the loaded manifest (null when no manifest).
   * Surfaced so run-all can call it out next to the final failure count. */
  manifestStaleness: ManifestStaleness | null;
  /** Whether this lane is structurally allowed to excuse an inherited red. */
  excusalEligible: boolean;
  /** Task #5318 — live-tip fallback facts for this run; null when it never
   * ran (not armed, ineligible lane, or no unresolved candidates). */
  liveTip: LiveTipRunResult | null;
}

/**
 * Classify every hard failure of a run, emit console lines, and write the
 * machine-readable attribution report agents cite in drift/skip explanations
 * and completion-review rebuttals. Never throws; any orchestration error
 * yields an all-blocking result with the error printed.
 */
export async function attributeRunFailures(opts: RunAttributionOptions): Promise<RunAttributionResult> {
  const fallback: RunAttributionResult = {
    attributions: opts.failures.map((f) => ({
      file: f.file,
      failureReason: f.failureReason,
      verdict: "yours",
      excusable: false,
      evidence: ["attribution unavailable — treated as yours (conservative)"],
      historyKind: "none",
      proofStatus: "classification-error",
    })),
    excusedFiles: [],
    blockingFiles: opts.failures.map((f) => f.file),
    lines: [],
    reportPath: null,
    manifest: null,
    manifestNote: null,
    manifestStaleness: null,
    excusalEligible: false,
    liveTip: null,
  };
  try {
    const manifestPath = opts.manifestPath ?? resolve(opts.repoRoot, DEFAULT_RED_MANIFEST_PATH);
    const { manifest, note: manifestNote } = loadRedManifest(manifestPath);
    const now = opts.now ?? new Date();
    const manifestStaleness = manifest ? computeManifestStaleness(manifest, now) : null;
    const attributions = opts.failures.map((f) =>
      classifyFailure({
        file: f.file,
        failureReason: f.failureReason,
        currentFingerprint: opts.fingerprints?.get(f.file) ?? null,
        manifest,
        manifestNote,
        priorRecords: opts.priorHistory?.suites?.[f.file] ?? null,
        now,
      }),
    );
    // Do not trust the caller-provided arming boolean on its own. The
    // attribution API is also used directly by focused tools/tests, and an
    // armed regression/nightly invocation must remain blocking even when the
    // manifest proof itself is exact.
    const excusalEligible = isExcusalEligibleLane(opts.mode, opts.publishing === true);
    const effectiveExcusalArmed = opts.excusalArmed && excusalEligible;

    // Task #5318 — live-tip fallback. Same double-check discipline as
    // effectiveExcusalArmed above: never trust the caller's boolean alone,
    // and additionally require excusal itself to be armed — proving a
    // failure "inherited" is pointless work when nothing will consume the
    // proof. Only "yours"/"unattributable" verdicts that are not already
    // excusable are eligible candidates; a suite already proven inherited by
    // the manifest, or already blocking for an unrelated structural reason,
    // is never re-litigated here.
    const effectiveLiveTipArmed = opts.liveTipArmed === true && excusalEligible && effectiveExcusalArmed;
    let liveTipResult: LiveTipRunResult | null = null;
    if (effectiveLiveTipArmed) {
      const liveTipCandidates: LiveTipCandidate[] = [];
      for (const a of attributions) {
        if (a.excusable) continue;
        if (a.verdict !== "yours" && a.verdict !== "unattributable") continue;
        const failure = opts.failures.find((f) => f.file === a.file);
        if (!failure) continue;
        liveTipCandidates.push({
          file: a.file,
          name: failure.name,
          headFailureReason: a.failureReason,
          extraNodeArgs: failure.extraNodeArgs,
          extraEnv: failure.extraEnv,
          timeoutMs: failure.timeoutMs,
        });
      }
      if (liveTipCandidates.length > 0) {
        try {
          const runner: LiveTipRunner = opts.liveTip ?? (await import("./liveTipAttribution")).reproduceAtUpstream;
          liveTipResult = await runner({
            repoRoot: opts.repoRoot,
            candidates: liveTipCandidates,
            budgetMs: opts.liveTipBudgetMs,
            maxSuites: opts.liveTipMaxSuites,
          });
        } catch (err) {
          // Never let a live-tip crash escape or weaken anything — every
          // candidate simply stays at its static verdict.
          liveTipResult = {
            ran: false,
            skippedReason: `live-tip fallback threw (${(err as Error).message})`,
            baseCommit: null,
            outcomes: [],
            wallMs: 0,
            budgetMs: opts.liveTipBudgetMs ?? 0,
            maxSuites: opts.liveTipMaxSuites ?? 0,
          };
        }
        if (liveTipResult?.ran) {
          for (const outcome of liveTipResult.outcomes) {
            if (outcome.status !== "proved") continue;
            const a = attributions.find((x) => x.file === outcome.file);
            if (!a || a.excusable) continue;
            a.verdict = "inherited";
            a.excusable = true;
            a.proofStatus = "proven-inherited-live-tip";
            a.evidence = [`LIVE-TIP VERIFIED: ${outcome.detail}`, ...outcome.evidence, ...a.evidence];
          }
        }
      }
    }

    const excused = attributions.filter((a) => a.excusable && effectiveExcusalArmed);
    const excusedSet = new Set(excused.map((a) => a.file));
    const blocking = attributions.filter((a) => !excusedSet.has(a.file));

    const lines: string[] = [];
    const manifestDesc = manifest
      ? `${Object.keys(manifest.entries).length} red suite(s) at main, published ${manifest.publishedAt} @ ${shortCommit(manifest.commit)}`
      : manifestNote
        ? `manifest unusable: ${manifestNote}`
        : "manifest absent (predates first nightly publish)";
    lines.push(`[attribution] classifying ${opts.failures.length} hard failure(s) against the upstream red manifest — ${manifestDesc}`);
    // Task #4480 — prominent staleness banner right under the header: a
    // frozen manifest must never quietly masquerade as proof main is green.
    if (manifestStaleness?.stale) {
      const ageDesc =
        manifestStaleness.ageDays === null
          ? "publishedAt unparseable"
          : `${manifestStaleness.ageDays.toFixed(1)}d old > ${RED_MANIFEST_STALE_AFTER_DAYS}d threshold`;
      lines.push(
        `[attribution] ⚠ STALE BASELINE: the upstream red manifest is ${ageDesc} — the nightly publisher has not run since (main may itself be red); "not listed red" cannot prove main is green, such failures are marked UNATTRIBUTABLE (still blocking, not excused)`,
      );
    }
    // Task #5318 — live-tip pass summary, printed once regardless of outcome
    // so a reader always knows whether the fallback ran and why.
    if (opts.liveTipArmed === true) {
      if (!effectiveLiveTipArmed) {
        lines.push(
          `[attribution] live-tip fallback requested but not armed (ineligible lane "${opts.mode}"${opts.publishing ? " (publishing)" : ""}, or excusal itself not armed)`,
        );
      } else if (liveTipResult === null) {
        lines.push(`[attribution] live-tip fallback: no unresolved candidates — nothing to reproduce`);
      } else if (!liveTipResult.ran) {
        lines.push(`[attribution] live-tip fallback did not run: ${liveTipResult.skippedReason}`);
      } else {
        const proved = liveTipResult.outcomes.filter((o) => o.status === "proved").length;
        lines.push(
          `[attribution] live-tip fallback: ${liveTipResult.outcomes.length} candidate(s) reproduced at base ${liveTipResult.baseCommit?.slice(0, 10) ?? "?"} — ${proved} proved inherited (${liveTipResult.wallMs}ms of ${liveTipResult.budgetMs}ms budget)`,
        );
        for (const o of liveTipResult.outcomes) {
          lines.push(`[attribution]     live-tip · ${o.file} — ${o.status}: ${o.detail}`);
        }
      }
    }
    for (const a of attributions) {
      if (a.proofStatus === "proven-inherited-live-tip" && excusedSet.has(a.file)) {
        lines.push(
          `[attribution] ✗ ${a.file} — INHERITED FROM UPSTREAM (live-tip verified), excused (non-blocking; next action: leave proven inherited debt alone)`,
        );
      } else if (a.verdict === "inherited" && excusedSet.has(a.file)) {
        lines.push(
          `[attribution] ✗ ${a.file} — INHERITED FROM UPSTREAM, excused (non-blocking; next action: leave proven inherited debt alone)`,
        );
      } else if (a.verdict === "inherited") {
        const reason =
          opts.excusalArmed && !excusalEligible
            ? `ineligible lane "${opts.mode}"${opts.publishing ? " (publishing)" : ""}`
            : `excusal not armed in mode "${opts.mode}"`;
        lines.push(
          `[attribution] ✗ ${a.file} — INHERITED FROM UPSTREAM (${reason}; still blocking; next action: repair through the canonical blocking workflow)`,
        );
      } else if (a.verdict === "unattributable") {
        lines.push(
          `[attribution] ✗ ${a.file} — UNATTRIBUTABLE (stale baseline; still blocking; next action: repair or verify in the canonical blocking workflow)`,
        );
      } else {
        lines.push(`[attribution] ✗ ${a.file} — YOURS (next action: repair the task)`);
      }
      for (const ev of a.evidence.slice(0, 2)) lines.push(`[attribution]     · ${ev}`);
    }

    // Machine-readable report (best-effort; console verdicts stand alone).
    const reportPathRel = opts.reportPath ?? DEFAULT_ATTRIBUTION_REPORT_PATH;
    const reportPathAbs = isAbsolute(reportPathRel) ? reportPathRel : resolve(opts.repoRoot, reportPathRel);
    let writtenReportPath: string | null = null;
    try {
      mkdirSync(dirname(reportPathAbs), { recursive: true });
      // Task #4491 — the gate writes a `lints` section (base-tree A/B lint
      // attribution, scripts/gateLintAttribution.ts) into this SAME report
      // file before the smoke phase runs. Carry a fresh section forward
      // instead of clobbering it; a stale one (> freshness window) is dropped
      // so it cannot mislead a later reader.
      let carriedLints: unknown = null;
      try {
        const prev = JSON.parse(readFileSync(reportPathAbs, "utf8")) as {
          lints?: { generatedAt?: string };
        } | null;
        const genAt = Date.parse(prev?.lints?.generatedAt ?? "");
        if (Number.isFinite(genAt) && Math.abs(now.getTime() - genAt) < ATTRIBUTION_REPORT_LINTS_FRESH_MS) {
          carriedLints = prev?.lints ?? null;
        }
      } catch {
        /* absent/corrupt → no carry */
      }
      const report = {
        // v2 (Task #4238): per-failure records gained the structured
        // `historyKind` field ("none" | "flaky" | "recovered").
        // v3 (Task #4480): manifest gained ageDays/stale; verdict gained the
        // "unattributable" value (stale baseline — blocking, not excused).
        // v4 (Task #4491): optional `lints` section — per-lint base-tree A/B
        // verdicts written by the gate; this writer carries a fresh section
        // forward rather than clobbering it.
        // v5: records both requested and structurally eligible excusal so an
        // executor can distinguish a proof-complete inherited red from a lane
        // that correctly kept it blocking.
        // proofStatus is an additive per-failure field; keep the shared report
        // version stable because the lint-attribution writer also owns it.
        // Task #5318: `liveTip` is likewise additive — the fallback's own
        // section, distinguishable from manifest-based proof via each
        // failure's proofStatus ("proven-inherited-live-tip").
        schemaVersion: 5,
        ...(carriedLints ? { lints: carriedLints } : {}),
        generatedAt: (opts.now ?? new Date()).toISOString(),
        mode: opts.mode,
        excusalArmed: effectiveExcusalArmed,
        excusalRequested: opts.excusalArmed,
        excusalEligible,
        liveTip: {
          armed: effectiveLiveTipArmed,
          requested: opts.liveTipArmed === true,
          attempted: liveTipResult?.ran ?? false,
          skippedReason: liveTipResult?.skippedReason ?? null,
          baseCommit: liveTipResult?.baseCommit ?? null,
          candidates: liveTipResult?.outcomes.length ?? 0,
          proved: liveTipResult ? liveTipResult.outcomes.filter((o) => o.status === "proved").length : 0,
          notProved: liveTipResult ? liveTipResult.outcomes.filter((o) => o.status === "not-proved").length : 0,
          inconclusive: liveTipResult ? liveTipResult.outcomes.filter((o) => o.status === "inconclusive").length : 0,
          wallMs: liveTipResult?.wallMs ?? 0,
          budgetMs: liveTipResult?.budgetMs ?? null,
          maxSuites: liveTipResult?.maxSuites ?? null,
        },
        manifest: {
          present: manifest !== null,
          path: DEFAULT_RED_MANIFEST_PATH,
          note: manifestNote,
          publishedAt: manifest?.publishedAt ?? null,
          commit: manifest?.commit ?? null,
          entryCount: manifest ? Object.keys(manifest.entries).length : null,
          ageDays: manifestStaleness?.ageDays ?? null,
          stale: manifestStaleness?.stale ?? null,
          staleAfterDays: RED_MANIFEST_STALE_AFTER_DAYS,
        },
        failures: attributions.map((a) => {
          const failure = opts.failures.find((f) => f.file === a.file);
          return {
            file: a.file,
            name: failure?.name ?? a.file,
            failureReason: a.failureReason,
            verdict: a.verdict,
            excused: excusedSet.has(a.file),
            nextAction: excusedSet.has(a.file)
              ? "leave-proven-inherited-debt"
              : "repair-through-canonical-blocking-workflow",
            evidence: a.evidence,
            historyKind: a.historyKind,
            proofStatus: a.proofStatus,
          };
        }),
        excusedCount: excusedSet.size,
        blockingCount: blocking.length,
      };
      writeFileSync(reportPathAbs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writtenReportPath = reportPathRel;
      lines.push(`[attribution] report: ${reportPathRel} — cite it verbatim in drift/skip explanations and completion-review rebuttals`);
    } catch (err) {
      lines.push(`[attribution] report write failed (${(err as Error).message}) — console verdicts above are authoritative`);
    }

    return {
      attributions,
      excusedFiles: [...excusedSet],
      blockingFiles: blocking.map((a) => a.file),
      lines,
      reportPath: writtenReportPath,
      manifest,
      manifestNote,
      manifestStaleness,
      excusalEligible,
      liveTip: liveTipResult,
    };
  } catch (err) {
    fallback.lines = [
      `[attribution] attribution failed (${(err as Error).message}) — ALL failures treated as yours (conservative fall-open)`,
    ];
    return fallback;
  }
}
