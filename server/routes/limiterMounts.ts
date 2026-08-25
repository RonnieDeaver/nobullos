export const WEBHOOK_PATHS: string[] = [
  "/api/stripe/webhook",
  "/api/twilio/webhooks",
  "/api/integrations/front/webhook",
  "/api/integrations/zoom/webhook",
  // Task #3972 — TwelveLabs indexing-completion webhook (TL-Signature
  // verified, no session auth).
  "/api/integrations/twelvelabs/webhook",
  // Task #3132 — LiveKit room webhook (signature-verified, no session auth).
  "/api/comms/webhook/livekit",
  // Task #5105 — GHL Marketplace inbound appointment/DND webhook (Ed25519-signed,
  // no session auth). Path is the sole public GHL inbound surface.
  "/api/integrations/ghl/marketplace-webhook",
  "/api/webhooks",
  // Webhook-registration management endpoints (list/create/delete). Their paths
  // contain /webhooks so the coverage parser classifies them as webhook routes;
  // they belong under webhookLimiter alongside the inbound receivers above.
  // Prefixes are kept narrow so only these exact routes are matched.
  "/api/clickup/workspaces/:workspaceId/webhooks",
  "/api/clickup/webhooks",
  "/api/comms/webhooks",
];

export const UPLOAD_PATHS: string[] = [
  "/api/feedback/upload-url",
  "/api/reports/import-pdf",
  "/api/webhooks/report-import",
  "/api/reports/:id/reimport",
  "/api/ats/parse-jd",
  "/api/ats/parse-scorecard",
  "/api/ats/candidates/:id/upload-resume",
  "/api/ats/portal/:token/video-upload-url",
  "/api/ats/portal/:token/submit-video",
  // ClickUp attachment uploads — both use multer (upload.single("file")); the
  // route-inventory parser detects the upload middleware and requires them
  // under uploadLimiter.
  "/api/clickup/tasks/:taskId/attachments",
  "/api/clickup/entity/:entityId/attachments",
  // Task #4023 — client file storage presigned mint + claim (POST-only
  // paths; the browser PUTs bytes directly to the signed URL, so these two
  // endpoints are the only upload-shaped requests that hit the app).
  "/api/clients/:clientId/files/upload-url",
  "/api/clients/:clientId/files/claim",
];

export const ADMIN_ONLY_PATHS: string[] = [
  "/api/ceo-pulses",
  "/api/webhook-import-logs",
  "/api/ceo-tools",
  // Task #1870 / #1898 — CEO-only list of soft-deleted users for the restore UI.
  "/api/users/deleted",
  // Task #1912 — CEO-only delete/restore audit timeline.
  "/api/users/delete-history",
  // Task #1950 / #1981 — CEO-only reassignment audit (outbound + inbound).
  "/api/users/reassign-history",
  // Task #2043 — CEO-only dry-run preview of the restored-fallback email cleanup.
  "/api/users/restored-email-cleanup/preview",
  // Task #2246 — CEO-only last-run status surface for the restored-fallback email cleanup.
  "/api/users/restored-email-cleanup/status",
  // Service Desk — CEO-only admin CRUD + setup/mapping endpoints (all guarded
  // by requireCeo). The route-inventory parser classifies these as admin_only
  // but they live outside the /api/admin prefix, so they need explicit mounts
  // to bring them under adminLimiter alongside their /api/admin neighbours.
  "/api/service-desk/setup",
  "/api/service-desk/eligibility",
  "/api/service-desk/tickets/needs-mapping",
  "/api/service-desk/tickets/:taskId/mapping",
  "/api/service-desk/tickets/:taskId/rerun-mapping",
  "/api/service-desk/tickets/:taskId/dismiss-mapping",
  // Task #5156 — CEO-only ClickUp role-projection configuration surface
  // (GET configuration, PUT destinations, PUT targets). All three routes are
  // requireCeo-gated. adminLimiter is method-safe (isMutating guard), so the
  // GET is skipped by adminLimiter automatically; the PUTs are throttled.
  "/api/service-desk/role-projections",
];

// Task #3829 — admin-classified surfaces that are READ-HEAVY dashboards or
// share a prefix with staff-facing GETs. adminLimiter's 30-req/15-min budget
// would break these UIs (the Ads OS dashboard alone fires ~10+ GETs per page
// load, and app.use mounts have no method filter), so they get the dedicated
// adminReadLimiter (300/15min, role-aware) instead. Their mutating siblings
// (POST run-audits, PUT criteria, …) remain throttled by writeLimiter.
export const ADMIN_READ_PATHS: string[] = [
  // Task #4644 — CEO analytics aggregate (GET only). Now requireCeo-gated, so
  // the coverage parser classifies it admin_only, but it lives outside the
  // /api/admin prefix and is a pure read surface.
  "/api/all-report-sections",
  // Service Desk mixed prefixes: GET is plain-authenticated (staff use these
  // to file tickets), only the mutations are requireCeo. A blanket
  // adminLimiter mount here would rate-limit every staff ticket form.
  "/api/service-desk/departments",
  "/api/service-desk/request-types",
  "/api/service-desk/config",
  // Ads OS — role-gated staff surface (Task #4977: read GETs are open to any
  // authenticated staff role via requireAccountManager; mutations and the
  // diagnostics lane stay requireCeo), and it lives outside the /api/admin
  // prefix. Read-heavy dashboards, so the whole surface stays under the
  // role-aware adminReadLimiter. Listed per top-level resource segment
  // (rather than a bare /api/ads-os prefix) so the internal cron endpoints
  // (/api/ads-os/cron/*, x-cron-key auth, no session) are NOT over-matched.
  "/api/ads-os/accounts",
  "/api/ads-os/audit",
  "/api/ads-os/budget-pacing",
  "/api/ads-os/clickup",
  "/api/ads-os/client",
  "/api/ads-os/clients",
  "/api/ads-os/combined",
  "/api/ads-os/dashboard",
  "/api/ads-os/directory",
  "/api/ads-os/health",
  "/api/ads-os/keyword-intel",
  // AM launch dashboard (GET board + POST refresh); read-heavy admin surface.
  "/api/ads-os/am",
  "/api/ads-os/lsa",
  "/api/ads-os/monitored-accounts",
  "/api/ads-os/proofs",
  "/api/ads-os/pyramid",
  "/api/ads-os/status",
  // CEO-only Paid Search Role Cutover preview and state reads. Keep this
  // narrow prefix under the role-aware read bucket without matching cron or
  // unrelated Ads OS traffic.
  "/api/ads-os/admin/paid-search-role-cutover",
  // Task #4334 — outbound-email admin surface (send log, counters,
  // suppressions, mailbox mapping, settings). Team-lead+ gated, read-heavy
  // dashboard GETs; mutations remain under writeLimiter.
  "/api/outbound-email",
  // Task #4335 — email sequences admin surface (sequence list + detail,
  // approval queue, enrollments, analytics, template library). The tabs
  // fire several GETs together on page load; mutations stay writeLimited.
  "/api/email-sequences",
  "/api/email-templates",
  // Task #4331 — deal stage automation admin surface (rules list, run
  // history, status poll). Team-lead+ gated; the rules/runs/status GETs
  // load together on the admin page.
  "/api/deal-automation",
  // settings fire together on each page load; team-lead gated reads).
  "/api/admin/sms-consent",
  // Book Operations is a bounded, team-lead-gated oversight dashboard. Its
  // repair siblings remain under exact sensitive-write mounts below.
  "/api/admin/book-operations",
];

export const SENSITIVE_WRITE_PATHS: string[] = [
  // Universal role assignment console mutations: client overrides, company
  // holders/defaults, bulk changes, and membership eligibility edits.
  "/api/admin/role-assignments",
  "/api/admin/blocked-ip-audit-retention",
  // Book-delivery operator actions can resend credentials or revoke paid
  // access. Keep the exact paths under the sensitive-write bucket without
  // throttling the read-heavy entitlement list that shares the prefix.
  "/api/admin/book-delivery/entitlements/:entitlementId/resend",
  "/api/admin/book-delivery/entitlements/:entitlementId/reissue",
  "/api/admin/book-delivery/entitlements/:entitlementId/revoke",
  "/api/admin/book-operations/payment-events/:paymentEventId/retry",
  "/api/admin/book-operations/outbox/:outboxId/replay",
  // Task #4611 — CEO-only Clerk restricted-signup enablement (coverage gap repaired during Task #4645 gate).
  "/api/admin/clerk/enable-restricted-signup",
  // Task #4336 — SMS consent: quiet-hours/kill-switch settings + manual state set.
  "/api/admin/sms-consent/settings",
  "/api/admin/sms-consent/manual",
  "/api/users/:id/role",
  // Task #1866 — CEO-only soft-delete of a user.
  "/api/users/:id",
  // Task #1870 — CEO-only restore of a soft-deleted user.
  "/api/users/:id/restore",
  "/api/clients/:clientId/stripe-link",
  "/api/integrations/stripe/connect",
  "/api/integrations/stripe/disconnect",
  "/api/integrations/pandadoc/connect",
  "/api/integrations/pandadoc/disconnect",
  "/api/integrations/slack/connect",
  "/api/integrations/slack/disconnect",
  "/api/integrations/ghl/connect",
  "/api/integrations/ghl/disconnect",
  "/api/integrations/front/disconnect",
  "/api/integrations/zoom/disconnect",
  "/api/integrations/google-calendar/disconnect",
  "/api/admin/rate-limit-multipliers",
  "/api/admin/rate-limit-multipliers/reset",
  "/api/admin/practice-area-settings",
  "/api/admin/practice-area-settings/:id",
  "/api/admin/phase-settings",
  "/api/admin/demo-report-setting",
  "/api/admin/locations/backfill-geocode",
  "/api/admin/migrate-product-types",
  "/api/admin/daily-judgments/run-all",
  "/api/admin/local-dominance/sync-all",
  "/api/health/block-ip",
  "/api/health/unblock-ip",
  "/api/health/rate-limits/auto-tune",
  "/api/health/rate-limits/auto-tune/run",
  "/api/health/rate-limits/apply-suggestion",
  "/api/health/rate-limits/thresholds",
  "/api/health/thresholds",
  "/api/health/thresholds/reset",
  // Task #4087 gate fix — the Zoom match-assistant mutations landed upstream
  // without SENSITIVE_WRITE_PATHS entries; the coverage suite was green-skipped
  // until this task touched agents.ts and re-executed it.
  "/api/admin/zoom/match-assistant/sweep",
  "/api/admin/zoom/match-assistant/calls/:id/assign",
  "/api/admin/zoom/match-assistant/calls/:id/reanalyze",
  "/api/admin/zoom/review-queue/:id/approve",
  "/api/admin/zoom/review-queue/:id/dismiss",
  "/api/admin/zoom/review-queue/:id/reopen",
  "/api/admin/zoom/review-queue/alert-settings",
  "/api/admin/zoom/review-queue/alert-settings/test",
  "/api/admin/match-settings",
  "/api/admin/audit-retention",
  "/api/admin/blocked-ip-audit-retention",
  // Task #1574 — these admin endpoints were previously invisible to the
  // route-inventory parser (multi-line `app.METHOD(` registrations). After
  // the parser fix in tests/route-inventory.ts they became visible to the
  // rate-limit-coverage test, which correctly flagged them as mutating
  // /api/admin/* routes without sensitiveWriteLimiter coverage. Adding
  // prefixes brings them under the same protection as their neighbours.
  "/api/admin/queue-control",
  "/api/admin/notifications",
  "/api/admin/twilio",
  "/api/admin/booking",
  "/api/admin/blocked-ip-trim-alert-config",
  "/api/admin/conversation-dedupe-conflicts",
  "/api/admin/client-contacts-audit-retention",
  "/api/admin/audit-prune-anomaly-config",
  "/api/admin/heatmap-coverage-check",
  "/api/admin/zoom/review-queue",
  // Task #1758 — operator dismisses the user-role backfill banner.
  "/api/admin/role-backfill-banner",
  // Task #1804 — CEO-only "Apply pending prod writes" panel.
  "/api/admin/prod-actions",
  "/api/admin/prod-actions/apply",
  // Task #2173 — CEO tunes the self-heal persistent-failure alert sensitivity.
  "/api/admin/prod-actions/failure-alert-threshold",
  "/api/twilio/admin/backfill-statuses",
  // Task #1643 — operator-triggered Front Analytics coverage refresh.
  "/api/admin/front/analytics-coverage",
  // Task #1695 — overnight aggressive-mode editor (PUT).
  "/api/admin/front/auto-closure/overnight",
  // Task #1885 — operator un-park for a parked Front recovery window.
  "/api/admin/front/auto-closure/unpark",
  // Task #2085 — operator re-arm of all parked windows under search strategy.
  "/api/admin/front/auto-closure/rearm",
  // Task #2098 — operator re-arm of a single parked window under search strategy.
  "/api/admin/front/auto-closure/rearm-one",
  // Task #1760 — operator-triggered regression-alert re-evaluation.
  "/api/admin/front/auto-closure/regression-alert-status/re-evaluate",
  // Task #1785 — SEMrush cadence settings cache reset.
  "/api/admin/semrush/cadence",
  // Task #2043 — CEO-only on-demand restored-fallback email cleanup trigger.
  "/api/users/restored-email-cleanup/run",
  // Task #3799 — Google Ads hygiene admin actions (CEO-only POSTs). Exact
  // paths rather than the /api/admin/google-ads-hygiene prefix because the
  // sibling GET dashboards (pacing/LSA/alerts list) poll frequently and must
  // not consume the 15-per-15-min sensitiveWrite bucket (app.use mounts have
  // no method filter).
  "/api/admin/google-ads-hygiene/:customerId/keyword-intel/run",
  "/api/admin/google-ads-hygiene/:customerId/alerts/compute",
  "/api/admin/google-ads-hygiene/alerts/:alertId/resolve",
  "/api/admin/google-ads-hygiene/alerts/:alertId/clickup",
  "/api/admin/google-ads-hygiene/alerts/:alertId/clickup/refresh",
  // Task #3799 — remaining uncovered sensitive writes flagged by
  // tests/rate-limit-coverage.test.ts: foundation audit run, ClickUp
  // integration disconnect (same policy as the other integration
  // disconnects above), and the CEO backup trigger.
  "/api/admin/google-ads-audit/:customerId/run",
  "/api/integrations/clickup/disconnect",
  "/api/admin/backups/run",
  // CEO-only Paid Search Role Cutover state mutation. The method-blind mount
  // is safe because sensitiveWriteLimiter skips GET/HEAD/OPTIONS.
  "/api/ads-os/admin/paid-search-role-cutover/state",
];

export const AUTH_LIMITER_PATHS: string[] = ["/api/login", "/api/callback"];

// Task #4041 — the public token-gated share-link download is the only
// unauthenticated client-file surface. Tokens are 256-bit random so guessing
// is infeasible, but without a per-IP limiter a hot-linked large file or a
// scripted scanner could consume bandwidth/DB work freely. shareFileLimiter
// is IP-keyed (no session exists on this surface) and mounted on the prefix
// in server/boot/httpApp.ts alongside the webhook/auth mounts.
export const SHARE_FILE_PATHS: string[] = ["/share/file"];

// ── Task #4788 — dedicated-bucket write routes ──────────────────────────────
// Mutating routes whose traffic is governed by a DEDICATED rate-limit bucket
// and therefore must NOT also drain the shared writeLimiter budget
// (60/15 min/user, role multipliers apply). Before this exemption these
// auto-fire writes double-counted: the comms presence heartbeat alone (POST
// every 25 s from every open tab) consumed 36 of the 60 slots per window,
// and typing indicators (~every 2 s while composing) plus sheets/docs
// autosave (~every 30 s) drained the rest — then every unrelated save
// (e.g. PUT /api/booking/me/availability/rules on the /profile Booking tab)
// got 429 "Too many write requests" for up to 15 minutes. Same precedent as
// the Task #944B webhook exemption in writeLimiter, made METHOD-aware
// because some paths have read/delete siblings that must stay write-limited
// (DELETE /api/sheets/workbooks/:id remains under writeLimiter while the
// PATCH autosave is exempt).
//
// Entries are "METHOD /path" strings; :params match any single segment;
// matching is exact segment-count (never prefix).
//
// tests/rate-limit-coverage.test.ts enforces BOTH directions of the pairing:
// every entry here must name a real route carrying its dedicated limiter,
// and every route carrying commsWriteLimiter / sheetsAutosaveLimiter must be
// listed here (no silent double-count regressions).

// Routes carrying commsWriteLimiter inline (category commsWrite, 60/min).
export const COMMS_WRITE_BUCKET_ROUTES: string[] = [
  "POST /api/comms/channels/:id/bookmarks",
  "PATCH /api/comms/channels/:id/bookmarks/:bId",
  "DELETE /api/comms/channels/:id/bookmarks/:bId",
  "PUT /api/comms/channels/:id/bookmarks/reorder",
  "PUT /api/comms/default-channels",
  "POST /api/comms/default-channels/apply-existing",
  "PUT /api/comms/channels/:id/draft",
  "POST /api/comms/channels/:id/scheduled-messages",
  "PATCH /api/comms/scheduled-messages/:id",
  "DELETE /api/comms/scheduled-messages/:id",
  "POST /api/comms/messages/:id/reminders",
  "DELETE /api/comms/reminders/:id",
  "POST /api/comms/messages/:id/forward",
  "POST /api/comms/channels/:id/typing",
  "POST /api/comms/messages/:id/reactions",
  "DELETE /api/comms/messages/:id/reactions/:emoji",
  "POST /api/comms/channels/:id/messages",
  "PATCH /api/comms/messages/:id",
  "DELETE /api/comms/messages/:id",
  "POST /api/comms/messages/:id/edit-history/:historyId/restore",
  "PUT /api/comms/status/me",
  "PUT /api/comms/status/me/custom",
  "POST /api/comms/presence/heartbeat",
  "PUT /api/comms/notification-settings",
];

// Routes carrying sheetsAutosaveLimiter inline (category sheetsAutosave,
// 200/15 min). The docs editor shares the same autosave limiter.
export const SHEETS_AUTOSAVE_BUCKET_ROUTES: string[] = [
  "PATCH /api/sheets/workbooks/:id",
  "PATCH /api/docs/documents/:id",
];

// Mutations already governed by the background_polling bucket: the paths in
// BACKGROUND_POLLING_PATHS (server/boot/httpApp.ts, Task #2880) are mounted
// method-blind via app.use, so the activity telemetry flush POST rides that
// bucket (120/15 min) and its tracker today - the shared write bucket was a
// pure double count.
export const BACKGROUND_POLLING_BUCKET_WRITE_ROUTES: string[] = [
  "POST /api/activity",
];

export const DEDICATED_BUCKET_WRITE_ROUTES: string[] = [
  ...COMMS_WRITE_BUCKET_ROUTES,
  ...SHEETS_AUTOSAVE_BUCKET_ROUTES,
  ...BACKGROUND_POLLING_BUCKET_WRITE_ROUTES,
];

function splitSegs(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

export function pathPrefixMatches(mountPath: string, routePath: string): boolean {
  const mountSegs = splitSegs(mountPath);
  const routeSegs = splitSegs(routePath);
  if (routeSegs.length < mountSegs.length) return false;
  for (let i = 0; i < mountSegs.length; i++) {
    const m = mountSegs[i];
    const r = routeSegs[i];
    if (m.startsWith(":") || r.startsWith(":")) continue;
    if (m !== r) return false;
  }
  return true;
}

function matchesAny(paths: string[], routePath: string): boolean {
  return paths.some((p) => pathPrefixMatches(p, routePath));
}

// Task #4788 — exact (non-prefix) "METHOD /path" matcher for the
// dedicated-bucket write exemption. Segment counts must be equal and a
// `:param` on either side matches any single segment, so the matcher works
// both for runtime URLs (concrete ids) and for route patterns
// (computeLimitersForRoute passes `:id`-style paths).
function methodPathMatches(entry: string, method: string, urlPath: string): boolean {
  const spaceIdx = entry.indexOf(" ");
  if (spaceIdx <= 0) return false;
  if (entry.slice(0, spaceIdx) !== method) return false;
  const entrySegs = splitSegs(entry.slice(spaceIdx + 1));
  const pathSegs = splitSegs(urlPath);
  if (entrySegs.length !== pathSegs.length) return false;
  for (let i = 0; i < entrySegs.length; i++) {
    const e = entrySegs[i];
    const p = pathSegs[i];
    if (e.startsWith(":") || p.startsWith(":")) continue;
    if (e !== p) return false;
  }
  return true;
}

export function isDedicatedBucketWriteRoute(method: string, url: string): boolean {
  const path = url.split("?")[0];
  const m = method.toUpperCase();
  return DEDICATED_BUCKET_WRITE_ROUTES.some((entry) => methodPathMatches(entry, m, path));
}

export interface RouteLimiterInfo {
  limiters: string[];
  notes: string[];
}

export function computeLimitersForRoute(
  method: string,
  routePath: string,
  inlineLimiter?: string | null,
): RouteLimiterInfo {
  const limiters: string[] = [];
  const notes: string[] = [];
  const m = method.toUpperCase();
  const isMutating = m !== "GET" && m !== "HEAD" && m !== "OPTIONS";

  const isHealth = routePath === "/api/health";
  const isWebhook = matchesAny(WEBHOOK_PATHS, routePath);

  if (routePath.startsWith("/api") && !isHealth && !isWebhook) {
    limiters.push("apiLimiter");
  }

  if (matchesAny(AUTH_LIMITER_PATHS, routePath)) {
    limiters.push("authLimiter");
  }

  if (isWebhook) {
    limiters.push("webhookLimiter");
  }

  // Task #4788 — mutations governed by a dedicated bucket (commsWrite,
  // sheetsAutosave, background_polling) are skipped by writeLimiter so they
  // cannot drain the shared 60/15min write budget.
  const isDedicatedBucketWrite = isMutating && isDedicatedBucketWriteRoute(m, routePath);

  if (routePath.startsWith("/api") && isMutating && !isDedicatedBucketWrite) {
    limiters.push("writeLimiter");
  }

  // Task #3853 — adminLimiter and sensitiveWriteLimiter skip GET/HEAD/OPTIONS
  // (mutations only), so read-only routes under their mounts are not limited
  // by them even though the app.use mount path matches.
  const isAdminMounted =
    pathPrefixMatches("/api/admin", routePath) || matchesAny(ADMIN_ONLY_PATHS, routePath);
  if (isAdminMounted && isMutating) {
    limiters.push("adminLimiter");
  }

  if (matchesAny(ADMIN_READ_PATHS, routePath)) {
    limiters.push("adminReadLimiter");
  }

  if (matchesAny(UPLOAD_PATHS, routePath)) {
    limiters.push("uploadLimiter");
  }

  const isSensitiveWriteMounted = matchesAny(SENSITIVE_WRITE_PATHS, routePath);
  if (isSensitiveWriteMounted && isMutating) {
    limiters.push("sensitiveWriteLimiter");
  }

  // Task #4041 — public share-link downloads get their own IP-keyed bucket.
  if (matchesAny(SHARE_FILE_PATHS, routePath)) {
    limiters.push("shareFileLimiter");
  }

  if (inlineLimiter && !limiters.includes(inlineLimiter)) {
    limiters.push(inlineLimiter);
  }

  if (isHealth) notes.push("Skipped by apiLimiter (health check)");
  if (isDedicatedBucketWrite && routePath.startsWith("/api"))
    notes.push("Skipped by writeLimiter (dedicated-bucket write route)");
  if (!isMutating && routePath.startsWith("/api")) notes.push("Skipped by writeLimiter (read-only method)");
  if (!isMutating && isAdminMounted) notes.push("Skipped by adminLimiter (read-only method)");
  if (!isMutating && isSensitiveWriteMounted) notes.push("Skipped by sensitiveWriteLimiter (read-only method)");

  return { limiters: Array.from(new Set(limiters)), notes };
}
