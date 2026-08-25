// Node ESM resolve hook that redirects every import of the canonical OpenAI
// adapter (`server/services/ai/openAiClient`) to the in-memory stub
// (`atsUnifiedOpenAiStub.mjs`) so the ATS unified re-eval failure-path test
// can make `chat.completions.create` throw deterministically without any
// network traffic. Registered via
// `--import ./tests/helpers/atsUnifiedOpenAiSetup.mjs` so it is active before
// `server/services/atsUnifiedScoring.ts` evaluates its module-local
// `const openai = createDefaultOpenAiClient()`.
//
// The stub re-exports the REAL adapter; when it does so its
// `context.parentURL` is the stub's own URL, so that resolution passes
// through untouched (otherwise the stub's `export *` would redirect onto
// itself — an infinite loop).

const STUB_URL = new URL("./atsUnifiedOpenAiStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/services\/ai\/openAiClient\.[tj]s$/.test(resolved.url) &&
    context.parentURL !== STUB_URL
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
