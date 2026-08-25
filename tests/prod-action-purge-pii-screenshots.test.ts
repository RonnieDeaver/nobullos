/* test-registration
{
  "name": "Purge swept-in PII screenshots lever (Task #4776)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4776: pins the mechanics of the purge_swept_pii_screenshots manual lever — the ONLY destructive git-history-rewrite capability in the registry. Hermetic (injected fake git runner, no DB, no network, no real rewrites, sub-second): deployment/no-repo/detached-HEAD refusals, the NODE_ENV=test default-deps arming refusal that keeps every automated suite from rewriting a real repo, already-purged idempotence, the bounded filter-branch command shape (fixed-constant paths, sweep-range bound, prune-empty), reflog/gc/disk cleanup ordering, blob-level verification honesty (residual refs reported, never deleted), and the lever contract (synthetic not-needed status, servedPurpose retires only on verified unreachability). A regression here either bricks the reviewer-demanded PII purge or, worse, arms a history rewrite somewhere it must never run.",
  "tier": "small"
}
test-registration */
/**
 * Task #4776 — the PII-purge lever is the operationalized form of the
 * completion reviewer's demanded git-history purge (platform-swept
 * screenshots with staff names/emails/photos). Everything here drives the
 * REAL applyPiiPurge/probePiiPurgeState logic through injected deps — a
 * scripted fake `git` runner — so the full pipeline (preflight →
 * filter-branch → reflog/gc → disk delete → verification) is exercised
 * with zero risk of touching an actual repository.
 */

import "./helpers/forceTestEnv";
import assert from "node:assert/strict";
import {
  applyPiiPurge,
  probePiiPurgeState,
  PURGED_PII_PATHS,
  __setGitPiiPurgeDepsForTest,
  __resetGitPiiPurgeDepsForTest,
} from "../server/services/gitPiiPurge";
import { purgeSweptPiiScreenshotsAction } from "../server/services/prodActions/platformOpsActions";

const [P1, P2] = [...PURGED_PII_PATHS];

type GitCall = string[];

/**
 * Scripted git runner: each rule matches a call by predicate; first match
 * wins. Unmatched calls throw (so the pipeline can't silently depend on
 * an unscripted command). Every call is recorded for order assertions.
 */
function makeGitRunner(
  rules: Array<{
    match: (args: string[]) => boolean;
    result: string | Error;
  }>,
) {
  const calls: GitCall[] = [];
  const runGit = async (args: string[]) => {
    calls.push([...args]);
    for (const rule of rules) {
      if (rule.match(args)) {
        if (rule.result instanceof Error) throw rule.result;
        return { stdout: rule.result };
      }
    }
    throw new Error(`unscripted git call: git ${args.join(" ")}`);
  };
  return { calls, runGit };
}

const is = (...prefix: string[]) => (args: string[]) =>
  prefix.every((p, i) => args[i] === p);
// The shared scanner's ref-side VERDICT probe for <path> — one --all walk:
// ["log","--all","--format=%H","-n","1","--",path].
const pathLog = (path: string) => (args: string[]) =>
  args[0] === "log" &&
  args[1] === "--all" &&
  args.includes("-n") &&
  args[args.length - 1] === path;
// The scanner's retainer-NAMING enumeration for <path> (no -n cap):
// ["log","--all","--full-history","--format=%H","--",path].
const touchingLog = (path: string) => (args: string[]) =>
  args[0] === "log" &&
  args[1] === "--all" &&
  !args.includes("-n") &&
  args[args.length - 1] === path;
// Retainer naming: ["for-each-ref","--contains=<sha>","--format=%(refname)"].
const containsRefs = (sha: string) => (args: string[]) =>
  args[0] === "for-each-ref" && args[1] === `--contains=${sha}`;
const reflogPathLog = (path: string) => (args: string[]) =>
  args[0] === "log" && args[1] === "--reflog" && args[args.length - 1] === path;
const objects = (path: string) => (args: string[]) =>
  args[0] === "rev-list" && args[1] === "--objects" && args[args.length - 1] === path;
// Post-rewrite residual classification: ONE --all walk over ALL fixed paths.
const residualTouchingAll = (args: string[]) =>
  args[0] === "log" &&
  args[1] === "--all" &&
  PURGED_PII_PATHS.every((p) => args.includes(p));
const backupRefList = is("for-each-ref", "--format=%(refname)", "refs/original");
// Tail rules for what a scenario does not script explicitly (first match
// wins, so specific rules above these stay in control): paths treated as
// never-committed — empty history, no blobs.
const cleanTailRules = [
  { match: (a: string[]) => a[0] === "log" && !a.includes("--reverse"), result: "" },
  { match: (a: string[]) => a[0] === "rev-list" && a[1] === "--objects", result: "" },
];

function findCall(calls: GitCall[], pred: (args: string[]) => boolean): number {
  return calls.findIndex(pred);
}

const removed: string[] = [];
const removeFile = async (p: string) => {
  removed.push(p);
};
const armed = () => ({ allowed: true }) as const;
const noDisk = async () => false;

async function main() {
  // ── Registration + lever contract ──
  assert.equal(purgeSweptPiiScreenshotsAction.id, "purge_swept_pii_screenshots");
  assert.equal(purgeSweptPiiScreenshotsAction.manualLever, true);
  assert.equal(purgeSweptPiiScreenshotsAction.convergence.kind, "converging");
  assert.equal(purgeSweptPiiScreenshotsAction.selfHeal, undefined);
  assert.equal(purgeSweptPiiScreenshotsAction.humanGate, undefined);
  assert.equal(typeof purgeSweptPiiScreenshotsAction.servedPurpose, "function");
  assert.equal(PURGED_PII_PATHS.length, 4);
  for (const p of PURGED_PII_PATHS) {
    assert.match(p, /^attached_assets\/Screenshot_2026-08-14_at_(9|11)\./);
    // The paths feed a shell fragment; the constants must stay shell-inert.
    assert.doesNotMatch(p, /[^A-Za-z0-9_./-]/);
  }
  const { PROD_ACTIONS } = await import(
    "../server/services/prodActions/composition"
  );
  assert.ok(
    PROD_ACTIONS.some((a: any) => a === purgeSweptPiiScreenshotsAction),
    "composition array must reference the identical action object",
  );

  // ── 1. Deployment refusal: blocked, zero git calls ──
  {
    const { calls, runGit } = makeGitRunner([]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => true,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "blocked");
    assert.match(out.detail, /DEV WORKSPACE/);
    assert.equal(calls.length, 0, "deployment refusal must not shell out");

    const status = await purgeSweptPiiScreenshotsAction.status();
    assert.equal(status.state, "not-needed", "lever status is always synthetic not-needed");
    assert.match(status.detail, /dev-workspace app/);
    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(served.served, false, "unverifiable env never retires the lever");
  }

  // ── 2. NODE_ENV=test arming refusal with DEFAULT deps ──
  // This suite runs under NODE_ENV=test, so resetting to the real deps and
  // pressing must refuse BEFORE any git command. (isDeployment is false in
  // a workspace/test env; the arming gate is the first live check.)
  {
    __resetGitPiiPurgeDepsForTest();
    const out = await applyPiiPurge();
    assert.equal(out.state, "blocked");
    assert.match(out.detail, /NODE_ENV=test|test environment/i);
  }

  // ── 3. No git repository → blocked ──
  {
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: new Error("not a git repo") },
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "blocked");
    assert.match(out.detail, /No git repository/);

    const probe = await probePiiPurgeState();
    assert.equal(probe.env, "no_repo");
  }

  // ── 4. Detached HEAD → blocked ──
  {
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "HEAD\n" },
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "blocked");
    assert.match(out.detail, /detached HEAD/);
  }

  // ── 5. Already purged everywhere → not-needed, no rewrite ──
  {
    const { calls, runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "main\n" },
      { match: pathLog(P1), result: "" },
      { match: pathLog(P2), result: "" },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "not-needed");
    assert.match(out.detail, /already unreachable/);
    assert.equal(
      findCall(calls, (a) => a[0] === "filter-branch"),
      -1,
      "no rewrite when nothing is reachable",
    );

    const status = await purgeSweptPiiScreenshotsAction.status();
    assert.equal(status.state, "not-needed");
    assert.match(status.detail, /purge is complete here/);
    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(served.served, true, "verified-unreachable retires the lever");
    assert.match(served.note ?? "", /unreachable from every ref/);
  }

  // ── 6. Happy path: all-owned-refs rewrite + cleanup + verified-clean ──
  {
    removed.length = 0;
    const OLDEST = "d75aab309aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PARENT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const BLOB1 = "1111111111111111111111111111111111111111";
    const BLOB2 = "2222222222222222222222222222222222222222";
    let rewritten = false;
    const { calls, runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "main\n" },
      // Preflight sees both reachable; post-rewrite verification sees none.
      {
        match: (a) => pathLog(P1)(a),
        get result() {
          return rewritten ? "" : "feedcafe\n";
        },
      } as any,
      {
        match: (a) => pathLog(P2)(a),
        get result() {
          return rewritten ? "" : "feedcafe\n";
        },
      },
      { match: objects(P1), result: `${BLOB1} ${P1}\n` },
      { match: objects(P2), result: `${BLOB2} ${P2}\n` },
      {
        match: (a) =>
          a[0] === "log" && a[1] === "--reverse" && a.includes("HEAD"),
        result: `${OLDEST}\nfffffff\n`,
      },
      { match: is("rev-parse", `${OLDEST}^`), result: `${PARENT}\n` },
      {
        match: (a) => a[0] === "filter-branch",
        get result() {
          rewritten = true;
          return "Rewrite aaa (1/3)\nRewrite bbb (2/3)\nRewrite ccc (3/3)\n";
        },
      } as any,
      { match: backupRefList, result: "refs/original/refs/heads/main\n" },
      { match: is("update-ref", "-d"), result: "" },
      { match: is("remote"), result: "" },
      { match: is("stash", "list"), result: "" },
      { match: is("reflog", "expire"), result: "" },
      { match: (a) => a.includes("gc"), result: "" },
      { match: is("rm", "--cached"), result: "" },
      { match: is("cat-file", "-e", BLOB1), result: new Error("gone") },
      { match: is("cat-file", "-e", BLOB2), result: new Error("gone") },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "applied");
    assert.match(out.detail, /Rewrote 3 commit\(s\) across all local branches\/tags/);
    assert.match(out.detail, /2\/2 historical blob\(s\) unreachable/);
    assert.match(out.detail, /on-disk copies verified absent/);
    assert.match(out.detail, /repository-side purge is COMPLETE and verified/);
    assert.match(out.detail, /checkpoint snapshots.*outside the repository/);
    assert.doesNotMatch(out.detail, /STILL PENDING/);

    // Command-shape pins for the destructive step: every owned ref
    // (branches + tags) is rewritten, bounded below by the sweep parent,
    // with tags re-pointed — refs/remotes/* deliberately absent.
    const fb = calls.find((a) => a[0] === "filter-branch")!;
    assert.ok(fb, "filter-branch ran");
    assert.ok(fb.includes("-f") && fb.includes("--prune-empty"), "forced + prune-empty");
    const idx = fb[fb.indexOf("--index-filter") + 1];
    for (const p of PURGED_PII_PATHS) {
      assert.ok(idx.includes(p), `index-filter drops fixed path ${p}`);
    }
    assert.ok(idx.startsWith("git rm --cached --ignore-unmatch"), "index-filter only removes");
    assert.equal(fb[fb.indexOf("--tag-name-filter") + 1], "cat", "tags re-pointed, not dropped");
    assert.deepEqual(
      fb.slice(fb.indexOf("--") + 1),
      [`^${OLDEST}^`, "--branches", "--tags"],
      "rewrite covers ALL local branches+tags, bounded to the sweep range",
    );
    assert.ok(!fb.includes("--remotes"), "remote-tracking refs are never rewritten");

    // Ordering: rewrite → backup-ref cleanup → residual classification →
    // reflog expire → gc → index/disk cleanup → blob verification.
    const iFb = findCall(calls, (a) => a[0] === "filter-branch");
    const iRef = findCall(calls, is("update-ref", "-d", "refs/original/refs/heads/main"));
    const iScan = findCall(calls, residualTouchingAll);
    const iExp = findCall(calls, is("reflog", "expire", "--expire=now", "--all"));
    const iGc = findCall(calls, (a) => a.includes("gc") && a.includes("--prune=now"));
    const iRm = findCall(calls, is("rm", "--cached", "--ignore-unmatch"));
    const iCat = findCall(calls, is("cat-file", "-e", BLOB1));
    assert.ok(
      iFb < iRef && iRef < iScan && iScan < iExp && iExp < iGc && iGc < iRm && iRm < iCat,
      `cleanup order holds (${[iFb, iRef, iScan, iExp, iGc, iRm, iCat].join(" < ")})`,
    );
    assert.deepEqual(removed.sort(), [...PURGED_PII_PATHS].sort(), "disk copies deleted");
  }

  // ── 7. LIVE remote still retains the history → named, kept, PENDING ──
  // The realistic post-rewrite layout the 2026-08 review flagged: an
  // origin/main-style tracking ref keeps the old lineage. The lever must
  // NOT delete it (next fetch would restore it — deletion only hides the
  // exposure), must name it for source-side purging, and must stay
  // unretired.
  {
    const OLDEST = "d75aab309aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BLOB1 = "1111111111111111111111111111111111111111";
    const { calls, runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "main\n" },
      // Reachable before AND after (origin/main still pins the path).
      { match: pathLog(P1), result: "feedcafe\n" },
      { match: pathLog(P2), result: "" },
      { match: objects(P1), result: `${BLOB1} ${P1}\n` },
      { match: objects(P2), result: "" },
      {
        match: (a) => a[0] === "log" && a[1] === "--reverse" && a.includes("HEAD"),
        result: `${OLDEST}\n`,
      },
      { match: is("rev-parse", `${OLDEST}^`), result: "bbbb\n" },
      { match: (a) => a[0] === "filter-branch", result: "Rewrite aaa (1/1)\n" },
      { match: backupRefList, result: "refs/original/refs/heads/main\n" },
      { match: is("update-ref", "-d", "refs/original/refs/heads/main"), result: "" },
      { match: is("remote"), result: "origin\n" },
      { match: touchingLog(P1), result: "feedcafe\n" },
      { match: residualTouchingAll, result: "feedcafe\n" },
      { match: containsRefs("feedcafe"), result: "refs/remotes/origin/main\n" },
      { match: is("stash", "list"), result: "" },
      { match: is("reflog", "expire"), result: "" },
      { match: (a) => a.includes("gc"), result: "" },
      { match: is("rm", "--cached"), result: "" },
      { match: is("cat-file", "-e", BLOB1), result: "" }, // blob STILL exists
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "applied");
    assert.match(out.detail, /REMEDIATION STILL PENDING/);
    assert.match(out.detail, /refs\/remotes\/origin\/main/);
    assert.match(out.detail, /purged at its source/);
    assert.match(out.detail, /0\/1 historical blob\(s\) unreachable/);
    assert.equal(
      findCall(calls, is("update-ref", "-d", "refs/remotes/origin/main")),
      -1,
      "a LIVE remote's tracking ref is never deleted (deletion only hides the exposure)",
    );

    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(served.served, false, "residual reachability keeps the lever visible");
  }

  // ── 8. filter-branch failure → error with stderr context ──
  {
    const OLDEST = "d75aab309aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "main\n" },
      { match: pathLog(P1), result: "feedcafe\n" },
      { match: pathLog(P2), result: "" },
      { match: objects(P1), result: "" },
      { match: objects(P2), result: "" },
      {
        match: (a) => a[0] === "log" && a[1] === "--reverse" && a.includes("HEAD"),
        result: `${OLDEST}\n`,
      },
      { match: is("rev-parse", `${OLDEST}^`), result: "bbbb\n" },
      {
        match: (a) => a[0] === "filter-branch",
        result: new Error("index filter failed: disk full"),
      },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "error");
    assert.match(out.detail, /git filter-branch failed: .*disk full/);
  }

  // ── 9. Paths reachable only from foreign refs (nothing on HEAD) → blocked ──
  {
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "main\n" },
      { match: pathLog(P1), result: "feedcafe\n" },
      { match: pathLog(P2), result: "" },
      { match: objects(P1), result: "" },
      { match: objects(P2), result: "" },
      {
        match: (a) => a[0] === "log" && a[1] === "--reverse" && a.includes("HEAD"),
        result: "",
      },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "blocked");
    assert.match(out.detail, /refs other than the current branch/);
  }

  // ── 10. Workspace status with work remaining names the one-shot press ──
  {
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: pathLog(P1), result: "feedcafe\n" },
      { match: pathLog(P2), result: "feedcafe\n" },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const status = await purgeSweptPiiScreenshotsAction.status();
    assert.equal(status.state, "not-needed", "lever never feeds the badge");
    assert.match(status.detail, /PII remediation still PENDING/);
    assert.match(status.detail, /2 of 4 swept-in screenshot path\(s\) remain reachable/);
    assert.match(status.detail, /Fire this lever once/);
    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(served.served, false);
  }

  // ── 11. STALE tracking ref (remote no longer configured) → deleted, clean ──
  // A leftover refs/remotes/<gone>/main cache is the one residual class the
  // lever may remove itself: no live remote stands behind it, so deletion IS
  // the purge, and it must happen BEFORE gc so the blobs actually prune.
  {
    const OLDEST = "d75aab309aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BLOB1 = "1111111111111111111111111111111111111111";
    let rewritten = false;
    let staleDeleted = false;
    const { calls, runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "main\n" },
      {
        match: (a) => pathLog(P1)(a),
        get result() {
          return rewritten && staleDeleted ? "" : "feedcafe\n";
        },
      } as any,
      {
        match: (a) => pathLog(P2)(a),
        get result() {
          return rewritten && staleDeleted ? "" : "feedcafe\n";
        },
      } as any,
      { match: objects(P1), result: `${BLOB1} ${P1}\n` },
      { match: objects(P2), result: "" },
      {
        match: (a) => a[0] === "log" && a[1] === "--reverse" && a.includes("HEAD"),
        result: `${OLDEST}\n`,
      },
      { match: is("rev-parse", `${OLDEST}^`), result: "bbbb\n" },
      {
        match: (a) => a[0] === "filter-branch",
        get result() {
          rewritten = true;
          return "Rewrite aaa (1/2)\nRewrite bbb (2/2)\n";
        },
      } as any,
      { match: backupRefList, result: "refs/original/refs/heads/main\n" },
      {
        match: is("update-ref", "-d", "refs/remotes/main-repl/main"),
        get result() {
          staleDeleted = true;
          return "";
        },
      } as any,
      { match: is("update-ref", "-d"), result: "" },
      { match: is("remote"), result: "" }, // NO remotes configured
      { match: residualTouchingAll, result: "feedcafe\n" },
      { match: containsRefs("feedcafe"), result: "refs/remotes/main-repl/main\n" },
      { match: is("stash", "list"), result: "stash@{0}\n" },
      { match: is("reflog", "expire"), result: "" },
      { match: (a) => a.includes("gc"), result: "" },
      { match: is("rm", "--cached"), result: "" },
      { match: is("cat-file", "-e", BLOB1), result: new Error("gone") },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "applied");
    assert.match(out.detail, /Deleted 1 stale remote-tracking ref\(s\)/);
    assert.match(out.detail, /refs\/remotes\/main-repl\/main/);
    assert.match(out.detail, /repository-side purge is COMPLETE and verified/);
    assert.doesNotMatch(out.detail, /STILL PENDING/);
    assert.match(out.detail, /1 git stash entry exist/);

    const iDel = findCall(calls, is("update-ref", "-d", "refs/remotes/main-repl/main"));
    const iGc = findCall(calls, (a) => a.includes("gc") && a.includes("--prune=now"));
    assert.ok(iDel !== -1 && iDel < iGc, "stale tracking ref deleted BEFORE gc so blobs prune");
  }

  // ── 12. Disk deletion failure is a HARD verification failure ──
  // History gets clean, but removeFile throws (e.g. EACCES) and the file
  // is still present afterwards: the lever must retain the error, refuse
  // the COMPLETE claim, keep the status PENDING, and never retire.
  {
    const OLDEST = "d75aab309aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BLOB1 = "1111111111111111111111111111111111111111";
    let rewritten = false;
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "main\n" },
      {
        match: (a) => pathLog(P1)(a),
        get result() {
          return rewritten ? "" : "feedcafe\n";
        },
      } as any,
      {
        match: (a) => pathLog(P2)(a),
        get result() {
          return rewritten ? "" : "feedcafe\n";
        },
      } as any,
      { match: objects(P1), result: `${BLOB1} ${P1}\n` },
      { match: objects(P2), result: "" },
      {
        match: (a) => a[0] === "log" && a[1] === "--reverse" && a.includes("HEAD"),
        result: `${OLDEST}\n`,
      },
      { match: is("rev-parse", `${OLDEST}^`), result: "bbbb\n" },
      {
        match: (a) => a[0] === "filter-branch",
        get result() {
          rewritten = true;
          return "Rewrite aaa (1/1)\n";
        },
      } as any,
      { match: backupRefList, result: "refs/original/refs/heads/main\n" },
      { match: is("update-ref", "-d"), result: "" },
      { match: is("remote"), result: "" },
      { match: is("stash", "list"), result: "" },
      { match: is("reflog", "expire"), result: "" },
      { match: (a) => a.includes("gc"), result: "" },
      { match: is("rm", "--cached"), result: "" },
      { match: is("cat-file", "-e", BLOB1), result: new Error("gone") },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile: async (p) => {
        if (p === P1) throw new Error("EACCES: permission denied");
      },
      pathExists: async (p) => p === P1, // P1 survives the delete attempt
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "applied");
    assert.match(out.detail, /on-disk copies NOT clear/);
    assert.match(out.detail, /REMEDIATION STILL PENDING — on-disk copies could not be removed/);
    assert.match(out.detail, /EACCES/);
    assert.doesNotMatch(out.detail, /COMPLETE and verified/);

    // Status names the disk copy; retirement stays impossible.
    const status = await purgeSweptPiiScreenshotsAction.status();
    assert.match(status.detail, /PII remediation still PENDING/);
    assert.match(status.detail, /1 still sit on disk/);
    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(
      served.served,
      false,
      "a lingering disk copy must keep the lever visible even with clean history",
    );
  }

  // ── 13. Stash-only retention: refs/stash retains, and is NAMED ──
  // A screenshot reachable only via a stash: the --all verdict walk covers
  // refs/stash (it is a real ref), and the --contains naming pass must
  // surface it by NAME so the operator sees WHAT retains the path. The
  // lever stays pending and unretired.
  {
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: pathLog(P1), result: "feedcafe\n" },
      { match: touchingLog(P1), result: "feedcafe\n" },
      { match: containsRefs("feedcafe"), result: "refs/stash\n" },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const probe = await probePiiPurgeState();
    assert.equal(probe.env, "workspace");
    const p1 = probe.reachable.find((r) => r.path === P1)!;
    assert.equal(p1.reachable, true, "stash-retained path stays reachable");
    assert.deepEqual(p1.retainedBy, ["refs/stash"], "the retaining stash ref is NAMED");
    for (const r of probe.reachable.filter((r) => r.path !== P1)) {
      assert.equal(r.reachable, false, `${r.path} is clean`);
    }

    const status = await purgeSweptPiiScreenshotsAction.status();
    assert.match(status.detail, /PII remediation still PENDING/);
    assert.match(status.detail, /1 of 4 swept-in screenshot path\(s\) remain reachable/);
    assert.match(status.detail, /retained by: refs\/stash/);
    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(served.served, false, "a stash-retained path must never retire the lever");
  }

  // ── 14. Reflog-only retention (stash@{1}/HEAD@{n}) → still pending ──
  // No ref path-scan hits, but the --reflog catch-all does: the scanner
  // must report the pseudo-source and refuse retirement.
  {
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: reflogPathLog(P2), result: "feedcafe\n" },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const probe = await probePiiPurgeState();
    const p2 = probe.reachable.find((r) => r.path === P2)!;
    assert.equal(p2.reachable, true, "reflog-only retention still counts as reachable");
    assert.match(p2.retainedBy.join(" "), /reflog entries/);
    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(served.served, false);
  }

  // ── 14b. APPLY on reflog-only retention → expire+gc lane, verified ──
  // The 2026-08 review gap: no ref (and nothing on HEAD) retains the path,
  // only a reflog entry does. The oldest-commit scan would find nothing —
  // the lever must NOT return blocked; expiring reflogs + gc IS the
  // remediation, and verification must still gate the COMPLETE claim.
  {
    const BLOB1 = "1111111111111111111111111111111111111111";
    let expired = false;
    const { calls, runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "main\n" },
      {
        match: (a) => reflogPathLog(P1)(a),
        get result() {
          return expired ? "" : "feedcafe\n";
        },
      } as any,
      { match: objects(P1), result: `${BLOB1} ${P1}\n` },
      {
        match: is("reflog", "expire", "--expire=now", "--all"),
        get result() {
          expired = true;
          return "";
        },
      },
      { match: (a) => a.includes("gc"), result: "" },
      { match: is("rm", "--cached"), result: "" },
      { match: is("cat-file", "-e", BLOB1), result: new Error("gone") },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "applied", "reflog-only retention must be remediable, not blocked");
    assert.match(out.detail, /reachable only via reflog entries/);
    assert.match(out.detail, /Expired ALL reflogs/);
    assert.match(out.detail, /1\/1 historical blob\(s\) unreachable/);
    assert.match(out.detail, /on-disk copies verified absent/);
    assert.match(out.detail, /repository-side purge is COMPLETE and verified/);
    assert.doesNotMatch(out.detail, /STILL PENDING/);
    assert.equal(
      findCall(calls, (a) => a[0] === "filter-branch"),
      -1,
      "no rewrite when no ref retains the paths",
    );
    const iExp = findCall(calls, is("reflog", "expire"));
    const iGc = findCall(calls, (a) => a.includes("gc") && a.includes("--prune=now"));
    assert.ok(iExp !== -1 && iExp < iGc, "reflogs expired before gc so the entries prune");

    // Once verified clean, the lever may retire.
    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(served.served, true, "verified reflog cleanup retires the lever");
  }

  // ── 14c. Reflog-only lane with a FAILED expire stays PENDING ──
  {
    const BLOB1 = "1111111111111111111111111111111111111111";
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      { match: is("rev-parse", "--abbrev-ref", "HEAD"), result: "main\n" },
      { match: reflogPathLog(P1), result: "feedcafe\n" }, // never clears
      { match: objects(P1), result: `${BLOB1} ${P1}\n` },
      {
        match: is("reflog", "expire", "--expire=now", "--all"),
        result: new Error("reflog expire exploded"),
      },
      { match: (a) => a.includes("gc"), result: "" },
      { match: is("rm", "--cached"), result: "" },
      { match: is("cat-file", "-e", BLOB1), result: "" }, // blob survives
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const out = await applyPiiPurge();
    assert.equal(out.state, "applied");
    assert.match(out.detail, /reflog expire FAILED/);
    assert.match(out.detail, /REMEDIATION STILL PENDING — history remains reachable via/);
    assert.doesNotMatch(out.detail, /COMPLETE and verified/);
    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(served.served, false, "failed expire keeps the lever visible");
  }

  // ── 15. Ref-scan failure fails toward visibility ──
  {
    const { runGit } = makeGitRunner([
      { match: is("rev-parse", "--git-dir"), result: ".git\n" },
      {
        match: (a: string[]) => a[0] === "log" && a[1] === "--all",
        result: new Error("git log exploded"),
      },
      ...cleanTailRules,
    ]);
    __setGitPiiPurgeDepsForTest({
      isDeployment: () => false,
      runGit,
      removeFile,
      pathExists: noDisk,
      allowRewrite: armed,
    });
    const probe = await probePiiPurgeState();
    assert.ok(
      probe.reachable.every((r) => r.reachable),
      "unverifiable ref scan counts every path as retained",
    );
    const served = await purgeSweptPiiScreenshotsAction.servedPurpose!();
    assert.equal(served.served, false);
  }

  __resetGitPiiPurgeDepsForTest();
  console.log("prod-action-purge-pii-screenshots tests passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
