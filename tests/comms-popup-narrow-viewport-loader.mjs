// Resolve hook redirecting `@/contexts/CommsContext` (or any relative import
// ending in contexts/CommsContext) to the tiny stub in
// `tests/comms-popup-narrow-viewport-stub.mjs`. Matches by basename so both the
// alias and any tsx-resolved absolute form hit the stub. Registered from
// `tests/comms-popup-narrow-viewport-setup.mjs` alongside the shared
// heavyClientLoader.

const STUB_URL = new URL("./comms-popup-narrow-viewport-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // Never redirect the stub itself (avoids a self-redirect loop).
  if (context.parentURL === STUB_URL) {
    return nextResolve(specifier, context);
  }
  const cleaned = specifier.replace(/\.(tsx?|jsx?)$/, "");
  if (cleaned.endsWith("contexts/CommsContext")) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
