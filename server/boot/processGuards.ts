/**
 * Boot — process-level guards.
 * Extracted verbatim from server/index.ts (Task #3787 split); invoked from
 * the index.ts bootstrap in the exact original sequence.
 * uncaughtException / unhandledRejection handlers.
 *
 * Task #3816: when the fault fires inside a request's async context, the
 * FATAL line now carries `rid=` + route so it can be correlated with the
 * access log and any user-reported request ID.
 */
import { getRequestContext } from "../observability/requestContext";

function requestTag(): string {
  const ctx = getRequestContext();
  if (!ctx) return "";
  return ` rid=${ctx.requestId} route=${ctx.method} ${ctx.path}`;
}

process.on("uncaughtException", (err) => {
  console.error(`[FATAL] Uncaught exception (process kept alive)${requestTag()}:`, err);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[FATAL] Unhandled rejection (process kept alive)${requestTag()}:`, reason);
});

export {};
