/**
 * Task #4346 — humane copy for the global query/mutation error toasts.
 *
 * Audit P1-8 (§8.3, audits/internal-os-design-audit-2026-08.md): the global
 * error toast rendered raw engineering text — "Request failed / bundled 429",
 * raw "500: {json}" bodies — with no recovery guidance. This module is the
 * single failure-class → operator-grade-copy mapping used by the query-client
 * cache handlers (client/src/lib/queryClient.ts) and by any surface that
 * formats a request error for a toast.
 *
 * Contract:
 * - Titles and descriptions are plain language with recovery guidance and
 *   NEVER contain raw status codes, JSON bodies, or stack-ish text.
 * - The raw error text survives in `technicalDetail`, rendered secondary
 *   (small/muted) so operators can still report specifics to the team.
 * - Pure and DB/DOM-free: covered by tests/query-error-copy.test.ts.
 * - Copy/presentation only — retry/backoff behavior lives in queryClient.ts
 *   and is deliberately untouched by this module.
 *
 * Toasts are reserved for async side-effect results. Field validation must
 * be inline (see client/src/components/ui/form-field.tsx — the FormField
 * standard), never a toast.
 */

export type QueryFailureClass =
  | "rate_limited"
  | "offline"
  | "network"
  | "auth_expired"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation"
  | "server_error"
  | "unknown";

export interface HumanizedQueryError {
  failureClass: QueryFailureClass;
  /** Plain-language toast title, e.g. "Too many requests". */
  title: string;
  /** Translated detail + recovery guidance, e.g. "Wait a moment and retry." */
  description: string;
  /**
   * The sanitized raw error text (status line, server body snippet). Shown
   * secondary in the toast — available for bug reports, never the headline.
   */
  technicalDetail?: string;
}

export interface HumanizeOptions {
  /** Whether the failure came from a read (query) or a write (mutation). */
  kind?: "query" | "mutation";
  /**
   * Injectable navigator.onLine for tests. Defaults to the real value when
   * a navigator exists; undefined means "can't tell" (treated as online).
   */
  onLine?: boolean;
}

/** Max characters of raw error text carried into `technicalDetail`. */
export const TECHNICAL_DETAIL_MAX_LENGTH = 160;

/**
 * Extract an HTTP status from the error-message shapes that actually reach
 * the global handlers in this codebase:
 *   - "429: Too Many Requests"            (default queryFn / apiRequest)
 *   - "bundled 429"                        (notifications poll queryFn)
 *   - "HTTP 500"                           (several admin cards)
 *   - "Failed to load meetings (500)"      (trailing-paren shape)
 *   - "Failed to reclaim job (HTTP 500)"
 * Anything else returns null — unanchored digit-matching would misread
 * ordinary copy (e.g. "Imported 429 rows").
 */
export function extractHttpStatus(message: string): number | null {
  const patterns = [
    /^(\d{3}):/,
    /^bundled (\d{3})$/,
    /^HTTP (\d{3})$/,
    /\(HTTP (\d{3})\)\s*$/,
    /\((\d{3})\)\s*$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match) {
      const status = Number(match[1]);
      if (status >= 100 && status <= 599) return status;
    }
  }
  return null;
}

/** Browser network-layer failure messages (no HTTP response at all). */
export function isNetworkErrorMessage(message: string): boolean {
  return (
    message.includes("Failed to fetch") ||
    message.includes("NetworkError") ||
    message.includes("Load failed")
  );
}

/** Collapse whitespace and truncate raw error text for the secondary line. */
function sanitizeRaw(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= TECHNICAL_DETAIL_MAX_LENGTH) return collapsed;
  return collapsed.slice(0, TECHNICAL_DETAIL_MAX_LENGTH) + "…";
}

/** True when a message reads as engineering output rather than human copy. */
function looksEngineering(message: string): boolean {
  return (
    message.includes("{") ||
    message.includes("<") ||
    message.includes("Exception") ||
    message.length > TECHNICAL_DETAIL_MAX_LENGTH
  );
}

function withTerminalPeriod(text: string): string {
  return /[.!?…]$/.test(text) ? text : text + ".";
}

const STATUS_CLASS: Record<number, QueryFailureClass> = {
  400: "validation",
  401: "auth_expired",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation",
  429: "rate_limited",
};

export function classifyQueryFailure(
  error: unknown,
  options: HumanizeOptions = {},
): QueryFailureClass {
  if (!(error instanceof Error)) return "unknown";
  const message = error.message;
  if (isNetworkErrorMessage(message)) {
    const onLine =
      options.onLine !== undefined
        ? options.onLine
        : typeof navigator !== "undefined"
          ? navigator.onLine
          : undefined;
    return onLine === false ? "offline" : "network";
  }
  const status = extractHttpStatus(message);
  if (status === null) return "unknown";
  if (status >= 500) return "server_error";
  return STATUS_CLASS[status] ?? "unknown";
}

const CLASS_COPY: Record<
  Exclude<QueryFailureClass, "unknown">,
  { title: string; description: string }
> = {
  rate_limited: {
    title: "Too many requests",
    description: "Wait a moment and retry.",
  },
  offline: {
    title: "You're offline",
    description: "Reconnect to the internet, then retry.",
  },
  network: {
    title: "Connection problem",
    description: "The server couldn't be reached. Check your connection and retry.",
  },
  auth_expired: {
    title: "Session expired",
    description: "Sign in again to continue.",
  },
  forbidden: {
    title: "Permission needed",
    description: "Your account can't do that. Ask an admin if you need access.",
  },
  not_found: {
    title: "Not found",
    description: "That item may have been moved or deleted. Refresh and try again.",
  },
  conflict: {
    title: "Someone else changed this",
    description: "Refresh to load the latest version, then re-apply your change.",
  },
  validation: {
    title: "Check the details",
    description: "Some entries weren't accepted. Fix the highlighted fields and try again.",
  },
  server_error: {
    title: "Server problem",
    description:
      "Something went wrong on our side. Wait a moment and retry — if it keeps failing, let the team know.",
  },
};

const UNKNOWN_RETRY_HINT = "Try again — if it keeps happening, let the team know.";

/**
 * Translate any request error into operator-grade toast copy: plain-language
 * title, recovery guidance in the description, and the raw text demoted to
 * `technicalDetail`.
 */
export function humanizeQueryError(
  error: unknown,
  options: HumanizeOptions = {},
): HumanizedQueryError {
  const kind = options.kind ?? "query";
  const unknownTitle = kind === "mutation" ? "That didn't go through" : "Couldn't load this data";

  if (!(error instanceof Error)) {
    return {
      failureClass: "unknown",
      title: unknownTitle,
      description: `An unexpected error occurred. ${UNKNOWN_RETRY_HINT}`,
      technicalDetail:
        typeof error === "string" && error.trim().length > 0 ? sanitizeRaw(error) : undefined,
    };
  }

  const failureClass = classifyQueryFailure(error, options);
  const message = error.message;

  if (failureClass !== "unknown") {
    return {
      failureClass,
      title: CLASS_COPY[failureClass].title,
      description: CLASS_COPY[failureClass].description,
      technicalDetail: sanitizeRaw(message),
    };
  }

  // Unknown class: no recognizable status, not a network error. Component
  // code often throws already-human messages ("Failed to create client") —
  // keep those in the description. Engineering-looking blobs are demoted to
  // the technical line so raw JSON never headlines a toast.
  if (message.trim().length === 0) {
    return {
      failureClass,
      title: unknownTitle,
      description: `An unexpected error occurred. ${UNKNOWN_RETRY_HINT}`,
    };
  }
  // Status-shaped messages whose code we don't map (e.g. "418: teapot") are
  // still engineering output — never let the digits headline.
  if (extractHttpStatus(message) !== null || looksEngineering(message)) {
    return {
      failureClass,
      title: unknownTitle,
      description: UNKNOWN_RETRY_HINT,
      technicalDetail: sanitizeRaw(message),
    };
  }
  return {
    failureClass,
    title: unknownTitle,
    description: `${withTerminalPeriod(sanitizeRaw(message))} ${UNKNOWN_RETRY_HINT}`,
  };
}
