# Revenue Integrity System (RIS) — QA + Engagement Layers (V1)

Operator runbook for the **Revenue Integrity System**. The QA layer shipped in Task #2367; the
Engagement layer shipped in Task #2388.

## What it is

RIS is a Reporting-role dashboard at **`/ris`** that tracks, per active client, whether the
promised marketing work is actually being done and the systems behind it are functioning.
It is organized into **layers**, selectable from the dashboard:

- **QA layer** (`layer='qa'`): a granular **per-client × per-product × per-location** checklist
  ledger resolved to one of **Pass / Fail / N/A / Blocked / Needs Review** per calendar-month
  period.
- **Engagement layer** (`layer='engagement'`): 8 relationship-health checks (universal,
  monthly, not location-specific) grouped **by category**, resolved to
  **Green / Yellow / Red / N/A** (see status mapping below). See [Engagement Layer](#engagement-layer-v1--task-2388).

RIS is **additive depth** on top of the existing Monthly Review (Command Panel "reviewed this
month" freshness check) — it does **not** re-check anything Monthly Review already covers.

Every check can still be set by a human. Data-driven checks carry an optional `auto_source`
tag (e.g. `posts_made`, `outbound_calls`, `ad_spend`, `listings`, `comm_cadence`) which the
**BigQuery auto-pull** (Task #2368) fills automatically once an operator configures a mapping —
see [BigQuery auto-pull](#bigquery-auto-pull-task-2368) below. Until then those checks stay at
Needs Review (never a silent Pass). The Engagement layer's NoBull Communication Cadence check
(`auto_source='comm_cadence'`) is a special case: it **displays** an auto-computed outbound
communication volume but **never auto-sets** the status — a human still resolves it (see
[Engagement Layer](#engagement-layer-v1--task-2388)).

## Data model

Two tables (`shared/models/ris.ts`, migration `0088_add_ris_qa_layer.sql`):

- **`ris_checks`** — the admin-editable catalog. Columns: `key` (unique), `label`,
  `description`, `layer` (`qa`), `product` (`universal`/`gbp`/`google_ads`/`lsa`/`webinar`),
  `category` (Access / Tracking / Fulfillment / Automation / Reporting / Spend-Delivery),
  `frequency` (`weekly`/`monthly`/`launch`), `location_specific`, `default_severity`
  (`low`/`medium`/`high`/`critical`), `default_owner_function`, `auto_source`, `active`,
  `sort_order`, `is_system`.
- **`ris_check_results`** — one row per `check × client × optional location × period`. Columns:
  `status`, `observed_value`, `notes`, `evidence_url`, `failure_reason`, `corrective_action`,
  `severity_override`, `source` (`manual`/`auto`), `checked_by`, `checked_at`. Uniqueness is a
  COALESCE index on `(check_id, client_id, COALESCE(location_id,''), period)` so a global check
  and per-location checks don't collide. Task #2368 (`0090_add_ris_bigquery_autopull.sql`) adds
  `confirmed_at` / `confirmed_by` (operator pinned an auto result) and `auto_error` (why the
  last auto-pull degraded to Needs Review).
- **`ris_auto_source_mappings`** — runtime-configurable BigQuery binding, one row per
  `auto_source` (added by Task #2368, `0089`). Columns: `auto_source` (unique), `label`,
  `enabled` (default **false**), `sql_template` (parameterized, see below), `value_column`,
  `comparator` (`none`/`gte`/`lte`/`gt`/`lt`/`eq`/`ne`), `threshold`, `unit_label`,
  `bq_location`, `description`. The BigQuery table/column names live **here**, never in code.

`period` is a calendar month string `YYYY-MM`. Launch-only checks use the sentinel period
`launch`.

## Catalog seeding

`seedRisCatalog()` (`server/services/ris/risCatalog.ts`) runs at boot (`server/index.ts`
bootstrap) with `ON CONFLICT (key) DO NOTHING` — **idempotent and non-destructive**: it never
overwrites admin edits or re-activates a disabled check. The V1 seed is ~31 checks across the
universal / gbp / google_ads / lsa / webinar products. To add a check permanently, add it to
the seed array *and* it will appear on next boot; to add one ad-hoc, use the in-app catalog
editor (managers only).

## Rollups & cadence

Rollups are computed **on read** (`server/services/ris/risService.ts`), never stored:

- **Completion %** = completed (any non-null status) / total due for the period.
- **Open fails / blocked / needs-review** counts, plus a **top-severity** rollup.
- **Due buckets**: `weekly` checks → "due this week", `monthly` → "due this month", `launch` →
  surfaced when a client/product/location is newly added (sentinel `launch` period).

A check instance is "due" for a client only if the check's `product` is in the client's
resolved product list (`normalizeProductList(client.products)`); `universal` always applies.
Location-specific checks fan out to one instance per active `clientLocations` row.

## Permissions

`canAccessRIS` / `canManageRIS` in `server/auth/permissions.ts`, both **permissive-mode aware**
(`role_permissions_permissive_mode`):

- **Access** (view + set results): `reporting_expert` function, plus `team_lead` / `ceo`.
- **Manage** (edit/disable/reorder the catalog): `team_lead` / `ceo`.

Every route is gated `isAuthenticated` + the relevant helper. The frontend mirrors access for
quicklink visibility but the server is authoritative.

## API

All under `/api/ris` (`server/routes/ris.ts`):

| Method | Path | Gate | Purpose |
| --- | --- | --- | --- |
| GET | `/checks` | access | list catalog |
| POST | `/checks` | manage | create check |
| PATCH | `/checks/:id` | manage | edit / disable check |
| POST | `/checks/reorder` | manage | reorder catalog |
| GET | `/portfolio?period=YYYY-MM` | access | portfolio rollup across active clients |
| GET | `/clients/:clientId?period=YYYY-MM` | access | per-client checklist + rollup |
| POST | `/clients/:clientId/results` | access | upsert a check result (manual) |
| POST | `/refresh` | access | on-demand BigQuery auto-pull (one client or all active) |
| POST | `/results/:id/confirm` | access | pin an auto result (stops further auto overwrite) |
| GET | `/auto-mappings` | manage | list mappings + unconfigured `auto_source` keys |
| PUT | `/auto-mappings/:autoSource` | manage | create/update one mapping |
| GET | `/client-bindings/:clientId` | manage | per-client BigQuery key + auto-source overrides |
| PUT | `/client-bindings/:clientId/bigquery-key` | manage | set/clear the client's `bigQueryClientKey` |
| PUT | `/client-bindings/:clientId/overrides/:autoSource` | manage | upsert a per-client rule override |
| DELETE | `/client-bindings/:clientId/overrides/:autoSource` | manage | remove an override (revert to global) |

## Flagging / escalation

`server/services/ris/risFlagging.ts` runs after a result upsert. When a check is set to a
**High/Critical Fail** or **Blocked**, it fans a flag through `notifyUser` (in-app inbox +
Slack DM mirror — the Notifications epic infra, category `system`) to `byFunction` of the
check's owner function **and** `reporting_expert`. Deduped by a key per **client + check +
period**, so re-saving the same failing check does not re-spam. Clearing the failure (status
moves to Pass/N/A) sends a **resolution notice** and clears the dedupe.

## DB pool & holds

All `risStorage.ts` queries go through `getDb()` wrapped in `withDbAttribution`
(request-scoped `api` pool from route handlers). No external I/O inside any hold; rollups are
pure reads. Conforms to the project DB pool-tenancy and ≤10 s hold rules.

## BigQuery auto-pull (Task #2368)

Auto-fills `auto_source`-tagged checks from BigQuery. **Default-OFF and additive** — it never
overwrites a manual or operator-confirmed result, and any unconfigured / unreachable / no-row
case degrades to **Needs Review**, never a silent Pass.

### Configuration (no table/column names in code)

1. **Credentials** (via the environment-secrets workflow, never hardcoded):
   `BIGQUERY_SERVICE_ACCOUNT_JSON` (the full GCP service-account key JSON, secret),
   optional `BIGQUERY_PROJECT_ID` (falls back to the key's `project_id`) and `BIGQUERY_LOCATION`.
   With no credentials, `isBigQueryConfigured()` is false and every auto check stays Needs Review.
2. **Mapping** per `auto_source`, in the **Auto-source mappings** panel on `/ris` (managers
   only) or via `PUT /api/ris/auto-mappings/:autoSource`. Set `enabled`, a parameterized
   `sql_template`, the `value_column` to read, and an optional `comparator` + `threshold`
   that turns the observed value into a suggested Pass/Fail. Mappings are **disabled by default**.

The `sql_template` is run **parameterized** (`server/services/ris/bigQueryClient.ts`) with named
params `@clientId`, `@locationId`, `@periodStart`, `@periodEnd` — never string-concatenated.
Operators own the SQL, so the BigQuery dataset/table/column layout is **not assumed in code**.

### Behavior

- `runRisAutoPull({ clientId?, period })` (`server/services/ris/risAutoPull.ts`): reads scope in
  a short DB hold → runs the BigQuery query **outside any hold** (HTTP) → writes results in a
  second short hold. Launch-only checks are skipped (they're event-driven, not periodic).
- The writer skips rows whose `source` is `manual` or that have `confirmed_at` set, so a human
  decision always wins. A degraded pull writes `status = needs_review` + `auto_error`.
- **Confirm / override**: `POST /results/:id/confirm` pins the current auto value (keeps
  `source = auto`, stamps `confirmed_at`/`confirmed_by`) so later pulls leave it alone; saving a
  manual result flips `source = manual` and clears the auto fields.
- **Triggers**: the on-demand **Refresh auto checks** button (per-client view) → `POST /refresh`,
  always available; plus a scheduled poll gated by `enable_ris_bigquery_autopull` (default OFF,
  interval `ris_bigquery_autopull_interval_ms`, default 6 h) running on the **worker pool** via
  `runWithWorkerDb` (`server/services/ris/risAutoPullScheduler.ts`, started in `server/index.ts`).

> Public docs consulted: Google Cloud BigQuery Node.js client (`@google-cloud/bigquery`) —
> `BigQuery({ projectId, credentials })`, `createQueryJob` / `query` with `params` + `types`
> (named parameters), and job `location`.

### Per-client binding (Task #2485)

Global mappings are the baseline; a client can carry its own BigQuery identity and per-check
rule tweaks layered on top.

- **Client key** — `clients.bigQueryClientKey` (text, nullable), set in the **Per-client
  BigQuery binding** panel on `/ris` Setup (managers only) or via
  `PUT /api/ris/client-bindings/:clientId/bigquery-key`. It binds into every query as the named
  STRING param **`@clientKey`** so operator SQL can scope rows to that client's BigQuery key
  without string concatenation.
- **Per-client overrides** — `ris_client_auto_source_overrides` (unique per `client_id` +
  `auto_source`) holds nullable copies of the rule fields (`sql_template`, `value_column`,
  `comparator`, `threshold`, `bq_location`) plus an extra `filter_value` bound as the named
  STRING param **`@filterValue`**.
- **Resolution** (`server/services/ris/risRuleResolution.ts`, `resolveRisRule`): per field, a
  non-null override wins, otherwise the global mapping value is inherited (`null = inherit`).
  Both the QA pull (`risAutoPull.ts`) and the Performance pull (`risPerformancePull.ts`) resolve
  through this **one shared path** so they can never drift.
- **Missing-key guard** — if the resolved `sql_template` references `@clientKey`
  (`templateNeedsClientKey`) but the client has no key set, the pull **short-circuits** before
  touching BigQuery: QA writes `needs_review` and Performance degrades to **gray**, each with a
  plain-English `auto_error`. Never a silent Pass. All #2368 invariants (manual/confirmed wins,
  unreachable/no-row → Needs Review, default-OFF) are preserved.

## Performance Layer (Task #2371)

A second, color-coded view at `/ris` (toggled by the **QA / Performance** layer switcher, `?layer=`
query param) that scores each client's **marketing output** per product as a **Product Health Card**
— statuses **Green / Yellow / Red / Gray / N/A**. It reuses the #2367 catalog/ledger/flagging and the
#2368 BigQuery client/mapping registry; it is **additive to**, not a duplicate of, the QA Layer.

### Status engine (`server/services/ris/risThresholds.ts`)

`computePerformanceStatus({ metricType, current, previous, target?, bands? })` is **pure** (no I/O)
and returns `{ status, changePct }` from the period-over-period change vs admin-tunable bands:

- **`volume`** / **`rate`** — higher is better; a *drop* past the yellow/red band degrades.
- **`cost`** — lower is better; a *rise* past the yellow/red band degrades.
- **`budget`** — pacing: a single current pacing-% scored against green/yellow windows (no prior; `changePct` stays null).
- Default bands: volume y15/r25, cost y15/r30, rate y10/r20, budget green 85–115 / yellow 70–130 (percent).
- **Degrade-to-gray, never silent green:** missing current, or missing / zero / `≤ minVolume` prior, parks at **Gray** with a null `changePct`.

`resolveBands(metricType, override?)` merges a per-check `thresholds` override (`ris_checks.thresholds`
jsonb) over the metric-type defaults; only the supplied keys override.

### Data & catalog

- `ris_checks` gains `metric_type` (∈ `volume`/`cost`/`rate`/`budget`) + `thresholds` jsonb; `ris_check_results`
  gains `current_value` / `previous_value` / `target_value` / `change_pct` (text). Status accepts the wider
  `risAllStatuses` union (`green`/`yellow`/`red`/`gray`/`na`). Migration `0091_add_ris_performance_layer.sql`
  (idempotent `ADD COLUMN IF NOT EXISTS`).
- `V1_PERFORMANCE_CHECKLIST` seeds Universal + GBP + Google Ads + LSA + Webinar checks idempotently alongside
  the QA list (`risCatalog.ts`), each carrying `metricType` / `product` / `severity` / `ownerFunction` / `autoSource`.

### Pull, rollups & API

- `runRisPerformancePull` (`server/services/ris/risPerformancePull.ts`) reuses `bigQueryClient` + the auto-source
  mapping registry, runs a dual-period query (current + prior) outside any DB hold, feeds the engine, and writes
  results in a short hold. Unconfigured / disabled mapping / unreachable / no-row / query-error all **degrade to gray**.
  `runRisAutoPull` (QA) is now QA-only (`layer !== "performance"`) so the two layers never cross-write.
- `buildClientPerformance` / `buildPortfolioPerformance` (`risService.ts`) roll results into Product Health Cards:
  a Universal summary plus one card per active product, **worst-of** status, a main metric (current vs previous + %Δ)
  and supporting metrics.
- `GET /api/ris/performance/portfolio` and `GET /api/ris/performance/clients/:clientId` (Reporting role; `period` query —
  the prior period is derived from each result's stored `previousValue`). `POST /api/ris/refresh` drives **both** pulls
  (`Promise.all`) and returns `{ qa, performance }`.
- **Scheduler:** the same worker-pool tick (`risAutoPullScheduler.ts`) runs the performance pull under the **existing**
  `enable_ris_bigquery_autopull` gate (default OFF) — **no new `system_settings` key**.

### Flagging

`isFlagWorthy` treats a **`red`** performance status exactly like a **High/Critical Fail** (only `high`/`critical`
severities flag; `blocked` always flags). `green` / `yellow` / `gray` / `na` never flag and clear an existing flag.

> Public docs consulted: same Google Cloud BigQuery Node.js client (`@google-cloud/bigquery`) parameterized-query
> surface as the #2368 auto-pull (named `@`-params, job `location`).

## Engagement Layer (V1 — Task #2388)

The Engagement layer (`layer='engagement'`) tracks **client-relationship health** rather than
system QA. It reuses the same `ris_checks` / `ris_check_results` tables, on-read rollups,
flagging, permissions, and `/ris` dashboard — it is a **new layer over the existing infra**, not
new infrastructure.

**Shape**: 8 seeded checks, all `product='universal'`, `frequency='monthly'`,
`location_specific=false`, across two categories:

- **`client_engagement`** — relationship-side checks (meeting attendance, lead feedback loop,
  review participation, strategic alignment, budget pacing, etc.).
- **`nobull_cadence`** — NoBull-side proactive-outreach checks, including check **#7 NoBull
  Communication Cadence** (`auto_source='comm_cadence'`).

Engagement checks are grouped **by category** in the dashboard (QA groups by product).

**Status mapping** (no schema change — stored values are the same QA statuses, relabeled in the
UI for this layer):

| Engagement label | Stored status |
| --- | --- |
| Green | `pass` |
| Yellow | `needs_review` |
| Red | `fail` |
| N/A | `na` |
| Blocked | `blocked` |

Flagging is unchanged: a **High/Critical Red (`fail`)** or **Blocked** fans the same
notification + Slack flag to the owner function and `reporting_expert`.

### NoBull Communication Cadence (check #7) — live auto-count

Check #7 carries `auto_source='comm_cadence'`. For each client + period,
`server/services/ris/risCadence.ts` (`getCommunicationCadence`) computes the **outbound**
communication volume for the month and attaches it to the check instance for display:

- Counts by `source_type`: `front_email` → emails, `twilio_call` → calls, `twilio_sms` → texts,
  plus a total, and `lastOutboundAt` / `lastInboundAt` timestamps.
- A communication is attributed to the client by `client_id` **or** a non-rejected
  `communication_client_links` row.
- Runs on the ambient pool wrapped in `withDbAttribution("ris:commCadence")`; pure read, no
  external I/O in any hold.

The cadence numbers are **display-only context** — the human still sets the Green/Yellow/Red/N/A
status. The auto-count **never** sets or overrides the stored status.

## Out of scope (V1)

- Auto-computing or auto-setting any engagement status (the comm-cadence counts in
  check #7 are display-only context; the human always sets the status).
- Anything Monthly Review already covers.
