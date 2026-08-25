# Request Observability — access log, request IDs, route metrics, error spine (Task #3816)

App-wide "golden signals" layer: one structured access-log line per API request, an `X-Request-Id` on every response, rolling per-route latency/error stats in the System Health Console, a sustained-regression alert, and one global JSON error middleware.

## Request IDs

- Every request gets a 16-hex request ID (`server/observability/requestContext.ts`), echoed on the response as `X-Request-Id`. A well-formed inbound `X-Request-Id` (`[A-Za-z0-9._-]{4,128}`) is honored; anything else is replaced.
- The ID rides an `AsyncLocalStorage` context — `getCurrentRequestId()` works anywhere downstream of the middleware (used by the global error handler and the FATAL process guards).
- **Debugging flow:** user screenshot/report → take the `requestId` from the error JSON (or `X-Request-Id` header) → grep server logs for `rid=<id>`.

## Access log (`server/observability/accessLog.ts`)

- One line per completed API request via the `[api]` source: `GET /api/foo 200 in 12ms rid=… route=… role=… uid=…`.
- Only `/api/*` is logged/measured. Elision: high-frequency health/polling routes are sampled 1-in-20 (`ELIDED_SAMPLE_EVERY_N`, logged with `sampled=1/20`); every request still feeds metrics. Any response ≥400 or ≥1500ms (`SLOW_ALWAYS_LOG_MS`) always logs.

## Route metrics + Health Console panel

- In-process ring buffers per `METHOD /route/:param` key (`server/services/requestMetrics.ts`): rolling p50/p95/max/avg, 4xx/5xx counts. Per instance; resets on restart.
- API: `GET /api/health/request-metrics?windowMs=&limit=&includeHistory=1` (authenticated) → summary + alert snapshot (effective config + breaching routes) + persistence info.
- UI: System Health Console → **API Route Metrics** card (`/admin/health`), tabs By Traffic / By p95 / By 5xx, breaching list on top.
- Persistence: every 5 min the flusher writes top-60 route windows + `_ALL_` to `api_route_stats_windows` (14d retention) for post-hoc analysis.

## Sustained-regression alert

- `server/services/requestMetricsAlerts.ts` evaluates every 60s (first eval 90s after boot): a route breaches when `count ≥ minCount` AND (5xx rate > `errorRatePct`, else p95 > `p95Ms`); after `consecutiveBreaches` consecutive breaching evaluations it dispatches `infra.api.route_regression` via `notifyByType` with dedupe key `api_route_regression:<route>` (dispatcher owns dedupe/6h reminders + admin in-app mirror). Recovery calls `markRecovered` (also when traffic stops).
- Config: `system_settings.request_metrics_alert_config` (JSON over defaults `{enabled:true, windowMs:600000, p95Ms:2500, errorRatePct:20, minCount:30, consecutiveBreaches:3}`). Write it via `setSystemSetting` (raw SQL skips cache invalidation; settings reads cache misses for 300s). Honors the `non_critical_sweeps` kill switch.

## Error spine (`server/observability/httpErrors.ts`)

- Global error middleware returns `{message, error, code, requestId, details?}`; 5xx messages are always `"Internal Server Error"` (no internals leak) and log `[Global Error] rid=… route=… status=… code=…`.
- New/migrated routes: throw `HttpError(status, message, code?, details?)` or just throw — and wrap handlers in `asyncHandler(fn, legacyErrorToken?)`. The second arg preserves a router's legacy `error` token byte-for-byte (response-contract compatibility); migrated examples: `server/routes/userNotifications.ts`, `server/routes/activity.ts`.

## Ops notes

- Schedulers start in `registerRoutes` but are **skipped under `NODE_ENV=test` / `TEST_SMOKE`** (suites booting routes must not flush windows or fire real alerts).
- Dev-only synthetic routes for end-to-end verification: `GET /api/_internal/obs-demo/slow?ms=` and `GET /api/_internal/obs-demo/error[?kind=http]`.
- In dev, dispatches record `skipped_no_channel` in `notification_deliveries` (no Slack channel mapped) — same as every other infra alert; the admin in-app mirror still delivers.
