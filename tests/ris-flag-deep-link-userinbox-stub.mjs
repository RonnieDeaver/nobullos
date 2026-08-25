// Test stub for server/services/notifications/userInbox.ts.
//
// The real module writes to the `user_notifications` table (and may mirror to
// Slack), so importing it would drag the DB pool into this pure deep-link test.
// We only need to capture what `processRisResultFlag` hands to `notifyUser`, so
// this stub records every call (including its `deepLink`) on a global the test
// reads, and makes `resolveDedupeNotification` a no-op.

globalThis.__RIS_FLAG_NOTIFY_CALLS__ = globalThis.__RIS_FLAG_NOTIFY_CALLS__ || [];
globalThis.__RIS_FLAG_RESOLVE_CALLS__ =
  globalThis.__RIS_FLAG_RESOLVE_CALLS__ || [];

export async function notifyUser(userId, opts) {
  globalThis.__RIS_FLAG_NOTIFY_CALLS__.push({ userId, opts });
  return { id: `stub-${globalThis.__RIS_FLAG_NOTIFY_CALLS__.length}` };
}

export async function resolveDedupeNotification(userId, dedupeKey) {
  globalThis.__RIS_FLAG_RESOLVE_CALLS__.push({ userId, dedupeKey });
  return 0;
}
