#!/usr/bin/env node
/**
 * Task #4617 — post-merge setup instrumentation + fingerprint-keyed skips.
 *
 * Used by scripts/post-merge.sh. MUST stay node-builtins-only: it runs
 * BEFORE `npm install` in the post-merge pipeline, so no npm dependency is
 * ever available. Keep everything synchronous — callers are bash lines.
 *
 * Responsibilities:
 *  1. Per-phase instrumentation with WRITE-AHEAD phase-start stamps: the
 *     stamp lands on disk before the phase command runs, so an outer-timeout
 *     SIGKILL (which cannot be trapped) still attributes the in-flight phase.
 *     Durable last-run report + append-only trimmed history (JSONL), reusing
 *     the canary ledger pattern.
 *  2. Fingerprint-keyed skips that FALL OPEN (any doubt ⇒ run) for exactly
 *     two phases: `npm install` and the SAFE_MIGRATIONS→drizzle-push→re-apply
 *     atomic trio. A skip is honored only when the fingerprint matches the
 *     last SUCCESSFUL completion in this environment. Interrupted phases
 *     never record fingerprints, so they re-run next time.
 *  3. Trio sentinel probe (P8 defense): before honoring a trio skip, parse
 *     the SAFE_MIGRATIONS list out of scripts/post-merge.sh, extract every
 *     CREATE TABLE/INDEX IF NOT EXISTS name those files create, and
 *     to_regclass()-check them against the live dev DB. Any missing object
 *     (e.g. a manual bare `drizzle-kit push` dropped raw-SQL objects between
 *     merges) ⇒ fall open and run the trio, exactly like today's always-run
 *     behavior would have healed it. No hand-maintained list to rot.
 *
 * Escape lever: POST_MERGE_FORCE_ALL=1 disables all skips.
 *
 * Exit-code contract for `should-skip-*`: exit 0 ⇒ SKIP is safe; exit 1 ⇒
 * RUN the phase. Every other subcommand exits 0 on success and is
 * best-effort from bash's perspective (instrumentation must never break the
 * pipeline; the caller wraps non-critical calls in `|| true`).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;
export const HISTORY_MAX_LINES = 200;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LAST_RUN_PATH = ".local/runs/post-merge-last-run.json";
export const HISTORY_PATH = ".local/runs/post-merge-history.jsonl";
export const FINGERPRINT_STATE_PATH = ".local/state/post-merge-fingerprints.json";
const POST_MERGE_SH = "scripts/post-merge.sh";

/* ------------------------------------------------------------------ */
/* Small injectable-deps toolkit (tests inject fakes; CLI uses real).  */
/* ------------------------------------------------------------------ */

export function realDeps(overrides = {}) {
  return {
    root: ROOT,
    env: process.env,
    now: () => new Date(),
    readFile: (p) => readFileSync(p, "utf8"),
    exists: (p) => existsSync(p),
    listDir: (p) => readdirSync(p, { withFileTypes: true }),
    stat: (p) => statSync(p),
    writeFileAtomic,
    spawn: (cmd, args, opts) => spawnSync(cmd, args, opts),
    log: (msg) => console.log(msg),
    ...overrides,
  };
}

export function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function readJsonOrNull(deps, path) {
  try {
    if (!deps.exists(path)) return null;
    return JSON.parse(deps.readFile(path));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Run/phase instrumentation                                           */
/* ------------------------------------------------------------------ */

export function beginRun(deps, { mergeSha = "", mergeBase = "" } = {}) {
  const lastRunPath = join(deps.root, LAST_RUN_PATH);
  const prior = readJsonOrNull(deps, lastRunPath);
  if (prior && !prior.finishedAt) {
    // Prior run never finished (outer-timeout SIGKILL or crash). Attribute
    // the in-flight phase and preserve the evidence in history.
    const inFlight = Array.isArray(prior.phases)
      ? prior.phases.find((p) => p.startedAt && !p.endedAt)
      : null;
    appendHistory(deps, {
      ...prior,
      interrupted: true,
      interruptedPhase: inFlight ? inFlight.name : null,
    });
  }
  const run = {
    schemaVersion: SCHEMA_VERSION,
    runId: `${deps.now().toISOString()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: deps.now().toISOString(),
    finishedAt: null,
    exit: null,
    mergeSha,
    mergeBase,
    phases: [],
  };
  deps.writeFileAtomic(lastRunPath, JSON.stringify(run, null, 2));
  return run;
}

export function phaseStart(deps, phaseName) {
  const lastRunPath = join(deps.root, LAST_RUN_PATH);
  const run = readJsonOrNull(deps, lastRunPath) ?? {
    schemaVersion: SCHEMA_VERSION,
    runId: `recovered-${deps.now().toISOString()}`,
    startedAt: deps.now().toISOString(),
    finishedAt: null,
    exit: null,
    mergeSha: "",
    mergeBase: "",
    phases: [],
  };
  run.phases = Array.isArray(run.phases) ? run.phases : [];
  run.phases.push({ name: phaseName, startedAt: deps.now().toISOString(), endedAt: null });
  // WRITE-AHEAD: this write completes before bash launches the phase command.
  deps.writeFileAtomic(lastRunPath, JSON.stringify(run, null, 2));
  return run;
}

export function phaseEnd(deps, phaseName, { exit = 0, skipped = false, skipReason = "" } = {}) {
  const lastRunPath = join(deps.root, LAST_RUN_PATH);
  const run = readJsonOrNull(deps, lastRunPath);
  if (!run) return null;
  run.phases = Array.isArray(run.phases) ? run.phases : [];
  // Latest un-ended entry for this phase (phases can repeat, e.g. npm retry).
  const entry = [...run.phases].reverse().find((p) => p.name === phaseName && !p.endedAt);
  const endedAt = deps.now().toISOString();
  if (entry) {
    entry.endedAt = endedAt;
    entry.exit = exit;
    entry.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(entry.startedAt));
    if (skipped) {
      entry.skipped = true;
      entry.skipReason = skipReason || "inputs unchanged since last successful run";
    }
  } else {
    run.phases.push({
      name: phaseName,
      startedAt: endedAt,
      endedAt,
      exit,
      durationMs: null,
      ...(skipped ? { skipped: true, skipReason: skipReason || "inputs unchanged since last successful run" } : {}),
    });
  }
  deps.writeFileAtomic(lastRunPath, JSON.stringify(run, null, 2));
  return run;
}

export function endRun(deps, { exit = 0 } = {}) {
  const lastRunPath = join(deps.root, LAST_RUN_PATH);
  const run = readJsonOrNull(deps, lastRunPath);
  if (!run) return null;
  run.finishedAt = deps.now().toISOString();
  run.exit = exit;
  deps.writeFileAtomic(lastRunPath, JSON.stringify(run, null, 2));
  appendHistory(deps, run);
  return run;
}

export function appendHistory(deps, entry) {
  const historyPath = join(deps.root, HISTORY_PATH);
  let lines = [];
  try {
    if (deps.exists(historyPath)) {
      lines = deps.readFile(historyPath).split("\n").filter((l) => l.trim() !== "");
    }
  } catch {
    lines = [];
  }
  lines.push(JSON.stringify(entry));
  if (lines.length > HISTORY_MAX_LINES) lines = lines.slice(lines.length - HISTORY_MAX_LINES);
  deps.writeFileAtomic(historyPath, lines.join("\n") + "\n");
}

/* ------------------------------------------------------------------ */
/* Fingerprints                                                        */
/* ------------------------------------------------------------------ */

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function hashFileInto(deps, hash, relPath) {
  const abs = join(deps.root, relPath);
  hash.update(relPath);
  hash.update("\u0000");
  hash.update(deps.readFile(abs));
  hash.update("\u0000");
}

function walkFiles(deps, relDir, out) {
  const abs = join(deps.root, relDir);
  if (!deps.exists(abs)) return;
  for (const ent of deps.listDir(abs)) {
    const rel = join(relDir, ent.name);
    if (ent.isDirectory()) walkFiles(deps, rel, out);
    else if (ent.isFile()) out.push(rel);
  }
}

/** npm-install phase fingerprint: dependency manifests only. */
export function computeNpmFingerprint(deps) {
  const hash = createHash("sha256");
  for (const f of ["package.json", "package-lock.json"]) hashFileInto(deps, hash, f);
  return hash.digest("hex");
}

/**
 * Atomic-trio fingerprint: everything that changes what the trio DOES.
 *  - migrations/** content (covers the SAFE_MIGRATIONS files and any new
 *    migration a merge brought — new/edited migration ⇒ fingerprint bust)
 *  - shared/** (drizzle schema + models — push input)
 *  - drizzle.config.ts (push config), package-lock.json (drizzle-kit version)
 *  - scripts/post-merge.sh itself (the SAFE_MIGRATIONS list lives there)
 *  - sha256(DATABASE_URL) — a different target DB is a different environment
 */
export function computeTrioFingerprint(deps) {
  const files = [];
  walkFiles(deps, "migrations", files);
  walkFiles(deps, "shared", files);
  for (const f of ["drizzle.config.ts", "package-lock.json", POST_MERGE_SH]) {
    if (deps.exists(join(deps.root, f))) files.push(f);
  }
  files.sort();
  const hash = createHash("sha256");
  for (const f of files) hashFileInto(deps, hash, f);
  hash.update("db\u0000");
  hash.update(sha256(String(deps.env.DATABASE_URL || "")));
  return hash.digest("hex");
}

export function readFingerprintState(deps) {
  return readJsonOrNull(deps, join(deps.root, FINGERPRINT_STATE_PATH)) ?? {
    schemaVersion: SCHEMA_VERSION,
  };
}

export function recordPhaseFingerprint(deps, phaseKey, fingerprint) {
  const state = readFingerprintState(deps);
  state[phaseKey] = {
    fingerprint,
    recordedAt: deps.now().toISOString(),
    mergeSha: deps.env.CANARY_MERGE_SHA || "",
  };
  deps.writeFileAtomic(join(deps.root, FINGERPRINT_STATE_PATH), JSON.stringify(state, null, 2));
  return state;
}

/* ------------------------------------------------------------------ */
/* Skip decisions — every uncertain path returns {skip:false}.         */
/* ------------------------------------------------------------------ */

export function decideNpmSkip(deps) {
  try {
    if (String(deps.env.POST_MERGE_FORCE_ALL || "") === "1") {
      return { skip: false, reason: "POST_MERGE_FORCE_ALL=1" };
    }
    const state = readFingerprintState(deps);
    if (!state.npm || !state.npm.fingerprint) {
      return { skip: false, reason: "no recorded successful npm install for this environment" };
    }
    const current = computeNpmFingerprint(deps);
    if (current !== state.npm.fingerprint) {
      return { skip: false, reason: "dependency manifests changed since last successful install" };
    }
    // Installed-tree probe: manifests unchanged but node_modules absent/torn.
    if (!deps.exists(join(deps.root, "node_modules", ".package-lock.json"))) {
      return { skip: false, reason: "node_modules/.package-lock.json missing (installed tree absent or torn)" };
    }
    return { skip: true, reason: "inputs unchanged since last successful run" };
  } catch (err) {
    return { skip: false, reason: `skip check errored (falling open): ${err?.message ?? err}` };
  }
}

/**
 * Parse the SAFE_MIGRATIONS=( ... ) array out of scripts/post-merge.sh.
 * Same shape tests/hermetic/bootstrap-db.ts relies on. Throws when the
 * array is absent/empty — callers fall open.
 */
export function parseSafeMigrations(shContent) {
  // Closing paren anchored at line start: comment lines INSIDE the array can
  // end with ")" (e.g. "(Task #3706)"), so a bare ")\n" match truncates early.
  const m = shContent.match(/SAFE_MIGRATIONS=\(([\s\S]*?)\n\)/);
  if (!m) throw new Error("SAFE_MIGRATIONS array not found in post-merge.sh");
  const entries = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (entries.length === 0) throw new Error("SAFE_MIGRATIONS array parsed empty");
  return entries;
}

/**
 * Extract the ordered create/drop operations on relations from a SQL file.
 * Only idempotent forms count (IF NOT EXISTS / IF EXISTS) — those are
 * exactly the raw-SQL objects the trio's re-apply pass manages (P8).
 * Order matters: SAFE_MIGRATIONS deliberately contains later files that
 * DROP objects earlier files created (e.g. 0138 drops the retired
 * google_ads_* tables 0108 created), and the net result after applying
 * the whole array in order is what the dev DB should actually contain.
 */
/** Strip SQL comments so commented-out statements never count (0067 keeps a
 *  disabled CREATE UNIQUE INDEX in a comment block). Naive about comment
 *  markers inside string literals — fine for an advisory fall-open probe. */
export function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function cleanName(raw) {
  const n = String(raw ?? "").trim().replaceAll('"', "");
  return /^[A-Za-z0-9_.]+$/.test(n) ? n : null;
}

function lastSegment(name) {
  return name.split(".").pop();
}

export function extractObjectOps(sql) {
  const clean = stripSqlComments(sql);
  const creates = [];
  const drops = [];
  for (const m of clean.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+("?[A-Za-z0-9_.]+"?)/gi)) {
    const name = cleanName(m[1]);
    if (name) creates.push({ kind: "table", name });
  }
  for (const m of clean.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+("?[A-Za-z0-9_.]+"?)\s+ON\s+(?:ONLY\s+)?("?[A-Za-z0-9_.]+"?)/gi,
  )) {
    const name = cleanName(m[1]);
    const onTable = cleanName(m[2]);
    if (name) creates.push({ kind: "index", name, onTable });
  }
  for (const m of clean.matchAll(/DROP\s+TABLE\s+IF\s+EXISTS\s+([A-Za-z0-9_.",\s]+?)(?=CASCADE|RESTRICT|;)/gi)) {
    for (const part of m[1].split(",")) {
      const name = cleanName(part);
      if (name) drops.push({ kind: "table", name });
    }
  }
  for (const m of clean.matchAll(/DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?IF\s+EXISTS\s+([A-Za-z0-9_.",\s]+?)(?=CASCADE|RESTRICT|;)/gi)) {
    for (const part of m[1].split(",")) {
      const name = cleanName(part);
      if (name) drops.push({ kind: "index", name });
    }
  }
  return { creates, drops };
}

/**
 * Net protected-object set after applying file contents in array order.
 * A DROP TABLE implicitly drops that table's indexes (0138 drops the
 * retired google_ads_* tables whose *_uq indexes 0108 created), so index
 * creations remember their ON table and vanish with it.
 */
export function computeProtectedObjects(sqlContents) {
  const live = new Map(); // name -> {kind, onTable?}
  for (const sql of sqlContents) {
    const { creates, drops } = extractObjectOps(sql);
    for (const c of creates) live.set(c.name, c);
    for (const d of drops) {
      live.delete(d.name);
      if (d.kind === "table") {
        for (const [n, v] of [...live]) {
          if (v.kind === "index" && v.onTable && lastSegment(v.onTable) === lastSegment(d.name)) {
            live.delete(n);
          }
        }
      }
    }
  }
  return [...live.keys()];
}

/**
 * Sentinel probe: verify every protected object exists via to_regclass.
 * Returns { ok:true } or { ok:false, reason } — callers fall open on !ok.
 */
export function runTrioSentinel(deps) {
  try {
    const sh = deps.readFile(join(deps.root, POST_MERGE_SH));
    const migrationFiles = parseSafeMigrations(sh);
    const contents = [];
    for (const rel of migrationFiles) {
      const abs = join(deps.root, rel);
      if (!deps.exists(abs)) continue; // same tolerance as the bash loop's [ -f ]
      contents.push(deps.readFile(abs));
    }
    const names = new Set(computeProtectedObjects(contents));
    if (names.size === 0) {
      return { ok: false, reason: "sentinel found no protected objects to verify (unexpected)" };
    }
    const list = [...names].map((n) => `'${n}'`).join(",");
    const query = `SELECT n FROM unnest(ARRAY[${list}]) AS n WHERE to_regclass(n) IS NULL;`;
    const res = deps.spawn("psql", [String(deps.env.DATABASE_URL || ""), "-tA", "-v", "ON_ERROR_STOP=1", "-c", query], {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (res.error || res.status !== 0) {
      return { ok: false, reason: `sentinel psql probe failed: ${res.error?.message ?? `exit ${res.status}`}` };
    }
    const missing = String(res.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    if (missing.length > 0) {
      return { ok: false, reason: `protected objects missing from dev DB: ${missing.join(", ")}` };
    }
    return { ok: true, reason: `all ${names.size} protected objects present` };
  } catch (err) {
    return { ok: false, reason: `sentinel errored (falling open): ${err?.message ?? err}` };
  }
}

export function decideTrioSkip(deps) {
  try {
    if (String(deps.env.POST_MERGE_FORCE_ALL || "") === "1") {
      return { skip: false, reason: "POST_MERGE_FORCE_ALL=1" };
    }
    const state = readFingerprintState(deps);
    if (!state.trio || !state.trio.fingerprint) {
      return { skip: false, reason: "no recorded successful schema trio for this environment" };
    }
    const current = computeTrioFingerprint(deps);
    if (current !== state.trio.fingerprint) {
      return { skip: false, reason: "schema/migration inputs changed since last successful trio" };
    }
    const sentinel = runTrioSentinel(deps);
    if (!sentinel.ok) {
      return { skip: false, reason: sentinel.reason };
    }
    return { skip: true, reason: `inputs unchanged since last successful run; ${sentinel.reason}` };
  } catch (err) {
    return { skip: false, reason: `skip check errored (falling open): ${err?.message ?? err}` };
  }
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function argValue(args, name) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

export function cliMain(argv) {
  const [cmd, ...args] = argv;
  const deps = realDeps();
  switch (cmd) {
    case "begin-run":
      beginRun(deps, { mergeSha: argValue(args, "merge-sha"), mergeBase: argValue(args, "merge-base") });
      return 0;
    case "phase-start":
      phaseStart(deps, argValue(args, "phase") || "unknown");
      return 0;
    case "phase-end":
      phaseEnd(deps, argValue(args, "phase") || "unknown", {
        exit: Number(argValue(args, "exit") || "0"),
        skipped: args.includes("--skipped"),
        skipReason: argValue(args, "skip-reason"),
      });
      return 0;
    case "end-run":
      endRun(deps, { exit: Number(argValue(args, "exit") || "0") });
      return 0;
    case "should-skip-npm": {
      const d = decideNpmSkip(deps);
      deps.log(`[post-merge-instrument] npm-install skip=${d.skip}: ${d.reason}`);
      return d.skip ? 0 : 1;
    }
    case "record-npm-success":
      recordPhaseFingerprint(deps, "npm", computeNpmFingerprint(deps));
      return 0;
    case "should-skip-trio": {
      const d = decideTrioSkip(deps);
      deps.log(`[post-merge-instrument] schema-trio skip=${d.skip}: ${d.reason}`);
      return d.skip ? 0 : 1;
    }
    case "record-trio-success":
      recordPhaseFingerprint(deps, "trio", computeTrioFingerprint(deps));
      return 0;
    default:
      console.error(`[post-merge-instrument] unknown subcommand: ${cmd ?? "(none)"}`);
      return 2;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(cliMain(process.argv.slice(2)));
}
