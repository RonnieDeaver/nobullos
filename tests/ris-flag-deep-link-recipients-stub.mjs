// Test stub for server/services/notifications/recipients.ts.
//
// The real `byFunction` runs a `getDb()` query to resolve which users hold a
// given function. This deep-link test does not care WHO is notified, only that
// SOMEONE is (so the notify path runs) and what URL they receive. Returning a
// single fixed recipient keeps the test DB-free while still exercising the
// emission loop.

export async function byFunction(_fn) {
  return ["stub-recipient-1"];
}
