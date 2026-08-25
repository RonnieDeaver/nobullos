/**
 * Task #1820 — Shared Upstash fetch passthrough helper.
 *
 * Many test files replace `global.fetch` with a stub that only handles
 * the specific external service the test is exercising (Slack, SendGrid,
 * PandaDoc, Zoom token endpoint, …). When `server/services/cache/redisCache.ts`
 * runs in the same process (it ALWAYS does, because the `system_settings`
 * read-through cache is wired through it), the @upstash/redis REST client
 * fires its own `fetch` against `*.upstash.io`. Three failure modes have
 * been observed:
 *
 *  1. Stubs that ONLY return a canned object for everything (e.g.
 *     `slack-auth-breaker-stuck-alerts.test.ts`'s tripBreakerNow /
 *     recordSuccessNow) make the @upstash/redis client try to read
 *     `.headers.get(...)` on a plain object → crash → noisy
 *     `[RedisCache] … error ns=system_settings: Cannot read properties of
 *     undefined (reading 'get')` warnings in the suite log.
 *  2. Stubs that throw "Unexpected fetch" on anything they don't
 *     recognise (e.g. the original zoom-reconnect test) abort the
 *     redis call entirely; depending on which storage write triggered
 *     it, the test under exercise can lose its system_settings
 *     invalidation and start flaking on stale cached values.
 *  3. Returning the WRONG envelope shape (e.g. `[{result:null}]` for a
 *     single-command call, or a 1-element array for a multi-op
 *     pipeline) causes `Cannot read properties of undefined (reading
 *     'error')` when the @upstash/redis client tries to read the i-th
 *     entry that doesn't exist.
 *
 * This helper handles all three modes. It inspects the URL and request
 * body to decide which shape to return:
 *
 *   - Pipeline (`/pipeline` or `/multi-exec`): JSON array of
 *     `{result:null}` envelopes, one per command in the request body
 *     (defaulting to a generous fallback if the body cannot be parsed).
 *   - Single command (everything else under `*.upstash.io`): a single
 *     `{result:null}` envelope.
 *
 * `result === null` is treated as a cache miss for GET and as a no-op
 * success for SET / DEL — so the system_settings cache behaves as
 * "always cold", every read falls through to the DB, and writes appear
 * to succeed without any real Redis traffic. This matches the
 * production fail-open path when Upstash is unreachable, so tests stay
 * representative of real failure modes.
 *
 * Usage:
 *
 *   const originalFetch = global.fetch;
 *   global.fetch = (async (input: any, init?: any) => {
 *     if (isUpstashRedisUrl(input)) return makeUpstashPassthroughResponse(input, init);
 *     // …existing test-specific intercepts…
 *     return originalFetch(input as any, init);
 *   }) as any;
 *
 * The helper is intentionally just two functions — not a wrapper that
 * takes over the whole fetch — because each test's existing stub has a
 * different signature and intercept order, and inlining the two-line
 * guard is clearer than a one-size-fits-all wrapper.
 */

function extractUrl(input: unknown): string {
  return typeof input === "string"
    ? input
    : (input as any)?.url
      ? (input as any).url
      : String(input);
}

export function isUpstashRedisUrl(input: unknown): boolean {
  return extractUrl(input).includes(".upstash.io");
}

const PIPELINE_FALLBACK_LENGTH = 32;

export function makeUpstashPassthroughResponse(
  input?: unknown,
  init?: { body?: unknown } | null,
): Response {
  const url = input === undefined ? "" : extractUrl(input);
  const isPipeline =
    url.includes("/pipeline") || url.includes("/multi-exec");

  let body: string;
  if (isPipeline) {
    let count = PIPELINE_FALLBACK_LENGTH;
    const rawBody = init?.body;
    if (rawBody !== undefined && rawBody !== null) {
      try {
        const text =
          typeof rawBody === "string" ? rawBody : String(rawBody);
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0) {
          count = parsed.length;
        }
      } catch {
        // fall through to PIPELINE_FALLBACK_LENGTH
      }
    }
    const arr = new Array(count).fill(null).map(() => ({ result: null }));
    body = JSON.stringify(arr);
  } else {
    body = JSON.stringify({ result: null });
  }

  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
