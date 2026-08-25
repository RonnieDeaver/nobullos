/**
 * Task #3816 — App-wide request spine, part 1: request IDs + request context.
 *
 * Every inbound HTTP request gets a request ID (inbound `X-Request-Id` is
 * honored when it looks sane, else one is generated), echoed back on the
 * response so any user screenshot / error report can be correlated with the
 * exact server activity. The ID also rides an AsyncLocalStorage context so
 * deep service code and the process-level uncaught-exception guards can tag
 * their logs with the request that was in flight.
 *
 * Dependency-free on purpose (node built-ins only) so it can be imported from
 * boot modules (processGuards, httpApp) and from tests without dragging in
 * db/storage.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export const REQUEST_ID_HEADER = "X-Request-Id";

export interface RequestContext {
  requestId: string;
  method: string;
  /** Raw path (no query string) — for FATAL-log correlation only. */
  path: string;
  startedAt: number;
}

const als = new AsyncLocalStorage<RequestContext>();

/**
 * Inbound IDs are accepted only when they are short, printable and free of
 * header-injection / log-forgery characters (no spaces, quotes, control
 * chars). Anything else is replaced with a generated ID.
 */
const INBOUND_ID_RE = /^[A-Za-z0-9._-]{4,128}$/;
/** Stored/logged form is capped so a hostile 128-char ID can't bloat lines. */
const MAX_ID_LEN = 64;

export function generateRequestId(): string {
  // 8 random bytes → 16 hex chars: short enough to eyeball/grep, unique
  // enough for correlation (collision needs ~2^32 requests in one window).
  return randomBytes(8).toString("hex");
}

export function sanitizeInboundRequestId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!INBOUND_ID_RE.test(trimmed)) return null;
  return trimmed.slice(0, MAX_ID_LEN);
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

export function getCurrentRequestId(): string | null {
  return als.getStore()?.requestId ?? null;
}
