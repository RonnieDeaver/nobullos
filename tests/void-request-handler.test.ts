/* test-registration
{
  "name": "toVoidRequestHandler — middleware rejections reach Express error handling, never unhandled (Task #3821)",
  "regression": true,
  "smoke": false,
  "sweepOnlyReason": "Narrow adapter-contract coverage: proves the shared void-returning middleware adapter routes ANY rejection (including a pre-authorization throw before the callee's own try/catch) to next() with zero unhandled rejections. The invariant only breaks if the tiny adapter in server/lib/voidRequestHandler.ts is edited; the nightly regression sweep is sufficient — not a merge-frequency regression class worth smoke-gate time.",
  "tier": "small"
}
test-registration */
/**
 * Task #3821 — the `no-misused-promises` cleanup adapts Promise-returning
 * role middleware (`requireTeamLead`, `requireAccountManager`) to
 * void-returning `RequestHandler`s via `toVoidRequestHandler`. The review
 * contract pinned here: a rejection thrown ANYWHERE in the async middleware
 * — including before its internal try/catch (e.g. a malformed `req` blowing
 * up on the initial `req.user` access) — must reach `next(err)` so Express
 * error handling sees it, and must never leak as an unhandled promise
 * rejection.
 *
 * Pure, in-memory: drives the adapter directly with stub req/res/next.
 */
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";

import { toVoidRequestHandler } from "../server/lib/voidRequestHandler";

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

async function main(): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    // 1. A middleware that throws IMMEDIATELY on property access (before any
    //    internal try/catch could run) — the pre-authorization failure mode.
    const preAuthBoom = async (req: Request, _res: Response, _next: NextFunction) => {
      // Simulates `const user = req.user.claims` on a malformed request.
      const anyReq = req as unknown as { user: { claims: { sub: string } } };
      return anyReq.user.claims.sub; // throws TypeError: user is undefined
    };
    const nextErrors: unknown[] = [];
    const next = ((err?: unknown) => {
      nextErrors.push(err);
    }) as NextFunction;

    toVoidRequestHandler(preAuthBoom)({} as Request, {} as Response, next);
    await settle();
    assert.equal(nextErrors.length, 1, "next() called exactly once");
    assert.ok(nextErrors[0] instanceof TypeError, "the pre-auth TypeError reached next()");
    ok("pre-authorization throw routes to next(err) — Express error handling sees it");

    // 2. An explicit async rejection mid-body behaves the same.
    const rejects = async () => {
      await settle();
      throw new Error("role lookup failed");
    };
    const nextErrors2: unknown[] = [];
    toVoidRequestHandler(rejects)(
      {} as Request,
      {} as Response,
      ((err?: unknown) => {
        nextErrors2.push(err);
      }) as NextFunction,
    );
    await settle();
    await settle();
    assert.equal(nextErrors2.length, 1);
    assert.equal((nextErrors2[0] as Error).message, "role lookup failed");
    ok("async mid-body rejection routes to next(err)");

    // 3. A resolving middleware never calls next with an error.
    const resolvesCalls: unknown[] = [];
    toVoidRequestHandler(async () => "authorized")(
      {} as Request,
      {} as Response,
      ((err?: unknown) => {
        resolvesCalls.push(err);
      }) as NextFunction,
    );
    await settle();
    assert.deepEqual(resolvesCalls, [], "no spurious next(err) on success");
    ok("successful middleware does not invoke the error path");

    // 4. Nothing above leaked an unhandled rejection.
    await settle();
    assert.deepEqual(unhandled, [], "no unhandled promise rejections leaked");
    ok("no unhandled rejection escaped the adapter in any scenario");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }

  console.log(`toVoidRequestHandler: ${passed} checks passed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("TEST FAILED:", err);
    process.exit(1);
  });
