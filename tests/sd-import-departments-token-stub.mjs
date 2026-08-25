// Stub for `server/services/clickUpIntegration` used ONLY by the service-desk
// import-departments route test (Task #3540).
//
// Re-exports the real module and overrides getAccessToken so the import route
// always sees a connected CEO account without any DB token rows or network calls.
// Returns null for non-CEO user IDs so the "token required" guard triggers correctly.

export * from "../server/services/clickUpIntegration";

const CEO_ID = "test-3540-ceo";

export async function getAccessToken(userId) {
  return userId === CEO_ID ? "sd-import-test-token" : null;
}
