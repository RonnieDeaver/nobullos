/* test-registration
{
  "name": "OpenAI adapter default timeout/retry policy (Task #4220)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4220 — fast, deterministic, no-DB unit guard on the shared OpenAI adapter's default timeout/retry policy; a silent regression re-opens the stalled-request-holds-a-worker-forever hazard across ~14 background modules.",
  "scanPaths": [
    "server/services/callAnalysis.ts",
    "server/services/callArchivePipeline.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #4220 — pin the default retry/timeout policy on the canonical OpenAI
 * adapter so it can't silently disappear. During the adapter migration
 * (Task #4191) only the route-layer client (server/routes/middleware.ts)
 * carried a timeout; the ~13 background module clients built via
 * createDefaultOpenAiClient() had NONE, so a stalled vendor request could
 * hold a background worker slot indefinitely.
 *
 * Guards:
 *   1. createDefaultOpenAiClient() applies DEFAULT_OPENAI_MAX_RETRIES /
 *      DEFAULT_OPENAI_TIMEOUT_MS by default.
 *   2. Explicit overrides still win (middleware's 60 s / 3 retries).
 *   3. The default constants stay sensible (bounded, non-zero).
 *   4. Source scan: every audio-transcription call site passes the longer
 *      per-request DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS (long audio calls
 *      legitimately exceed the chat-completion default).
 *
 * No network egress: constructing the SDK client performs no requests.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  createDefaultOpenAiClient,
  createOpenAiClient,
  DEFAULT_OPENAI_MAX_RETRIES,
  DEFAULT_OPENAI_TIMEOUT_MS,
  DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS,
} from "../server/services/ai/openAiClient";

async function main() {
  // 1. Defaults applied.
  const client = createDefaultOpenAiClient({ apiKey: "test-key-not-real" });
  assert.equal(
    client.timeout,
    DEFAULT_OPENAI_TIMEOUT_MS,
    "default client must carry the default timeout",
  );
  assert.equal(
    client.maxRetries,
    DEFAULT_OPENAI_MAX_RETRIES,
    "default client must carry the default maxRetries",
  );

  // 2. Overrides win (route-layer client precedent: 60s / 3 retries).
  const overridden = createDefaultOpenAiClient({
    apiKey: "test-key-not-real",
    timeout: 60_000,
    maxRetries: 1,
  });
  assert.equal(overridden.timeout, 60_000, "timeout override must win");
  assert.equal(overridden.maxRetries, 1, "maxRetries override must win");

  // 2b. The RAW factory (Ads OS credential-resolving callers) is bounded
  //     too — "raw" means credentials, not an unbounded request.
  const raw = createOpenAiClient({ apiKey: "test-key-not-real" });
  assert.equal(
    raw.timeout,
    DEFAULT_OPENAI_TIMEOUT_MS,
    "raw factory must carry the default timeout",
  );
  assert.equal(
    raw.maxRetries,
    DEFAULT_OPENAI_MAX_RETRIES,
    "raw factory must carry the default maxRetries",
  );
  const rawOverridden = createOpenAiClient({
    apiKey: "test-key-not-real",
    timeout: 45_000,
    maxRetries: 0,
  });
  assert.equal(rawOverridden.timeout, 45_000, "raw factory timeout override must win");
  assert.equal(rawOverridden.maxRetries, 0, "raw factory maxRetries override must win");

  // 3. Constants stay sensible: bounded (a worker slot is eventually freed)
  //    and non-trivial (won't kill legitimately slow chat completions).
  assert.ok(
    DEFAULT_OPENAI_TIMEOUT_MS >= 30_000 && DEFAULT_OPENAI_TIMEOUT_MS <= 10 * 60_000,
    `DEFAULT_OPENAI_TIMEOUT_MS out of sane range: ${DEFAULT_OPENAI_TIMEOUT_MS}`,
  );
  assert.ok(
    DEFAULT_OPENAI_MAX_RETRIES >= 0 && DEFAULT_OPENAI_MAX_RETRIES <= 5,
    `DEFAULT_OPENAI_MAX_RETRIES out of sane range: ${DEFAULT_OPENAI_MAX_RETRIES}`,
  );
  assert.ok(
    DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS > DEFAULT_OPENAI_TIMEOUT_MS,
    "transcription timeout must exceed the general default",
  );

  // 4. Every audio-transcription call site passes the per-request
  //    transcription timeout so long audio jobs aren't regressed by the new
  //    client-level default.
  const repoRoot = process.cwd();
  const transcriptionFiles = [
    "server/services/callAnalysis.ts",
    "server/services/callArchivePipeline.ts",
  ];
  for (const rel of transcriptionFiles) {
    const src = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    const callSites = src.match(/audio\.transcriptions\.create\(/g) ?? [];
    assert.ok(
      callSites.length > 0,
      `${rel}: expected at least one audio.transcriptions.create call site`,
    );
    const withOverride =
      src.match(
        /audio\.transcriptions\.create\([\s\S]*?\}\s*,\s*\{\s*timeout:\s*DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS\s*\}\s*\)/g,
      ) ?? [];
    assert.equal(
      withOverride.length,
      callSites.length,
      `${rel}: every transcription call must pass { timeout: DEFAULT_OPENAI_TRANSCRIPTION_TIMEOUT_MS } (found ${withOverride.length}/${callSites.length})`,
    );
  }

  console.log("openai-client-default-timeout: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
