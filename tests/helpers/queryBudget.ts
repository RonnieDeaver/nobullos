/**
 * Task #1724 Phase 4.3 — Query-count budget harness.
 *
 * A test helper that snapshots how many DB queries a piece of code
 * issues. Routes and storage helpers can pin a per-call budget so a
 * future regression like Task #1721 Phase 1.1 (`notifyUser` quietly
 * grew to four round trips) trips a test instead of a production
 * pager.
 *
 * Implementation: monkey-patches `pg`'s `Pool.prototype.query` and
 * `Client.prototype.query` exactly once. While a `runWithQueryBudget`
 * scope is active in the calling async context, every invocation
 * increments a per-scope counter. Outside any scope the patches are
 * no-ops, so they're safe to leave installed for the rest of the
 * process.
 *
 * Usage:
 *
 *   import {
 *     runWithQueryBudget,
 *     assertQueryBudget,
 *   } from "./helpers/queryBudget";
 *
 *   // Capture and inspect:
 *   const { result, count, queries } = await runWithQueryBudget(() =>
 *     someRouteHandler(req, res),
 *   );
 *   expect(count).toBeLessThanOrEqual(3);
 *
 *   // Or assert directly (throws with detail on overrun):
 *   await assertQueryBudget(3, "POST /api/notifications", () =>
 *     someRouteHandler(req, res),
 *   );
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

interface BudgetScope {
  count: number;
  queries: string[];
  capture: boolean;
}

const scopeStorage = new AsyncLocalStorage<BudgetScope>();

// Idempotent install: re-importing this module from multiple test
// files must not double-count. We tag the prototypes so the wrap is
// applied exactly once per process.
const PATCH_FLAG = Symbol.for("nobull.queryBudgetPatched.v1");

function previewQuery(arg: unknown): string {
  if (typeof arg === "string") return arg.slice(0, 200);
  if (arg && typeof arg === "object" && "text" in (arg as Record<string, unknown>)) {
    const text = (arg as { text?: unknown }).text;
    if (typeof text === "string") return text.slice(0, 200);
  }
  return "<unknown>";
}

function installPatch(target: { prototype: any }): void {
  const proto = target.prototype as Record<string | symbol, unknown>;
  if (proto[PATCH_FLAG]) return;
  const original = proto.query as (...args: unknown[]) => unknown;
  if (typeof original !== "function") return;
  const wrapped = function patchedQuery(this: unknown, ...args: unknown[]) {
    const scope = scopeStorage.getStore();
    if (scope) {
      scope.count += 1;
      if (scope.capture) scope.queries.push(previewQuery(args[0]));
    }
    return (original as Function).apply(this, args);
  };
  proto.query = wrapped;
  proto[PATCH_FLAG] = true;
}

installPatch(pg.Pool);
installPatch(pg.Client);

export interface QueryBudgetResult<T> {
  result: T;
  count: number;
  queries: string[];
}

export interface RunWithQueryBudgetOptions {
  /** Capture truncated query previews (default true). Disable for very
   *  hot inner loops where allocation noise matters. */
  capture?: boolean;
}

/** Run `fn` and report how many DB queries it issued. */
export async function runWithQueryBudget<T>(
  fn: () => Promise<T> | T,
  options: RunWithQueryBudgetOptions = {},
): Promise<QueryBudgetResult<T>> {
  const scope: BudgetScope = {
    count: 0,
    queries: [],
    capture: options.capture !== false,
  };
  const result = await scopeStorage.run(scope, async () => fn());
  return { result, count: scope.count, queries: scope.queries };
}

export class QueryBudgetExceededError extends Error {
  constructor(
    public readonly label: string,
    public readonly budget: number,
    public readonly actual: number,
    public readonly queries: string[],
  ) {
    super(
      `query budget exceeded for ${label}: expected ≤ ${budget}, observed ${actual}.\n` +
        `Queries (truncated to 200 chars each):\n` +
        queries.map((q, i) => `  [${i + 1}] ${q}`).join("\n"),
    );
    this.name = "QueryBudgetExceededError";
  }
}

/** Throw if `fn` issues more than `budget` queries. */
export async function assertQueryBudget<T>(
  budget: number,
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const { result, count, queries } = await runWithQueryBudget(fn);
  if (count > budget) {
    throw new QueryBudgetExceededError(label, budget, count, queries);
  }
  return result;
}

/** Test-only escape hatch — temporarily clear the scope (used by the
 *  harness's own self-test to verify the patch is no-op outside any
 *  scope). */
export function __runOutsideBudgetScope<T>(fn: () => T | Promise<T>): Promise<T> {
  return scopeStorage.exit(async () => fn());
}
