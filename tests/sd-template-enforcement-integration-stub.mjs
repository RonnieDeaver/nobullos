// Stub for `server/services/clickUpIntegration` used ONLY by the service-desk
// template-enforcement smoke test (Task #3395).
//
// Overrides getAccessToken so the seeded `clickup_user_tokens` row resolves to
// a fake bearer token without touching AES token decryption or real secrets.

export * from "../server/services/clickUpIntegration";

export async function getAccessToken(userId) {
  const calls =
    globalThis.__sdTemplateTokenCalls ?? (globalThis.__sdTemplateTokenCalls = []);
  calls.push(userId);
  return `stub-token-for-${userId}`;
}
