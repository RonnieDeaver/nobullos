// Resolve hook for tests/client/comms-clients-view-persistence.test.tsx
// (Task #4490):
// - redirects CommsContext to the shared pin-collapse stub shim (same
//   lightweight context instance for Comms.tsx / CommsSidebar and the test's
//   provider), and
// - redirects @/hooks/useTwilioDevice to a test-controllable stub file so
//   the suite can flip `incomingCall` truthy without the real Twilio Voice
//   SDK (globalThis.__TEST_TWILIO_DEVICE.setIncomingCall).

const SHIM_URL = new URL("./comms-sidebar-pin-collapse-shim.mjs", import.meta.url).href;
const TWILIO_STUB_URL = new URL(
  "./comms-clients-view-persistence-twilio-stub.mjs",
  import.meta.url,
).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === SHIM_URL || context.parentURL === TWILIO_STUB_URL) {
    return nextResolve(specifier, context);
  }
  if (/contexts\/CommsContext(\.tsx?)?$/.test(specifier)) {
    return { url: SHIM_URL, shortCircuit: true, format: "module" };
  }
  if (/hooks\/useTwilioDevice(\.tsx?)?$/.test(specifier)) {
    return { url: TWILIO_STUB_URL, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
