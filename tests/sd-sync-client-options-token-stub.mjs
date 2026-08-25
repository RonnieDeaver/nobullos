// Stub for `server/services/clickUpIntegration` used by the
// sync-client-options route test (Task #3571).
// Always returns a valid token for CEO_ID; null for other user IDs.

export * from "../server/services/clickUpIntegration";

const CEO_ID = "test-3571-ceo";

export async function getAccessToken(userId) {
  return userId === CEO_ID ? "sd-sync-test-token" : null;
}
