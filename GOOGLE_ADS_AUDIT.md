# Google Ads Hygiene Audit Runbook (Task #2784)

## Scope
Admin-only (`/admin/ads-hygiene`, CEO-tier gate) read-only audit of a
connected Google Ads account (reuses Task #1759's MCC connection — no new
OAuth, no write-back to Google Ads). Scores account hygiene against a
law-firm-specific checklist across 8 categories and surfaces a ranked
report with per-check detail and a persisted history of runs.

**Out of scope (intentionally):** any mutation of the Google Ads account,
new OAuth flows, scheduling/automation of audits, non-CEO access.

## Architecture
- **Checklist config:** `server/config/googleAdsAuditChecks.ts` — 8
  weighted categories (`CHECK_CATEGORIES`, weights sum to 1.0), ~24
  checks (`AUDIT_CHECKS`, each with an intra-category weight), and gates
  (`AUDIT_GATES`) that cap the final score when a critical condition
  fires. Discrete checks map status → score via `DISCRETE_STATUS_SCORE`
  (good=100, okay=70, bad=35, critical=0); continuous checks derive a
  0-100 score from a measured ratio via ordered bands.
- **GAQL data pull:** `server/services/googleAdsAuditQueries.ts` — reuses
  `gaqlSearchStream` / `buildSyncCustomerQueries` from
  `googleAdsIntegration.ts` (same client, tokens, and API version as the
  Task #1759 daily sync). Pulls account status, optimization score,
  recommendations, campaign/geo/language settings, negative keyword
  sets, search terms, keyword quality scores, ads, asset links, policy
  topics, audience signals, and conversion actions.
- **Scoring engine:** `server/services/googleAdsAuditEngine.ts` —
  `runGoogleAdsAudit(customerId, opts)` fetches live data, evaluates
  every check, computes category-weighted `H` (raw) and `H_final`
  (after gate caps), persists the run + per-check rows, and returns an
  `AuditReport`. `buildAuditReportFromRun` reconstructs the same shape
  from persisted rows for viewing past runs.
- **Persistence:** `shared/models/googleAdsAudit.ts` —
  `google_ads_audit_runs` (one row per audit trigger: status, scoreH,
  scoreHFinal, triggeredBy, metadata) + `google_ads_audit_check_results`
  (one row per check per run: status, score, measuredValue,
  affectedEntities, recommendedFix). Tables are lazily self-created by
  `ensureGoogleAdsAuditTables()` in
  `server/storage/googleAdsAuditStorage.ts` — no dedicated migration
  file.
- **Routes:** `server/routes/googleAdsAudit.ts`, all gated
  `isAuthenticated` + `requireCeo`:
  - `GET /api/admin/google-ads-audit/accounts` — connected, non-manager
    Google Ads accounts (from `google_ads_customers`, Task #1759).
  - `POST /api/admin/google-ads-audit/:customerId/run` — triggers a
    fresh audit (read-only GAQL calls only).
  - `GET /api/admin/google-ads-audit/:customerId/runs` — recent run
    history for the account.
  - `GET /api/admin/google-ads-audit/runs/:runId` — a specific past
    report.
- **UI:** `client/src/pages/admin/GoogleAdsHygieneAudit.tsx` — account
  picker, "Run new audit" action, past-run picker, overall
  `H`/`H_final` score with triggered-gate explanations, 8 category
  sub-scores, and an accordion of per-check detail (status, measured
  value, affected entities, recommended fix). Reachable from the
  Quicklinks "System" cluster (CEO-only) and directly at
  `/admin/ads-hygiene`.

## Gates
Gate definitions live in `AUDIT_GATES` in
`server/config/googleAdsAuditChecks.ts`. A fired gate caps `H_final`
below the raw weighted `H` and is surfaced in the UI with its cap value
and a plain-language explanation — the raw `H` is still shown alongside
so an operator can see how much a single critical issue is depressing
the account's overall hygiene score.

## Extending the checklist
Add a new check to `AUDIT_CHECKS` (with category id, weight, kind,
description, and fix template), implement its evaluation in the
`evalCheck` switch in `googleAdsAuditEngine.ts`, and add any new GAQL
query it needs to `googleAdsAuditQueries.ts`. Keep intra-category
weights summing to 1.0 and re-verify category weights still sum to 1.0
in `CHECK_CATEGORIES`.
