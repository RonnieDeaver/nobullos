# External-Call Audit & DB-Hold Trends (Pool Epic Phase 1.5)

Operator runbook for the audit surface shipped by Task #1728.

## Surfaces

| Surface | Purpose | Gated by |
| --- | --- | --- |
| `external_call_audits` table | Per-call audit of outbound integration requests (hashes only). | `external_call_audit_enabled` |
| `external_call_audit_daily_rollups` table | Per-day aggregate populated by an hourly `workerDb` rollup. | `external_call_audit_enabled` |
| `db_hold_label_rollups` table | Per-day aggregate of `pool_state_samples.top_hold_labels`. | `db_hold_rollup_enabled` |
| `/admin/db-attribution/trends` | Admin page with 8 panels reading the rollups. | `team_lead` role |

## Hard redaction rules

The audit wrapper (`server/services/externalCallAudit.ts`) **never** persists:

- Authorization headers or bearer / OAuth tokens
- Request bodies or query-string values containing secrets
- Raw response bodies
- PII payloads (call transcripts, email bodies, etc.)

Stored fields are limited to: integration name, endpoint path (query string
stripped), method, status code, duration, response **size** (bytes) and
sha-256 **hash** (truncated to 64 hex chars), cache-hit flag, caller label
(from `getCurrentDbHoldLabel()`), error class, and a sha-256 dedupe key
hashed from `integration|method|endpoint|sortedParams`.

If you add a new wrapper site, do **not** pass the response body or any
header into `auditOutboundCall` — only its hash/size.

## Wired integrations

`auditOutboundCall` is currently invoked from:

- `server/services/semrushApi.ts` — `apiGetInner`
- `server/services/frontIntegration.ts` — `frontApiRequest` (top-level
  attempts only; retries reuse the same audit row)
- `server/services/zoomIntegration.ts` — `zoomApiRequest` and
  `zoomApiRequestWithBody`
- `server/services/ghlIntegration.ts` — private-token GHL API boundary

### ClickUp role projection boundary (Task #5156)

The ClickUp role projection worker (`clickup_role_projection` queue, `handleClickUpRoleProjectionJob`)
makes outbound calls to the ClickUp API to set People custom-field values on tasks/lists.
These calls are made from `server/services/clickUpRoleProjectionClient.ts` via `cuProjectionCall`.

The projection client enforces hard redaction — no token, body, or raw vendor response
is ever stored or logged. The `lastError` field on `cu_role_projection_commands` stores only
a bounded (2000-char) safe message extracted from the classified error, never the raw HTTP body.
The `/api/service-desk/role-projections/status` route additionally truncates `lastError` to
500 characters before returning it to the UI.

`auditOutboundCall` is NOT yet wired to the projection worker calls (the projection client
is a background worker path, not a request-scoped route). Adding it follows the standard pattern:

```ts
import { auditOutboundCall } from "./externalCallAudit";
// wrap cuProjectionCall's fetch boundary
```

This is deferred until the projection lane is promoted to production.

These cover the high-volume outbound paths. Adding a new integration is
two lines:

```ts
import { auditOutboundCall } from "./externalCallAudit";

return auditOutboundCall(
  { integration: "openai", endpoint: "/chat/completions", method: "POST" },
  async () => {
    const res = await openai.chat.completions.create(args);
    const json = JSON.stringify(res);
    return {
      value: res,
      statusCode: 200,
      responseSizeBytes: Buffer.byteLength(json, "utf8"),
      responseHash: sha256(json).slice(0, 64),
    };
  },
);
```

## Kill switches

Both switches default to `false`. Writes (and the admin panels) only
populate once the operator flips them:

```sql
UPDATE system_settings SET value = 'true' WHERE key = 'external_call_audit_enabled';
UPDATE system_settings SET value = 'true' WHERE key = 'db_hold_rollup_enabled';
```

Disable by setting the value back to `'false'`. The audit buffer flushes
on a 10-second cadence and the rollups run hourly; toggle takes effect on
the next tick.

## Retention

- Raw `external_call_audits` rows are pruned after **14 days**.
- Both rollup tables are pruned after **90 days**.

Pruning runs once per day on `workerDb` (`maintenance:pool-audit-rollup-prune`
attribution label).

## Reading the admin trends page

Each of the 8 panels is independent — empty panels just mean the
corresponding switch is off or there is no qualifying data yet.

1. **Top DB hold labels — today.** Highest total hold time per label
   (UTC). Use this to find what's pinning connections right now.
2. **Week-over-week movers.** New regressions. A row with `Δ total`
   in the red is a label that used the API pool measurably more this
   week than last.
3. **Longest max holds (7d).** Single worst hold per label. A row here
   ≥ 30s is a strong candidate for query-budget tightening.
4. **Labels exceeding 10s (7d).** Hard threshold view — anything in
   this panel is degrading p95 latency for whichever pool it lives on.
5. **Background work on API pool (7d).** Attribution-leak detector.
   Any worker/maintenance label that shows up under `pool = api` is
   pulling from the request-serving pool and should be moved to
   `workerDb` (or wrapped in the correct attribution scope).
6. **External call volume (7d).** Per-integration totals. The
   `cache hit` and `same-resp` columns surface integrations that are
   making identical repeated calls — these are caching opportunities.
7. **Noisiest external endpoints (7d).** Endpoint-level detail for
   panel 6. High `same-resp` here is the same call producing the
   identical hash repeatedly — wrap with an in-process cache or a
   `system_settings`-backed memo.
8. **Front recovery backoff frequency (24h).** Live audit-table query.
   A spike in `calls 1h` while `429s` is also climbing means the
   recovery worker is in a tight backoff loop — flip the Front
   recovery kill switch or extend the backoff window.

The page also renders several **always-visible** panels that do not
depend on the Phase 0 switches (Front warp throughput, apply-layer
drops, parked windows, and the items below). These read live in-memory
or cheap on-demand state, so they populate immediately.

- **Front email mirror health (Task #2171).** Always-visible health
  card for the `front_sync_emails` mirror. It compares the mirror's
  newest row (`MAX(created_at)`) against live Front webhook intake
  (`MAX(received_at)` on `source_event_log` where
  `source_system='front'`), shows the computed lag, the writer kill
  switch state, and a `Fresh` / `Frozen` / `No traffic` verdict. The
  numbers come from the same `evaluateFrontMirrorFreshness` core the
  Task #2146 background watcher and the Task #2172 auto-recovery
  prod-action use, so the panel and the alert can never disagree. Use
  it to confirm mirror health proactively (and after a fix) instead of
  waiting for the next alert tick. `Frozen` = webhooks arriving but the
  mirror writer has stopped inserting rows (writer disabled or broken);
  `No traffic` = no fresh Front webhooks, so lag can't be judged.

## Operational impact

When both switches are **off** (default):

- The wrapper short-circuits with zero allocations.
- No DB writes occur.
- The admin trends page renders empty panels with explanatory copy.

When both switches are **on**:

- Each outbound call adds a single in-memory record (~250 bytes).
- The flusher batches up to 500 inserts every 10s on `workerDb`.
- The hourly rollup tick processes today + yesterday only.
- Buffer is capped at 5,000 records; surplus is dropped with a
  rate-limited warning log.

If buffer-drop warnings appear, raise the flush cadence or the batch
size in `server/services/externalCallAudit.ts` before enabling more
integrations.
