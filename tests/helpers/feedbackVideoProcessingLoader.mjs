// Node ESM resolve hook that redirects every import of
// `server/services/feedbackVideoProcessing` to the in-memory stub
// (`feedbackVideoProcessingStub.mjs`) so the feedback video restart-resume
// sweep test can drive the re-drive outcome deterministically without hitting
// real object storage / TwelveLabs. Registered via
// `--import ./tests/helpers/feedbackVideoProcessingSetup.mjs` so it is active
// before the test file (and its import chain) evaluates.
//
// The stub itself re-exports the REAL `feedbackVideoProcessing`; when it does
// so its `context.parentURL` is the stub's own URL, so we pass that resolution
// through untouched to avoid redirecting the stub onto itself (an infinite
// loop). Every other importer gets the stub.

const STUB_URL = new URL("./feedbackVideoProcessingStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/services\/feedbackVideoProcessing\.[tj]s$/.test(resolved.url) &&
    context.parentURL !== STUB_URL
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
