// Node ESM resolve/load hook for the Profile "?tab=" deep-link DOM test
// (Task #3105). Mirrors `client-detail-tab-from-url-loader.mjs`:
//
// `Profile.tsx` statically imports three heavy feature panels
// (BookingSettingsPanel, MyMeetingsPanel, UserNotificationSettingsPanel)
// whose transitive deps (calendar widgets, SSE hooks, etc.) don't matter to
// the tab-routing behavior under test. Each is redirected to a tiny stub that
// renders a marker div so the test can assert WHICH panel mounted. `cmdk`
// (pulled in via the timezone combobox's @/components/ui/command) is shimmed
// with the shared inline shim, and `.css` side-effect imports map to an empty
// module as a defensive catch-all.

const CMDK_SHIM_URL = new URL("./ads-hygiene-cmdk-shim.mjs", import.meta.url).href;
const PANEL_SHIM_URL = new URL("./profile-tab-panel-shim.mjs", import.meta.url).href;
const STUB_CSS = "profile-tab-stub:css";
// `Profile.tsx`'s graph reaches `@/hooks/use-auth`, whose `@clerk/react` hooks
// throw outside a live <ClerkProvider>. Stub `@clerk/react` with a signed-IN
// loaded session (same STUB_CLERK pattern as tests/helpers/heavyClientLoader.mjs
// — only the two hooks use-auth imports); the REAL use-auth hook then fetches
// the DB user (team_member) through the suite's `/api/auth/user` fetch stub.
const STUB_CLERK = "profile-tab-stub:clerk-react";

// specifier → marker testid rendered by the stub component.
const STUBBED_PANELS = new Map([
  ["@/components/booking/BookingSettingsPanel", "stub-booking-settings-panel"],
  ["@/components/booking/MyMeetingsPanel", "stub-my-meetings-panel"],
  ["@/components/UserNotificationSettingsPanel", "stub-notification-settings-panel"],
]);

export async function resolve(specifier, context, nextResolve) {
  if (STUBBED_PANELS.has(specifier)) {
    return {
      url: `${PANEL_SHIM_URL}?testid=${STUBBED_PANELS.get(specifier)}`,
      shortCircuit: true,
      format: "module",
    };
  }
  if (specifier === "cmdk") {
    return { url: CMDK_SHIM_URL, shortCircuit: true, format: "module" };
  }
  if (specifier === "@clerk/react") {
    return { url: STUB_CLERK, shortCircuit: true, format: "module" };
  }
  if (specifier.endsWith(".css")) {
    return { url: STUB_CSS, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_CSS) {
    return { format: "module", source: "export default {};", shortCircuit: true };
  }
  if (url === STUB_CLERK) {
    // Only the two hooks `@/hooks/use-auth` imports; signed-IN loaded session,
    // sign-out is a no-op (mirrors heavyClientLoader.mjs's STUB_CLERK).
    const source = `
export function useAuth() { return { isLoaded: true, isSignedIn: true }; }
export function useClerk() { return { signOut: async () => {} }; }
`;
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
