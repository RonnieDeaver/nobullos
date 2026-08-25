// Stub for `server/services/notifications/userInbox` used ONLY by the
// service-desk submit status-fallback test (Task #3569).
//
// Re-exports the real module and overrides notifyUser so no real notification
// is sent. All calls are recorded in globalThis.__sdSubmitNotifyCalls for
// assertion.

export * from "../server/services/notifications/userInbox";

export async function notifyUser(userId, params) {
  if (!Array.isArray(globalThis.__sdSubmitNotifyCalls)) {
    globalThis.__sdSubmitNotifyCalls = [];
  }
  globalThis.__sdSubmitNotifyCalls.push({ userId, params });
}
