// Node ESM resolve hook for tests/onboarding-e2e-full-chain.test.ts (Task
// #5298, stage 4 of the New Client Onboarding epic). Redirects imports of
// `server/services/zoomIntegration` and
// `server/services/googleCalendarIntegration` to in-memory stubs so a real
// onboarding booking (Zoom meeting + Google Calendar event) can complete
// end to end without hitting either live API.
//
// Both stubs live in the shared location tests/vendor-stubs/ (Task #5313 —
// see TESTING.md, "Shared vendor test stubs") so the next suite needing
// Zoom or Calendar coverage can import them directly instead of authoring
// new ones.
//
// Each stub re-exports the REAL module; when a stub itself imports the
// real file, context.parentURL is the stub's own URL, so that resolution
// passes through untouched (avoids a self-redirect loop).
// Registered via `--import ./tests/onboarding-e2e-setup.mjs`.

const ZOOM_STUB_URL = new URL("./vendor-stubs/zoom-stub.mjs", import.meta.url).href;
const CALENDAR_STUB_URL = new URL("./vendor-stubs/calendar-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved?.url) {
    if (
      /\/server\/services\/zoomIntegration\.[tj]s$/.test(resolved.url) &&
      context.parentURL !== ZOOM_STUB_URL
    ) {
      return { url: ZOOM_STUB_URL, shortCircuit: true, format: "module" };
    }
    if (
      /\/server\/services\/googleCalendarIntegration\.[tj]s$/.test(resolved.url) &&
      context.parentURL !== CALENDAR_STUB_URL
    ) {
      return { url: CALENDAR_STUB_URL, shortCircuit: true, format: "module" };
    }
  }
  return resolved;
}
