/**
 * lint-server-import-cycles.ts — whole-repository runtime import-cycle gate
 * for server code (Task #3951).
 *
 * Both previously known runtime cycles are gone (Front recovery↔ingestion,
 * Task #3945; cache/kill-switch/storage, Task #3947 — each pinned by its own
 * per-pair guard suite), but nothing prevented a brand-new cycle between
 * OTHER modules from creeping in unnoticed until someone manually re-ran the
 * pinned Knip audit. This lint makes cycle prevention mechanical: it traces
 * the runtime import graph of ALL server code (every module under server/
 * and shared/, mounted or not) and fails when ANY cycle exists, printing the
 * complete cycle path (module → module → … → back to the first).
 *
 * Mechanism (per the accepted task design): the repository-native esbuild
 * import-graph tracer — the same frontier-BFS, parse-only, never-LINK
 * pattern as tests/relatedSmokeSelection.ts traceImportClosures — extended
 * to record importer→importee EDGES, followed by Tarjan SCC over the edge
 * graph. esbuild is a pinned devDependency, the scan is fully offline and
 * deterministic, and nothing is ever auto-fixed.
 *
 * Edge semantics (what counts as a cycle edge):
 *   - Static `import`/`export … from` edges are cycle edges — they force
 *     module evaluation at load time, which is exactly what made the
 *     #3945/#3947 cycles boot hazards. `require(...)` is counted too
 *     (server code is ESM; a require would be a static-style edge).
 *   - `import type` edges are erased by esbuild's TS parser before
 *     resolution — they cannot form a runtime cycle and are invisible here,
 *     by design.
 *   - Literal dynamic `import(...)` edges are NOT cycle edges: deferred
 *     lazy imports are this repository's sanctioned cycle-break boundary
 *     (e.g. server/services/apiPoolPressureTuning.ts documents importing
 *     storage lazily precisely to keep the static graph acyclic; same
 *     pattern in mcu/worker, semrushApi, clientFileDelivery). The pinned
 *     Knip audit's zero-cycle verdict rests on the same semantics. Dynamic
 *     TARGETS are still traversed, so static cycles among lazily-reached
 *     modules are still caught.
 *   - Bare package / node builtin imports are external (no edge).
 *   - Non-literal dynamic imports are invisible to any static tracer; the
 *     per-pair guard suites and the pinned manual Knip audit
 *     (`npx --yes knip@6.32.0 --cycles --reporter cycles --no-exit-code
 *     --no-progress`) remain the documented reference for those.
 *
 * There is NO allow-list, mutable or otherwise: the enforced baseline is
 * zero cycles. If this lint fires, break the cycle (the house recipe is the
 * dependency-free leaf-module extraction used by Tasks #3945/#3947) — never
 * weaken this check.
 *
 * Wired through gate.ts LINT_CHECKS; the `.replit` `Validate` workflow runs
 * `npm run gate`. Guarded by tests/lint-server-import-cycles.test.ts (fixture-driven
 * positive + negative detection proofs).
 *
 * Exit 1 when any runtime cycle exists (or the trace itself fails — a cycle
 * gate that cannot see the graph must not pass vacuously); 0 when the graph
 * is acyclic.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Directories whose modules form the server runtime graph. Every parseable
 * file below them is an entry, so unmounted/rarely-imported modules are
 * covered too (a cycle among them still breaks the next importer). */
export const DEFAULT_ENTRY_DIRS = ["server", "shared"] as const;

const PARSEABLE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE_RE = /\.test\.tsx?$/;

/** Same asset stubbing as the related-smoke tracer: content irrelevant,
 * edges still resolvable without parse errors. */
const EMPTY_LOADER_EXTS = [
  ".css", ".scss", ".sass", ".less",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".wav", ".ogg", ".mp4", ".webm", ".mov",
  ".pdf", ".node", ".wasm", ".md", ".txt", ".html",
];

/** pluginData sentinel so our own build.resolve() calls fall through to
 * esbuild's native resolver instead of re-entering the onResolve hook. */
const RESOLVE_PASSTHROUGH = { serverCyclePassthrough: true };

function normalizeRepoPath(p: string): string {
  let out = p.trim().replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out;
}

/** Recursively list parseable, non-test source files under `absDir`. */
function listSourceFiles(absDir: string, repoRoot: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    if (name === "node_modules" || name === ".git") continue;
    const abs = join(absDir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listSourceFiles(abs, repoRoot));
    } else if (st.isFile() && PARSEABLE_RE.test(name) && !TEST_FILE_RE.test(name)) {
      out.push(normalizeRepoPath(relative(repoRoot, abs)));
    }
  }
  return out;
}

export interface CycleScanResult {
  ok: boolean;
  /** Each cycle as a closed repo-relative path: [a, b, …, a]. */
  cycles: string[][];
  fileCount: number;
  edgeCount: number;
  /** Non-null when the trace itself failed — treat as a lint failure. */
  error: string | null;
}

/**
 * Trace the runtime import graph rooted at every source file under
 * `entryDirs` (repo-relative) and return every cycle found. Pure —
 * no printing, no process.exit — so the guard test drives it against
 * fixture trees.
 */
export async function findImportCycles(
  repoRoot: string = ROOT,
  entryDirs: readonly string[] = DEFAULT_ENTRY_DIRS,
): Promise<CycleScanResult> {
  const fail = (error: string): CycleScanResult => ({
    ok: false, cycles: [], fileCount: 0, edgeCount: 0, error,
  });

  const entries: string[] = [];
  for (const dir of entryDirs) {
    const absDir = resolve(repoRoot, dir);
    if (!existsSync(absDir)) return fail(`entry directory ${dir} does not exist under ${repoRoot}`);
    entries.push(...listSourceFiles(absDir, repoRoot));
  }
  if (entries.length === 0) return fail(`no parseable source files under ${entryDirs.join(", ")}`);

  const loader: Record<string, esbuild.Loader> = {};
  for (const ext of EMPTY_LOADER_EXTS) loader[ext] = "empty";

  const rootPrefix = resolve(repoRoot) + sep;
  const toRel = (abs: string): string => normalizeRepoPath(relative(repoRoot, abs));

  /** repo-relative importer → repo-relative importees (runtime edges only). */
  const edges = new Map<string, Set<string>>();
  let edgeCount = 0;
  const addEdge = (importerAbs: string, importeeAbs: string): void => {
    const importer = toRel(importerAbs);
    let set = edges.get(importer);
    if (!set) {
      set = new Set();
      edges.set(importer, set);
    }
    if (!set.has(toRel(importeeAbs))) {
      set.add(toRel(importeeAbs));
      edgeCount++;
    }
  };

  const scheduled = new Set<string>(entries.map((e) => resolve(repoRoot, e)));
  let frontier = [...scheduled];
  const unresolvable: string[] = [];

  while (frontier.length > 0) {
    const next = new Set<string>();
    try {
      await esbuild.build({
        entryPoints: frontier,
        bundle: true,
        write: false,
        outdir: resolve(tmpdir(), "server-import-cycles-trace-out"),
        platform: "node",
        format: "esm",
        target: "esnext",
        jsx: "automatic",
        logLevel: "silent",
        absWorkingDir: repoRoot,
        loader,
        plugins: [
          {
            name: "server-cycle-edge-recorder",
            setup(build) {
              build.onResolve({ filter: /.*/ }, async (args) => {
                if (args.pluginData === RESOLVE_PASSTHROUGH) return undefined;
                if (args.kind === "entry-point") return undefined;

                // Alias mapping (mirrors tsconfig paths).
                let spec = args.path;
                let resolveDir = args.resolveDir;
                if (spec.startsWith("@/")) {
                  spec = `./client/src/${spec.slice(2)}`;
                  resolveDir = repoRoot;
                } else if (spec.startsWith("@shared/")) {
                  spec = `./shared/${spec.slice("@shared/".length)}`;
                  resolveDir = repoRoot;
                }

                // Bare package / node builtin: external, no edge.
                if (!spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("/")) {
                  return { path: args.path, external: true };
                }

                const resolved = await build.resolve(spec, {
                  resolveDir,
                  importer: args.importer,
                  kind: args.kind,
                  pluginData: RESOLVE_PASSTHROUGH,
                });
                if (resolved.errors.length > 0 || !resolved.path) {
                  unresolvable.push(
                    `cannot resolve "${args.path}" imported from ${toRel(args.importer)}`,
                  );
                  return { path: args.path, external: true };
                }

                const abs = resolve(resolved.path);
                const insideRepo =
                  abs.startsWith(rootPrefix) && !abs.includes(`${sep}node_modules${sep}`);
                if (!insideRepo) return { path: abs, external: true };

                if (PARSEABLE_RE.test(abs)) {
                  // Dynamic import() = sanctioned lazy cycle-break boundary:
                  // traverse the target but record no cycle edge (see header).
                  if (args.kind !== "dynamic-import") addEdge(args.importer, abs);
                  if (!scheduled.has(abs)) {
                    scheduled.add(abs);
                    next.add(abs);
                  }
                }
                return { path: abs, external: true };
              });
            },
          },
        ],
      });
    } catch (err) {
      return fail(
        `esbuild trace failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    frontier = [...next];
  }

  if (unresolvable.length > 0) {
    // A hole in the graph means a cycle could hide in it — fail loudly
    // instead of passing vacuously.
    return fail(
      `unresolvable relative import(s) — the graph is incomplete:\n  ${unresolvable.join("\n  ")}`,
    );
  }

  const cycles = findCyclesInGraph(edges);
  return { ok: cycles.length === 0, cycles, fileCount: scheduled.size, edgeCount, error: null };
}

/**
 * Tarjan SCC over the edge map (iterative — the server graph is deep enough
 * that recursive DFS risks the stack). Every SCC with more than one node, or
 * a single node with a self-edge, contains at least one cycle; for each such
 * SCC one complete cycle path is extracted via a DFS confined to the SCC.
 */
export function findCyclesInGraph(edges: Map<string, Set<string>>): string[][] {
  const nodes = new Set<string>();
  for (const [from, tos] of edges) {
    nodes.add(from);
    for (const to of tos) nodes.add(to);
  }

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const sccs: string[][] = [];

  for (const start of nodes) {
    if (index.has(start)) continue;
    // Iterative Tarjan with an explicit work stack of [node, neighborIterator].
    const work: Array<{ node: string; iter: Iterator<string> }> = [];
    const push = (node: string) => {
      index.set(node, counter);
      lowlink.set(node, counter);
      counter++;
      stack.push(node);
      onStack.add(node);
      work.push({ node, iter: (edges.get(node) ?? new Set<string>())[Symbol.iterator]() });
    };
    push(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const step = frame.iter.next();
      if (!step.done) {
        const neighbor = step.value;
        if (!index.has(neighbor)) {
          push(neighbor);
        } else if (onStack.has(neighbor)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node)!, index.get(neighbor)!),
          );
        }
      } else {
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].node;
          lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(frame.node)!));
        }
        if (lowlink.get(frame.node) === index.get(frame.node)) {
          const scc: string[] = [];
          for (;;) {
            const n = stack.pop()!;
            onStack.delete(n);
            scc.push(n);
            if (n === frame.node) break;
          }
          sccs.push(scc);
        }
      }
    }
  }

  const cycles: string[][] = [];
  for (const scc of sccs) {
    const members = new Set(scc);
    const hasSelfLoop = scc.length === 1 && (edges.get(scc[0])?.has(scc[0]) ?? false);
    if (scc.length === 1 && !hasSelfLoop) continue;
    if (hasSelfLoop) {
      cycles.push([scc[0], scc[0]]);
      continue;
    }
    cycles.push(extractCyclePath(scc[0], members, edges));
  }
  // Deterministic report order.
  cycles.sort((a, b) => a.join(" ").localeCompare(b.join(" ")));
  return cycles;
}

/** DFS confined to one SCC: returns a closed path [n0, …, nk, n0]. */
function extractCyclePath(
  start: string,
  members: Set<string>,
  edges: Map<string, Set<string>>,
): string[] {
  const path: string[] = [start];
  const posInPath = new Map<string, number>([[start, 0]]);
  const iters = new Map<string, Iterator<string>>();
  for (;;) {
    const node = path[path.length - 1];
    let iter = iters.get(node);
    if (!iter) {
      iter = [...(edges.get(node) ?? new Set<string>())]
        .filter((n) => members.has(n))
        .sort()
        [Symbol.iterator]();
      iters.set(node, iter);
    }
    const step = iter.next();
    if (step.done) {
      // Dead end inside the SCC (cannot happen in a genuine SCC, but stay
      // total): backtrack.
      posInPath.delete(node);
      iters.delete(node);
      path.pop();
      if (path.length === 0) return [start, start]; // defensive
      continue;
    }
    const neighbor = step.value;
    const seenAt = posInPath.get(neighbor);
    if (seenAt !== undefined) {
      return [...path.slice(seenAt), neighbor];
    }
    posInPath.set(neighbor, path.length);
    path.push(neighbor);
  }
}

export async function runLint(
  repoRoot: string = ROOT,
  entryDirs: readonly string[] = DEFAULT_ENTRY_DIRS,
): Promise<{ ok: boolean; message: string }> {
  const result = await findImportCycles(repoRoot, entryDirs);
  if (result.error !== null) {
    return {
      ok: false,
      message: `lint-server-import-cycles: TRACE FAILED (treated as a violation — the gate must not pass blind):\n  ${result.error}`,
    };
  }
  if (result.cycles.length > 0) {
    const blocks = result.cycles.map(
      (c, i) => `  cycle ${i + 1} of ${result.cycles.length}:\n    ${c.join("\n    → ")}`,
    );
    return {
      ok: false,
      message:
        `lint-server-import-cycles: ${result.cycles.length} runtime import cycle(s) in server code ` +
        `(${result.fileCount} files, ${result.edgeCount} edges traced):\n` +
        `${blocks.join("\n")}\n` +
        `Break the cycle — extract the shared state/helpers into a dependency-free leaf module ` +
        `(house recipe: Tasks #3945/#3947, see .agents/memory/runtime-cycle-leaf-state-break.md). ` +
        `There is deliberately NO allow-list: the enforced baseline is zero cycles.`,
    };
  }
  return {
    ok: true,
    message: `lint-server-import-cycles: OK — zero runtime import cycles (${result.fileCount} files, ${result.edgeCount} edges traced from ${entryDirs.join(", ")})`,
  };
}

/** Gate worker-pool entry (Task #3789 cliMain contract): prints and returns
 * the exit code. Async is fine — the gate worker awaits cliMain(). */
export async function cliMain(): Promise<number> {
  try {
    const { ok, message } = await runLint();
    if (ok) {
      console.log(message);
      return 0;
    }
    console.error(message);
    return 1;
  } finally {
    // Stop the esbuild service child so standalone runs and worker threads
    // drain naturally.
    try {
      await esbuild.stop();
    } catch {
      /* nothing to stop when esbuild never started */
    }
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exit(await cliMain());
}
