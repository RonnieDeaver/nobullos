// Shared pure classifiers for the endpoint contract table.
//
// Extracted from scripts/generate-endpoint-contract-table.mjs (Task #4105) so
// that scripts/lint-contract-table-freshness.ts can recompute the auth/role/
// classification columns from the route inventory's `middleware` field and
// flag drift when a route's middleware changes without moving its
// registration line (which would otherwise leave those columns stale while
// the method/path/handler comparison still passes).
//
// These functions are PURE: input is an inventory route
// ({ path, middleware? }), output is a string cell value. Keep them free of
// fs/corpus access — the lint imports this module and must stay cheap.

export function authClass(route) {
  const mw = route.middleware || [];
  if (mw.includes("validateTwilioWebhook")) return "webhook";
  if (mw.includes("requireCeoToolsAuth")) return "token";
  if (mw.includes("isAuthenticated") || mw.some((m) => m.startsWith("require"))) return "session";
  return "none";
}

export function roleClass(route) {
  const mw = route.middleware || [];
  if (mw.includes("requireCeo")) return "ceo";
  if (mw.includes("requireTeamLead")) return "team_lead";
  if (mw.includes("requireAccountManager")) return "account_manager";
  if (mw.includes("requireCommandCenterAccess")) return "command_center";
  if (mw.includes("requireTwilioAccess")) return "twilio_access";
  if (mw.includes("requireInternal")) return "internal";
  return "—";
}

// Task #1574: re-classify each route into the Track-D taxonomy
//   public | authenticated | admin | webhook | internal | debug/dev-only | deprecated
export function trackDClass(route) {
  if (/\/webhooks?\b/.test(route.path)) return "webhook";
  if (route.middleware?.includes("requireInternal")) return "internal";
  if (route.middleware?.includes("requireCeoToolsAuth")) return "internal";
  if (/(\/dry-run\b|\/test\b|\/test-history\b|\/debug\b|\/dev\b)/.test(route.path))
    return "debug/dev-only";
  // Task #4087: pruned the matchless 'contamination-scan' and 'remediate-'
  // tokens after the D-DEAD wave-2 removals. 'migrate-' stays: it still
  // matches the live /api/admin/migrate-product-types route.
  if (
    /\/migrate-|seed-all|decontaminate|shadow-evaluation|comparative-semantic\/reset/.test(
      route.path,
    )
  )
    return "debug/dev-only";
  if (route.path.includes("/admin/")) return "admin";
  if (
    route.middleware?.includes("requireCeo") ||
    route.middleware?.includes("requireTeamLead")
  )
    return "admin";
  if (route.middleware?.includes("isAuthenticated") || route.middleware?.some((m) => m.startsWith("require")))
    return "authenticated";
  return "public";
}
