# Production Remediation Runbook

Operator playbook for the four issues surfaced by the May 18 2026 production read-only inspection. Each section is self-contained and idempotent — re-running the steps when conditions are already good is safe.

Sourced from Task #1602.

---

## 1. P0 — Front webhook intake stall

### Symptom

`front_webhook_normalize` and/or `front_webhook_apply` `pending` count grows day over day, oldest pending age grows, and the in-app Front integration "Last sync" age grows. Internal evidence: `source_event_log` has no new `source_system='front'` rows for many minutes/hours.

### Quick check (read-only)

```sh
npx tsx scripts/check-front-webhook-receiver.ts
```

The script prints, against the dev workspace DB by default. To inspect production, pass `--print-sql` to dump the exact queries and paste them into the read-only prod SQL tool (which the script cannot connect to directly).

- last `source_event_log` Front receive time + count in last 1h / 24h
- last `front_webhook_normalize` enqueue + completion counts
- pending backlog age for both `front_webhook_normalize` and `front_webhook_apply`

**If `last received` is more than ~30 min ago during business hours**, the receiver/upstream is stalled, not the worker. Proceed to recovery.

### Recovery — receiver/upstream is stalled

The drainer chain is healthy as long as `front_webhook_apply` rows continue to complete; this means Front itself stopped delivering. Run, in order:

1. **Check Front's webhook delivery log.** Front dashboard → Settings → Developers → Webhooks → `nobull-os` (or whatever the integration is named) → Recent deliveries. Look for delivery failures, 4xx/5xx responses, or "Webhook disabled by Front" notices.
2. **Verify the webhook target URL is correct.** It must point at the current production hostname `/api/integrations/front/webhook` and use HTTPS.
3. **Verify the webhook is still enabled.** Front auto-disables webhooks after sustained delivery failures.
4. **Verify event subscriptions.** Required event types must include `conversation` and `message` events. If subscriptions were silently narrowed, re-enable them.
5. **Verify the webhook secret matches.** There is **no admin UI field or `system_settings` key** for this — the only mechanism is the `FRONT_WEBHOOK_SECRET` environment secret, and deployments snapshot secrets at publish time, so changing it requires a republish. The Front side is an **OAuth app**, so the secret is the **app signing secret** from Front's Developer settings (application-webhook signing), not a per-webhook secret.

   **Prerequisite — receiver fix must land first.** Our current receiver verifies an HMAC over the raw body only, while Front application webhooks sign `{x-front-request-timestamp}:{rawBody}` and validate the URL via an `x-front-challenge` header echo. Until the receiver is rewritten to match Front's real scheme (see the receiver-fix follow-up task), leave `FRONT_WEBHOOK_SECRET` **unset** — setting it earlier makes the integration look configured while deliveries remain impossible.

   Once the receiver fix is deployed, the sequence is:
   1. Copy the app signing secret from Front → Settings → Developers → the OAuth app.
   2. Set `FRONT_WEBHOOK_SECRET` via the workspace secrets manager (both workspace and production/deployment stores).
   3. **Republish** the app so the deployment picks up the new secret.
   4. Re-save the webhook URL in Front so Front re-runs its save-time validation against the fixed receiver.
   5. Verify ingestion: watch `source_event_log` for new `front:webhook:*` rows within ~5 min.
6. **Send a manual test event.** Front dashboard → the webhook → "Send test event". Re-run the quick check above; a new `source_event_log` row should appear immediately.

### Recovery — receiver is fine but worker isn't draining

Only relevant if the quick check shows new Front rows arriving but `front_webhook_normalize` pending is still growing. Check:

- `system_settings.queue_drain_state` for a `front_webhook_normalize` pause (`scripts/queue-drain-status.ts`). If paused, resume with the queue-drain admin UI or the existing `setQueuePause` helper.
- Worker logs for `[work-queue] handler not registered for queue front_webhook_normalize`. If present, scheduler boot order is broken (handlers are registered in `server/services/workQueueHandlers.ts`; see Task #1602 plan for verification).
- Stuck leases: rows with `status='processing'` and `leased_at` older than the lease TTL. The existing `recoverStuckLeases` worker handles this; if it isn't running, restart the app.

---

## 2. P1 — `background_ingestion_saturation_window` alert dispatching fails 100+ times/hour

### Symptom

`manual_reserve_alert_dispatches` shows a flood of `status='failed'` rows with `error_message LIKE '%Slack API error: invalid_auth%'` (or `token_revoked`, `account_inactive`, etc.).

### Why it now stops by itself

Task #1602 added an **auth circuit breaker** in `server/services/slackIntegration.ts`. When any Slack API call returns a terminal auth error (`invalid_auth` / `not_authed` / `account_inactive` / `token_revoked` / `token_expired` / `invalid_token` / `missing_scope` / `no_permission`), the breaker trips for 5 minutes. During the cooldown:

- All `slackApi*` calls short-circuit without hitting the network.
- `isConnected()` returns `false`, so alert pipelines record `not_configured` ("Slack integration not connected") instead of `failed`.
- One throttled log line (`[Slack] Auth breaker tripped (...)`) is emitted per cooldown window.

This caps the noise at ~12 events/hour per metric instead of ~60.

### Real recovery — operator must re-auth Slack

The breaker stops the spam; it does **not** repair the token. Do this:

1. Confirm the failure mode: in the app, **Admin → Integrations → Slack → "Test connection"**. A red "invalid_auth" / "token_revoked" / "account_inactive" message confirms the token is dead.
2. Generate a new bot token:
   - api.slack.com → your app → OAuth & Permissions → "Reinstall to Workspace" (re-issues the bot token).
   - Copy the new `xoxb-…` token.
3. Paste it into **Admin → Integrations → Slack → "Bot Token"** and save. This calls `setToken()` which writes `system_settings.slack_bot_token`.
4. Click **"Test connection"** again. A green checkmark confirms `auth.test` succeeded, which **also clears the breaker in-memory** — no restart needed.
5. Watch `manual_reserve_alert_dispatches` for the next minute. New rows should be `status='sent'`.

### If you intentionally want Slack alerts off

Don't leave a revoked token in place. Either:

- Clear the token: **Admin → Integrations → Slack → "Disconnect"** (calls `disconnect()` which writes an empty `slack_bot_token`). Subsequent dispatches record `not_configured`, not `failed`.
- Or mute the specific noisy metric: set `manual_reserve_alert_mute` in `system_settings` per the existing mute workflow (`server/services/manualReserveAlerts.ts`, search `loadMuteState`). Include a `mute_reason`, `muted_by`, and `review_after`.

---

### Sustained-breaker watcher (Task #1610)

The breaker stops *call-side* noise. To make sure operators are paged when the breaker keeps tripping forever (e.g. nobody re-auths Slack), a watcher in `server/services/slackAuthBreakerStuckAlerts.ts` runs every 5 min and reads `getSlackAuthState()`. It does **not** touch breaker control flow.

Two notifications are dispatched via `notifyByType`:

- `pipeline.slack_auth.breaker_stuck` — fires once per cooldown window when the breaker has been open / Slack auth has been failing longer than the configured threshold. While the breaker is open, Slack delivery of this alert will record `not_configured`; the real delivery channels for this alert are email + in-app.
- `pipeline.slack_auth.breaker_recovered` — fires exactly once after a stuck alert, once Slack has had a successful call (incl. `auth.test`).

`system_settings` keys (all optional — defaults shown):

| Key | Default | Effect |
| --- | --- | --- |
| `slack_auth_breaker_alerts_enabled` | `true` | Master kill switch for both stuck + recovered alerts. |
| `slack_auth_breaker_stuck_threshold_minutes` | `30` | Minimum minutes-since-last-successful-Slack-call before the stuck alert fires. |
| `slack_auth_breaker_stuck_cooldown_minutes` | `360` | Minimum minutes between repeated stuck alerts for the same stuck period. |

A dispatcher-skip (Slack disconnected, kill switch off, etc.) intentionally does **not** arm the cooldown — the next tick after the notification subsystem recovers can still deliver the alert.

---

## 3. P2 — Enable `pg_stat_statements` on production

### Symptom

`SELECT * FROM pg_stat_statements LIMIT 1` on the prod read-only SQL tool fails with `relation "pg_stat_statements" does not exist`.

### Why we can't auto-fix this

The read-only prod SQL tool used by Replit Agent and audit tooling is read-only by design — it cannot run `CREATE EXTENSION`. The deployed app role (`neondb_owner`) can. Neon already has `pg_stat_statements` in `shared_preload_libraries`, so this is a one-line `CREATE EXTENSION`, not a control-plane toggle.

### Dev workspace: mirror the extension's catalog row (May 2026 update)

**Current rule:** install `pg_stat_statements` on dev too, with the explicit `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` one-shot below.

**Why this reverses the original Task #1814 guidance:** Task #1814 dropped the catalog row on dev to stop a `CREATE VIEW pg_stat_statements_info` migration the prod deploy couldn't apply (dev had it, prod didn't). After the prod side of step 3 ran (the `create_pg_stat_statements_extension` CEO action installed the extension on `neondb`), the situation flipped: prod has the extension-owned view, dev doesn't, and Replit's deploy-time schema differ generated the **inverse** failure — `DROP VIEW public.pg_stat_statements_info — cannot drop view ... because extension pg_stat_statements requires it`. Replit's deploy differ compares live dev vs. live prod schemas, NOT the drizzle source, so the `drizzle.config.ts tablesFilter` (still in place, still useful for drizzle-kit) does not protect this path. The fix is to make both sides match again — by mirroring the catalog row on dev. The views on Helium will be non-functional (Helium's `shared_preload_libraries = timescaledb,helium` doesn't preload the underlying functions, so `SELECT * FROM pg_stat_statements` errors with "must be loaded via shared_preload_libraries"), but nothing on dev queries them — Task #1724's regression scan is graceful when the extension is missing AND when the underlying functions error.

**One-shot dev mirror:**

```bash
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
```

Verify on dev:

```sql
SELECT extname FROM pg_extension WHERE extname='pg_stat_statements';
SELECT relname FROM pg_class WHERE relname IN ('pg_stat_statements','pg_stat_statements_info') AND relnamespace = 'public'::regnamespace;
```

Run this whenever a fresh dev workspace is provisioned (the catalog row does not survive a wipe).

**CEO panel safety:** The `create_pg_stat_statements_extension` CEO registry action (`server/services/prodActionsRegistry.ts`) keeps its `clusterPreloadsPgStatStatements()` guard — it still refuses to install via the CEO panel on Helium because that path is meant for prod-Neon-like targets where the extension is functional. The deliberate dev mirror is created by the explicit `psql` one-shot above, not the CEO panel.

### One-time operator step

Connect to prod as `neondb_owner` (e.g. via the Neon console SQL editor or a `psql` shell against prod `DATABASE_URL`) and run:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Verify:

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_stat_statements';
-- expected: pg_stat_statements | 1.10
```

The read-only SQL tool already has `SELECT` permission on system catalogs, so no GRANT is needed afterwards.

### Query cookbook (run via the read-only prod SQL tool after enablement)

```sql
-- Top 20 queries by total runtime
SELECT LEFT(query, 120) AS query, calls, total_exec_time, mean_exec_time, rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;

-- Top 20 by mean runtime (slow individual statements)
SELECT LEFT(query, 120) AS query, calls, mean_exec_time, max_exec_time, rows
FROM pg_stat_statements
WHERE calls > 10
ORDER BY mean_exec_time DESC
LIMIT 20;

-- Top 20 by call volume (hot path candidates for caching)
SELECT LEFT(query, 120) AS query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 20;

-- Reset the stats baseline (after a deploy or before an experiment)
SELECT pg_stat_statements_reset();
```

Postgres 16 uses `total_exec_time` / `mean_exec_time` / `max_exec_time` (the `_exec_` variants), not the PG ≤12 column names — the snippets above already account for that.

---

## 3a. Neon Cold-Start Auth Timeout During Bootstrap

### Symptom

A fresh autoscale container emits one or more warn lines on startup:

```
[Bootstrap] transient DB error during durable_pipeline_tables — retry 1/5 in 1000ms: 08P01 Authentication timed out
```

If retries exhaust, the process exits with:

```
[Bootstrap] FATAL: durable_pipeline_tables failed after 5 retries — process will exit: <error>
command finished with error [node ./dist/index.cjs]: exit status 1
```

The same shape applies to the other two guarded bootstrap steps:
`external_source_id_unique` and `scheduler_start`.

### Meaning

A small number of `[Bootstrap] transient DB error during ...` lines during deploy is almost always Neon being slow to hand out the first DB connection to a fresh autoscale container — the API pool's `pool.connect()` call exceeds its acquire timeout and surfaces a transient code such as `08P01` ("Authentication timed out"), `08006`, or `08001`. Task #1630 makes the three bootstrap gates (`durable_pipeline_tables`, `external_source_id_unique`, `scheduler_start`) tolerate up to 5 retries with exponential backoff (`1s → 2s → 4s → 8s → 16s`, ~31 s worst-case wall time) before treating the failure as fatal. Structural errors — missing tables, syntax errors, permission denied, schema drift — are NOT retried and still fail fast on the first attempt.

### Operator action when retries succeed

None. The process self-recovered. The warn lines are informational only and do not indicate a deploy or schema problem.

### Operator action when retries exhaust 5 times

Before manually restarting:

1. Check the Neon status page (https://neonstatus.com) for an active incident.
2. Confirm the production DB is reachable — open Admin → Health, or run a `SELECT 1` against the read-only prod SQL tool.
3. Skim the deploy logs immediately before the FATAL line: a non-transient PG code (e.g. `42P01`, `42703`, `42501`) means it was a schema / permission problem from the start, not a Neon cold-start blip, and a redeploy will not fix it.

### Escalation triggers

- A `[Bootstrap] FATAL: <step> failed after 5 retries` line appears.
- The container crash-loops across multiple autoscale restarts (more than 2–3 within ~5 minutes).
- Neon status page shows an active incident.
- The app remains unavailable for more than ~5 minutes after the most recent restart.

---

## 4. P2 — Documentation: provider drift

See `audits/G-docs-findings.md` § 2 finding **G-011** for the full evidence trail. Short version: `replit.md` previously stated the deployed app runs on Helium 16.10; it actually runs on **Neon 16.12 on `neondb`** (the workspace dev DB *is* Helium 16.10, but that's only the dev environment). The Runtime Truth Table in `replit.md` now splits dev vs. prod rows.

If you change the database provider (e.g. migrate prod off Neon), update both `replit.md` § "Runtime Truth Table" and `audits/G-docs-findings.md` § 1 in the same PR.

---

## Appendix — verifying everything is good after a remediation

```sh
# 1. Front receiver liveness
npx tsx scripts/check-front-webhook-receiver.ts

# 2. Slack breaker state — quick smoke test (writes nothing)
node -e "import('./dist/services/slackIntegration.js').then(m => console.log(m.getSlackAuthState()))"

# 3. pg_stat_statements (paste into prod read-only SQL tool)
#   SELECT count(*) FROM pg_stat_statements;
```

All three should return non-empty / healthy values within 5 minutes of completing the relevant remediation step.
