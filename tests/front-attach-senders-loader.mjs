// Node ESM resolve hook for the batch domain-attach route test (Task #2536).
//
// Redirects every import of `server/services/frontIntegration` to the
// recording stub in `front-attach-senders-frontintegration-stub.mjs`, EXCEPT
// the stub's own `export * from "../server/services/frontIntegration"` (which
// must reach the real module) — otherwise the re-export would resolve back
// onto the stub and loop forever.
//
// Registered via `--import ./tests/front-attach-senders-setup.mjs` so the hook
// is live before the route file's dynamic import evaluates.

const STUB_URL = new URL(
  "./front-attach-senders-frontintegration-stub.mjs",
  import.meta.url,
).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  // The stub re-exporting the real module must pass straight through.
  if (context.parentURL === STUB_URL) return resolved;
  if (/\/server\/services\/frontIntegration\.[tj]s$/.test(resolved.url)) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
