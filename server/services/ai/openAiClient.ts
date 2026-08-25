/**
 * Canonical OpenAI adapter — the ONLY file allowed to import the `openai`
 * SDK (vendor-confinement guard, scripts/lint-vendor-confinement.ts).
 *
 * Task #4191: Task #4180 froze the direct-importer baseline at 17 files with
 * no designated adapter. This file is now the designated owning adapter: all
 * former direct importers construct their clients through the factories
 * below, and the frozen baseline shrank to just this file — any net-new
 * `import ... from "openai"` elsewhere fails the gate.
 *
 * Design notes (no behavior change from the migration):
 *   - Each consumer keeps building its OWN client instance (module-local
 *     singletons, per-call clients in scripts/adsOs) exactly as before —
 *     several modules rely on module-local clients as test seams, so this
 *     adapter deliberately does NOT share a global singleton.
 *   - `createDefaultOpenAiClient()` reproduces the repo-standard config
 *     (Replit AI-integrations key + base URL from the environment) that 14
 *     of the former importers used verbatim; `overrides` covers the
 *     middleware client's maxRetries/timeout.
 *   - `createOpenAiClient()` is the raw factory for callers with their own
 *     credential resolution (Ads OS config accessors).
 *   - Vendor types are re-exported as `OpenAiClient` / `OpenAiClientOptions`
 *     so consumers never need the vendor package for typing either.
 */
import OpenAI from "openai";

/** The vendor client type, re-exported so consumers never import "openai". */
export type OpenAiClient = OpenAI;

/** Constructor options for the vendor client. */
export type OpenAiClientOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>;

/**
 * Raw factory for callers that resolve credentials themselves (Ads OS config
 * accessors). Task #4220: still applies the default retry/timeout policy —
 * "raw" means credentials, not an unbounded request — callers may override.
 */
export function createOpenAiClient(options: OpenAiClientOptions): OpenAiClient {
  return new OpenAI({
    maxRetries: DEFAULT_OPENAI_MAX_RETRIES,
    timeout: DEFAULT_OPENAI_TIMEOUT_MS,
    ...options,
  });
}

/**
 * Task #4220: default retry/timeout policy for every repo-standard client.
 * The SDK ships with NO request timeout, so a stalled vendor request could
 * hold a background worker slot indefinitely (route-layer precedent:
 * server/routes/middleware.ts, Task #1572). 120 s covers slow background
 * chat-completion sites (daily judgment, churn radar) without hiding genuine
 * outages; `maxRetries: 3` matches the middleware client so 429/5xx are
 * retried predictably. Long audio-transcription calls override PER REQUEST
 * (see DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS) rather than per client.
 */
export const DEFAULT_OPENAI_MAX_RETRIES = 3;
export const DEFAULT_OPENAI_TIMEOUT_MS = 120_000;

/**
 * Per-request timeout for audio transcription calls (Whisper-family). Audio
 * uploads + transcription legitimately run far longer than chat completions;
 * 5 min matches callArchivePipeline's LOCK_TTL_MS ("long enough for a slow
 * transcription"). Pass as the request-options argument:
 *   openai.audio.transcriptions.create({...}, { timeout: DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS })
 */
export const DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS = 300_000;

/**
 * Repo-standard client: Replit AI-integrations key + base URL from the
 * environment (the exact config the former direct importers used), plus the
 * default retry/timeout policy above unless explicitly overridden.
 */
export function createDefaultOpenAiClient(
  overrides: Partial<OpenAiClientOptions> = {},
): OpenAiClient {
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    maxRetries: DEFAULT_OPENAI_MAX_RETRIES,
    timeout: DEFAULT_OPENAI_TIMEOUT_MS,
    ...overrides,
  });
}
