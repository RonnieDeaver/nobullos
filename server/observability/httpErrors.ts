/**
 * Task #3816 — App-wide request spine, part 3: error taxonomy + global
 * Express error middleware.
 *
 * Before this, routes hand-rolled try/catch (each with its own 500 body) and
 * the app-level handler returned a bare `{ message: "Internal Server Error" }`
 * for everything, without logging the request ID. Now:
 *
 *  - `HttpError` + a small snake_case code taxonomy give intentional errors a
 *    consistent JSON shape.
 *  - `asyncHandler(fn, legacyErrorToken?)` lets routers drop hand-rolled
 *    catch blocks WITHOUT changing their response contracts: the optional
 *    token is what the router's old catch wrote into the `error` field
 *    (e.g. "Server error", "list_failed"), so migrated routes keep
 *    byte-identical `error` values while gaining the code/requestId fields
 *    and centralized logging.
 *  - `globalApiErrorHandler` yields one shape for every uncaught route error:
 *      { message, error, code, requestId, details? }
 *    `message` is kept for the pre-existing global-handler contract; `error`
 *    is kept for the dominant router convention. 5xx messages are always the
 *    generic "Internal Server Error" (internals never leak); 4xx messages
 *    surface the thrown message.
 *
 * Dependency-free (no db/storage imports) so routers and tests can import it
 * freely.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Small, closed taxonomy — additions should be rare and deliberate. */
export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
  "rate_limited",
  "internal_error",
  "upstream_error",
  "unavailable",
  "upstream_timeout",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "unprocessable",
  429: "rate_limited",
  500: "internal_error",
  502: "upstream_error",
  503: "unavailable",
  504: "upstream_timeout",
};

export function codeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS[status] ?? (status < 500 ? "bad_request" : "internal_error");
}

export interface HttpErrorOptions {
  code?: ErrorCode;
  /** Extra JSON-safe payload surfaced to the client (validation issues etc.). */
  details?: unknown;
  /**
   * Whether the message is client-safe. Defaults: true for <500, false for
   * >=500 (5xx bodies say "Internal Server Error" unless expose is forced).
   */
  expose?: boolean;
  /** Value for the legacy `error` body field (defaults to the message). */
  errorToken?: string;
  cause?: unknown;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly expose: boolean;
  readonly errorToken?: string;

  constructor(status: number, message: string, options: HttpErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HttpError";
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    this.code = options.code ?? codeForStatus(this.status);
    this.details = options.details;
    this.expose = options.expose ?? this.status < 500;
    this.errorToken = options.errorToken;
  }
}

/**
 * Wrap an async route handler so rejections/throws reach the global error
 * middleware instead of becoming unhandled rejections.
 *
 * `legacyErrorToken` preserves a migrated router's old catch-block contract:
 * unexpected errors respond with that exact value in the `error` field
 * (status 500), exactly as the removed hand-rolled catch did.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>,
  legacyErrorToken?: string,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err: any) => {
      if (legacyErrorToken && err && typeof err === "object" && !(err instanceof HttpError)) {
        if (err.errorToken === undefined) {
          try {
            err.errorToken = legacyErrorToken;
          } catch {
            // frozen error object — fall back to the generic token
          }
        }
      }
      next(err);
    });
  };
}

function resolveStatus(err: any): number {
  const raw = Number(err?.status ?? err?.statusCode);
  return Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
}

function resolveCode(err: any, status: number): ErrorCode {
  const raw = err?.code;
  if (typeof raw === "string" && (ERROR_CODES as readonly string[]).includes(raw)) {
    return raw as ErrorCode;
  }
  // Node/pg errors carry codes like ECONNREFUSED / 42P01 — never surface
  // those raw; map through the status taxonomy instead.
  return codeForStatus(status);
}

/**
 * Global Express error middleware. Mounted once in server/index.ts after
 * route registration (replacing the old inline handler). Always logs with
 * the request ID; response body shape:
 *   { message, error, code, requestId, details? }
 */
export function globalApiErrorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  const requestId = (req as any).requestId ?? "-";
  const status = resolveStatus(err);
  const code = resolveCode(err, status);
  const route = `${req.method} ${(req.baseUrl || "") + ((req as any).route?.path ?? req.path ?? "")}`;

  if (res.headersSent) {
    // Too late to write a body (e.g. SSE stream, partial response) — log and
    // let Express terminate the connection.
    console.error(
      `[Global Error] rid=${requestId} route=${route} status_sent code=${code}: ${err?.message ?? err}`,
    );
    return next(err);
  }

  const isHttpError = err instanceof HttpError;
  const expose = isHttpError ? err.expose : status < 500;
  const message = expose && err?.message ? String(err.message) : status >= 500 ? "Internal Server Error" : `HTTP ${status}`;
  const errorToken =
    typeof err?.errorToken === "string" && err.errorToken ? String(err.errorToken) : message;

  if (status >= 500) {
    // 5xx: full stack — this is the line a rid from a user report leads to.
    console.error(`[Global Error] rid=${requestId} route=${route} status=${status} code=${code}:`, err);
  } else {
    console.warn(
      `[Global Error] rid=${requestId} route=${route} status=${status} code=${code}: ${err?.message ?? err}`,
    );
  }

  const body: Record<string, unknown> = { message, error: errorToken, code, requestId };
  if (isHttpError && err.details !== undefined) body.details = err.details;
  res.status(status).json(body);
}
