/**
 * Task #1630 — Retry bootstrap on Neon cold-start.
 *
 * A pure transient-error classifier plus a bounded retry helper used by
 * the three FATAL bootstrap gates in `server/index.ts`
 * (`durable_pipeline_tables`, `external_source_id_unique`,
 * `scheduler_start`).
 *
 * Classification is intentionally CONSERVATIVE: if we are not sure the
 * error is a transient connection/auth handoff blip, we do NOT retry —
 * we surface it so structural problems (missing tables, bad SQL,
 * permission failures, schema drift) still fail fast and visibly.
 *
 * The helper accepts an injectable `sleep` so unit tests can use a
 * fake-clock and run instantly.
 */

const TRANSIENT_PG_CODES = new Set<string>([
  "08P01", // protocol violation / auth timed out at handshake
  "08006", // connection failure
  "08001", // sqlclient unable to establish sqlconnection
]);

const TRANSIENT_NODE_CODES = new Set<string>([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
]);

const TRANSIENT_MESSAGE_SUBSTRINGS = [
  "authentication timed out",
  "connection terminated",
  "connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "terminating connection due to administrator command",
  "connection timeout",
  "connection reset",
];

const FATAL_PG_CODES = new Set<string>([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42601", // syntax_error
  "42501", // insufficient_privilege
  "23505", // unique_violation
  "22P02", // invalid_text_representation
]);

function getCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const v = (err as { code?: unknown }).code;
    if (typeof v === "string") return v;
  }
  return undefined;
}

function getMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const v = (err as { message?: unknown }).message;
    if (typeof v === "string") return v;
  }
  if (typeof err === "string") return err;
  return "";
}

/**
 * Pure predicate: does this error look like a transient Neon
 * connection / auth handoff blip we should retry during bootstrap?
 */
export function isTransientDbError(err: unknown): boolean {
  const code = getCode(err);
  if (code) {
    if (FATAL_PG_CODES.has(code)) return false;
    if (TRANSIENT_PG_CODES.has(code)) return true;
    if (TRANSIENT_NODE_CODES.has(code)) return true;
  }
  const msg = getMessage(err).toLowerCase();
  if (!msg) return false;
  for (const needle of TRANSIENT_MESSAGE_SUBSTRINGS) {
    if (msg.includes(needle)) return true;
  }
  return false;
}

export interface RetryTransientDbStepOptions {
  maxAttempts?: number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<typeof console, "warn">;
}

const DEFAULT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeForLog(msg: string): string {
  // Defense-in-depth: never echo a connection string / DATABASE_URL
  // into deploy logs even if a future driver decides to include it in
  // an error message. Redact any URL-like substrings.
  return msg.replace(/\b[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/\S+/g, "[redacted-url]");
}

/**
 * Run `fn()` with bounded retries on transient DB errors. Non-transient
 * errors are rethrown immediately with no sleep. After `maxAttempts`
 * transient retries (1 initial attempt + up to maxAttempts retries),
 * the last error is rethrown.
 *
 * Default contract per Task #1630: `maxAttempts=5` means 5 retries
 * with delays [1000,2000,4000,8000,16000] (~31s worst-case wall time)
 * before final exhaustion, for a total of up to 6 fn() invocations.
 */
export async function retryTransientDbStep<T>(
  stepName: string,
  fn: () => Promise<T>,
  opts: RetryTransientDbStepOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const delaysMs = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const logger = opts.logger ?? console;

  // attempt=0 is the initial try; attempts 1..maxAttempts are retries.
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err)) {
        throw err;
      }
      const retryNumber = attempt + 1;
      if (retryNumber > maxAttempts) {
        throw err;
      }
      const delayMs = delaysMs[attempt] ?? delaysMs[delaysMs.length - 1] ?? 1000;
      const code = getCode(err) ?? "";
      const message = sanitizeForLog(getMessage(err));
      logger.warn(
        `[Bootstrap] transient DB error during ${stepName} — retry ${retryNumber}/${maxAttempts} in ${delayMs}ms: ${code} ${message}`,
      );
      await sleep(delayMs);
    }
  }
  // Unreachable: loop body either returns or throws.
  throw new Error(`retryTransientDbStep(${stepName}) exited loop unexpectedly`);
}
