// Node ESM resolve hook that redirects every import of `server/mcu/worker` to
// the in-memory stub (`onLocationChangedStub.mjs`) so the add-stale-location
// route test can exercise the SUCCESS path without arming the real 30s MCU
// recompute timer that `onLocationChanged()` schedules. Registered via
// `--import ./tests/helpers/onLocationChangedSetup.mjs` so it is active before
// `server/routes/clients` evaluates its static
// `import { onLocationChanged } from "../mcu/worker"`.
//
// The stub itself re-exports the REAL `worker`; when it does so its
// `context.parentURL` is the stub's own URL, so we pass that resolution
// through untouched to avoid redirecting the stub onto itself (an infinite
// loop). Every other importer gets the stub.

const STUB_URL = new URL("./onLocationChangedStub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    resolved?.url &&
    /\/server\/mcu\/worker\.[tj]s$/.test(resolved.url) &&
    context.parentURL !== STUB_URL
  ) {
    return { url: STUB_URL, shortCircuit: true, format: "module" };
  }
  return resolved;
}
