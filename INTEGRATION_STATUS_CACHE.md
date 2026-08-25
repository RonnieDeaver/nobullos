# Integration Status Cache & Boot Prewarm

Operator runbook for the Integrations Hub badge cache
(`server/services/integrationStatusCache.ts`), the shared probe loaders
(`server/services/integrationStatusLoaders.ts`), and the boot-time
prewarm (Task #3341).

## How badges get their status

- `/api/integrations/all-status` never awaits an upstream probe. It reads
  per-integration cache entries and kicks background refreshes when an
  entry is missing or older than its fresh-TTL (60 s healthy / 15 s after
  a real disconnect).
- Cache layers: per-process memory first, best-effort Redis
  (`nobull:<env>:integration_status:*`, TTL 300 s) for cross-instance
  hydration, plus a Redis epoch key for cross-instance invalidation.
- Probe outcomes (Task #1861): `connected` / `unauthorized` commit;
  `probe_failed` preserves the last-known value — a transient blip never
  paints "Not Connected". A cold cache returns `value: null` and the UI
  renders "Checking…".

## Shared loaders (drift guard)

The Front, Zoom, Google Ads, and HighLevel loaders live in
`server/services/integrationStatusLoaders.ts`; SEMrush ships its own
shared `semrushCachedProbeLoader`. The route and the boot prewarm MUST
invoke these identical loaders for the identical cache keys — enforced by
`tests/integration-status-prewarm.test.ts` (in the SMOKE_FILES gate). If
you add a badge that should prewarm, extract its loader into the shared
module and add its key to `PREWARM_INTEGRATIONS`.

## Boot prewarm (Task #3341)

After the env-namespace fix (Task #3338), the prod
`nobull:prod:integration_status:*` namespace starts empty on every
deploy, so the first admin poll after a rolling restart painted
"Checking…" until each probe landed — and autoscale instances disagreed
until each one warmed independently.

`prewarmCriticalIntegrationStatuses()` fires the critical probes
(Front, Zoom, SEMrush, Slack, PandaDoc, Stripe, Twilio, and HighLevel) at
process boot:

- Runs in the async bootstrap of `server/index.ts`, immediately AFTER the
  awaited `flushEnvNamespacesOnBoot()` (ordering matters — the flush must
  not wipe fresh prewarm writes).
- Deployment-gated via `isRunningInDeployment()`. The dev workspace
  restarts constantly and its probes would add churn against live
  provider APIs; force-enable in dev with
  `INTEGRATION_STATUS_PREWARM_FORCE_ENABLE=1`.
- Goes through `getCachedIntegrationStatus()` — single-flight, worker DB
  pool, preserve semantics, and Redis commit all apply. A warm Redis peer
  value (previous deploy generation within the 300 s TTL, or a sibling
  instance) short-circuits the probe entirely.
- Fail-soft: never blocks bootstrap, never throws.

## Measured "Checking…" window

Measured Jul 20 2026 (dev workspace, force-enabled, cold Redis):

| Integration | Prewarm call → committed cache value |
| --- | --- |
| SEMrush | ~0.3 s |
| Google Ads | ~0.5 s |
| Front | ~1.0 s |
| Zoom | ~2.0 s (includes an OAuth refresh round-trip) |

The prewarm kick itself is ~10 ms; probes run in parallel in the
background. On redeploy the expected worst-case "Checking…" window is
therefore **probe latency (~1–3 s) after the instance boots**, instead of
the previous "first admin poll + probe round-trip" (up to ~60 s of
mixed/inconsistent badges across the fleet). New autoscale peers booting
later than the first instance hydrate directly from the Redis value
(≤300 s old) and typically show real status on their very first poll.

## Troubleshooting

- **Badges stuck "Checking…" after a deploy**: check deployment logs for
  `[IntegrationStatusPrewarm]`. If absent, the prewarm didn't run
  (gating); if present but values never commit, the probes are returning
  `preserve` (transient upstream failure) — see the integration's own
  runbook/breaker.
- **One instance disagrees with another**: epoch propagation is debounced
  ~2 s per key; disagreement beyond one 5 s poll interval usually means
  Redis is disabled (`redis_cache_enabled` kill switch) or unreachable —
  each instance then probes independently.
