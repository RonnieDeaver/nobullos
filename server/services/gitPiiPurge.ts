// @db-pool-intent: none — this module never touches the database.
/**
 * Task #4776 — git-history purge of the two swept-in PII screenshots.
 *
 * Background: the platform's pre-merge auto-commit ("Git commit prior to
 * merge", d75aab30) swept two browser screenshots showing staff names,
 * email addresses, and profile photos into main's history. The Task #4776
 * completion review classified that as a data-exposure blocker and required
 * an operator-run history purge. This module is the mechanized form of that
 * purge, fired deliberately via the `purge_swept_pii_screenshots` manual
 * lever in the CEO prod-actions panel.
 *
 * Environment contract — the purge can ONLY run where the git repository
 * actually lives:
 *   - Deployment: no `.git` ships in the bundle, and rewriting a copy would
 *     be meaningless → the lever reports `blocked` with instructions to fire
 *     it from the dev-workspace app.
 *   - Dev workspace: the real repo. The rewrite is bounded (only commits
 *     since the sweep commit), reflogs are expired, blobs pruned, on-disk
 *     copies deleted, and unreachability is VERIFIED (path-history empty +
 *     `git cat-file -e` fails for every preflight-collected blob id).
 *   - Tests: the DEFAULT deps refuse to rewrite under NODE_ENV=test /
 *     TEST_SMOKE — the dedicated suite injects fake deps instead, so no
 *     test run can ever rewrite a real repository.
 *
 * Honesty notes baked into outcomes: refs this process does not own (e.g.
 * platform checkpoint refs, remote-tracking refs) are never deleted — if a
 * path stays reachable after the rewrite, the outcome says so and the lever
 * stays visible (servedPurpose false). Replit platform-side checkpoint
 * storage lives outside the repository and is explicitly out of scope.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, stat } from "node:fs/promises";
import { isRunningInDeployment } from "../lib/deploymentEnv";
import { registerModuleStateResetForTest } from "./moduleStateReset";
import type { ProdActionOutcome } from "./prodActions/kernel";

const execFileAsync = promisify(execFile);

/**
 * The exact repository paths being purged. Fixed constants — never derived
 * from request input — so the shell fragment handed to `filter-branch`'s
 * --index-filter cannot be injected into.
 *
 * Four screenshots, swept in by TWO separate platform "Git commit prior to
 * merge" auto-commits in the main workspace (the 9:2x pair and the 11:1x
 * pair). All four show staff names/emails/photos and must leave history.
 */
export const PURGED_PII_PATHS: readonly string[] = [
  "attached_assets/Screenshot_2026-08-14_at_9.23.36_AM_1786717420256.png",
  "attached_assets/Screenshot_2026-08-14_at_9.25.34_AM_1786717538301.png",
  "attached_assets/Screenshot_2026-08-14_at_11.10.42_AM_1786723847365.png",
  "attached_assets/Screenshot_2026-08-14_at_11.13.32_AM_1786724017496.png",
];

/** Generous ceilings: filter-branch/gc walk real history on a large repo. */
const GIT_QUICK_TIMEOUT_MS = 30_000;
const GIT_REWRITE_TIMEOUT_MS = 10 * 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitPiiPurgeDeps {
  isDeployment(): boolean;
  /**
   * Runs `git <args>` at the repo root and resolves with stdout, rejecting
   * on non-zero exit. Verification deliberately uses the rejection path
   * (`cat-file -e` on a purged blob MUST fail).
   */
  runGit(args: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: string }>;
  removeFile(path: string): Promise<void>;
  /**
   * Disk-absence check backing the hard verification condition: the purge
   * only counts as complete when every path is BOTH git-unreachable and
   * absent from the working tree. Errors count as "exists" (fail toward
   * visibility).
   */
  pathExists(path: string): Promise<boolean>;
  /**
   * Rewrite arming gate. The default refuses under test env so no automated
   * suite can rewrite a real repository; the dedicated suite injects an
   * always-allowed gate alongside its fake `runGit`.
   */
  allowRewrite(): { allowed: true } | { allowed: false; reason: string };
}

const defaultDeps: GitPiiPurgeDeps = {
  isDeployment: () => isRunningInDeployment(),
  runGit: async (args, opts) => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: process.cwd(),
      timeout: opts?.timeoutMs ?? GIT_QUICK_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: "1" },
    });
    return { stdout: String(stdout ?? "") };
  },
  removeFile: async (path) => {
    await rm(path, { force: true });
  },
  pathExists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch (err: any) {
      if (err?.code === "ENOENT") return false;
      // Unreadable ≠ absent: any other error keeps the path "present".
      return true;
    }
  },
  allowRewrite: () => {
    if (process.env.NODE_ENV === "test" || process.env.TEST_SMOKE) {
      return {
        allowed: false,
        reason:
          "refusing to rewrite git history under a test environment (NODE_ENV=test/TEST_SMOKE) — the purge only arms with the real dev-workspace deps",
      };
    }
    return { allowed: true };
  },
};

let deps: GitPiiPurgeDeps = defaultDeps;

export function __setGitPiiPurgeDepsForTest(overrides: Partial<GitPiiPurgeDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

export function __resetGitPiiPurgeDepsForTest(): void {
  deps = defaultDeps;
}

registerModuleStateResetForTest("gitPiiPurge.deps", () => {
  deps = defaultDeps;
});

async function gitOk(args: string[], timeoutMs?: number): Promise<string | null> {
  try {
    const { stdout } = await deps.runGit(args, { timeoutMs });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Caps on the retainer-NAMING side channel (`for-each-ref --contains` per
 * touching commit). The reachability VERDICT never depends on these — it
 * comes from the single `--all`/`--reflog` walks below.
 */
const MAX_RETAINER_NAMING_PROBES = 8;
const MAX_NAMED_RETAINERS = 40;

export interface PathReachability {
  reachable: boolean;
  /**
   * What retains the path: ref names, "reflog entries (…)" for commits
   * reachable only via reflogs (git stash beyond the tip, HEAD@{n}), or
   * "(… failed …)" markers when a scan could not run. Empty = verified
   * unreachable.
   */
  retainedBy: string[];
}

/**
 * The ONE reachability scanner shared by the read-only probe, the apply
 * preflight, and the post-rewrite verification.
 *
 * Verdict: ONE `git log --all -n 1 -- path` walk covers every ref in a
 * single spawn. (A per-ref loop is NOT viable here: repl clones carry
 * thousands of platform task refs, and per-ref spawns turned every probe
 * into a multi-minute git storm that timed out whole test suites.) `--all`
 * alone still misses reflog-only commits (stash entries beyond the tip,
 * HEAD@{n}), so a `--reflog` catch-all follows.
 *
 * Naming: when the path IS ref-reachable, retainer names come from
 * `for-each-ref --contains` on the commits that touch the path (bounded by
 * MAX_RETAINER_NAMING_PROBES/MAX_NAMED_RETAINERS). Naming is advisory
 * detail for the operator — the verdict above stands regardless.
 *
 * Every scan failure counts as retained: unverified is never "purged".
 */
async function scanPathReachability(path: string): Promise<PathReachability> {
  const retainedBy: string[] = [];
  const refHit = await gitOk(["log", "--all", "--format=%H", "-n", "1", "--", path]);
  if (refHit === null) {
    retainedBy.push("(all-refs scan failed — treating path as retained)");
  } else if (refHit.trim().length > 0) {
    const touching = await gitOk([
      "log",
      "--all",
      "--full-history",
      "--format=%H",
      "--",
      path,
    ]);
    const named = new Set<string>();
    let namingIncomplete = false;
    if (touching === null) {
      namingIncomplete = true;
    } else {
      const commits = touching
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (commits.length > MAX_RETAINER_NAMING_PROBES) namingIncomplete = true;
      for (const commit of commits.slice(0, MAX_RETAINER_NAMING_PROBES)) {
        const refsOut = await gitOk([
          "for-each-ref",
          `--contains=${commit}`,
          "--format=%(refname)",
        ]);
        if (refsOut === null) {
          namingIncomplete = true;
          continue;
        }
        for (const ref of refsOut
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)) {
          named.add(ref);
        }
      }
    }
    const names = [...named];
    retainedBy.push(...names.slice(0, MAX_NAMED_RETAINERS));
    if (names.length > MAX_NAMED_RETAINERS) {
      retainedBy.push(`(+${names.length - MAX_NAMED_RETAINERS} more refs)`);
    }
    if (retainedBy.length === 0 || namingIncomplete) {
      retainedBy.push("(reachable from at least one ref — retainer naming incomplete)");
    }
  }
  // Reflog catch-all: stash entries beyond refs/stash's tip and HEAD@{n}
  // history are reachable ONLY via reflogs — no ref-based scan sees them.
  const reflogOut = await gitOk(["log", "--reflog", "--format=%H", "-n", "1", "--", path]);
  if (reflogOut === null) {
    retainedBy.push("reflog (scan failed — treated as retaining)");
  } else if (reflogOut.trim().length > 0 && retainedBy.length === 0) {
    retainedBy.push("reflog entries (e.g. git stash / HEAD@{n})");
  }
  return { reachable: retainedBy.length > 0, retainedBy };
}

export interface PiiPurgeProbe {
  env: "deployment" | "no_repo" | "workspace";
  /** Per-path: is the path still reachable from ANY ref or reflog entry? */
  reachable: { path: string; reachable: boolean; retainedBy: string[] }[];
  /**
   * Per-path: does the file still exist in the working tree? Disk absence
   * is a HARD completion condition alongside git unreachability — a purge
   * that scrubs history but leaves the bytes on disk is not a remediation.
   */
  onDisk: { path: string; exists: boolean }[];
}

/**
 * Read-only environment + reachability probe backing the lever's status
 * detail and served-purpose retirement. Never throws; unverifiable
 * environments report `deployment`/`no_repo` so the lever fails toward
 * visibility.
 */
export async function probePiiPurgeState(): Promise<PiiPurgeProbe> {
  const onDisk: PiiPurgeProbe["onDisk"] = [];
  for (const path of PURGED_PII_PATHS) {
    let exists = true;
    try {
      exists = await deps.pathExists(path);
    } catch {
      // Fail toward visibility.
    }
    onDisk.push({ path, exists });
  }
  if (deps.isDeployment()) {
    return { env: "deployment", reachable: [], onDisk };
  }
  if ((await gitOk(["rev-parse", "--git-dir"])) === null) {
    return { env: "no_repo", reachable: [], onDisk };
  }
  const reachable: PiiPurgeProbe["reachable"] = [];
  for (const path of PURGED_PII_PATHS) {
    const scan = await scanPathReachability(path);
    reachable.push({ path, reachable: scan.reachable, retainedBy: scan.retainedBy });
  }
  return { env: "workspace", reachable, onDisk };
}

/**
 * Delete every PII path from disk, then VERIFY absence. Returns a
 * description per path that is still present (deletion error and/or the
 * post-delete existence check failing) — empty array = verified absent.
 * Deletion failures are retained, never swallowed into success.
 */
async function deleteAndVerifyDiskCopies(): Promise<string[]> {
  const failures: string[] = [];
  for (const path of PURGED_PII_PATHS) {
    let deleteError: string | null = null;
    try {
      await deps.removeFile(path);
    } catch (err: any) {
      deleteError = String(err?.message ?? err).slice(0, 200);
    }
    let stillThere = true;
    try {
      stillThere = await deps.pathExists(path);
    } catch {
      stillThere = true; // unverifiable = present (fail toward visibility)
    }
    if (stillThere) {
      failures.push(`${path}${deleteError ? ` (${deleteError})` : " (still present after delete)"}`);
    }
  }
  return failures;
}

/** Collect every blob id any ref OR reflog entry stores for `path`. */
async function collectBlobIds(path: string): Promise<string[]> {
  const out = await gitOk(["rev-list", "--objects", "--all", "--reflog", "--", path]);
  if (out === null) return [];
  const ids = new Set<string>();
  for (const line of out.split("\n")) {
    const [sha, ...rest] = line.trim().split(/\s+/);
    if (sha && rest.join(" ") === path) ids.add(sha);
  }
  return [...ids];
}

/**
 * Cleanup lane for reflog-only retention: no ref names the paths — they
 * survive solely in reflog entries (dropped stashes, HEAD@{n} history).
 * There is nothing to rewrite and nothing foreign; expiring every reflog
 * and pruning IS the complete, locally-owned remediation. Verification
 * (shared scanner + blob checks + disk absence) still gates the COMPLETE
 * claim, so a failed expire/gc stays PENDING.
 */
async function cleanupReflogOnlyRetention(
  preBlobs: Map<string, string[]>,
  startedAt: number,
): Promise<ProdActionOutcome> {
  const reflogOk = (await gitOk(["reflog", "expire", "--expire=now", "--all"])) !== null;
  const gcOk =
    (await gitOk(
      ["-c", "gc.autoDetach=false", "gc", "--prune=now", "--quiet"],
      GIT_REWRITE_TIMEOUT_MS,
    )) !== null;
  await gitOk(["rm", "--cached", "--ignore-unmatch", "--quiet", "--", ...PURGED_PII_PATHS]);
  const diskFailures = await deleteAndVerifyDiskCopies();

  const residualPaths: string[] = [];
  for (const path of PURGED_PII_PATHS) {
    const scan = await scanPathReachability(path);
    if (scan.reachable) {
      residualPaths.push(`${path} (via ${scan.retainedBy.slice(0, 6).join(", ")})`);
    }
  }
  let blobsChecked = 0;
  let blobsGone = 0;
  for (const [, ids] of preBlobs) {
    for (const id of ids) {
      blobsChecked += 1;
      try {
        await deps.runGit(["cat-file", "-e", id]);
        // Object still exists — NOT purged.
      } catch {
        blobsGone += 1;
      }
    }
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const parts = [
    `No ref retains the screenshot paths — they were reachable only via reflog entries (git stash / HEAD@{n} history), so no rewrite was needed. Expired ALL reflogs${reflogOk ? "" : " (reflog expire FAILED)"} and ran gc --prune=now${gcOk ? "" : " (gc FAILED — blobs may linger until the next gc)"}.`,
    `Verification: ${blobsGone}/${blobsChecked} historical blob(s) unreachable; on-disk copies ${diskFailures.length === 0 ? "verified absent" : "NOT clear"}.`,
  ];
  if (diskFailures.length > 0) {
    parts.push(
      `REMEDIATION STILL PENDING — on-disk copies could not be removed/verified absent: ${diskFailures.join("; ")}. ` +
        "Fix permissions (or delete the files manually) and fire the lever again.",
    );
  }
  if (residualPaths.length > 0) {
    parts.push(
      `REMEDIATION STILL PENDING — history remains reachable via: ${residualPaths.join("; ")}. ` +
        "Fire the lever again; if reflog entries persist, inspect git stash list / git reflog manually.",
    );
  } else if (blobsGone === blobsChecked && gcOk && reflogOk && diskFailures.length === 0) {
    parts.push(
      "All paths are now unreachable from every ref and reflog (incl. stash) in this repository AND verified absent from disk — the repository-side purge is COMPLETE and verified.",
    );
  }
  parts.push(
    "Replit platform-side checkpoint snapshots are stored outside the repository and are not modified by this purge.",
  );
  return { state: "applied", detail: `${parts.join(" ")} (${seconds}s)` };
}

/**
 * The purge itself. Returns a prod-action outcome; never throws for
 * expected environmental refusals (those are `blocked`), only for
 * programming errors.
 */
export async function applyPiiPurge(): Promise<ProdActionOutcome> {
  const startedAt = Date.now();

  if (deps.isDeployment()) {
    return {
      state: "blocked",
      detail:
        "This lever rewrites the git repository, which does not exist in the deployment. " +
        "Open the CEO panel in the DEV WORKSPACE app (the workspace preview) and fire it there.",
    };
  }
  const gate = deps.allowRewrite();
  if (!gate.allowed) {
    return { state: "blocked", detail: `Purge not armed: ${gate.reason}.` };
  }
  if ((await gitOk(["rev-parse", "--git-dir"])) === null) {
    return {
      state: "blocked",
      detail:
        "No git repository found at the app root — this environment cannot host the purge. " +
        "Fire the lever from the dev-workspace app.",
    };
  }
  const branchOut = await gitOk(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchOut?.trim() ?? "";
  if (!branch || branch === "HEAD") {
    return {
      state: "blocked",
      detail: `Repository is on a detached HEAD (or the branch could not be read) — check out the main branch first, then fire the lever.`,
    };
  }

  // ── Preflight: what is reachable (shared scanner), which blobs must die ──
  const preBlobs = new Map<string, string[]>();
  let anyReachable = false;
  const retainingEntries: string[] = [];
  for (const path of PURGED_PII_PATHS) {
    const scan = await scanPathReachability(path);
    if (scan.reachable) anyReachable = true;
    retainingEntries.push(...scan.retainedBy);
    preBlobs.set(path, await collectBlobIds(path));
  }
  if (!anyReachable) {
    // History is clean, but disk absence is a HARD completion condition:
    // sweep any lingering working-tree copies before declaring done.
    const lingering = await deleteAndVerifyDiskCopies();
    if (lingering.length > 0) {
      return {
        state: "error",
        detail:
          "History is clean, but on-disk copies could NOT be removed/verified absent: " +
          `${lingering.join("; ")}. The remediation stays PENDING — fix permissions (or delete the files manually) and fire the lever again.`,
      };
    }
    return {
      state: "not-needed",
      detail:
        "All screenshot paths are already unreachable from every ref and reflog (incl. stash) in this repository and verified absent from disk — the purge is complete here. " +
        "Note: Replit platform-side checkpoint snapshots live outside the repository and are not covered by this check.",
    };
  }

  // ── Reflog-only retention: nothing rewritable, nothing foreign ──
  // No ref names the paths (only stash/HEAD@{n} reflog entries retain
  // them), so the oldest-commit scan below would come up empty and wrongly
  // return `blocked` forever. Expire + gc is the complete remediation here.
  if (retainingEntries.every((e) => e.startsWith("reflog entries"))) {
    return cleanupReflogOnlyRetention(preBlobs, startedAt);
  }

  // ── Bound the rewrite: oldest commit on the CURRENT branch touching either path ──
  const oldestOut = await gitOk([
    "log",
    "--reverse",
    "--format=%H",
    "HEAD",
    "--",
    ...PURGED_PII_PATHS,
  ]);
  const oldest = oldestOut?.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!oldest) {
    return {
      state: "blocked",
      detail:
        "The screenshot paths are reachable only via refs other than the current branch (remote-tracking or platform refs this process does not own). " +
        "Nothing on the current branch to rewrite; resolve the foreign refs manually (git for-each-ref --contains) before purging.",
    };
  }
  const parent = await gitOk(["rev-parse", `${oldest}^`]);

  // ── Rewrite ALL owned refs (every local branch + tag), bounded below ──
  // A HEAD-only rewrite leaves sibling branches holding the old lineage, so
  // `git log --all` verification could never pass. `--branches --tags`
  // rewrites every ref this repository owns; refs/remotes/* are deliberately
  // NOT rewritten (they are caches of REMOTE state — handled below).
  // Fixed-constant paths only (see PURGED_PII_PATHS) — nothing user-supplied
  // enters this shell fragment.
  const range =
    parent === null
      ? ["--branches", "--tags"]
      : [`^${oldest}^`, "--branches", "--tags"];
  const indexFilter =
    "git rm --cached --ignore-unmatch -- " +
    PURGED_PII_PATHS.map((p) => `'${p}'`).join(" ");
  let rewrittenCount = 0;
  try {
    const { stdout } = await deps.runGit(
      [
        "filter-branch",
        "-f",
        "--index-filter",
        indexFilter,
        "--prune-empty",
        "--tag-name-filter",
        "cat",
        "--",
        ...range,
      ],
      { timeoutMs: GIT_REWRITE_TIMEOUT_MS },
    );
    rewrittenCount = (stdout.match(/^Rewrite /gm) ?? []).length;
  } catch (err: any) {
    return {
      state: "error",
      detail: `git filter-branch failed: ${String(err?.message ?? err).slice(0, 400)}`,
    };
  }

  // ── Drop every filter-branch backup ref (refs/original/*) ──
  const backupRefs =
    (await gitOk(["for-each-ref", "--format=%(refname)", "refs/original"]))
      ?.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0) ?? [];
  for (const ref of backupRefs) {
    await gitOk(["update-ref", "-d", ref]);
  }

  // ── Classify residual refs BEFORE pruning ──
  // Any ref still listing the paths in its history keeps the blobs alive.
  // Two ownership classes:
  //   - refs/remotes/<name>/* whose remote is NO LONGER configured: a stale
  //     local cache — safe to delete here (deleting it purges nothing remote
  //     because there IS no remote behind it anymore).
  //   - refs/remotes/<name>/* whose remote IS configured, plus anything else
  //     (platform refs, stash): NOT ours to delete. Deleting a live remote's
  //     tracking ref would only HIDE the exposure locally — the next fetch
  //     restores it — so these are reported by name for source-side purging.
  const liveRemotes = new Set(
    (await gitOk(["remote"]))
      ?.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0) ?? [],
  );
  // ONE --all walk finds the touching commits that survived the rewrite
  // (owned refs were just rewritten, so any survivor is retained via refs
  // this process does not own — or via a stale tracking cache), then
  // `for-each-ref --contains` names the refs holding each. Bounded like the
  // shared scanner's naming; anything missed here is still caught by the
  // fail-closed verification below. Scan failures classify nothing (the
  // verification scanner is the gate that counts failures as retained).
  const residualTouching = await gitOk([
    "log",
    "--all",
    "--full-history",
    "--format=%H",
    "--",
    ...PURGED_PII_PATHS,
  ]);
  const residualRefNames = new Set<string>();
  const residualCommits = (residualTouching ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const commit of residualCommits.slice(0, MAX_RETAINER_NAMING_PROBES)) {
    const refsOut = await gitOk([
      "for-each-ref",
      `--contains=${commit}`,
      "--format=%(refname)",
    ]);
    for (const ref of (refsOut ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("refs/original/"))) {
      residualRefNames.add(ref);
    }
  }
  const staleTrackingDeleted: string[] = [];
  const foreignResidualRefs: string[] = [];
  for (const ref of residualRefNames) {
    const remoteMatch = ref.match(/^refs\/remotes\/([^/]+)\//);
    if (remoteMatch && !liveRemotes.has(remoteMatch[1])) {
      // Stale tracking cache of a remote that no longer exists — delete.
      if ((await gitOk(["update-ref", "-d", ref])) !== null) {
        staleTrackingDeleted.push(ref);
        continue;
      }
    }
    foreignResidualRefs.push(ref);
  }
  const stashCount =
    (await gitOk(["stash", "list", "--format=%gd"]))
      ?.split("\n")
      .filter((l) => l.trim().length > 0).length ?? 0;

  // ── Expire reflogs + prune the now-unreachable objects ──
  const reflogOk = (await gitOk(["reflog", "expire", "--expire=now", "--all"])) !== null;
  const gcOk =
    (await gitOk(
      ["-c", "gc.autoDetach=false", "gc", "--prune=now", "--quiet"],
      GIT_REWRITE_TIMEOUT_MS,
    )) !== null;

  // ── Clear index entries + on-disk copies (filter-branch touches neither) ──
  await gitOk(["rm", "--cached", "--ignore-unmatch", "--quiet", "--", ...PURGED_PII_PATHS]);
  const diskFailures = await deleteAndVerifyDiskCopies();

  // ── Verify: path history empty everywhere (same scanner as the probe —
  // single --all walk + --reflog catch-all) + every preflight blob gone ──
  const residualPaths: string[] = [];
  for (const path of PURGED_PII_PATHS) {
    const scan = await scanPathReachability(path);
    if (scan.reachable) {
      residualPaths.push(`${path} (via ${scan.retainedBy.slice(0, 6).join(", ")})`);
    }
  }
  let blobsChecked = 0;
  let blobsGone = 0;
  for (const [, ids] of preBlobs) {
    for (const id of ids) {
      blobsChecked += 1;
      try {
        await deps.runGit(["cat-file", "-e", id]);
        // Object still exists — NOT purged.
      } catch {
        blobsGone += 1;
      }
    }
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const parts = [
    `Rewrote ${rewrittenCount} commit(s) across all local branches/tags (bounds: ${range.join(" ")}; current branch ${branch}), expired reflogs${reflogOk ? "" : " (reflog expire FAILED)"}, ran gc --prune=now${gcOk ? "" : " (gc FAILED — blobs may linger until the next gc)"}.`,
    `Verification: ${blobsGone}/${blobsChecked} historical blob(s) unreachable; on-disk copies ${diskFailures.length === 0 ? "verified absent" : "NOT clear"}.`,
  ];
  if (diskFailures.length > 0) {
    parts.push(
      `REMEDIATION STILL PENDING — on-disk copies could not be removed/verified absent: ${diskFailures.join("; ")}. ` +
        "Fix permissions (or delete the files manually) and fire the lever again.",
    );
  }
  if (staleTrackingDeleted.length > 0) {
    parts.push(
      `Deleted ${staleTrackingDeleted.length} stale remote-tracking ref(s) whose remote is no longer configured: ${staleTrackingDeleted.join(", ")}.`,
    );
  }
  if (residualPaths.length > 0 || foreignResidualRefs.length > 0) {
    const named =
      foreignResidualRefs.length > 0
        ? foreignResidualRefs.slice(0, 25).join(", ") +
          (foreignResidualRefs.length > 25
            ? ` (+${foreignResidualRefs.length - 25} more)`
            : "")
        : residualPaths.join(", ");
    parts.push(
      `REMEDIATION STILL PENDING — history remains reachable via refs this process does not own: ${named}. ` +
        "Deleting a live remote's tracking ref would only hide the exposure locally (the next fetch restores it) — " +
        "the retaining remote/platform repository must be purged at its source. The lever stays visible until " +
        "verification passes here.",
    );
  } else if (blobsGone === blobsChecked && gcOk && reflogOk && diskFailures.length === 0) {
    parts.push(
      "All paths are now unreachable from every ref and reflog (incl. stash) in this repository AND verified absent from disk — the repository-side purge is COMPLETE and verified.",
    );
  } else if (diskFailures.length === 0) {
    parts.push(
      "Path history is clean but full blob/gc verification did not complete — treat the purge as PENDING and check the flags above.",
    );
  }
  if (stashCount > 0) {
    parts.push(
      `Note: ${stashCount} git stash entr${stashCount === 1 ? "y" : "ies"} exist and are outside this purge — drop any that predate it (git stash clear) if they might contain the screenshots.`,
    );
  }
  parts.push(
    "Replit platform-side checkpoint snapshots are stored outside the repository and are not modified by this purge.",
  );
  return {
    state: "applied",
    detail: `${parts.join(" ")} (${seconds}s)`,
  };
}
