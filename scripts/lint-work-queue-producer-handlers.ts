/**
 * Task #2833 — Catch queues that are enqueued but have no handler, before
 * they ship.
 *
 * Background: Task #2637 deleted the `retroactive_reprocess` handler while
 * leaving three producers live — ~50k jobs/week failed silently for months
 * because the startup assert (`assertRequiredHandlersRegistered` in
 * server/index.ts) is warn-and-continue, and the Task #2824 smoke test only
 * covers the HARDCODED required list. A producer for a queue type NOT on
 * that list would still fail silently at dequeue with "No handler
 * registered".
 *
 * What this lint does
 * -------------------
 * 1. Scans every server/**\/*.ts file (comments masked) for work-queue
 *    PRODUCER sites:
 *      - `enqueueJob({ queueName: ... })`
 *      - `enqueueToQueue({ queueName: ... })`
 *      - `enqueueRepairJob({ queueName: ... })`
 *      - `enqueueApplyJob(workResultId, <type>)`
 *      - direct `.insert(workQueue).values({ queueName: ... })`
 * 2. Resolves each site's queue name:
 *      - string literal → resolved directly
 *      - identifier → same-file `const X = "..."`, then static
 *        `import { X } from "..."`, then the nearest preceding
 *        `const { X } = await import("...")` destructure; const
 *        initializers may be ternaries / record maps — every plausible
 *        queue-name string literal in the initializer is collected
 *        (one level of identifier indirection is followed).
 * 3. Collects every HANDLER registration: the first argument of every
 *    `registerHandler(...)` call in server/ (literal or resolved constant).
 *    This is a superset of `registerAllHandlers()` on purpose: a handful of
 *    handlers (e.g. google_ads_sync) register from their own scheduler
 *    module, and deleting such a module deletes its producers too.
 * 4. FAILS if any resolved producer queue name has no registered handler —
 *    the exact #2637/#2824 failure mode, now for EVERY queue, not just the
 *    startup-required list.
 * 5. Producer sites whose queue name cannot be statically resolved
 *    (pass-through wrappers taking `opts.queueName`, replay paths that
 *    re-enqueue an existing row's own queueName, apply types read from DB
 *    rows) must be RECORDED in the baseline file
 *    (`scripts/lint-work-queue-producer-handlers.baseline.txt`) so a new
 *    dynamic producer is a deliberate decision, not a silent gap. Stale
 *    baseline entries also fail, keeping the list honest.
 *
 * Gating: the `.replit` `Validate` workflow runs `npm run gate`; this lint is gated by
 * `tests/lint-work-queue-producer-handlers.test.ts` in SMOKE_FILES (its
 * first assertion runs runLint() on the real tree) — the same pattern as
 * lint-smoke-gate-regression.
 *
 * Exit codes:
 *   0 — every enqueued queue name has a registered handler, and every
 *       unresolvable producer site is baselined (no stale entries).
 *   1 — at least one producer references a queue with no handler, or an
 *       unrecorded dynamic producer site, or a stale baseline entry.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Scope intentionally fixed (Task #2846): work_queue producers AND handlers
// are both registered only in server runtime code (verified: no enqueue
// call sites exist in scripts/ or tests/).
const DEFAULT_SERVER_DIR = "server";
const DEFAULT_BASELINE_PATH =
  "scripts/lint-work-queue-producer-handlers.baseline.txt";

/** path (posix, relative) → masked source */
export type SourceTree = Map<string, string>;

// ---------------------------------------------------------------------------
// Comment masking. Replaces comment CONTENTS with spaces (newlines kept so
// line numbers survive) while leaving strings, template literals, and — per
// the documented scanner lesson — regex literals untouched. Without regex
// handling, a regex containing a quote character flips the scanner into
// string mode and swallows the rest of the file.
// ---------------------------------------------------------------------------
export function maskComments(source: string): string {
  const out = source.split("");
  type State =
    | "code"
    | "line"
    | "block"
    | "single"
    | "double"
    | "template"
    | "regex"
    | "regexClass";
  let state: State = "code";
  // Template literals nest via ${ ... } — track brace depth per template.
  const templateBraceStack: number[] = [];
  let braceDepth = 0;
  let lastSignificant = "";
  let lastWord = "";

  const regexCanFollow = (): boolean => {
    if (lastSignificant === "") return true;
    if ("(,=:[!&|?{};+-*%<>~^".includes(lastSignificant)) return true;
    // `return /re/`, `case /re/`, `typeof /re/` …
    if (/[A-Za-z0-9_$]/.test(lastSignificant)) {
      return [
        "return", "case", "typeof", "in", "of", "instanceof", "new",
        "delete", "void", "do", "else", "yield", "await",
      ].includes(lastWord);
    }
    return false;
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    switch (state) {
      case "code":
        if (c === "/" && next === "/") {
          state = "line";
          out[i] = " ";
        } else if (c === "/" && next === "*") {
          state = "block";
          out[i] = " ";
        } else if (c === "'") {
          state = "single";
        } else if (c === '"') {
          state = "double";
        } else if (c === "`") {
          state = "template";
        } else if (c === "/" && regexCanFollow()) {
          state = "regex";
        } else if (c === "}" && templateBraceStack.length > 0) {
          if (braceDepth === templateBraceStack[templateBraceStack.length - 1]) {
            templateBraceStack.pop();
            state = "template";
          } else {
            braceDepth--;
          }
        } else if (c === "{") {
          braceDepth++;
        } else if (c === "}") {
          braceDepth--;
        }
        if (state === "code" || state === "single" || state === "double" ||
            state === "template" || state === "regex") {
          if (!/\s/.test(c)) {
            lastSignificant = c;
            if (/[A-Za-z0-9_$]/.test(c)) lastWord += c;
            else lastWord = "";
          }
        }
        break;
      case "line":
        if (c === "\n") state = "code";
        else out[i] = " ";
        break;
      case "block":
        if (c === "*" && next === "/") {
          out[i] = " ";
          out[i + 1] = " ";
          i++;
          state = "code";
        } else if (c !== "\n") {
          out[i] = " ";
        }
        break;
      case "single":
        if (c === "\\") i++;
        else if (c === "'") { state = "code"; lastSignificant = "'"; lastWord = ""; }
        break;
      case "double":
        if (c === "\\") i++;
        else if (c === '"') { state = "code"; lastSignificant = '"'; lastWord = ""; }
        break;
      case "template":
        if (c === "\\") i++;
        else if (c === "`") { state = "code"; lastSignificant = "`"; lastWord = ""; }
        else if (c === "$" && next === "{") {
          templateBraceStack.push(braceDepth);
          state = "code";
          i++; // skip the '{' — depth tracked via the stack sentinel
        }
        break;
      case "regex":
        if (c === "\\") i++;
        else if (c === "[") state = "regexClass";
        else if (c === "/") { state = "code"; lastSignificant = "/"; lastWord = ""; }
        else if (c === "\n") { state = "code"; } // not a regex after all — bail safely
        break;
      case "regexClass":
        if (c === "\\") i++;
        else if (c === "]") state = "regex";
        break;
    }
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Source tree loading
// ---------------------------------------------------------------------------
export function loadServerTree(serverDir: string = DEFAULT_SERVER_DIR): SourceTree {
  const tree: SourceTree = new Map();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        tree.set(full.split(path.sep).join("/"), maskComments(readFileSync(full, "utf8")));
      }
    }
  };
  walk(serverDir);
  return tree;
}

// ---------------------------------------------------------------------------
// Identifier resolution
// ---------------------------------------------------------------------------
const QUEUE_LITERAL_RE = /["']([a-z][a-z0-9_]*)["']/g;

function literalsFromInitializer(init: string): string[] {
  // Drop literals used in COMPARISONS (`x === "recording_completed" ? ...`):
  // those are condition operands, not values the const can hold.
  const withoutComparisons = init
    .replace(/[=!]==?\s*["'][^"'\n]*["']/g, " ")
    .replace(/["'][^"'\n]*["']\s*[=!]==?/g, " ");
  const out: string[] = [];
  for (const m of withoutComparisons.matchAll(QUEUE_LITERAL_RE)) out.push(m[1]);
  return out;
}

function findConstInitializer(source: string, ident: string): string | null {
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${ident}\\b[^=\\n]*=\\s*([\\s\\S]*?)(?:;|\\n\\s*(?:export\\s+)?(?:const|let|var|function|class|interface|type)\\b)`,
  );
  const m = source.match(re);
  return m ? m[1] : null;
}

function resolveModuleSpec(tree: SourceTree, fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.join(path.posix.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (tree.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve an identifier at a producer/registration site to the set of queue
 * name string literals it can hold. Returns null when unresolvable.
 */
export function resolveIdentifier(
  tree: SourceTree,
  file: string,
  ident: string,
  siteIndex: number,
  depth = 0,
): string[] | null {
  if (depth > 2) return null;
  const source = tree.get(file);
  if (!source) return null;

  // 1. Same-file const.
  const init = findConstInitializer(source, ident);
  if (init !== null) {
    const literals = literalsFromInitializer(init);
    if (literals.length > 0) return literals;
    // Follow one level of identifier indirection (e.g. `queueMap[config.mode]`).
    const innerIdents = [...init.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)]
      .map((m) => m[1])
      .filter((w) => w !== ident && !["await", "import", "config", "process"].includes(w));
    for (const inner of innerIdents) {
      const resolved = resolveIdentifier(tree, file, inner, siteIndex, depth + 1);
      if (resolved && resolved.length > 0) return resolved;
    }
    return null;
  }

  // 2. Static import: `import { X } from "..."` or `import { A as X } from "..."`.
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1].split(",").map((s) => s.trim());
    for (const name of names) {
      const asMatch = name.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      const local = asMatch ? asMatch[2] : name;
      const original = asMatch ? asMatch[1] : name;
      if (local !== ident) continue;
      const target = resolveModuleSpec(tree, file, m[2]);
      if (!target) return null;
      return resolveIdentifier(tree, target, original, 0, depth + 1);
    }
  }

  // 3. Nearest preceding dynamic-import destructure:
  //    `const { X, ... } = await import("...")`.
  let best: { index: number; original: string; spec: string } | null = null;
  for (const m of source.matchAll(/\{([^{}]*)\}\s*=\s*(?:await\s+)?import\(\s*["']([^"']+)["']\s*\)/g)) {
    if (m.index === undefined || m.index > siteIndex) continue;
    const names = m[1].split(",").map((s) => s.trim());
    for (const name of names) {
      const asMatch = name.match(/^([\w$]+)\s*:\s*([\w$]+)$/);
      const local = asMatch ? asMatch[2] : name;
      const original = asMatch ? asMatch[1] : name;
      if (local !== ident) continue;
      if (!best || m.index > best.index) best = { index: m.index, original, spec: m[2] };
    }
  }
  if (best) {
    const target = resolveModuleSpec(tree, file, best.spec);
    if (!target) return null;
    return resolveIdentifier(tree, target, best.original, 0, depth + 1);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Handler registrations
// ---------------------------------------------------------------------------
export function collectRegisteredHandlers(tree: SourceTree): Set<string> {
  const handlers = new Set<string>();
  for (const [file, source] of tree) {
    for (const m of source.matchAll(/\bregisterHandler\(\s*(["'][a-z][a-z0-9_]*["']|[A-Za-z_$][\w$]*)\s*,/g)) {
      const token = m[1];
      if (token.startsWith('"') || token.startsWith("'")) {
        handlers.add(token.slice(1, -1));
      } else {
        const resolved = resolveIdentifier(tree, file, token, m.index ?? 0);
        for (const q of resolved ?? []) handlers.add(q);
      }
    }
  }
  return handlers;
}

// ---------------------------------------------------------------------------
// Producer sites
// ---------------------------------------------------------------------------
export interface ProducerSite {
  file: string;
  line: number;
  /** The raw token found for the queue name (or a descriptive placeholder). */
  token: string;
  /** Queue name literals the site can enqueue; null = unresolvable/dynamic. */
  resolved: string[] | null;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

const ENQUEUE_OBJECT_ANCHOR =
  /\b(enqueueJob|enqueueToQueue|enqueueRepairJob|submitRepairJob)\s*\(\s*\{/g;
const INSERT_WORK_QUEUE_ANCHOR = /\.insert\(\s*workQueue\s*\)/g;
const APPLY_JOB_ANCHOR = /\benqueueApplyJob\(\s*[^,()]+,\s*([^,()]+)[,)]/g;
// Callers pass the queue name as the 3rd positional argument; the wrapper's
// own internal enqueueJob({ queueName, ... }) is a baselined pass-through.
const DEFER_SATURATED_ANCHOR =
  /\bdeferIfDbPoolSaturated\(\s*[^,()]+,\s*[^,()]+,\s*([^,()\n]+)\s*[,)]/g;

/** Extract the `{ ... }` object literal starting at `openBraceIndex`. */
function objectLiteralAt(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(openBraceIndex, i + 1);
    }
  }
  return source.slice(openBraceIndex, openBraceIndex + 800);
}

// Skip the enqueue-helper DEFINITIONS themselves: their `queueName` is the
// incoming parameter, and their callers are what this lint scans.
const WRAPPER_DEFINITION_FILES = new Set<string>([
  "server/services/workScheduler.ts",
  "server/services/workQueueLease.ts",
]);

export function collectProducerSites(tree: SourceTree): ProducerSite[] {
  const sites: ProducerSite[] = [];

  for (const [file, source] of tree) {
    for (const m of source.matchAll(ENQUEUE_OBJECT_ANCHOR)) {
      const openBrace = (m.index ?? 0) + m[0].length - 1;
      const window = objectLiteralAt(source, openBrace);
      // First `queueName` property in the object literal: either
      // `queueName: <value>` or ES shorthand `queueName,`. The negative
      // lookbehind rejects member access like `params.queueName`.
      const qm = window.match(/(?<![\w$.])queueName\s*(?::\s*("[^"\n]*"|'[^'\n]*'|[A-Za-z_$][\w$]*(?:[.[][^,\n]*)?)|(,))/);
      if (!qm) {
        sites.push({
          file,
          line: lineOf(source, m.index ?? 0),
          token: "<spread/no queueName property>",
          resolved: null,
        });
        continue;
      }
      const token = qm[2] === "," ? "queueName" : qm[1];
      sites.push(makeSite(tree, file, source, m.index ?? 0, token));
    }

    if (!WRAPPER_DEFINITION_FILES.has(file)) {
      for (const m of source.matchAll(INSERT_WORK_QUEUE_ANCHOR)) {
        const window = source.slice(m.index ?? 0, (m.index ?? 0) + 500);
        const qm = window.match(/(?<![\w$.])queueName\s*:\s*("[^"\n]*"|'[^'\n]*'|[A-Za-z_$][\w$]*(?:[.[][^,\n]*)?)/);
        if (!qm) continue; // not a values() insert carrying a queueName
        sites.push(makeSite(tree, file, source, m.index ?? 0, qm[1]));
      }
    } else {
      // The wrapper's own insert uses params.queueName — pass-through by
      // construction; its callers are scanned above.
    }

    for (const m of source.matchAll(APPLY_JOB_ANCHOR)) {
      const token = m[1].trim();
      if (token.includes(":")) continue; // definition parameter typing, not a call
      sites.push(makeSite(tree, file, source, m.index ?? 0, token));
    }

    for (const m of source.matchAll(DEFER_SATURATED_ANCHOR)) {
      const token = m[1].trim();
      if (token.includes(":")) continue; // definition parameter typing, not a call
      sites.push(makeSite(tree, file, source, m.index ?? 0, token));
    }
  }

  return sites;
}

function makeSite(
  tree: SourceTree,
  file: string,
  source: string,
  index: number,
  token: string,
): ProducerSite {
  const line = lineOf(source, index);
  if (token.startsWith('"') || token.startsWith("'")) {
    return { file, line, token, resolved: [token.slice(1, -1)] };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(token)) {
    const resolved = resolveIdentifier(tree, file, token, index);
    return { file, line, token, resolved: resolved && resolved.length > 0 ? resolved : null };
  }
  // Member access / computed — dynamic.
  return { file, line, token, resolved: null };
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------
export function baselineKey(site: ProducerSite): string {
  return `${site.file} :: ${site.token}`;
}

export function loadBaseline(baselinePath: string): Set<string> {
  const out = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(baselinePath, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const withoutComment = line.split("#")[0];
    const trimmed = withoutComment.trim();
    if (!trimmed) continue;
    out.add(trimmed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lint entry point
// ---------------------------------------------------------------------------
export interface LintOptions {
  serverDir?: string;
  baselinePath?: string;
  /** Injectable for tests — bypasses the filesystem walk when provided. */
  tree?: SourceTree;
}

export interface MissingHandlerFinding {
  queue: string;
  file: string;
  line: number;
  token: string;
}

export interface LintResult {
  ok: boolean;
  registeredHandlers: string[];
  producerSites: ProducerSite[];
  /** Resolved producer queue names with NO registered handler — the #2637 bug class. */
  missingHandlers: MissingHandlerFinding[];
  /** Dynamic/unresolvable producer sites not recorded in the baseline. */
  unrecordedDynamic: ProducerSite[];
  /** Baseline entries that no longer match any dynamic site. */
  staleBaseline: string[];
  dynamicBaselinedCount: number;
}

export function runLint(options: LintOptions = {}): LintResult {
  const tree = options.tree ?? loadServerTree(options.serverDir ?? DEFAULT_SERVER_DIR);
  const baselinePath = options.baselinePath ?? DEFAULT_BASELINE_PATH;

  const registered = collectRegisteredHandlers(tree);
  const sites = collectProducerSites(tree);
  const baseline = loadBaseline(baselinePath);

  const missingHandlers: MissingHandlerFinding[] = [];
  const unrecordedDynamic: ProducerSite[] = [];
  const seenDynamicKeys = new Set<string>();

  for (const site of sites) {
    if (site.resolved) {
      for (const queue of site.resolved) {
        if (!registered.has(queue)) {
          missingHandlers.push({ queue, file: site.file, line: site.line, token: site.token });
        }
      }
    } else {
      const key = baselineKey(site);
      seenDynamicKeys.add(key);
      if (!baseline.has(key)) unrecordedDynamic.push(site);
    }
  }

  const staleBaseline = [...baseline].filter((k) => !seenDynamicKeys.has(k)).sort();
  missingHandlers.sort((a, b) => a.queue.localeCompare(b.queue) || a.file.localeCompare(b.file));

  return {
    ok: missingHandlers.length === 0 && unrecordedDynamic.length === 0 && staleBaseline.length === 0,
    registeredHandlers: [...registered].sort(),
    producerSites: sites,
    missingHandlers,
    unrecordedDynamic,
    staleBaseline,
    dynamicBaselinedCount: seenDynamicKeys.size - unrecordedDynamic.length,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  !!process.argv[1]?.endsWith("lint-work-queue-producer-handlers.ts");

if (isMain) {
  const result = runLint();
  const resolvedCount = result.producerSites.filter((s) => s.resolved).length;

  if (result.ok) {
    console.log(
      `lint-work-queue-producer-handlers: OK — ${resolvedCount} resolved producer site(s) ` +
        `across ${new Set(result.producerSites.map((s) => s.file)).size} file(s), ` +
        `${result.registeredHandlers.length} registered handler queue(s), ` +
        `${result.dynamicBaselinedCount} baselined dynamic site(s).`,
    );
    process.exit(0);
  }

  if (result.missingHandlers.length > 0) {
    console.error("");
    console.error(
      "✗ lint-work-queue-producer-handlers: enqueue site(s) reference a queue with NO registered handler",
    );
    console.error("");
    console.error(
      "  This is the Task #2637/#2824 failure mode: jobs land in work_queue and",
    );
    console.error(
      "  fail at dequeue with \"No handler registered\" — silently, because the",
    );
    console.error("  startup assert is warn-and-continue.");
    console.error("");
    console.error("  Either register a handler (registerAllHandlers() in");
    console.error("  server/services/workQueueHandlers.ts) or remove/redirect the producer:");
    console.error("");
    for (const f of result.missingHandlers) {
      console.error(`    - queue "${f.queue}" enqueued at ${f.file}:${f.line} (${f.token})`);
    }
    console.error("");
  }

  if (result.unrecordedDynamic.length > 0) {
    console.error(
      "✗ lint-work-queue-producer-handlers: dynamic enqueue site(s) whose queue name cannot be statically resolved",
    );
    console.error("");
    console.error(
      "  Record each as a deliberate pass-through in scripts/lint-work-queue-producer-handlers.baseline.txt",
    );
    console.error(
      "  (one `file :: token` per line, with a trailing \"# reason\" comment), or refactor",
    );
    console.error("  the site to use a resolvable constant/literal:");
    console.error("");
    for (const s of result.unrecordedDynamic) {
      console.error(`    - ${baselineKey(s)}   (line ${s.line})`);
    }
    console.error("");
  }

  if (result.staleBaseline.length > 0) {
    console.error(
      "✗ lint-work-queue-producer-handlers: stale baseline entr(ies) — remove them:",
    );
    for (const k of result.staleBaseline) console.error(`    - ${k}`);
    console.error("");
  }

  process.exit(1);
}
