// Stub for `server/services/clickUpIntegration` used by
// tests/sd-transition-waiting-fields.test.ts. Re-exports the REAL module
// and overrides only getAccessToken so the transition route always sees a
// connected ClickUp account without any DB token rows or network calls.
export * from "../../server/services/clickUpIntegration";

export async function getAccessToken(_userId) {
  return "sd-test-token";
}
