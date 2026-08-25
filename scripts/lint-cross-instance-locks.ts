/**
 * Task #2382 — Lint guard against new background jobs that lack
 * cross-instance protection on the `autoscale` deploy target.
 *
 * Background: Task #2363 audited every scheduler/worker by hand and gave
 * the run-once ones a cluster-wide Postgres advisory lock
 * (`server/services/crossInstanceLock.ts` / `workerLock.acquireDistributedLock`).
 * The deploy target is `autoscale`, so almost every `setInterval` cron or
 * worker starts on EVERY instance (workspace process + each deployed
 * instance). A "run-once" job guarded only by an in-process flag (a
 * boolean, a `Set`, or the in-memory `workerLock` Map) therefore still
 * runs once PER INSTANCE — double external-API calls, double rollup
 * writes, etc.
 *
 * That audit is a point-in-time snapshot. Nothing stops a future engineer
 * from adding a NEW scheduler guarded only by an in-process flag and
 * silently reintroducing the double-run-on-autoscale bug. This lint is the
 * standing guard, mirroring `lint-db-pool-tenancy` /
 * `lint-getdb-attribution`: every file under `server/` that schedules
 * recurring background work must be accounted for.
 *
 * A `setInterval(...)` cron is only ONE way to schedule recurring work.
 * Task #2397: the guard also recognizes two other run-once-prone patterns
 * that would otherwise slip past:
 *
 *   - A self-rescheduling `setTimeout(...)` loop — a function that re-arms
 *     a `setTimeout` on every tick (either `setTimeout(tick, ms)` with a
 *     named callback, or a `scheduleNext()`-style function whose callback
 *     calls itself). This behaves exactly like a `setInterval` cron at
 *     runtime, so it carries the same double-run-on-autoscale risk.
 *   - A cron-library scheduler entry point — `node-cron`'s
 *     `cron.schedule(...)`, the `cron` package's `new CronJob(...)`,
 *     `node-schedule`'s `scheduleJob(...)`, `croner`'s `new Cron(...)`, or
 *     `toad-scheduler` — which likewise fires on every instance.
 *
 * The ubiquitous one-shot delay / sleep helper
 * `await new Promise((r) => setTimeout(r, ms))` is NOT a self-rescheduling
 * loop and is deliberately not flagged: its callback is a promise
 * resolver, never a file-level function that re-arms the timer.
 *
 * A scheduler-bearing file PASSES when ANY of the following holds:
 *
 *   1. It references a cross-instance lock helper
 *      (`acquireWorkerSingletonLock`, `withWorkerSingletonLock`,
 *      `acquireDistributedLock`, or `acquireCrossInstanceLock`) — the job
 *      is a cluster-wide singleton.
 *
 *   2. It carries an explicit safe-by-design annotation in its header
 *      (first HEADER_LINES lines):
 *
 *        // @cross-instance-safe: <reason>
 *
 *      Use this when the recurring work is safe to run on every instance
 *      by design — e.g. it claims `work_queue` rows with
 *      `FOR UPDATE SKIP LOCKED` (and WANTS every instance polling), it is
 *      idempotent (UPSERT / dedupe-keyed / cooldown-guarded emit), or it
 *      is gated to the deployment via `shouldRunFrontBackgroundWorkers()`.
 *      State the specific reason so the next reader can check it.
 *
 *   3. Its path is listed in the baseline
 *      (`scripts/lint-cross-instance-locks.baseline.txt`) — the set of
 *      schedulers that existed and were audited when this guard shipped
 *      (the Task #2363 snapshot). Each baseline line carries its audit
 *      category as rationale.
 *
 * The lint FAILS when:
 *
 *   1. A new scheduler-bearing file (setInterval, self-rescheduling
 *      setTimeout loop, or cron-library entry point) is none of the above
 *      — i.e. a new background entry point with no cross-instance
 *      protection and no declared rationale.
 *   2. A baseline entry is stale (the file no longer exists, or no longer
 *      schedules recurring background work) — keep the baseline honest.
 *
 * To make the lint pass for a NEW job: wrap the run-once work in
 * `withWorkerSingletonLock(name, fn)` (see `crossInstanceLock.ts`), or add
 * a `// @cross-instance-safe: <reason>` header annotation if it is safe by
 * design. Adding a path to the baseline is the grandfather escape hatch
 * and should be reserved for the audited snapshot — prefer the annotation.
 *
 * Baseline format: one `<path>` per line. Trailing `# ...` comments and
 * blank lines are ignored. See `WORKERS_QUEUES_RUNBOOK.md §
 * Cross-instance run-once worker locks`.
 *
 * Exit codes:
 *   0 — every scheduler is protected, annotated, or baselined.
 *   1 — at least one new unprotected scheduler, or a stale baseline entry.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Scope intentionally fixed (Task #2846): background schedulers that need
// cross-instance locks are registered only in server runtime code; scripts/
// one-offs run manually, not as autoscale-resident intervals.
const DEFAULT_ROOT = "server";
const DEFAULT_BASELINE_PATH = "scripts/lint-cross-instance-locks.baseline.txt";
const HEADER_LINES = 80;

// A file "schedules recurring background work" when it calls setInterval.
const SET_INTERVAL_RE = /\bsetInterval\s*\(/;

// Cron-library scheduler entry points. node-cron (`cron.schedule`), the
// `cron` package (`new CronJob`), node-schedule (`scheduleJob`), croner
// (`new Cron(`), and toad-scheduler all fire on every instance just like a
// setInterval cron, so a cron-bearing file is a scheduler entry point too.
const CRON_RE =
  /\bcron\.schedule\s*\(|\bnew\s+CronJob\b|\bscheduleJob\s*\(|\bnew\s+Cron\s*\(|\bToadScheduler\b|\bSimpleIntervalJob\b|(?:from|require\(\s*)["'](?:node-cron|node-schedule|cron|croner|toad-scheduler)["']/;

// Cross-instance lock helpers — referencing any of these means the job
// takes the cluster-wide advisory lock and is a singleton.
const LOCK_HELPER_RE =
  /\b(acquireWorkerSingletonLock|withWorkerSingletonLock|acquireDistributedLock|acquireCrossInstanceLock)\b/;

// Explicit safe-by-design annotation, anywhere in the file header.
const SAFE_ANNOTATION_RE = /@cross-instance-safe\b/;

// The lock primitives themselves define `setInterval` (heartbeat) and/or
// the helpers; they are infrastructure, not background entry points.
const PRIMITIVE_FILES = new Set<string>([
  "server/services/workerLock.ts",
  "server/services/crossInstanceLock.ts",
]);

export interface LintOptions {
  root: string;
  baselinePath: string;
}

export interface LintResult {
  ok: boolean;
  /** Scheduler files scanned (excluding primitives). */
  scanned: number;
  protectedCount: number;
  annotatedCount: number;
  baselinedCount: number;
  /** New scheduler files with no protection/annotation/baseline. */
  offenders: Array<{ file: string; reason: string }>;
  /** Baseline entries that are no longer schedulers. */
  stale: string[];
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent === "node_modules" || ent.startsWith(".")) continue;
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
    out.push(full);
  }
}

function loadBaseline(path: string): Set<string> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    // Strip trailing comments and whitespace; ignore comment-only/blank lines.
    const withoutComment = line.split("#")[0];
    const trimmed = withoutComment.trim();
    if (!trimmed) continue;
    out.add(trimmed);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Keywords after which a `/` begins a regex literal (operand position),
// not a division operator.
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "case", "do", "else",
  "void", "delete", "yield", "await", "new",
]);

// Chars after which a `/` begins a regex literal. `)`, `]`, `}` and word
// chars are operands → a following `/` is division.
const REGEX_PREV_CHARS = "(){[,;:=!&|?+-*/%^~<>";

// The identifier ending just before index `idx` in `src`, for deciding
// whether a `/` after a keyword (e.g. `return /re/`) starts a regex.
function prevWord(src: string, idx: number): string {
  let j = idx - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  const end = j;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j])) j--;
  return src.slice(j + 1, end + 1);
}

// Replace the CONTENTS of string literals, template literals, comments, and
// regex literals with spaces (preserving length and newlines) so the
// structural scans below never trip on a `setInterval` / `setTimeout` /
// `cron.schedule` / brace / quote that lives inside one of them. Code —
// including the identifiers we care about — is left untouched. Template
// literals are masked whole (including any `${...}` expressions); reschedule
// self-calls never live inside a template, so nothing real is lost and brace
// balance is preserved. Regex literals MUST be masked too: an `escapeXml`
// helper's `.replace(/"/g, ...)` / `.replace(/'/g, ...)` would otherwise
// flip the scanner into string mode and swallow the rest of the file.
export function maskLiterals(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  // Last significant code char seen — used only to disambiguate a `/` as
  // a regex literal vs a division operator.
  let prev = "";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") (out[i] = " "), i++;
      continue; // prev unchanged across a comment
    }
    if (c === "/" && c2 === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) (out[i] = " "), (out[i + 1] = " "), (i += 2);
      continue; // prev unchanged across a comment
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out[i] = " ";
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          out[i] = " ";
          if (i + 1 < n && src[i + 1] !== "\n") out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          out[i] = " ";
          i++;
          break;
        }
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      prev = ")"; // a string/template is an operand
      continue;
    }
    if (c === "/") {
      let isRegex = prev === "" || REGEX_PREV_CHARS.includes(prev);
      if (!isRegex && /[A-Za-z0-9_$]/.test(prev)) {
        isRegex = REGEX_KEYWORDS.has(prevWord(src, i));
      }
      if (isRegex) {
        out[i] = " ";
        i++;
        let inClass = false;
        while (i < n && src[i] !== "\n") {
          const ch = src[i];
          if (ch === "\\") {
            out[i] = " ";
            if (i + 1 < n && src[i + 1] !== "\n") out[i + 1] = " ";
            i += 2;
            continue;
          }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) {
            out[i] = " ";
            i++;
            break;
          }
          out[i] = " ";
          i++;
        }
        // Mask trailing flags (g, i, m, s, u, y, d).
        while (i < n && /[a-z]/i.test(src[i])) (out[i] = " "), i++;
        prev = ")"; // a regex is an operand
        continue;
      }
      prev = "/";
      i++;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

// Index of the brace matching the `{` at `open` in already-masked source
// (strings/comments removed), or -1 if unbalanced.
function matchBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

// The text of the first top-level argument of the call whose `(` is at
// `openParen` in already-masked source — i.e. a `setTimeout(...)` callback.
// Stops at the first top-level comma or the matching close paren.
function firstCallArg(masked: string, openParen: number): string {
  let depth = 0;
  const argStart = openParen + 1;
  for (let i = openParen; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (--depth === 0) return masked.slice(argStart, i);
    } else if (c === "," && depth === 1) {
      return masked.slice(argStart, i);
    }
  }
  return masked.slice(argStart);
}

// Collect every name defined as a function in this file: classic
// `function NAME(`, and `const|let|var NAME = (async)? (...) =>` /
// `= function`. The set lets us tell a genuine self-rescheduling callback
// (`setTimeout(tick, ms)`, where `tick` is a file-level function) apart
// from the ubiquitous sleep helper (`setTimeout(resolve, ms)`, where
// `resolve` is just a promise-resolver parameter, never a defined fn).
// Operates on masked source.
function collectFunctionDefs(masked: string): Array<{ name: string; index: number }> {
  const defs: Array<{ name: string; index: number }> = [];
  const fnDecl = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = fnDecl.exec(masked))) defs.push({ name: m[1], index: m.index });
  const arrowConst =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  while ((m = arrowConst.exec(masked))) defs.push({ name: m[1], index: m.index });
  return defs;
}

// Brace-matched `{...}` body of the function whose definition keyword starts
// at `defIndex`, or null for an expression-bodied arrow (no block). The
// param list is paren-matched first so a destructured/defaulted param does
// not confuse the body-brace search. Operates on masked source.
function findBlockBody(masked: string, defIndex: number): [number, number] | null {
  const paren = masked.indexOf("(", defIndex);
  if (paren === -1) return null;
  let depth = 0;
  let i = paren;
  for (; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      i++;
      break;
    }
  }
  // Between the param close and the body `{` lies only `=>` / a return-type
  // annotation. A `;` first means an expression-bodied arrow (no block).
  const limit = Math.min(masked.length, i + 400);
  let brace = -1;
  for (let j = i; j < limit; j++) {
    const c = masked[j];
    if (c === "{") {
      brace = j;
      break;
    }
    if (c === ";") break;
  }
  if (brace === -1) return null;
  const close = matchBrace(masked, brace);
  return close === -1 ? null : [brace, close];
}

// A self-rescheduling `setTimeout(...)` loop re-arms a timer on every tick,
// behaving exactly like a `setInterval` cron. Two structural forms are
// detected, both keyed on the set of file-level function names so the
// ubiquitous `new Promise((r) => setTimeout(r, ms))` sleep helper (whose
// callback is a promise resolver, not a defined function) is NOT flagged:
//
//   Form 1 — bare named callback: `setTimeout(tick, ms)` where `tick` is a
//            function defined in this file.
//   Form 2 — recursive scheduler: a block-bodied function `F` that re-arms
//            a timer whose CALLBACK calls `F` again — i.e. a `setTimeout(`
//            inside `F` whose first argument (the callback) contains a
//            self-call `F(` (e.g. a `scheduleNext()` helper whose timer
//            callback calls itself).
//
// The callback-scoped check is what separates a genuine reschedule from a
// retry-with-sleep: `await new Promise(r => setTimeout(r, ms)); return F();`
// also recurses, but the recursion runs AFTER the sleep, OUTSIDE the
// `setTimeout(r, ...)` callback (whose only argument is the resolver `r`),
// so it is correctly NOT flagged.
//
// `masked` must be the literal-masked source (see maskLiterals).
export function hasSelfReschedulingTimeout(masked: string): boolean {
  if (!/\bsetTimeout\s*\(/.test(masked)) return false;
  const defs = collectFunctionDefs(masked);
  if (defs.length === 0) return false;
  const names = new Set(defs.map((d) => d.name));

  // Form 1: setTimeout(<fn-name>, ...) — a bare named callback.
  const bareCb = /\bsetTimeout\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
  let m: RegExpExecArray | null;
  while ((m = bareCb.exec(masked))) {
    if (names.has(m[1])) return true;
  }

  // Form 2: a block-bodied function F whose body holds a `setTimeout(`
  // whose callback re-invokes F. Proper body bounding is essential: the
  // sleep helper's tiny expression body never includes its caller's
  // `sleep(...)` call, so `await sleep(ms)` polling loops are not loops.
  for (const { name, index } of defs) {
    const body = findBlockBody(masked, index);
    if (!body) continue;
    const text = masked.slice(body[0], body[1] + 1);
    const selfCall = new RegExp("\\b" + escapeRegExp(name) + "\\s*\\(");
    const st = /\bsetTimeout\s*\(/g;
    let sm: RegExpExecArray | null;
    while ((sm = st.exec(text))) {
      const openParen = sm.index + sm[0].length - 1;
      if (selfCall.test(firstCallArg(text, openParen))) return true;
    }
  }
  return false;
}

// A file is a recurring-background-work scheduler entry point if it uses
// any of: setInterval, a self-rescheduling setTimeout loop, or a cron lib.
// `masked` must be the literal-masked source (see maskLiterals).
export function isSchedulerFile(masked: string): boolean {
  return (
    SET_INTERVAL_RE.test(masked) ||
    CRON_RE.test(masked) ||
    hasSelfReschedulingTimeout(masked)
  );
}

// Human-readable summary of WHICH scheduler pattern(s) a file uses, for the
// offender message so the engineer knows what tripped the guard.
// `masked` must be the literal-masked source (see maskLiterals).
function describeScheduler(masked: string): string {
  const kinds: string[] = [];
  if (SET_INTERVAL_RE.test(masked)) kinds.push("calls setInterval(...)");
  if (hasSelfReschedulingTimeout(masked))
    kinds.push("has a self-rescheduling setTimeout(...) loop");
  if (CRON_RE.test(masked)) kinds.push("registers a cron-library scheduler");
  return kinds.join(" / ");
}

export function runLint(options: LintOptions): LintResult {
  const files: string[] = [];
  walk(options.root, files);

  const baseline = loadBaseline(options.baselinePath);
  const seenInScan = new Set<string>();

  const offenders: Array<{ file: string; reason: string }> = [];
  let protectedCount = 0;
  let annotatedCount = 0;
  let baselinedCount = 0;

  for (const file of files) {
    if (PRIMITIVE_FILES.has(file)) continue;
    const src = readFileSync(file, "utf8");
    // Structural scans run on the literal-masked copy so a `setInterval` /
    // `setTimeout` / `cron.schedule` mention inside a comment or string is
    // never flagged. The `@cross-instance-safe` annotation, however, LIVES
    // in a comment, so it must be matched against the raw source.
    const masked = maskLiterals(src);
    if (!isSchedulerFile(masked)) continue;
    seenInScan.add(file);

    if (LOCK_HELPER_RE.test(masked)) {
      protectedCount++;
      continue;
    }
    const header = src.split("\n", HEADER_LINES).join("\n");
    if (SAFE_ANNOTATION_RE.test(header)) {
      annotatedCount++;
      continue;
    }
    if (baseline.has(file)) {
      baselinedCount++;
      continue;
    }
    offenders.push({
      file,
      reason: `${describeScheduler(masked)} but has no cross-instance lock, no \`@cross-instance-safe\` annotation, and is not baselined`,
    });
  }

  // Stale baseline entries: listed but no longer a scheduler entry point.
  const stale: string[] = [];
  for (const entry of Array.from(baseline)) {
    if (seenInScan.has(entry)) continue;
    if (!existsSync(entry)) {
      stale.push(`${entry} (file no longer exists)`);
      continue;
    }
    const src = readFileSync(entry, "utf8");
    if (!isSchedulerFile(maskLiterals(src))) {
      stale.push(`${entry} (no longer schedules recurring background work)`);
    }
  }

  return {
    ok: offenders.length === 0 && stale.length === 0,
    scanned: seenInScan.size,
    protectedCount,
    annotatedCount,
    baselinedCount,
    offenders,
    stale,
  };
}

export function cliMain(): number {
  const result = runLint({ root: DEFAULT_ROOT, baselinePath: DEFAULT_BASELINE_PATH });
  const { offenders, stale } = result;

  if (offenders.length === 0 && stale.length === 0) {
    console.log(
      `lint-cross-instance-locks: OK (${result.scanned} setInterval scheduler${
        result.scanned === 1 ? "" : "s"
      } under ${DEFAULT_ROOT}/: ${result.protectedCount} lock-protected, ${result.annotatedCount} annotated, ${result.baselinedCount} baselined)`,
    );
    return 0;
  }

  if (offenders.length > 0) {
    console.error("");
    console.error(
      "✗ lint-cross-instance-locks: new background scheduler(s) without cross-instance protection",
    );
    console.error("");
    console.error(
      "  The deploy target is `autoscale`, so a setInterval scheduler starts on EVERY",
    );
    console.error(
      "  instance. A run-once job guarded only by an in-process flag (boolean / Set /",
    );
    console.error(
      "  the in-memory workerLock Map) still runs once PER INSTANCE — double external",
    );
    console.error("  API calls, double rollup writes, etc.");
    console.error("");
    console.error("  Fix one of three ways:");
    console.error("");
    console.error(
      "    A) Make it a cluster-wide singleton (preferred for run-once jobs):",
    );
    console.error(
      '       import { withWorkerSingletonLock } from "./crossInstanceLock";',
    );
    console.error(
      '       await withWorkerSingletonLock("my_job_name", async () => { ... });',
    );
    console.error("");
    console.error(
      "    B) If it is safe to run on every instance by design, add a header comment:",
    );
    console.error(
      "       // @cross-instance-safe: <reason — e.g. work_queue SKIP LOCKED / idempotent",
    );
    console.error("       //   UPSERT / deployment-gated>");
    console.error("");
    console.error(
      `    C) Grandfather it (audited snapshot only) by adding the path to`,
    );
    console.error(`       ${DEFAULT_BASELINE_PATH} with its rationale.`);
    console.error("");
    console.error(
      "  See WORKERS_QUEUES_RUNBOOK.md § Cross-instance run-once worker locks.",
    );
    console.error("");
    console.error("  Offending files:");
    for (const o of offenders) console.error(`    - ${o.file}: ${o.reason}`);
    console.error("");
  }

  if (stale.length > 0) {
    console.error("");
    console.error(
      "✗ lint-cross-instance-locks: stale baseline entries (no longer setInterval schedulers)",
    );
    console.error("");
    console.error(`  Remove these from ${DEFAULT_BASELINE_PATH}:`);
    for (const s of stale) console.error(`    - ${s}`);
    console.error("");
  }

  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-cross-instance-locks.ts");

if (isMain) {
  process.exit(cliMain());
}
