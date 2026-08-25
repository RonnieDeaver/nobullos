import { auditOutboundCall, type IntegrationName } from "../services/externalCallAudit";

const DEFAULT_TIMEOUT_MS = 15_000;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const MAX_RETRIES = 5;

export interface FetchWithRetryAuditOptions {
  /** Integration the call is hitting (e.g. "google_maps", "fcc_census"). */
  service: IntegrationName;
  /** Stable per-operation name used as the audit endpoint label. */
  operation: string;
  /**
   * Optional dedupe inputs hashed into the audit's `request_dedupe_key`.
   * Use this for caller-provided identifiers (e.g. lat/lng, address) that
   * are NOT in the URL query string. Anything passed here is sha256-hashed
   * before being persisted — never logged raw.
   */
  dedupeParams?: Record<string, unknown>;
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  label: string = "API",
  audit?: FetchWithRetryAuditOptions,
): Promise<Response> {
  let attempt = 0;
  let backoff = INITIAL_BACKOFF_MS;

  // Pull query params off the URL so the dedupe hash is stable across api-key
  // rotation and across hosts. We never log the raw param values — they only
  // contribute to the sha256 request_dedupe_key.
  let endpoint = audit?.operation ?? label;
  const dedupeParams: Record<string, unknown> = { ...(audit?.dedupeParams ?? {}) };
  if (audit) {
    try {
      const parsed = new URL(url, "http://placeholder.local");
      endpoint = `${audit.operation} ${parsed.pathname}`.slice(0, 256);
      for (const [k, v] of parsed.searchParams.entries()) {
        // Strip credential-bearing params from the dedupe hash so it stays
        // stable across key rotation.
        if (k === "key" || k === "api_key" || k === "token" || k === "access_token") continue;
        if (!(k in dedupeParams)) dedupeParams[k] = v;
      }
    } catch {
      // url may already be a path — fall through with the operation as endpoint
    }
  }

  while (attempt < MAX_RETRIES) {
    attempt++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    const doFetch = async () => {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      // Read the body once so we can hash + size it for the audit, then
      // hand back a clone so the caller can still `.json()` / `.text()`.
      let responseSizeBytes: number | undefined;
      let responseHash: string | undefined;
      try {
        const cloned = res.clone();
        const buf = Buffer.from(await cloned.arrayBuffer());
        responseSizeBytes = buf.byteLength;
        if (responseSizeBytes > 0) {
          const { createHash } = await import("node:crypto");
          responseHash = createHash("sha256").update(buf).digest("hex").slice(0, 64);
        }
      } catch {
        // Streaming bodies — skip hashing, still record status + timing.
      }
      return {
        value: res,
        statusCode: res.status,
        responseSizeBytes,
        responseHash,
      };
    };

    try {
      const response = audit
        ? await auditOutboundCall<Response>(
            {
              integration: audit.service,
              endpoint,
              method: ((options.method as string) ?? "GET").toUpperCase(),
              dedupeParams,
            },
            doFetch,
          )
        : await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`[${label}] Max retries (${MAX_RETRIES}) exceeded with HTTP ${response.status}`);
        }
        const retryAfter = response.headers.get('retry-after');
        const waitMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, MAX_BACKOFF_MS) : backoff;
        const effectiveWait = response.status === 429 ? Math.max(waitMs, 3000) : waitMs;
        console.warn(`[${label}] Attempt ${attempt}/${MAX_RETRIES} got HTTP ${response.status}. Retrying in ${Math.round(effectiveWait / 1000)}s...`);
        await new Promise((r) => setTimeout(r, effectiveWait));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }

      return response;
    } catch (error: any) {
      clearTimeout(timeout);
      if (attempt >= MAX_RETRIES) {
        throw new Error(`[${label}] Max retries (${MAX_RETRIES}) exceeded: ${error?.message || "unknown error"}`);
      }
      const isTimeout = error?.name === "AbortError" || error?.message?.includes("aborted");
      const reason = isTimeout ? "timeout" : error?.message || "unknown error";
      console.warn(`[${label}] Attempt ${attempt}/${MAX_RETRIES} failed (${reason}). Retrying in ${Math.round(backoff / 1000)}s...`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 1.5, MAX_BACKOFF_MS);
    }
  }

  throw new Error(`[${label}] Max retries (${MAX_RETRIES}) exceeded`);
}
