// Resolve hook redirecting `@/hooks/use-auth` (or any relative import ending
// in hooks/use-auth) to the tiny stub in
// `tests/comms-sidebar-cmdk-use-auth-stub.mjs`. Matches by suffix so both the
// alias and any tsx-resolved absolute form hit the stub. Registered from
// `tests/comms-sidebar-cmdk-setup.mjs` alongside the shared heavyClientLoader
// and the CommsContext stub loader.

const STUB_URL = new URL("./comms-sidebar-cmdk-use-auth-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // Never redirect the stub itself (avoids a self-redirect loop).
  if (context.parentURL === STUB_URL) {
    return nextResolve(specifier, context);
  }
  const cleaned = specifier.replace(/\.(tsx?|jsx?)$/, "");
  if (cleaned.endsWith("hooks/use-auth")) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
