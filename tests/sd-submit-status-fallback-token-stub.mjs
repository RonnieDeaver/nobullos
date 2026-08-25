// Stub for `server/services/clickUpIntegration` used ONLY by the service-desk
// submit status-fallback test (Task #3569).
//
// Re-exports the real module and overrides getAccessToken so the submit route
// always sees a connected actor without any DB token rows or real OAuth.

export * from "../server/services/clickUpIntegration";

const ACTOR_ID = "test-3569-actor";

export async function getAccessToken(userId) {
  return userId === ACTOR_ID ? "test-cu-token-3569" : null;
}
