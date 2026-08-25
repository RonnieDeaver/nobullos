# Ads OS Runbook

**Subsystem:** NBM Ads OS (NoBull Marketing paid-search operations console) — rebuild inside NoBull OS.

**Status:** Phase 0 shipped (foundations + integration proofs). Phase 1 shipped (directory, enrollment, dashboards). Phase 2 shipped (budget source, criteria, pacing tools + overlays, morning cron). Phase 3 shipped (GAds + LSA hygiene audits). Phase 4 shipped (Search Term Analyzer: AI negatives + keyword finder + traffic quality). Phases 5–6 in progress.

**UI entry point:** `/ads-os` (CEO-only, Quicklinks → Internal Tools → Ads OS ✦). Main dashboard at `/ads-os`, Google Ads board at `/ads-os/gads`, LSA board at `/ads-os/lsa`, Phase 0 proofs moved to `/ads-os/proofs`.

**API namespace:** `/api/ads-os/*`

---

## Architecture overview

The Ads OS rebuild lives entirely under:
- `server/services/adsOs/` — config seam, Google Ads client, ClickUp directory (`clickUpDirectory.ts`), enrollment resolver (`enrollment.ts`), dashboard builders (`dashboardService.ts`, `lsaDashboardService.ts`, `combinedDashboardService.ts`), date-range math (`dateRange.ts`), single-flight lock (`singleflight.ts`), OpenAI helper, Slack webhook, the jsonb store layer, and the Phase 2 pacing stack: budget source seam (`budgetSource.ts`), criteria service (`criteriaService.ts`), GAds/LSA pacing engines (`pacingEngine.ts`, `lsaPacingEngine.ts`), morning scheduler (`morningPacingScheduler.ts`), the Phase 3 audit stack under `audit/`, and the Phase 4 analyzer under `keywordIntel/` (`queries.ts`, `suggest.ts`, `safety.ts`, `engine.ts`, `keywordFinder.ts`, `kiStore.ts`).
- `server/routes/adsOs.ts` — route module registered via `registerAdsOsRoutes(app)`.
- `client/src/pages/adsOs/` — `MainDashboard.tsx`, `GadsDashboard.tsx`, `LsaDashboard.tsx`, `ClientProfile.tsx` (full profile — Phase 6), pacing tools `BudgetPacingTool.tsx` (`/ads-os/a/:cid/pacing`) + `LsaPacingTool.tsx` (`/ads-os/lsa/a/:cid/pacing`), analyzer pages `AnalyzerChooser.tsx` (`/ads-os/a/:cid/analyzer`) + `KeywordIntelTool.tsx` (`…/analyzer/negatives`) + `KeywordFinderTool.tsx` (`…/analyzer/keywords`), shared `components/` (incl. `PacePill.tsx`, `PacingChart.tsx`, `CriteriaEditor.tsx`, `CommandPalette.tsx`, `Breadcrumbs.tsx`, `PerformanceSection.tsx`) + `lib/` (incl. `adsEditorCsv.ts`), scoped stylesheet `adsOs.css` (every rule under `.ads-os`).
- `client/src/pages/AdsOsProofs.tsx` — Phase 0 proofs page (now routed at `/ads-os/proofs`).

The earlier broken port at `/admin/ads-os` (Task #2958) was retired in Task #3603 — its routes, services, scheduler, and store tables are gone, and `/admin/ads-os` now redirects here. This module is the only Ads OS surface.

### Key design decisions

| Decision | Rationale |
| --- | --- |
| `/api/ads-os/*` namespace | Avoids collision with existing `/api/dashboard`, `/api/accounts`, etc. (spec §8 paths collide with NoBull routes). |
| Postgres jsonb `ads_os_*` tables | Replaces spec's Firestore (spec §7 explicitly allows an alternative store). |
| Role-gated Ads OS actions with a criteria-only session exception | Most Ads OS reads require `account_manager` and writes/triggers require `ceo`, matching existing ads tooling. The canonical and legacy criteria GET/PUT aliases deliberately require only `isAuthenticated`, so any approved signed-in user can maintain client criteria without opening any other Ads OS action. |
| Direct env-var credential reads | `config.ts` is the only place secrets are read; nothing is serialized to the browser. |
| **Env secrets are the ONLY Google Ads auth path — app-wide** | Per spec §9, `googleAdsClient.getAccessToken()` exchanges `GOOGLE_ADS_CLIENT_ID` + `GOOGLE_ADS_CLIENT_SECRET` + `GOOGLE_ADS_REFRESH_TOKEN` (trimmed on read) directly. Terminal 4xx rejections are negative-cached 5 min so a dead token is never re-POSTed per GAQL call. **Task #4008:** the whole app now shares this path — the exported `getEnvAccessToken()` seam also mints for the platform integration (Ads Hygiene, Discover Customers, campaign sync), and the platform-managed `google_ads_connection` + its OAuth machinery were retired (the old two-lane split is gone; one credential, one mint, single point of failure by design — rotation runbook in `GOOGLE_ADS.md`). |
| `clickup_live` field added to dashboard payloads | Deliberate drift from the bundle: powers the spec §3.2 ClickUp-outage warning banner without a second request. |
| Directory liveness = current health, not "ever fetched" | Deliberate divergence from the source `bundle_is_live()` ("at least one fetch has succeeded; slightly-stale counts"): spec §2 requires the auto→label fallback "when ClickUp is unreachable", so a post-success outage must flip `clickup_live` false, keep serving the stale bundle for display, and swing auto enrollment to labels — minus CIDs the stale bundle remembers as deliberately dropped (known to ClickUp, under no live client). One signal (`bundleIsLive()`) drives both the banner and the enrollment gate so they can never disagree. Gated by `tests/ads-os-clickup-liveness.test.ts` + `tests/client/ads-os-clickup-banner.test.tsx`. |
| ClickUp Practice Area directory contract uses the canonical Client List | For the ClickUp-backed directory and its server writeback seam, list `901417549202`, field `237317f2-e612-4983-baf7-97166de73a77` (`Practice Area`, ClickUp type `labels`) owns the ordered option labels and each live parent client's selected values. The Ads OS criteria `practice_areas` field is a local mirror: interactive saves synchronize it per client, and the bounded manual production action below repairs historical fleet drift. |
| Overlay columns are all live store reads | Pacing (Phase 2), Hygiene (Phase 3), Traffic-quality (Phase 4) and Alerts (Phase 6) columns read their stores; the interim `phaseStubs.tsx` placeholder layer was removed when the last overlay went live. |

---

## Configuration

All secrets and behavior settings are documented in `audits/G-docs-findings.md §4`.

| Secret / env var | Required for |
| --- | --- |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | All Google Ads API calls |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | MCC identity (digits only) |
| `GOOGLE_ADS_CLIENT_ID` | OAuth2 token exchange |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth2 token exchange |
| `GOOGLE_ADS_REFRESH_TOKEN` | OAuth2 refresh (sole token source app-wide — Task #4008) |
| `CLICKUP_API_TOKEN` | Client List directory, ticket creation |
| `OPENAI_API_KEY` | AI features (falls back to `AI_INTEGRATIONS_OPENAI_API_KEY`) |
| `SLACK_WEBHOOK_URL` | Morning alert digest (optional; absent = digest off) |
| `CRON_SECRET` | Gating POST /api/ads-os/cron/refresh-pacing (optional; absent = endpoint 401s) |
| `ADS_OS_PACING_REFRESH_FORCE_ENABLE` | Dev/test only: run the morning pacing scheduler outside deployments |
| `KI_MAX_TERMS` / `KI_BATCH_SIZE` / `KI_MIN_CONVERSIONS` | Optional analyzer tuning (defaults 500 / 40 / 1.0); confidence floors + labels also env-overridable in `config.ts` |

Kill switch: system setting `ads_os_pacing_refresh_enabled` (default **off**) gates the internal ~6am ET pacing refresh scheduler.

---

## Store layer

12 jsonb tables, all in `migrations/0136_ads_os_stores.sql`, all idempotent (`IF NOT EXISTS`):

| Table | Spec collection | Key |
| --- | --- | --- |
| `ads_os_clients_criteria` | `keyword_intel_clients` | digits-only CID |
| `ads_os_audit_scores` | `audit_scores` | CID |
| `ads_os_lsa_audit_scores` | `lsa_audit_scores` | CID |
| `ads_os_budget_pacing` | `budget_pacing` | CID |
| `ads_os_lsa_budget_pacing` | `lsa_budget_pacing` | CID |
| `ads_os_traffic_quality` | `traffic_quality` | CID |
| `ads_os_keyword_actioned` | `keyword_actioned` | CID |
| `ads_os_pyramid_breakdown` | `pyramid_breakdown` | CID |
| `ads_os_account_alerts` | `account_alerts` | `{product}:{cid}` |
| `ads_os_account_alerts_notified` | `account_alerts_notified` | `{product}:{cid}` |
| `ads_os_clickup_tasks` | `clickup_tasks` | `{product}:{cid}` |
| `ads_os_client_log_summaries` | `client_log_summaries` | sheet ID |

### Self-healing schema + store health signal (Task #3706)

These tables exist **only** as raw SQL (not `shared/schema.ts`), so a DB reset/replacement
silently removed all 12 once — and the best-effort store swallowed every failure while
dashboards blanked and criteria saves no-op'd. Two defenses now apply
(`storeSchema.ts`, gated by `tests/ads-os-store-health.test.ts`, smoke):

- **Boot + runtime ensure** — `ensureAdsOsStoreTables()` (idempotent, single-flighted,
  mirrors 0136) runs in the server bootstrap in **all** environments, and any store op
  that hits `relation does not exist` (42P01) re-runs the ensure and retries once
  (failed-ensure retries cool down 30s). 0136 is also in `scripts/post-merge.sh`
  SAFE_MIGRATIONS so a post-merge `db:push` can't drop the tables again.
- **Loud outage signal** — every store op feeds a per-process health state:
  42P01 flips it to `missing_tables` immediately; other errors flip to `errors` after
  3 consecutive failures; any success resets. Surfaced as an amber banner on all three
  Ads OS dashboards (`store_ok` / `store_reason` in the dashboard payloads) and a
  `store` block in `GET /api/ads-os/status` — empty pacing columns are never again
  indistinguishable from "no data yet".
- **Write strictness** — criteria saves (`putCriteria`) throw on failure (a save can
  never report ok without persisting); derived data a refresh can regenerate stays
  best-effort log-and-swallow (spec §7).

---

## ClickUp Practice Area directory contract

The existing ClickUp Client List refresh reads both the paginated parent/subtask
directory and list custom-field metadata through the runtime-rotatable company
token boundary. It requires exactly one exact-name `Practice Area` field with the
pinned UUID and `labels` type. Option IDs, labels, and `orderindex` values must be
complete, correctly typed, whitespace-exact, and unique. Missing, ambiguous,
wrong-type, duplicate, or malformed metadata fails the refresh instead of
guessing.

The successful directory bundle carries the complete canonical option list plus
each live parent's selected labels in canonical option order. Every Google Ads
and LSA CID under that parent receives the same selection. ClickUp task values
may be option-ID strings or `{ id }` objects; unknown, duplicate, or malformed
values fail closed. A failed refresh never replaces the last good bundle:
10-minute caching, keyed single-flight, 60-second failure backoff, stale display,
force refresh, `clickup_live`, and token-rotation behavior remain the same.

The server-side replacement operation accepts a CID and canonical labels,
first forces a successful directory+field-metadata refresh while holding the
directory lock, then requires exactly one live parent mapping, validates every
label against that fresh option map, orders the set canonically, and sends
ClickUp the whole replacement as `[{ id }]` (or `[]` to clear). A stale display
bundle never authorizes a write. Re-applying the same set is a no-op. Transient
server failures get one bounded retry; rate-limit, authorization, timeout,
unknown-label, and mapping failures are explicit. The cached parent and all
associated CIDs are patched only after ClickUp confirms success. An ambiguous
failure can therefore leave ClickUp ahead of the cache, but the next successful
directory refresh reconciles it; cached data is never optimistically corrupted.
This operation writes only ClickUp metadata and does not change Google Ads.

The criteria `practice_areas` value is now a strict local mirror of this
ClickUp authority. Interactive criteria saves update the parent selection first,
then persist the same canonical labels locally. The
`ads-os-reconcile-practice-areas` production action repairs historical fleet
drift without writing ClickUp: it takes one forced-fresh validated directory
snapshot, patches only `practice_areas` + `updated_at`, preserves all other raw
JSON keys, and seeds a missing document only for a non-empty canonical
selection. Unavailable, stale, malformed, or ambiguous directory state blocks
the pass; unmapped stored CIDs are diagnosed and never cleared.

### Historical Practice Area rollout — publish before press

1. **Publish the implementation first.** Never press an older deployment's
   production actions or use **Apply all** for this rollout.
2. In the published production-actions panel, find the individual manual lever
   **Ads OS: reconcile stored Practice Areas from ClickUp**. Review its live
   detail and require a fresh snapshot timestamp plus explicit mismatch,
   missing-document, unmapped-account, ClickUp, and criteria-store diagnostics.
3. If the row is blocked/error, or reports an ambiguous/unsafe mapping, do not
   press it. Repair the named ClickUp or store prerequisite and refresh the
   panel; stale cached data never authorizes reconciliation.
4. Press only that lever. A partial local failure is reported per CID; successful
   siblings remain converged and a later individual rerun safely finishes the
   remaining CIDs. Missing documents with an authoritative empty selection stay
   absent by design.
5. Refresh the panel. The lever retires to History only when a new fresh probe
   verifies every eligible stored document matches. Then resume the separate
   production-verification task; do not run the lever from this implementation
   task.

---

## Read-only guard

Ads OS must **never** call a Google Ads mutate endpoint. An automated smoke-gate test
(`tests/ads-os-mutate-guard.test.ts`) greps `server/services/adsOs/**` for mutate service
names and verbs and fails if any appear. Do not add mutate calls — the entire product is
an operator-facing analytics/alerts console.

**One sanctioned exception, deliberately OUTSIDE this directory (Task #4964):**
`server/services/googleAdsLabelMutate.ts` can create the `NBM_GADS_MONITOR_CAMPAIGN`
label in a client account and attach it to campaigns — nothing else. It is invoked only
from the operator-gated one-press prod action `apply_ads_os_monitor_labels` (a MANUAL
LEVER: Apply-all skips it, nothing schedules it). Never move it into `server/services/adsOs/`
and never widen the mutate guard to accommodate writes inside the directory.

### Monitor-label coverage (Task #4964)

All GAds metrics are scoped to campaigns carrying `KI_CAMPAIGN_LABEL`
(`NBM_GADS_MONITOR_CAMPAIGN`). An enrolled account whose active non-LSA campaigns carry
**zero** labels silently renders $0.00 everywhere. The shared classifier
`server/services/adsOs/labelCoverage.ts` grades each enrolled account
`full | partial | zero | no_active | unknown` (partial = intentional scoping, never
touched; unknown = Ads API error, never treated as broken) and feeds three consumers:

- **Surfacing** — the combined dashboard sets `zero_label` on affected GAds members;
  the Main board row and the client-profile account row show a "setup needed" chip,
  distinct from `metrics_failed` (fetch failure) and from genuine zero spend.
- **Repair** — the `apply_ads_os_monitor_labels` prod action (production actions
  panel): for zero-label accounts only, ensures the label exists and applies it to all
  active non-LSA campaigns, with a per-account/per-campaign audit in the run detail;
  idempotent (a repeat press re-detects and reports not-needed) and per-account
  failure-isolated. It invalidates the combined-dashboard in-process cache on
  completion so fixed accounts show real numbers on the next read.
- **Drift guard** — `server/services/adsOs/labelDriftGuard.ts`: a lock-guarded periodic
  evaluator (deployment-gated, cross-instance singleton, kill switch
  `ads_os_label_drift_guard_enabled`, default ON) alerts the responsible admins once
  per ET day per zero-label account (bell dedupe key
  `ads_os.label_drift:<day>:<cid>:<uid>`), re-firing on subsequent days while the
  condition persists. Durable day ledger in `notification_health_state`.
- **Enrollment/MCC guard** — `server/services/adsOs/enrollmentMissingGuard.ts`: once per
  ET day, compares every CID enrolled under a live ClickUp client (GAds or LSA,
  including Off) with the MCC's ENABLED non-manager account list. Each missing CID
  sends a Slack notification plus responsible-admin bell mirrors naming the client
  and CID, deduped by `ads_os.mcc_enrollment_missing:<day>:<cid>` (with a user
  suffix for each bell recipient) and re-fired on subsequent days until corrected.
  Slack and each bell recipient are awaited and ledgered independently, so failed
  deliveries retry on the next 15-minute tick without repeating completed channels.
  A failed/stale ClickUp read or MCC
  query is a non-observation and never produces a false alert. Deployment-gated,
  cross-instance singleton, default-ON kill switch
  `ads_os_mcc_enrollment_guard_enabled`.

#### Drift-guard production verification

Run `tsx scripts/verify-ads-os-label-drift-prod.ts` against the prod DB (or prod-replica).
The script checks five invariants and emits one of three verdicts:

- **PASS** — all required invariants are confirmed.
- **PENDING** — the health-state singleton is present but not enough production data has
  accumulated yet (e.g. run on day 1 before zero-label alerts have fired, or before a second
  ET day has elapsed). Re-run the next day.
- **FAIL** — at least one invariant is definitively broken; see triage below.

| # | Check | PASS condition |
| --- | --- | --- |
| 1 | Singleton present | `notification_health_state` row exists for `system.ads_os.label_drift` **and** `metadata_json` carries a `completedDay` or `lastEvaluatedAt` value — proves at least one full evaluation pass ran. Every healthy 15-min tick refreshes `lastEvaluatedAt`; the independent staleness watchdog alerts responsible admins when it is missing, invalid, or ≥30 minutes old. |
| 2 | Alert fired | `user_notifications` has ≥ 1 row with `dedupe_key LIKE 'ads_os.label_drift:%'` in the window — proves recipients were notified when zero-label accounts existed. PENDING when no bell rows exist (guard may be healthy or not enough time has elapsed). |
| 3 | Intra-day dedup clean | No (ET day, customer\_id, user\_id) triple has > 1 bell row — proves the durable per-day ledger blocked 15-min re-tick spam. |
| 4 | Daily re-fire | Bell rows span ≥ 2 distinct ET days — proves the day-complete stamp rolls over at midnight ET and the guard re-alerts on day 2. PENDING with only 1 day of data. |
| 5 | Quiet after repair | Only checked when `--repair-day YYYY-MM-DD` is supplied: **(a)** `notification_health_state.state` is `"healthy"` and `transitioned_at` falls on or after the ET calendar date of repair-day (compared via Postgres `AT TIME ZONE 'America/New_York'`, DST-safe), AND **(b)** zero bell rows exist whose embedded ET day (the `YYYY-MM-DD` segment of the dedupe key) is **strictly after** repair-day (lexicographic string comparison on the key-embedded date — inherently DST-safe). The same-day pre-repair alert is expected and excluded from the no-bell window. |

```bash
# Day 1 after deploy (single-day check):
tsx scripts/verify-ads-os-label-drift-prod.ts --days 2

# Day 2+ (confirm daily re-fire):
tsx scripts/verify-ads-os-label-drift-prod.ts --days 7

# After apply_ads_os_monitor_labels fixes all accounts on 2026-08-20:
tsx scripts/verify-ads-os-label-drift-prod.ts --repair-day 2026-08-20
```

**Triage guide (if a check fails):**

- *[1] Singleton missing or no full-pass evidence* — the scheduler never completed a pass.
  Check deployment logs for `[adsOsLabelDrift]` lines. Confirm `isRunningInDeployment()` is
  true and the `WORKER_STAGGER_OFFSETS.ads_os_label_drift` boot delay (~18 min) has elapsed.
  A stale heartbeat should also create a responsible-admin bell unless
  `ads_os_label_drift_guard_staleness_alert_enabled` is explicitly disabled.
- *[2] No bell rows despite known zero-label accounts* — check the kill switch
  (`ads_os_label_drift_guard_enabled` must be absent or `"1"`) and verify
  `getResponsibleAdminsForAlert()` returns at least one user id.
- *[3] Intra-day dups* — the `completedDay` stamp in `notification_health_state.metadata_json`
  is not persisting between ticks. Inspect `metadata_json` directly; check for
  concurrent writers or a `upsertHealthState` failure.
- *[4] No re-fire on day 2+* — read `metadata_json`: if `completedDay` equals the prior
  day's stamp, the guard correctly short-circuited (intra-day); if day 2 shows
  `completedDay` from day 1, the ET date comparison is wrong (`labelDriftDayStamp` timezone).
- *[5] Bells after repair (next-day+)* — either the repair prod action did not fix all
  zero-label accounts, or new accounts have drifted back to zero since the repair.

---

## Phase map

| Phase | Scope | Status |
| --- | --- | --- |
| **0 — Foundations** | Config seam, Google Ads client, ClickUp directory, OpenAI helper, Slack webhook, store layer, proofs page | **Shipped** |
| **1 — Directory & dashboards** | Directory bundle cache, enrollment resolver, MCC + monitored-account lists, GAds/LSA/combined dashboards + UI (budget pacing moved to Phase 2) | **Shipped** |
| **2 — Stores, criteria & pacing** | Budget source seam (ClickUp-primary / CSV-fallback), client criteria store + editor, GAds + LSA pacing engines/tool pages, dashboard pace overlays, cron endpoint + morning scheduler | **Shipped** |
| **3 — Hygiene audits** | Scored GAds audit (25 checks, GEO/KWS/BID/ADS/AST/OPT/STR), LSA hygiene (VER/POL/BUD/PERF), shared report UI + gauge, HTML export, score stores + dashboard Hygiene columns, run-stale-audits | **Shipped** |
| **4 — Search Term Analyzer** | Two-mode analyzer (spec §6.6): AI negative keywords (protected sets, reason-first review, safety filter, traffic quality) + rules-based New Keywords (actioned store, live-negatives skip, negatives cross-check with held-back flow), Editor CSV exports, dashboard Traffic-quality pill | **Shipped** |
| **5 — Pyramid Breakdown** | AI campaign-performance review, pyramid tier nav, action chips, profile-tile snapshot | **Shipped** |
| **6 — Profile, alerts & polish** | Client profile + performance charts, alerts engine + dashboard badges, Slack digest (only-on-change), ClickUp alert tickets, client-log AI summary, ⌘K palette + breadcrumbs, full-cron completion | **Shipped** |
| **7 — AM Dashboard** | Launch board (`/ads-os/am`): per-client cards, deep links (ClickUp field + seed), nightly Paused/Off status verification (single-doc store + keep-last-batch guards), alert badges/dropdown, toolbar filters + shareable URLs, verification phase prepended to the morning routine | **Shipped** |

---

## Phase 1 — directory, enrollment & dashboards

### Routes (all `isAuthenticated + requireCeo`)

| Route | Payload | Cache |
| --- | --- | --- |
| `GET /api/ads-os/audit/:cid?lookback_days=&force=` | GAds hygiene `AuditReport` — 25 checks, categories, gates, next steps (+ `from_cache`) | 1h in-process + single-flight; **every run persists** `{final_score, band, generated_at, compact next_steps}` to `ads_os_audit_scores` |
| `GET /api/ads-os/audit/:cid/report.html` | Standalone HTML export (spec §6.5 sub-path), `Content-Disposition: inline` with a sanitized filename | serves the cached report when fresh |
| `POST /api/ads-os/dashboard/run-audits` | `{requested, ran, skipped, failed: [{cid, error}]}` — audits every monitored GAds account whose stored score is older than 7 days | 300s deadline, `mapPool(4)`, per-item isolation |
| `GET /api/ads-os/lsa/hygiene/:cid?force=` + `/report.html` | LSA hygiene — same `AuditReport` shape (VER-01/POL-01/BUD-02/PERF-01/PERF-02); non-enrolled accounts return band `N/A` | 1h + single-flight; persists to `ads_os_lsa_audit_scores` |
| `POST /api/ads-os/lsa/dashboard/run-audits` | LSA equivalent of run-stale-audits | same |

Single-audit routes have 120s deadlines; the usual §4 error mapping applies. Dashboard rows fill `health_score/health_band/health_at` **live from the score stores** (like pacing overlays — never through the 1h metric cache), so Hygiene columns update the moment any run persists.

### Enrollment semantics (`enrollment.ts`, ported from `backend/app/enrollment.py`)

- ClickUp "Ads Status" per (product, CID): `On`/blank+CID ⇒ monitored, `Paused` ⇒ shown as paused, `Off` ⇒ hidden from GAds/LSA boards.
- Offboarded parent status (configurable, default `offboarded`) excludes the client everywhere; its CIDs stay in the known-CID sets.
- `ACCOUNT_ENROLLMENT=auto|clickup|label`: while ClickUp is live, `auto` unions legacy `NBM_GADS_MONITOR`/`NBM_LSA_MONITOR` labels only for CIDs absent from the Client List across both products; for any known CID, ClickUp's missing product wins, so a stale label cannot invent a second product. When ClickUp is unreachable, `auto` retains the legacy label outage fallback (with remembered offboarded exclusions); `clickup`/`label` force one source.
- Campaign gating: GAds metrics count only `NBM_GADS_MONITOR_CAMPAIGN`-labeled campaigns; LSA scope is labeled campaigns if any, else all `LOCAL_SERVICES` campaigns.
- Account discovery: `customer_client` under the MCC (`login-customer-id` header), ENABLED only.

### Google Ads API v24 GAQL fields — verified against the live field reference (fetched 2026-07-27)

| Resource (fields page) | Fields used | Verified |
| --- | --- | --- |
| [`customer_client`](https://developers.google.com/google-ads/api/fields/v24/customer_client) | `client_customer`, `id`, `descriptive_name`, `currency_code`, `time_zone`, `manager`, `test_account`, `status`, `level`, `applied_labels` | all present |
| [`label`](https://developers.google.com/google-ads/api/fields/v24/label) | `resource_name`, `name` | all present |
| [`campaign_label`](https://developers.google.com/google-ads/api/fields/v24/campaign_label) | `campaign.id`, `label.name` via attributed resources | page lists `campaign` + `label` as attributed resources ("Fields from the above resources may be selected along with this resource") |
| [`campaign`](https://developers.google.com/google-ads/api/fields/v24/campaign) | `id`, `status`, `advertising_channel_type`; `segments.date`; `metrics.cost_micros`, `metrics.conversions` (metrics on the [v24 metrics page](https://developers.google.com/google-ads/api/fields/v24/metrics)) | all present; `LOCAL_SERVICES` confirmed on the [AdvertisingChannelType enum](https://developers.google.com/google-ads/api/reference/rpc/v24/AdvertisingChannelTypeEnum.AdvertisingChannelType) |
| [`local_services_lead`](https://developers.google.com/google-ads/api/fields/v24/local_services_lead) | `lead_type`, `lead_charged`, `creation_date_time` | all present |
| [`local_services_lead_conversation`](https://developers.google.com/google-ads/api/fields/v24/local_services_lead_conversation) | `conversation_channel` (`PHONE_CALL`), `phone_call_details.call_duration_millis`, `event_date_time`, `lead` | all present |

Date filters use `segments.date BETWEEN '<start>' AND '<end>'` (never `DURING LAST_N_DAYS` — see `GOOGLE_ADS.md`); LSA datetime fields use `>= 'YYYY-MM-DD 00:00:00' AND <= 'YYYY-MM-DD 23:59:59'` bounds.

ClickUp directory: [`GET /list/{list_id}/task` (gettasks)](https://developer.clickup.com/reference/gettasks) with `subtasks=true&include_closed=true` paging via `page`; dropdown values resolved through `custom_fields[].type_config.options` by `orderindex`; LSA city suffix parsed from subtask names. Answer rate = conversations with `call_duration_millis` present ÷ charged phone leads.

### Frontend behavior

- Client-side stale-while-revalidate: last payload per `{dash}:{window}:{compare}` served instantly from `dashCache`, quiet revalidate in background; out-of-order responses dropped via reqId guard.
- Metric pills tint only on ≥10% change (leads up green, CPL up red, spend neutral); zero-baseline change counts as significant (`Infinity`).
- Main board hides clients with `has_active_monitoring === false` (profile URL still works); summary tiles stay portfolio-wide under filters; row click → `/ads-os/client/:name` (live profile page since Phase 6).
- All overlay columns (pacing, hygiene, traffic quality, alerts) are live store reads; the pre-Phase-6 `phaseStubs.tsx` placeholder layer is gone.

---

## Phase 2 — budget source, criteria & pacing

### Routes (cron excepted; criteria GET/PUT require only `isAuthenticated`, all other routes retain their existing role gates)

| Route | Payload | Cache |
| --- | --- | --- |
| `GET /api/ads-os/budget-pacing/:cid?force=` | GAds pacing report — tiles, daily spend-vs-target series, per-campaign breakdown (paused-mid-month tagged) | 1h in-process + single-flight; **every run persists its summary** to `ads_os_budget_pacing` |
| `GET /api/ads-os/lsa/pacing/:cid?force=` | LSA pacing report (+ `spend_last_30d`, the BUD-02 signal) | same, persists to `ads_os_lsa_budget_pacing` |
| `GET\|PUT /api/ads-os/clients/:cid/criteria` (legacy alias `/api/ads-os/keyword-intel/:cid/criteria`) | Criteria doc (spec §6.11) + auto-derived defaults (account name; service area from campaign geo targeting) | none; PUT invalidates that account's pacing cache, and a schedule change refreshes its pacing store immediately (best-effort — never fails the save) |
| `POST /api/ads-os/cron/refresh-pacing` | `{gads: {requested, ran}, lsa: {…}}` | Shared-secret gate `X-Cron-Key == CRON_SECRET` (401 when unset); refreshes every ENROLLED account **including Off** |

### Pacing math (spec §6.7, ported verbatim — gated by `tests/ads-os-pacing-math.test.ts`, smoke)

- Spend window: 1st → yesterday. Labeled campaigns count **regardless of status** — a campaign paused mid-month still spent money that must count.
- `expected_to_date = budget × scheduled_days_elapsed / total_scheduled_days`; pace % `= (mtd / expected − 1) × 100`; `recommended_daily = (budget − mtd) / remaining_scheduled_days`.
- GAds: schedule-aware via the criteria Mon–Sun ad schedule (`pyWeekday` Mon=0; empty/junk schedule ⇒ every day). LSA: every day counts; recommendation shown **weekly** (`recommended_daily × 7`).
- **Schedule inference (Task #3706):** when an account has **no saved schedule**, the GAds engine infers serving days from the last 28 days of actual daily spend (window ends yesterday, trimmed to first spend day; needs ≥ 14 observed days; a weekday counts as "on" when ≥ 50% of its occurrences spent ≥ $0.01; ambiguous/short/no-spend history ⇒ every-day default). Saved criteria **always win**. The report/doc carry `schedule_source` (`saved` | `inferred` | `default`) — inferred schedules render with an `≈` prefix + "save criteria to override" note.
- **Early-month neutral state:** with **zero scheduled days elapsed** (e.g. a Mon–Fri account on a weekend month-start), `pace_vs_expected_pct` is `null` — the tool and dashboards show a neutral "Not started / no scheduled days elapsed yet" chip instead of a misleading −100%. This is exactly the Aug 1–2 2026 weekend bug: Mon–Fri accounts read "−100% far behind" on every-day defaults while their $0 weekend spend was real and correct.
- Budget seam (`budgetSource.ts`, gated by `tests/ads-os-budget-source.test.ts`): the ClickUp Client List's per-product, per-CID "Paid Search Budget" is the **sole authority**. Positive, zero, blank, and missing product values from a successful ClickUp fetch are final; the retired Google Sheet is never read or gap-filled. The existing ClickUp directory owns its ~10-minute cache, failure backoff, and stale serving. Every result also carries source health: a successful current fetch is authoritative and may clear a stale persisted budget; an outage may serve the last cached ClickUp copy but cannot authorize a destructive clear.

### Dashboard pacing overlays

- Every dashboard request reads the pacing stores **live** (`ads_os_budget_pacing` / `ads_os_lsa_budget_pacing`) — never through the 1h metric cache — so pills update as soon as any run persists (tool open, criteria save, cron).
- Pace pill rules (shared `lib/pace.ts`): green 0…−5, amber −5…−15, light red positive or < −15; **MBH** (monthly budget hit, `mtd ≥ budget`): dark red while ads still run, dark grey when paused.
- Main board combined formula: total MTD is the sum of **every counted GAds and LSA account's current MTD spend**, including accounts whose product budget is zero/blank; total monthly budget is the sum of configured per-product ClickUp budgets; combined expected-to-date is the sum of each budgeted account's schedule-aware target; pace is `(total MTD / combined expected-to-date − 1) × 100`; MBH is `total MTD ≥ total monthly budget`. The hover breakdown shows every counted spend contribution and labels unbudgeted accounts explicitly. Off accounts keep counting **only while their stored month is current and has spend**, so a frozen last-month value resets at the boundary instead of leaking forever. The client-profile combined row reuses this same aggregate.
- GAds and LSA product dashboards remain account-isolated: each row uses only that product/account's own ClickUp budget, MTD spend, and applied schedule. A shared CID does not merge the two product budgets outside the Main/client-level aggregate.

### Morning refresh scheduler (`morningPacingScheduler.ts`)

Deployment-gated cross-instance singleton (Postgres advisory lock), following the existing scheduler conventions: 15-min ticks, fires once per day after 6am ET (`ads_os_pacing_refresh_last_run_date` marks completion), same code path as the cron endpoint. The GAds fleet phase forces **one** fresh ClickUp directory read before account fan-out; GAds and LSA then resolve every account from that same product-separated snapshot, so the job converges authoritative zero/blank values without multiplying vendor calls. A failed forced read is non-authoritative and preserves last-known pacing rows. Default **off** — enable via system setting `ads_os_pacing_refresh_enabled`; `ADS_OS_PACING_REFRESH_FORCE_ENABLE=1` forces it outside deployments (dev/tests). Since Phase 6 the run body also recomputes every account's alerts, reconciles ClickUp tickets, and sends the Slack digest (see §Phase 6).

**Turning it on in production (Task #3612):** press the **Enable Ads OS morning pacing refresh (~6am ET)** prod-action (`enable_ads_os_pacing_refresh`) in the Integrations Hub. It sets `ads_os_pacing_refresh_enabled = true` in the production `system_settings`; the setting is re-checked live at every tick, so no restart is needed. The action is only meaningful after a publish that includes Phase 2 (the deployed app owns the scheduler).

**Verifying the first morning run** (after ~6am ET the next day), against the production DB:
1. `SELECT value FROM system_settings WHERE key = 'ads_os_pacing_refresh_last_run_date'` — must equal today's ET date (`YYYY-MM-DD`).
2. `SELECT max(updated_at) FROM ads_os_budget_pacing` and `... FROM ads_os_lsa_budget_pacing` — both fresh (same morning).
3. Deployment logs show `[AdsOsV2] Morning pacing refresh done: gads …, lsa …`.

Alternative accepted path (no internal scheduler): an external scheduler POSTs `/api/ads-os/cron/refresh-pacing` with header `X-Cron-Key: $CRON_SECRET` daily; verify the same store freshness.

### Authoritative-budget rollout and reconciliation (2026-08-19)

The read-only pre-change comparison covered all 65 configured ClickUp clients and found three GAds substitutions caused by the retired sheet fallback:

| Client | ClickUp GAds budget | Previously served |
| --- | ---: | ---: |
| O'Brien Law | $0 | $1,652 |
| MJ Law | $0 | $1,000 |
| Dellutri Law | $0 | $1,909 |

After publishing this contract, invoke the existing `POST /api/ads-os/cron/refresh-pacing` once. Its single forced ClickUp read plus the existing per-account GAds/LSA fleet paths overwrites those stale nonzero rows with null budget-derived fields; it does not introduce a backfill, route, scheduler, or polling lane. Re-run the same all-client comparison at **(product, CID)** grain against `ads_os_budget_pacing` and `ads_os_lsa_budget_pacing` (these rows are also what the combined dashboard and client profile serve). Rollout acceptance is **0 ClickUp-versus-served mismatches** across both products. If `clickup_live` is false, stop: the run intentionally preserves last-known rows and cannot be used as reconciliation evidence.

**2026-08-19 development rollout rehearsal:** the live ClickUp directory returned 65 configured clients and 63 product/CID assignments with `clickup_live=true`. The cloned development stores began with 54 mismatches because most pacing rows had not been filled. The existing fleet refresh completed `32/32` GAds and `34/34` LSA runs. The repeated all-client comparison then reported **0 mismatches** (`[]`) across the same 65-client corpus. This proves convergence on the deployed code path; repeat the one-press refresh and zero-mismatch read after Publish to bank production evidence.

**2026-08-19 production reconciliation (17:45–18:00 UTC):** the active successful VM deployment was the 17:23 UTC publish commit `eb96f3af72ba`, whose direct parent was the ClickUp-authority change `9ecb10b507d0`. A forced read-only ClickUp probe returned HTTP 200 with `live=true`, no error, and 65 clients; direct live snapshots before and after refresh each contained the same 63 product/CID assignments. Before refresh, production still held the three retired GAds values above, while the independent LSA rows already matched ClickUp. The existing `POST /api/ads-os/cron/refresh-pacing` completed once with HTTP 200 in 67 seconds: GAds `32/32`, LSA `34/34`. The final production comparison against the post-refresh 18:00 UTC ClickUp snapshot found **0 mismatches across all 63 configured product/CID assignments**. O'Brien Law (CID `1142840199`) now stores GAds `null` and LSA `$6,000`; MJ Law (`2146364898`) stores GAds `null` and LSA `$3,000`; Dellutri Law (`9446178488`) stores GAds `null` and LSA `$10,000`. The combined-dashboard member `pacing_budget` is overlaid from these stores on every request, and the client-profile `pacing.rows[].budget` reads the same rows directly, so both served projections have the same zero-mismatch result without a separate stale budget cache. No deployed read/write failure was found and no code remediation was required; the remaining values were unreconciled pre-refresh state. Sanitized timestamped captures are committed at [`docs/verification/5060/evidence/production-budget-reconciliation-2026-08-19.md`](docs/verification/5060/evidence/production-budget-reconciliation-2026-08-19.md).

> **Freshness lives in `ads_os_budget_pacing` / `ads_os_lsa_budget_pacing` — NOT `google_ads_pacing_store` (Task #4036).** `google_ads_pacing_store` belongs to the retired legacy Ads OS (`/admin/ads-os`, Task #3603); its prod copy is an orphan frozen at its last legacy write (2026-07-17) and will read "stale" forever. Migration `0138_drop_legacy_google_ads_os_tables.sql` drops it (idempotent, now in post-merge SAFE_MIGRATIONS so the next Publish diff removes the orphans from prod). When auditing pacing freshness, always check `SELECT max(updated_at) FROM ads_os_budget_pacing` — the same table the Integrations Hub Google Ads card's freshness lane reads (`getLatestAdsOsDataUpdate()`).

### Production light-up checklist (post store-outage recovery, Task #3706)

The `ads_os_*` tables are missing from **production** until the next Publish (they were
lost with the DB reset; prod never runs devMigrations, and the boot ensure only ships
with the next deploy). To light Budget Pacing back up in production, in order:

1. **Before Publish (dev):** confirm all 12 tables exist in the dev DB —
   `SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ads_os_%'`
   must return 12 (the dev server's boot ensure creates them; they're also in
   post-merge SAFE_MIGRATIONS). Replit's Publish diffs the **dev DB against the prod
   DB**, so the tables must exist in dev first or the diff won't add them.
2. **Publish (user action):** review the schema diff — it must **ADD** the `ads_os_*`
   tables (two-column jsonb shape) and nothing destructive.
3. **Enable the refresh:** press the **Enable Ads OS morning pacing refresh (~6am ET)**
   prod-action (`enable_ads_os_pacing_refresh`) in the Integrations Hub — the setting
   also vanished with the reset, so the scheduler is OFF in prod until pressed.
4. **First fill without waiting for 6am:** POST `/api/ads-os/cron/refresh-pacing` with
   `X-Cron-Key: $CRON_SECRET` against the deployed app (or wait for the next ~6am ET run).
5. **Verify:** dashboard Budget Pacing columns populate (no amber store-outage banner);
   `ads_os_pacing_refresh_last_run_date` stamps in prod `system_settings`;
   `SELECT max(updated_at) FROM ads_os_budget_pacing` is fresh. Hygiene / Traffic
   Quality columns refill on their existing on-demand buttons (no backfill).

---

## Phase 3 — hygiene audits (GAds + LSA)

### Routes (all `isAuthenticated + requireCeo`)

| Route | Payload | Cache |
| --- | --- | --- |
| `GET /api/ads-os/audit/:cid?lookback_days=&force=` | GAds hygiene `AuditReport` — 25 checks, categories, gates, next steps (+ `from_cache`) | 1h in-process + single-flight; **every run persists** `{final_score, band, generated_at, compact next_steps}` to `ads_os_audit_scores` |
| `GET /api/ads-os/audit/:cid/report.html` | Standalone HTML export (spec §6.5 sub-path), `Content-Disposition: inline` with a sanitized filename | serves the cached report when fresh |
| `POST /api/ads-os/dashboard/run-audits` | `{requested, ran, skipped, failed: [{cid, error}]}` — audits every monitored GAds account whose stored score is older than 7 days | 300s deadline, `mapPool(4)`, per-item isolation |
| `GET /api/ads-os/lsa/hygiene/:cid?force=` + `/report.html` | LSA hygiene — same `AuditReport` shape (VER-01/POL-01/BUD-02/PERF-01/PERF-02); non-enrolled accounts return band `N/A` | 1h + single-flight; persists to `ads_os_lsa_audit_scores` |
| `POST /api/ads-os/lsa/dashboard/run-audits` | LSA equivalent of run-stale-audits | same |

Single-audit routes have 120s deadlines; the usual §4 error mapping applies. Dashboard rows fill `health_score/health_band/health_at` **live from the score stores** (like pacing overlays — never through the 1h metric cache), so Hygiene columns update the moment any run persists.

### Scoring model (`audit/weightsConfig.ts` — verbatim `weights.yaml` port; gated by `tests/ads-os-hygiene-audit.test.ts`, smoke)

- **Flat impact-weighted average** across all 25 checks — impact tiers critical 12 / high 6 / medium 3 / low 1; status sub-scores good 100 / okay 60 / bad 20 / critical 0; **N/A checks are excluded entirely** (weight 0). Category scores are display-only (same math per category), they do not feed the overall.
- **Critical gates:** a `critical`-impact check with status bad/critical caps the overall at `65 − 10 × (n − 1)`, floor 10 (status *okay* never gates). All failing criticals share the single effective cap; the banner names each gate with the check's measured value. `final = min(raw, cap)`, round1.
- **Bands:** ≥90 Excellent · ≥75 Healthy · ≥60 Needs Attention · ≥40 At Risk · else Critical.
- **POL category removed** from the GAds audit per the team's 2026 re-tier (serving/policy failures → Phase 6 alerts engine; also dropped: ADS-04, OPT-02, STR-02, STR-04). The next-steps "Fix ASAP" tier holds structural failures only.
- Tunables: check thresholds live in `audit/checksConfig.ts` (checks.yaml port; env-overridable where the source supported it), weights/caps/bands in `audit/weightsConfig.ts`, `AUDIT_CACHE_TTL_SECONDS` + LSA thresholds in `config.ts`.

### Audit context (`audit/context.ts` — port of `backend/app/audit/context.py`)

- ~20 GAQL pulls run **concurrently**; each query failure isolates into `context.warnings` and its dependent checks report N/A — a query blip never fails the audit.
- Scope rules: **labeled** campaigns that are ENABLED **or spent in the last 7 days** (ENDED always skipped); ad-group/ad/keyword/asset datasets are ENABLED-only within that scope.
- Resources queried (v24 fields verified against the live field reference, 2026-07-27): `customer`, `campaign` (incl. bidding scheme fields, `optimization_score`, network settings, `metrics.search_budget_lost_impression_share`/`search_rank_lost_impression_share`), `campaign_label`, `campaign_criterion` (location/language/proximity, `negative`), `ad_group`, `ad_group_ad` (`ad.type`, `ad_strength`, RSA pinning via `ad.responsive_search_ad.headlines/descriptions`), `ad_group_criterion` (keywords + `quality_info.*` QS factors, negatives), `campaign_shared_set` (shared negative lists), `asset` + `campaign_asset`/`ad_group_asset`/`customer_asset` (`field_type`), `recommendation`. LSA: `local_services_verification_artifact.status` is the reliable signal (`expiration` can read past while PASSED; CANCELLED = superseded submission; UNSPECIFIED/blank = legacy verified — informational only, never a failure).

### Report UI (`/ads-os/a/:cid/audit`, `/ads-os/lsa/a/:cid/hygiene`)

Auto-runs on open (cache makes this cheap), Re-run forces past the 1h cache, Export HTML opens the `/report.html` sub-path. Gauge + band hero, gate banner (red when the cap binds, amber otherwise), per-category cards with per-check rows (status dot, evidence, recommendation), next steps tiered **Critical / Easy wins / Schedule for this week**; step chips scroll-flash to their source check. LSA not-enrolled renders the not-enrolled panel, not an error.

### Stale audits (`staleAudits.ts`)

"Run stale audits" buttons re-audit accounts whose stored score is `> 7 days` old (`STALE_DAYS = 7`, missing/unparseable → stale). Audits are on-demand only — opening a report or the dashboard button; the morning cron does **not** run audits (kept on-demand in Phase 6 — the cron covers pacing + alerts + digest + ticket reconcile only).

---

## Phase 4 — Search Term Analyzer (spec §6.6)

### Routes (all `isAuthenticated + requireCeo`, 120s deadlines, §4 error mapping)

| Route | Payload | Cache |
| --- | --- | --- |
| `GET /api/ads-os/keyword-intel/:cid?lookback_days=7\|14\|30&force=` | Negatives report — paste-ready suggestions (broad plain / `"phrase"` / `[exact]`) with category, confidence, reason, per-term metrics, covers-N note, converting-term caution; traffic quality + coverage; honesty warnings (+ `from_cache`) | 1h in-process + single-flight keyed `{cid}:{window}`; **every run persists** traffic quality + per-window pending negatives (`negatives_by_window`) to `ads_os_traffic_quality` |
| `GET /api/ads-os/keyword-intel/:cid/keywords?lookback_days=&force=` (default 30d) | New-keyword report — phrase suggestions with reason, held-back conflicts (blocking negative + category + reason + Dismiss), `actioned_hidden` / `account_blocked` counts, honesty warnings | 1h + single-flight for the base; actioned + negatives cross-check overlay recomputed **live per request** |
| `POST /api/ads-os/keyword-intel/:cid/keywords/actioned` `{search_term, undo?}` | `{ok: true}` — mark a suggestion added/dismissed; undo reverses | `ads_os_keyword_actioned` (the broken module's `google_ads_actioned_keywords` table stays untouched) |

OpenAI unconfigured → **503** on the negatives route — the spec's one AI-is-the-feature case; an OpenAI call failure → 502. Saving criteria (PUT) invalidates this account's analyzer cache (plus pacing, as before). Negatives are **never** suppressed by the actioned store (only keyword suggestions are).

### Negatives engine (`keywordIntel/` — ported from `backend/app/keyword_intel/*`, prompts verbatim)

- Pulls (labeled campaigns **regardless of status**; v24 fields verified 2026-07-27): [`search_term_view`](https://developers.google.com/google-ads/api/fields/v24/search_term_view) served terms + metrics, ENABLED `ad_group_criterion` keywords, `campaign_criterion` geo names via `geo_target_constant`, keyword-level spend (coverage denominator).
- Protected sets: stem-aware words (trailing-s fold; never double-s / ≤3 chars) from business name + website brand tokens + services offered + extra protected terms + practice areas + **active keywords**; protected geo from the criteria service area (US state abbr ↔ full name, DC → washington) + campaign geo names.
- Review: highest-cost-first, capped `KI_MAX_TERMS=500` (beyond-cap → honesty warning), batches of 40 reviewed concurrently with the reason-first prompt (intent summary → KEEP test → verdict, categories, broad self-test, geo rules) via OpenAI Structured Outputs. A failed batch → warning + `incomplete` flag on the persisted window; only total failure throws.
- Deterministic safety filter (`safety.ts`): hallucinated-term drop, protected enforcement (broad = ANY protected word drops it; phrase/exact = ALL words protected), dedupe across terms (summed metrics, max confidence, covers-N note), asymmetric floors — broad ≥ 0.8 (below → **downgrade to whole-term phrase**, not dropped), phrase/exact ≥ 0.6 or ≥ 0.45 for informational/job_seeker.
- Converting-term caution: every kept suggestion runs through the negative-match simulator (broad any-order / phrase contiguous / exact identical, **no close variants**, 1-char tokens kept) against ALL in-window converting terms — including terms the model kept; blockers get the amber per-row caution (top-3 by conversions, `+N more`). Provably correct per #3145 via `tests/ads-os-keyword-intel-engine.test.ts`.
- Traffic quality `= (analyzed − wasteful) ÷ analyzed spend`; coverage `= analyzed term spend ÷ total keyword spend`; no wasteful terms → clean 100%. Persisted every run; the GAds dashboard **Traffic-quality pill** (green ≥90 / amber 70–89 / red <70) reads the store live per row, with window/age/coverage in the hover.

### Keyword finder (`keywordFinder.ts` — rules-based, no AI)

- Converting terms (`conversions ≥ KI_MIN_CONVERSIONS`, default 1.0) with CPA ≤ their campaign's average become phrase suggestions; campaigns without a CPA baseline are skipped; terms already covered by active keywords are skipped (`keywordTupleKey`); terms blocked by **live** account negatives (campaign + ad group + shared sets) are skipped with the `account_blocked` count.
- Cross-check: each negatives run persists pending suggestions per lookback window — window W supersedes ≤W, 30-day expiry, legacy flat docs migrate under their stored lookback. The finder unions all live windows (largest window wins category/reason) and holds clashing suggestions back into the amber section with the blocking negative + reason; per-row Dismiss = mark actioned (undo-able). Honesty warnings when the negatives review is narrower than the finder window, incomplete, or has never run. Re-running negatives self-heals held-back rows.

### UI (`/ads-os/a/:cid/analyzer` chooser → `…/negatives`, `…/keywords`)

Both direct tool routes show the same persistent, route-aware mode switch (`Negative Keywords` / `New Keywords`), with the current mode active and keyboard tab semantics; the chooser route remains supported for existing links. Both tools auto-run on open with a 7/14/30 window selector (negatives default 7d, keywords 30d). Negatives: stat tiles (incl. traffic quality + coverage), sortable table (metrics/category/confidence/reason), checkbox selection + Copy selected, campaign-level Google Ads Editor CSV with the own-campaign vs all-campaigns dialog, criteria editor + sparse-criteria hint. Keywords: rule-hint tile with skip counts, Add-to-plan ✓ flow, ad-group-level Editor CSV, held-back table with Dismiss. CSV builders in `lib/adsEditorCsv.ts` (ported verbatim). Tests: `tests/ads-os-keyword-intel-safety.test.ts` (smoke — safety filter + prompt fidelity), `tests/ads-os-keyword-intel-engine.test.ts` (engine/finder orchestration via resolve-hook stubs), and `tests/client/ads-os-analyzer-mode-tabs.test.tsx` (DB-free direct-page mode discovery and keyboard switching).

---

## Phase 6 — Client profile, alerts & polish (spec §6.4, §6.10, §3.4, §3.5, §5)

### Routes (all `isAuthenticated + requireCeo`; cron is X-Cron-Key)

| Route | Payload | Cache |
| --- | --- | --- |
| `GET /api/ads-os/client/profile?name&window&compare` | Assembled per-client page: maroon hero (combined spend/leads/blended CPL + deltas, combined pace, per-account mini split, Doer/Checker, alerts chip, combined budget), jump-nav, pacing rows + Combined, hygiene snapshot + "Run audit" chips, Pyramid tile (Phase 5 snapshot), traffic-quality gauges, tools rows with Ads-Status chips | Combined-dashboard cache + stores — **zero Ads API calls when warm** |
| `GET /api/ads-os/client/performance?name&start&end` | Zero-filled daily per-account series incl. Off accounts (GAds = labeled cost+conversions; LSA = LOCAL_SERVICES cost + charged leads by lead **creation** date); end clamped to yesterday, span ≤ 400d; per-account failure → `failed: true` (amber chip), never silent zeros | 1h; 120s while any account failed |
| `GET /api/ads-os/client/log-summary?name&force=` | 30-day AI summary of the sheet's "Optimizations & Ideas" tab (service-account read); spec state codes rendered as plain English; failed refresh → last good summary with `stale: true` + `refresh_error` | ~1 day per sheet; `force=1` regenerates |
| `POST /api/ads-os/dashboard/run-alerts` · `POST /api/ads-os/lsa/dashboard/run-alerts` · `POST /api/ads-os/combined/dashboard/run-alerts` | Recompute + persist alerts for the badges — per-product for the GAds/LSA dashboards, both products for the Main Dashboard's Refresh (spec §8; no digest, no ticket create). All return the run summary `{gads_accounts, lsa_accounts, total_alerts, digest}`; the dashboards surface a notice when the run fails or resolves 0 enrolled accounts | — |
| `GET /api/ads-os/clients/:cid/sibling` | Same client's other-product account (breadcrumb "also runs ↗" pill); `{}` when none **and** on directory failure (best-effort) | directory bundle |
| `GET /api/ads-os/clickup/enabled` · `POST /api/ads-os/clickup/task` | Ticket support flag · create-or-return the open ticket for one alert (503 when `CLICKUP_API_TOKEN` absent; button hidden client-side) | ticket status ~90s |
| `GET /api/ads-os/health` · `GET /api/ads-os/accounts/:cid/probe` | Liveness + credentials presence · end-to-end GAQL proof | — |

`POST /api/ads-os/cron/refresh-pacing` now runs the **whole morning routine**: pacing for every enrolled account → all alerts recomputed → ClickUp tickets reconciled → Slack digest. The 6am ET scheduler runs the same body.

### Alerts engine (`alertsEngine.ts` + `alertsQueries.ts`)

- **GAds**: `account_suspended` (critical, short-circuits campaign checks) → per-campaign: `no_impressions` on a scheduled day (criteria `schedule_days`, served-history same-weekday fallback when unset), `spend_spike` vs 7-day active-day average (strictly > +200%, medium), `no_conversions` over the 7-day window (high, ENDED campaigns excluded), disapproved/limited/under-review ads (policy-topic reasons), SEARCH can't-serve (no eligible ads/keywords; SDA exempt from the keyword check), PMax `asset_group.primary_status` serving states (all-bad / mixed split / PENDING-only quiet / failed-query skip), disapproved vs limited assets. **LSA**: suspended, all-paused, verification failed (latest artifact per type; a PASSED supersedes), no charged leads in 7d vs prior-30 history.
- Ads-Status `Paused` suppresses the expected-while-paused codes **before persist**; `Off` clears the account's alerts row. Persisted per `{product}:{cid}` → dashboard ⚠ badges (worst-severity colored) + "Needs attention only" filter + profile alerts chip.
- **Slack digest** (`alertsNotify.ts`): Block Kit post to `SLACK_WEBHOOK_URL`, critical+high only, grouped per account, **only-on-change** via `{code}:{campaign_id}` fingerprints — sent once, never re-nagged; cleared accounts self-heal (re-alert allowed later); failed runs (`null`) leave snapshots untouched; delivery failure or unset webhook keeps alerts pending for the next run. No webhook = digest disabled, badges unaffected.
- **ClickUp tickets** (`alertsTickets.ts`): per-alert create into the product's Tickets list, name = alert title, detail + account/deep-link footer, due today, space-level Client dropdown matched by name via the alias table; idempotent while open (map keyed `{product}:{cid}:{alert_code}`); button flips Create↔View from live state, reconciled by cron/Refresh.

### Profile & performance frontend

- `/ads-os/client/:name` (`ClientProfile.tsx`): hero → jump-nav → pacing → hygiene → pyramid → performance → AI log summary (loads async, never delays the page) → tools. Charts (`PerformanceSection.tsx` + `PerfChart`/`PerfComposition`/`RangeSelector`): **all derivation in the browser** — presets (30/14/7, MTD, last month, 3/6/12 full calendar months, custom), Daily/Weekly-Monday/Monthly buckets with dimmed "(partial)" edges, timeframe switches never refetch; Overview card (Spend+Leads donuts, CPL-by-account bars — never a pie, blended spend-area·leads-line·CPL-bars trend) + collapsed 3-up per-account mini cards (own scales, no dual axes); attribution-lag footnote.
- **Performance breakdowns (Task #3912):** multi-account clients get a collapsible **"By channel"** row (GAds vs all-LSA-combined; rendered only when both channels are among the included accounts) between the Overview card and "By account". Header: segmented battery bar + "GAds N% · LSA N% of spend". Expanded: "Share of this range" spend/leads split bars, a platform table (per-channel Spend/Leads/CPL with delta chips + account counts), and per-channel combined trend rows honoring the timeframe control. The "By account" header carries its own battery (account palette, payload order) + "N accounts · X drives Y% of spend" top-spender summary. Both breakdowns aggregate exactly the #3900-visible set (plus revealed idle accounts) — Ads Status never filters, comparison-window-only spenders count — and a channel containing a metrics-failed account shows the "data didn't load" chip with its deltas suppressed. Helpers `channelBreakdown`/`spendBattery` in `PerformanceSection.tsx`, locked by the perf-bucketing suite; channel colors are the `--chan-gads`/`--chan-lsa` theme variables.
- **Performance account visibility is activity-based, never status-based (Task #3900):** ClickUp Ads Status cannot hide an account — Off/Paused accounts render (with their status chips) whenever the selected range **or** the loaded comparison period saw any spend or leads. Only accounts confirmed idle in every applicable window collapse behind a muted "N accounts with no activity — show" reveal (overview table, composition, breakdown cards; the "By account" count follows). Uncertain data never hides (comparison loading/failed and `metrics_failed` placeholder zeros keep an account visible), an all-idle client renders unfiltered (never a blank section), blended KPIs/donuts/trend still sum every account (idle = zeros), and colors stay keyed to payload order so reveals never reshuffle them. Rule: `accountVisibility` in `PerformanceSection.tsx`, locked by the perf-bucketing suite.
- Polish: ⌘K "Jump to…" palette (clients, GAds/LSA accounts, pages), breadcrumbs with searchable account/client switchers + sibling pill, spinner-with-sentence loading states and red error panels with retry on every page.
- Tests: `tests/ads-os-alerts-notify-clientlog.test.ts` (smoke — severity matrix, suppression, digest fingerprints, client-log parsing/state codes) and `tests/client/ads-os-perf-bucketing.test.tsx` (smoke — presets/bucketing/blending).

---

## Phase 7 — AM Dashboard (Task #3988)

The daily entry point into client accounts (`/ads-os/am`, "AM Dashboard" tab): one launch card per client with ≥ 1 account subtask — full book, Off accounts included — with per-account launch buttons, Ads-Status chips carrying the nightly ✓/✗ verification, Doer/Checker tags, ⚠ alert badge + dropdown, Client Log and "Open all LSA".

### Routes

| Route | Behaviour |
| --- | --- |
| `GET /api/ads-os/am/dashboard` | Whole board in one payload (`buildAmDashboard`): one cached directory read + one bulk alerts read (single SELECT over `ads_os_account_alerts`) + one status-check doc read. Clients sorted case-insensitively, GAds rows before LSA, labels `Google Ads` / `LSA - <City>` / `LSA`, deep link resolution ClickUp field → seed → null, alert roll-up (critical/high/medium counted; unknown severities listed, never counted), `clickup_ok`/`degraded` flags, `status_checked_at` from the check doc. Zero Ads API calls. |
| `POST /api/ads-os/am/dashboard/refresh` | Verification **first**, then the alert orchestrator (`runAlerts(false)` — no digest). Phases isolated in both directions; always 200 with per-phase outcomes `{status_checks, alerts}` (each carries its own `error`/`skipped` marker). 503 `AdsOsCredsMissing` only when the Google Ads creds are absent up front. |

`POST /api/ads-os/cron/refresh-pacing` (and the 6am ET scheduler body `runAdsOsPacingRefresh`) now **prepends the verification phase** before pacing + alerts; a computed batch that fails to persist logs loudly (`console.error`) rather than pretending success.

### Status verification (`statusCheck.ts` + `ads_os_status_checks` store)

Nightly proof that ClickUp's Paused/Off claims hold: targets are the enrolled ClickUp-Paused/Off accounts, scoped per product — one GAQL query each (`campaign.status = 'ENABLED' AND campaign.serving_status != 'ENDED'`, `advertising_channel_type =/!= LOCAL_SERVICES` for LSA/GAds). The whole batch persists as **one document** (key `all`) with per-account `{expected, matches, enabled_campaigns, enabled_campaign_names(≤5×80ch), checked_at}` or `{expected, error, checked_at}`; one shared `generated_at` per batch. Three **keep-last-batch guards** (previous verdicts survive, each logs its case): ClickUp directory down → `{skipped:"clickup_unavailable"}`; zero Paused/Off targets → `{skipped:"no_targets"}`; every account errored → `{skipped:"all_errored", errors:N}`. Chip states on the board: grey `✓` (claim holds), orange+ring `✗` naming ≤3 offending campaigns (`mismatch` class), bare chip + tooltip when unreachable or never checked; On accounts show no chip; board-level banner until the first batch exists.

### Deep links (`clickUpDirectory.ts` + `amDeeplinksSeed.ts`)

The directory captures a per-account launch URL from any subtask custom field whose **name** contains "account link" or "deep link" (case-insensitive substring; value trimmed; http/https only; last-write-wins among valid values), exposed via `clickUpDeepLinks()`. Resolution order per account: ClickUp field → 46-entry `AM_DEEPLINKS_SEED` (static TS import — survives the CJS prod bundle) → null ("no link yet", counted in the board footer). Launch semantics: GAds links reuse a **named tab** per account (`gads-<cid>`, deliberately no `noopener` so re-clicks refocus), LSA links open plain new tabs, "Open all LSA" (shown only when a client has >1 linked LSA account after filtering) opens all synchronously in one click.

### Board UI (`AmDashboard.tsx`, `StatusChip.tsx`, `lib/amFilters.ts`)

CSS multi-column masonry (`columns`), content-height cards, maroon header linking to the client profile. Toolbar: search (client names OR CIDs, hyphens/spaces ignored), Ads-manager/Checker selects (only people in the data, first names), platform toggles (hide accounts, drop emptied clients), visible-set count, Refresh (disabled while running, distinct message per failure mode). Filters persist to localStorage and mirror into the URL (defaults omitted); **any** query string means every param is URL-specified — a shared link reproduces the sharer's exact view — and saved filters naming departed people reset to "all". Alert badge: amber when ≥1 critical/high, grey when medium-only, absent when clean; dropdown lists every alert (severity dot, product tag, account label, detail), closes on Escape/outside click, renders above neighbouring cards (cards are not `overflow: hidden`). `StatusChip` is shared-ready for the client profile overlay (follow-up).

Tests: `tests/ads-os-am-status-check.test.ts` (smoke — deep-link capture/seed, payload sort/roll-up/precedence, verification sweep + all three guards), `tests/ads-os-am-filters.test.ts` (smoke — URL/localStorage semantics, search pipeline), `tests/ads-os-am-chip-render.test.ts` (smoke — the four chip states), `tests/ads-os-am-refresh-route.test.ts` (sweep — route auth, phase isolation both directions, verification-before-alerts order, morning-job prepend).

---

## Paid Search role contract

Paid Search uses the final capability-based assignment model:

- Every department supports **Doer**.
- **Checker** exists only for stable department UUIDs approved in
  `shared/departmentRoleCapabilities.ts`. Paid Search is checker-capable.
- Department display names are not capability keys. A new or renamed
  department defaults to Doer-only until its UUID is explicitly approved.
- The live assignment, import, display, and projection paths consume only Doer
  and capability-approved Checker. Retired responsibility columns or values may
  remain as migration residue or historical evidence, but are never effective,
  displayed, imported, edited, or projected.

### Authority and display

The canonical production Client List **`901417549202`** remains authoritative
for enrollment, budget, Ads Status, grouping, client-log, and ClickUp directory
facts. The Ads OS role overlay resolves Doer/Checker through the universal
NoBull assignment boundary; no sandbox is a read source.
Google Ads remains read-only.

Firm bindings are exact, case-insensitive, and unique on both sides. Duplicate
names, blank or multi-person People values, unmapped parents, and conflicting
identities fail closed rather than being guessed or truncated.

### Canonical ClickUp projection

The only Paid Search production role destinations are the existing People
fields:

| Responsibility | People field ID |
| --- | --- |
| `doer` | `21335dc5-98ba-470c-b8a9-944e3cfed343` |
| `checker` | `0bfb4a38-47e4-4343-bb83-051a9fd40122` |

These IDs are literal and not environment-overridable. Ordinary NoBull edits
stage generic durable role-projection commands. The worker re-validates the
stable Paid Search department UUID, canonical list, exact People field, fresh
target, identity, destination approvals, Paid Search write approval, and
`projectionWritesEnabled` before mutation. Unsupported responsibilities,
wrong fields/lists, ambiguous departments or targets, and stale identities are
denied.

The generic `clickup_role_projection` kill switch pauses writes only; NoBull
assignments and Ads OS reads remain intact. Destination configuration/status
and bounded repair use the Service Desk role-projection APIs documented in
[CLICKUP.md](./CLICKUP.md#company-token-outbound-role-projection-task-5156).

### Import evidence is historical and immutable

The historical one-time resumable `import_paid_search_roles` action was defined
to read canonical Doer/Checker values into NoBull without writing ClickUp.
`ps_role_import_audit` retains any compact per-parent/role resume state and
`ps_role_import_attempts` retains append-only attempt evidence. Do not delete,
rewrite, or reinterpret those records during role cleanup; retired role residue
is not a reason to mutate historical audit evidence.

---

## Ops playbook

### Integration probe failures

**Google Ads 503 / AdsOsCredsMissing:** one or more of the five credential env vars is missing. Check which ones via `GET /api/ads-os/status`.

**Google Ads 503 "quota":** developer-token daily quota hit. Resets automatically — wait and retry.

**ClickUp 503:** `CLICKUP_API_TOKEN` missing. Set it in Replit Secrets.

**OpenAI 503:** both `OPENAI_API_KEY` and `AI_INTEGRATIONS_OPENAI_API_KEY` are missing.

### Adding an account to monitoring

Set the account's "Ads Status" field (subtask in the ClickUp Client List, list `901417549202`) to `On` or `Paused`. The directory refresh (10-min cache) picks it up. No code change needed.

### Pacing pill missing / stale on a dashboard

Pills read the pacing stores; a store row appears when any pacing run persists. Fixes in order: open the account's pacing tool (auto-runs + persists), press **Re-run** there (forces past the 1h cache), or refresh everything via `curl -X POST .../api/ads-os/cron/refresh-pacing -H "X-Cron-Key: $CRON_SECRET"`. For unattended mornings, enable the `ads_os_pacing_refresh_enabled` setting (deployment only; `ADS_OS_PACING_REFRESH_FORCE_ENABLE=1` in dev). A pill stays empty when ClickUp has no positive budget for that product/CID — check the tool's budget-source line and the `clickup_live` health indicator. An enrolled account with **no labeled campaigns yet** (GAds) or **no Local Services campaigns yet** (LSA) still persists a **budget-only row** when ClickUp has a positive budget (Task #4975 — spend/pace stay `—` until the campaigns exist). A successful ClickUp zero/blank persists an all-null summary to clear old pacing values; an outage does not.

### "Where is account X?" — absent or flat-zero in profile Performance

The performance payload deliberately includes **every** enrolled account of the client — Off and Paused too — and the UI hides only accounts with zero spend **and** zero leads in the selected range and the loaded comparison period; those sit behind the "N accounts with no activity — show" note, never gone (ClickUp Ads Status never hides an account, and if every account is idle nothing is filtered at all). If an account is truly absent from the payload, or charts flat zeros despite known past spend, there are exactly two real mechanisms:

1. **The account is no longer ENABLED under the MCC** (cancelled/closed at Google). Account discovery is ENABLED-only and the Ads API refuses to report on cancelled accounts — its history is unqueryable. This is a Google-side hard stop; document it for the client, don't chase it.
2. **The GAds series counts only `NBM_GADS_MONITOR_CAMPAIGN`-labeled campaigns** (deliberate parity with the dashboards). Spend in unlabeled campaigns never charts — label the campaigns if they should count. (LSA differs: all `LOCAL_SERVICES` campaigns count.)

### Alerts digest didn't post / posts nothing

Silence is usually by design: nothing **new** (fingerprints in `ads_os_account_alerts_notified` already cover every current critical/high), no critical/high alerts at all (clean book sends nothing), or `SLACK_WEBHOOK_URL` unset (log: `SLACK_WEBHOOK_URL unset — N new alert(s) not sent`; badges still work). A Slack delivery failure leaves alerts pending — they retry on the next cron/refresh. Recompute badges via the dashboards' Refresh (`POST /api/ads-os/dashboard/run-alerts`, no digest) or run the full routine via the cron endpoint.

### ClickUp ticket button missing / wrong on an alert

`CLICKUP_API_TOKEN` absent → `GET /api/ads-os/clickup/enabled` is false and the button is hidden (`POST /api/ads-os/clickup/task` 503s). If a ticket was closed in ClickUp but the button still says View (or vice versa), wait ~90s (status cache) or press the dashboard Refresh — the cron also reconciles every morning.

### Budget wrong or missing in the pacing tool

Check the ClickUp Client List's product subtask and CID. Its "Paid Search Budget" is final: a positive value is served only for that product/CID; zero or blank means `monthly_budget: null` and clears old budget-derived pacing fields after a successful refresh. GAds and LSA can share one CID without sharing budgets. The retired Google Sheet is never consulted. ClickUp edits normally appear within the directory cache window (~10 minutes); **Re-run** refreshes one account's pacing cache, while the fleet cron forces one fresh directory read before fan-out. During a ClickUp outage (`clickup_live:false`), Ads OS may display the last cached ClickUp value and intentionally leaves persisted summaries unchanged—restore ClickUp health before diagnosing a budget mismatch.

### Google Ads auth is down (dashboards 503 "OAuth token exchange failed")

1. Mint a fresh refresh token **under the same OAuth client as `GOOGLE_ADS_CLIENT_ID`** (a token minted under any other client fails with `401 unauthorized_client`), then update the `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` / `GOOGLE_ADS_REFRESH_TOKEN` secrets as a matching trio.
2. **Restart the app** — long-lived processes keep stale env values after a secret edit, and the restart also clears the 5-min negative cache on terminal 4xx rejections.
3. Confirm via `GET /api/ads-os/status` (`refreshTokenSource`: `env` | `none`) and `GET /api/ads-os/accounts`.

Since Task #4008 this same env trio powers **every** Google Ads surface
(hygiene, discovery, campaign sync — not just Ads OS), so an auth-down state
here also stalls those; the full rotation runbook lives in `GOOGLE_ADS.md`.
There is no in-app reconnect — rotation is a secrets edit + restart.

---

*See spec: `attached_assets/NBM-Ads-OS-System-Spec_1785137380517.md`*
*Source bundle: `attached_assets/nbm-ads-os-source-code_1785137380518.txt`*
