# NoBull OS Runbooks

This document is the canonical index of operator runbooks for NoBull OS. Use `replit.md` for the short architecture overview and runtime truth; use this file to find the right runbook for an integration, pipeline, worker, or operational subsystem.

## Runbook Index

Top-level operator runbooks. Each is the canonical reference for its subsystem; the System Architecture bullets above are summaries that link here.

| Runbook | Covers |
| --- | --- |
| [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md) | Recurring meetings — kill switches, flag flip procedure, incident playbook, verification harness. |
| [CLERK_RESTRICTED_SIGNUP.md](./CLERK_RESTRICTED_SIGNUP.md) | Clerk Restricted sign-up (allowlist) — per-environment CEO flip procedure, manual stranger-cannot-sign-up verification checklist, automated smoke coverage. |
| [TWILIO.md](./TWILIO.md) | Twilio core configuration, browser-audio vs forward modes, call-recording compliance. |
| [TWILIO_VOICEMAIL.md](./TWILIO_VOICEMAIL.md) | Inbound voicemail TwiML, webhooks, playback proxy, listened-state, inbox UI. |
| [TWILIO_RECORDING_ARCHIVE.md](./TWILIO_RECORDING_ARCHIVE.md) | Recording archive to object storage + Drive mirror + Twilio purge + match reconciler. |
| [CALL_ANALYSIS.md](./CALL_ANALYSIS.md) | Typed failure-reason classification for `call_analysis_jobs` plus the one-off backfill. |
| [LEADS.md](./LEADS.md) | Lead intake & lifecycle stages — forward-only ladder on `clients`, inquiry/booking intake, auto-deal settings, prospect gating contract, `/leads` view; deal tags/segments/scoring + stage automation (`deal_automation_enabled` kill switch). |
| [ASYNC_CORRECTNESS.md](./ASYNC_CORRECTNESS.md) | Async-correctness lint (typescript-eslint) — the four gated rules, count-baseline + ratchet semantics, and the `void` fire-and-forget annotation convention. |
| [COMPLETION_REBASE_TRIAGE.md](./COMPLETION_REBASE_TRIAGE.md) | "Main moved during completion validation" protocol — quiesce, scripted conflict triage (`scripts/rebase-conflict-triage.ts`: generated artifacts regen on the rebased tree, memory-index union, lockfile reinstall, unknowns fall open to manual), residual resolution, merge-integrity pass, single incremental revalidation. |
| [KNIP_AUDIT.md](./KNIP_AUDIT.md) | Periodic warning-only Knip audit — pinned `npm run audit:knip` invocation, repository-aware config model, expected steady-state findings, documented classifications (`gsap`, `express-serve-static-core`), deletion protocol; never part of the merge gate. |
| [REQUEST_OBSERVABILITY.md](./REQUEST_OBSERVABILITY.md) | App-wide request spine — access log + request IDs (`rid=` grep flow), per-route p50/p95 metrics panel/API, sustained-regression alert config, global JSON error middleware + `asyncHandler` migration. |
| [COMMS.md](./COMMS.md) | Internal Comms — full subsystem runbook: status model, scheduled delivery queue, incoming webhooks + slash commands, custom emoji, notification resolution, voice/video calls (LiveKit), call lifecycle, room webhook auto-end, recording pipeline. |
| [COMMS_PARITY.md](./COMMS_PARITY.md) | Slack-parity tracker for Internal Comms — shipped-feature checklist per category and the remaining gap summary. |
| [ZOOM_REVIEW_QUEUE.md](./ZOOM_REVIEW_QUEUE.md) | Manual review queue for non-deterministic Zoom recordings; trend snapshot + bulk actions. |
| [INTEGRATION_STATUS_CACHE.md](./INTEGRATION_STATUS_CACHE.md) | Integrations Hub badge cache — probe outcome contract, shared loaders, boot-time prewarm, measured "Checking…" window on redeploy. |
| [GOOGLE_ADS.md](./GOOGLE_ADS.md) | Google Ads integration — single env-credential model (Task #4008), shared token mint, rotation runbook, daily campaign + keyword sync worker, kill switches, admin card. |
| [ADS_OS.md](./ADS_OS.md) | Ads OS rebuild — NBM paid-search operations console: config seam, Google Ads read-only client, ClickUp Client List, OpenAI structured outputs, jsonb store layer, alert digest, phase map, ops playbook. |
| [SEMRUSH_MAPPING.md](./SEMRUSH_MAPPING.md) | Canonical `applySemrushLocationMapping` helper and its narrow exception to the Import Write Policy. |
| [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md) | Queue drain control, backlog alerts, pause-baseline backfill. |
| [MANUAL_RESERVE_RESEND_ATTRIBUTION.md](./MANUAL_RESERVE_RESEND_ATTRIBUTION.md) | One-off backfill that attributes older manual-reserve alert resends. |
| [COMMAND_PANEL_BUDGET_GAPS.md](./COMMAND_PANEL_BUDGET_GAPS.md) | Command Panel product-without-budget gaps — audit query + 2026-08 snapshot (dev + prod offenders), read-view "Budget missing" notice, close-the-gap procedure, persistence-policy decision. |
| [TESTING.md](./TESTING.md) | Test suite and CI control plane — hermetic DB, selection/green evidence, flake quarantine, shards, duration budgets, canary/watchdog roles, pre-deploy gate, and the owner-approved task-agent read-only boundary; scheduled and operator-run validation remain intact. |
| [NOTIFICATIONS.md](./NOTIFICATIONS.md) | Per-user in-app notification inbox — categories, recipient helpers, wired event sources, contract for new sources. |
| [PROD_REMEDIATION.md](./PROD_REMEDIATION.md) | Production remediation playbook (Front receiver, Slack auth circuit breaker, `pg_stat_statements`, Neon cold-start bootstrap auth timeout). |
| [OPENAI.md](./OPENAI.md) | OpenAI usage across services — models, retry, fallback, quota incidents. |
| [STRIPE.md](./STRIPE.md) | Stripe billing — local mirror via `stripe-replit-sync`, webhooks, key rotation. |
| [BOOK_FUNNEL_LAUNCH.md](./BOOK_FUNNEL_LAUNCH.md) | Paid book-funnel launch verdict and evidence, policy versions, Digital/Complete readiness blockers, immutable purchase snapshots, pending live-vendor/performance checks, and the inactive provider-neutral fulfillment boundary. |
| [FRONT.md](./FRONT.md) | Front ingestion, normalize/apply pipeline state machine, hard-match, bulk actions, historical recovery. |
| [ZOOM.md](./ZOOM.md) | Zoom OAuth + granular scopes, OAuth app rebuild procedure, meeting create, deterministic booking match, backfills, alerts. |
| [GOOGLE_CALENDAR.md](./GOOGLE_CALENDAR.md) | Per-AM OAuth, free/busy, event lifecycle, recurrence semantics. |
| [GOOGLE_DRIVE.md](./GOOGLE_DRIVE.md) | RETIRED integration (Task #4084) — retirement record + the surviving service-account Sheets read lane. |
| [GEOSPATIAL_APIS.md](./GEOSPATIAL_APIS.md) | Google Maps (geocoding + Places), MapTiler basemap, FCC Census Block API. |
| [SEMRUSH_HEATMAP_PIPELINE.md](./SEMRUSH_HEATMAP_PIPELINE.md) | SEMrush heatmap + Local Dominance pipeline, circuit breaker, retry, ghost cleanup. |
| [PANDADOC.md](./PANDADOC.md) | PandaDoc contract sync — text extraction, 429 retry. |
| [GHL.md](./GHL.md) | HighLevel CRM operations mirror — authority boundaries, cached health, audit, credential rotation, outage controls, and complete buyer lifecycle automation runbook (v1, pre-production/pending): approved contact fields/tags/pipeline stages (lockstep with `server/services/ghlBuyerSync.ts`), Workflows A–F trigger/stop conditions (Workflow A starts only after a recoverable checkout contact; Workflow B is CRM-only with NoBull-only receipt/access), inbound signed webhook `POST /api/integrations/ghl/marketplace-webhook`, the `ghl_buyer_sync_config_v1` env-specific config setting, the durable `ghl_outbound_sync` outbox relay (leasing/retry/dead-letter/config-deferred), idempotency/correlation via `book_provider_correlations`, automated hermetic test evidence + pending live-GHL checklist, and activation gates. |
| [TRANSCRIPTION_PROVIDERS.md](./TRANSCRIPTION_PROVIDERS.md) | Rev.ai (ATS video) + Rev.com (optional call transcript). |
| [TWELVELABS.md](./TWELVELABS.md) | Video understanding — Marengo/Pegasus indexing, search, frame extraction. |
| [SENDGRID.md](./SENDGRID.md) | Outbound email: internal alert mailer + client-facing lane (mailbox-first routing, CEO-gated SendGrid overflow, suppression list, signed event webhook). |
| [docs/pool-epic-baseline.md](./docs/pool-epic-baseline.md) | DB Pool Stability Epic — Phase 0 baseline (7-day prod metrics, owner roster, Phase 0 safety switches). Refresh on each phase boundary. |
| [EXTERNAL_CALL_AUDIT.md](./EXTERNAL_CALL_AUDIT.md) | DB Pool Stability Epic Phase 1.5 — external-call audit wrapper, daily rollups, DB-hold rollups, `/admin/db-attribution/trends` page, retention, kill switches. |
| [PROD_ACTION_SELF_HEAL.md](./PROD_ACTION_SELF_HEAL.md) | Self-heal scheduler that auto-applies idempotent, recurring maintenance prod-actions (Task #2086) — eligibility, cadence/backoff, gating, master switch. |
| [RIS.md](./RIS.md) | Revenue Integrity System QA layer (Task #2367) — `/ris` dashboard, checklist data model, catalog seeding, rollups/cadence, permissions, API, flagging. |
| [BACKUPS.md](./BACKUPS.md) | Daily app backup (Task #2657) — `pg_dump` + Object Storage file manifest/incremental archive, deployment-gated singleton scheduler, `/admin/backups` CEO console, download + manual run, manual restore procedure. |
| [GOOGLE_ADS_AUDIT.md](./GOOGLE_ADS_AUDIT.md) | Google Ads Hygiene Audit (Task #2784) — `/admin/ads-hygiene` CEO-only read-only checklist scoring, 8 weighted categories, critical gates, persisted runs, extending the checklist. |
| [KEEP_ALIVE_RUNBOOK.md](./KEEP_ALIVE_RUNBOOK.md) | Integration keep-alive audit — which integrations need proactive token rotation, why, schedulers for Zoom and SEMrush, Slack channel_not_found self-alert, incident playbook, kill switches. |
| [FRONT_ANALYTICS_COVERAGE.md](./FRONT_ANALYTICS_COVERAGE.md) | Front Analytics all-time coverage — message-grain accounting, backlog drains, gap close/backfill, sweeps, adoption floor, operational console. |
| [SEMRUSH_CADENCE.md](./SEMRUSH_CADENCE.md) | SEMrush refresh cadence — emergency firehose pause, demand-driven refresh gate, verification, rollback. |
| [PG_STAT_STATEMENTS_REGRESSION.md](./PG_STAT_STATEMENTS_REGRESSION.md) | Nightly `pg_stat_statements` regression scan — baseline diff, Slack top-5 regressions, baseline refresh procedure. |
| [CLICKUP.md](./CLICKUP.md) | ClickUp integration — OAuth connection, workspace mirror sync, task/list/doc read models, worker handlers, kill switches, and company-token outbound role-projection rollout/recovery. |
| [SERVICE_DESK.md](./SERVICE_DESK.md) | Internal Service Desk — ClickUp-backed tickets, setup wizard, statuses/custom fields, role eligibility vs projection identity, home-page views, notifications, overdue/auto-close schedulers. |
| [SHEETS.md](./SHEETS.md) | NoBull Sheets — workbook/folder CRUD, edit locking, version history, xlsx/csv import + export, dashboards, kill switch `sheets_writes_disabled`. |
| [DOCS.md](./DOCS.md) | NoBull Docs — in-app word documents (Univer docs preset), edit locking + revision guard, version history + restore points, docx import/export, client Files tab integration. |
| [CLIENT_FILES.md](./CLIENT_FILES.md) | In-app client file storage — per-client folders/files on private object storage, presigned-upload claim security, versioning, trash + retention purge worker, activity log, global Files library. |
| [threat_model.md](./threat_model.md) | Security threat model — assets, trust boundaries, threat categories, scan anchors; consumed by security reviews. |
| [DB_OPTIMIZATION_PLAYBOOK.md](./DB_OPTIMIZATION_PLAYBOOK.md) | Database optimization replication playbook — portable patterns (pools, holds, audits, lints) distilled from the DB Pool Stability Epic. |
| [TASK_PREFLIGHT.md](./TASK_PREFLIGHT.md) | Per-task preflight checklist — subsystem-indexed prevention rules for the 11 recurring failure classes; router at the top directs agents to the relevant sections. |
| [TASK_SELFCHECK.md](./TASK_SELFCHECK.md) | Per-task self-check checklist — non-executing inspection of touched code, coverage, registration, doc/index obligations, migration safety, and prior-fix preservation; the consolidated gate is a manual, operator-triggered tool (routine completion is validated by Replit's built-in review). |
| [WORKTREE_HYGIENE.md](./WORKTREE_HYGIENE.md) | Worktree hygiene & scratch policy — sanctioned scratch zones (`.local/scratch/`, `tmp/`) with TTL GC, junk-pattern + root allow-list lint, gate/predeploy self-clean wiring, platform-dir safety guarantees. |
| [CODE_QUALITY.md](./CODE_QUALITY.md) | Code-quality non-negotiables — repo-wide rules for maintainability, stack boundaries, dependencies, module boundaries, dead/superseded code, quality-check suppression, and review-by-inspection; supplements (never overrides) replit.md, docs/DO_NOT_BREAK.md, canonical runbooks, and subsystem contracts. |
| [DESIGN.md](./DESIGN.md) | Design-system contract for the NoBull marketing website — identity, tokens, composition and content-integrity rules that bind marketing-site design work. |
| [PRODUCT.md](./PRODUCT.md) | Product specification for NoBull Marketing — platform, audience, and product purpose; grounds marketing-site copy and design decisions. |
| [ARCHITECTURE_GOVERNOR_INTAKE.md](./ARCHITECTURE_GOVERNOR_INTAKE.md) | Point-in-time (2026-08-09) read-only architecture intake report — evidence-labeled system/DB/integration/worker/API/test/gate map, trigger matrix, and candidate guards for designing the Architecture Governor skill. |
| [ARCHITECTURE_BOUNDARIES.md](./ARCHITECTURE_BOUNDARIES.md) | Post-split module boundaries (2026-08 architecture program) — dependency-direction rules + ownership map for the split surfaces (integration routes, prod-actions registry, four admin container roots, ATS/reports JSONB accessor boundaries); composition-root size budgets enforced by the gate's monolith-size lint. |

## Integration Runbook Coverage Matrix

Every integration listed in the Runtime Truth Table's Primary integrations row has an owning runbook (dedicated or grouped). When adding a new integration to that row, add a row here in the same PR.

| Integration | Owning runbook(s) |
| --- | --- |
| OpenAI | [OPENAI.md](./OPENAI.md) (+ transcription detail in [CALL_ANALYSIS.md](./CALL_ANALYSIS.md)) |
| Stripe | [STRIPE.md](./STRIPE.md) |
| Twilio | [TWILIO.md](./TWILIO.md) + [TWILIO_VOICEMAIL.md](./TWILIO_VOICEMAIL.md) + [TWILIO_RECORDING_ARCHIVE.md](./TWILIO_RECORDING_ARCHIVE.md) + [CALL_ANALYSIS.md](./CALL_ANALYSIS.md) |
| Zoom | [ZOOM.md](./ZOOM.md) + [ZOOM_REVIEW_QUEUE.md](./ZOOM_REVIEW_QUEUE.md) + [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md) + [KEEP_ALIVE_RUNBOOK.md](./KEEP_ALIVE_RUNBOOK.md) (token keep-alive) |
| Front | [FRONT.md](./FRONT.md) |
| Google Calendar | [GOOGLE_CALENDAR.md](./GOOGLE_CALENDAR.md) (+ recurrence semantics in [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md)) |
| Google Drive | [GOOGLE_DRIVE.md](./GOOGLE_DRIVE.md) — integration retired (Task #4084); Sheets read lane only |
| Google Maps | [GEOSPATIAL_APIS.md](./GEOSPATIAL_APIS.md) |
| Semrush | [SEMRUSH_MAPPING.md](./SEMRUSH_MAPPING.md) (mapping writes) + [SEMRUSH_HEATMAP_PIPELINE.md](./SEMRUSH_HEATMAP_PIPELINE.md) (heatmap / Local Dominance) + [KEEP_ALIVE_RUNBOOK.md](./KEEP_ALIVE_RUNBOOK.md) (token keep-alive) |
| PandaDoc | [PANDADOC.md](./PANDADOC.md) |
| HighLevel GHL | [GHL.md](./GHL.md) — CRM mirror operations + buyer lifecycle automation (Workflows A–F, tags/fields/pipeline lockstep with `ghlBuyerSync.ts`, `ghl_buyer_sync_config_v1` setting, `ghl_outbound_sync` outbox relay, `POST /api/integrations/ghl/marketplace-webhook`, SMS/email consent rules, activation gates — pre-production/pending) |
| Rev.ai / Rev.com | [TRANSCRIPTION_PROVIDERS.md](./TRANSCRIPTION_PROVIDERS.md) |
| TwelveLabs | [TWELVELABS.md](./TWELVELABS.md) |
| MapTiler | [GEOSPATIAL_APIS.md](./GEOSPATIAL_APIS.md) |
| FCC Census | [GEOSPATIAL_APIS.md](./GEOSPATIAL_APIS.md) |
| SendGrid | [SENDGRID.md](./SENDGRID.md) |
| Google Ads | [GOOGLE_ADS.md](./GOOGLE_ADS.md) |
| Google BigQuery | [RIS.md § BigQuery auto-pull](./RIS.md#bigquery-auto-pull-task-2368) (RIS auto-pull) |
| ClickUp | [CLICKUP.md](./CLICKUP.md) (per-user OAuth, task/time/goal/doc management, webhook sync, company-token outbound role-projection rollout/recovery) + [SERVICE_DESK.md](./SERVICE_DESK.md) (Service Desk ClickUp structure, config, departments, ticket read model, assignment eligibility) |

## Operational Runbook Coverage Matrix

Non-integration operational subsystems with their own queue / credential / kill switch / alert / admin console / replay behavior. Add a row when shipping a new subsystem.

| Subsystem | Owning runbook |
| --- | --- |
| Workers + queues + drain control + backlog alerts | [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md) |
| Table retention pruner + size watchdog + deep-prune reclaim (Task #3814) | [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md) |
| Call analysis pipeline + typed failure classification | [CALL_ANALYSIS.md](./CALL_ANALYSIS.md) |
| Call recording archive (object storage + Drive mirror + Twilio purge) | [TWILIO_RECORDING_ARCHIVE.md](./TWILIO_RECORDING_ARCHIVE.md) |
| Inbound voicemail | [TWILIO_VOICEMAIL.md](./TWILIO_VOICEMAIL.md) |
| Booking + recurring meetings + five kill switches | [BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md) |
| Zoom review queue (non-deterministic recordings) | [ZOOM_REVIEW_QUEUE.md](./ZOOM_REVIEW_QUEUE.md) |
| Lead intake & lifecycle stages (prospect gating, auto-deal settings) | [LEADS.md](./LEADS.md) |
| Front normalize/apply pipeline + historical recovery + bulk actions | [FRONT.md](./FRONT.md) |
| Marketing website (nobullmarketing.com static clone, host routing, demo-form intake) | [RUNBOOKS.md § Marketing Website Runbook](#marketing-website-runbook) |
| SEMrush mapping writes (Import Write Policy exception) | [SEMRUSH_MAPPING.md](./SEMRUSH_MAPPING.md) |
| SEMrush heatmap / Local Dominance sync workers | [SEMRUSH_HEATMAP_PIPELINE.md](./SEMRUSH_HEATMAP_PIPELINE.md) |
| Outbound email (alerts/notifications) | [SENDGRID.md](./SENDGRID.md) |
| ATS transcription / scoring | [TRANSCRIPTION_PROVIDERS.md](./TRANSCRIPTION_PROVIDERS.md) (transcription) + AI scoring covered in [OPENAI.md](./OPENAI.md) |
| Manual-reserve resend attribution backfill | [MANUAL_RESERVE_RESEND_ATTRIBUTION.md](./MANUAL_RESERVE_RESEND_ATTRIBUTION.md) |
| Front Analytics all-time coverage (denominator + dashboard + alerts) | [FRONT_ANALYTICS_COVERAGE.md](./FRONT_ANALYTICS_COVERAGE.md) |
| Twilio all-time failure audit + remediation (Task #1618) | [TWILIO.md § All-time failure audit](./TWILIO.md) + [`audits/twilio-failure-audit.md`](./audits/twilio-failure-audit.md) (script pair: `scripts/audit-twilio-failures.ts`, `scripts/remediate-twilio-failures.ts`) |
| External-call audit + DB-hold rollups + admin trends page (Pool epic Phase 1.5, Task #1728) | [EXTERNAL_CALL_AUDIT.md](./EXTERNAL_CALL_AUDIT.md) |
| Production remediation playbook | [PROD_REMEDIATION.md](./PROD_REMEDIATION.md) |
| Testing & pre-deploy gate | [TESTING.md](./TESTING.md) |
| Per-user notification inbox + recipient helpers + event-source wiring | [NOTIFICATIONS.md](./NOTIFICATIONS.md) |
| Google Ads daily sync worker + env-credential auth + customer discovery (Task #1759 / #4008) | [GOOGLE_ADS.md](./GOOGLE_ADS.md) |
| Restored-fallback email auto-cleanup scheduler (Task #2029) | [WORKERS_QUEUES_RUNBOOK.md § Restored-fallback email auto-cleanup](./WORKERS_QUEUES_RUNBOOK.md#restored-fallback-email-auto-cleanup-task-2029) |
| Maintenance prod-action self-heal scheduler (Task #2086) | [PROD_ACTION_SELF_HEAL.md](./PROD_ACTION_SELF_HEAL.md) |
| Revenue Integrity System QA layer + checklist ledger + flagging (Task #2367) | [RIS.md](./RIS.md) |
| Cross-instance run-once worker locks (advisory-lock singletons, Task #2363) | [WORKERS_QUEUES_RUNBOOK.md § Cross-instance run-once worker locks](./WORKERS_QUEUES_RUNBOOK.md#cross-instance-run-once-worker-locks-task-2363) |
| Daily app backup (DB dump + Object Storage file manifest/archive) + `/admin/backups` console (Task #2657) | [BACKUPS.md](./BACKUPS.md) |
| Google Ads Hygiene Audit checklist scoring + `/admin/ads-hygiene` console (Task #2784) | [GOOGLE_ADS_AUDIT.md](./GOOGLE_ADS_AUDIT.md) |
| Integration keep-alive schedulers (Zoom + SEMrush) + Slack channel_not_found self-alert | [KEEP_ALIVE_RUNBOOK.md](./KEEP_ALIVE_RUNBOOK.md) |
| Service Desk ClickUp structure, config, departments, request types, ticket read model + `/admin/service-desk` console | [SERVICE_DESK.md](./SERVICE_DESK.md) |
| Universal role assignments + ClickUp projection queue, kill switch, status, repair, and staged rollout | [CLICKUP.md § Company-token outbound role projection](./CLICKUP.md#company-token-outbound-role-projection-task-5156) + [WORKERS_QUEUES_RUNBOOK.md § ClickUp role projection queue](./WORKERS_QUEUES_RUNBOOK.md#clickup-role-projection-queue-task-5156) |
| NoBull Sheets — workbook/folder CRUD, edit locking (heartbeat + revision guard), version history + restore, live data blocks, xlsx/csv import + export, kill switch | [SHEETS.md](./SHEETS.md) |
| NoBull Docs — in-app document editor (Univer docs preset), single-editor lock + revision guard, versions + restore points, docx import/export (Task #4024) | [DOCS.md](./DOCS.md) |
| Client file storage — per-client folders/files, upload claim security, versioning, trash + retention purge worker (Task #4023) | [CLIENT_FILES.md](./CLIENT_FILES.md) |
| Report data historical hygiene — audited prod actions closing the F3 gaps (empty-section backfill, section-history baseline seed, inactive-product block cleanup lever; Tasks #829/#1028 + 2026-05-13 sections fix, Task #4175) | [`audits/f3-operational-script-disposition-2026-08-09.md`](./audits/f3-operational-script-disposition-2026-08-09.md) (measured gaps + 2026-08-09 addendum). Execution path: CEO panel → Prod Actions — `backfill_empty_report_sections` + `backfill_report_section_history_baseline` (Apply-all lane, converging) and `cleanup_inactive_product_report_blocks` (manual lever; writes via the audited section writer so edit history is preserved). Logic: `server/services/reportHistoricalHygiene.ts`. The three former `scripts/` one-offs are deleted (Task #4175) — git history is the archive. |
| DB pool tenancy (api / worker / probe assignment rules) | This file — [Audit Surface Runbook](#audit-surface-runbook-db-pool-tenancy--external-call-audit) (**canonical home** for the tenant rules; `replit.md` § "DB Pool Tenancy Rules" is a one-line pointer only) |
| DB hold rules (≤10 s, no external I/O inside a hold) | This file — [Audit Surface Runbook](#audit-surface-runbook-db-pool-tenancy--external-call-audit) + rules in `replit.md` § "DB Hold Rules" |
| External-call audit surface (per-integration call volume + cache-hit + same-response detection) | This file — [Audit Surface Runbook](#audit-surface-runbook-db-pool-tenancy--external-call-audit) |

### Missing Runbook Discovery Results

One-line verdict per subsystem considered during the Task #1608 discovery pass. Use the same format when adding new items: `<subsystem> — covered by <runbook> | section in <runbook> | NEW <runbook>.md | intentionally folded into <runbook> (reason)`.

Primary integrations:
- OpenAI — NEW `OPENAI.md`
- Stripe — NEW `STRIPE.md`
- Twilio — covered by `TWILIO.md` + `TWILIO_VOICEMAIL.md` + `TWILIO_RECORDING_ARCHIVE.md` + `CALL_ANALYSIS.md` (pre-existing)
- Zoom — NEW `ZOOM.md` (sibling: `ZOOM_REVIEW_QUEUE.md`, `BOOKING_RECURRENCE.md`)
- Front — NEW `FRONT.md`
- Google Calendar — NEW `GOOGLE_CALENDAR.md`
- Google Drive — NEW `GOOGLE_DRIVE.md` (integration retired by Task #4084; doc kept as retirement record + Sheets lane)
- Google Maps — NEW `GEOSPATIAL_APIS.md` (grouped)
- MapTiler — covered by `GEOSPATIAL_APIS.md`
- FCC Census — covered by `GEOSPATIAL_APIS.md`
- Semrush — covered by `SEMRUSH_MAPPING.md` (mapping writes, pre-existing) + NEW `SEMRUSH_HEATMAP_PIPELINE.md` (heatmap/Local Dominance)
- PandaDoc — NEW `PANDADOC.md`
- Rev.ai — NEW `TRANSCRIPTION_PROVIDERS.md` (grouped with Rev.com)
- Rev.com — covered by `TRANSCRIPTION_PROVIDERS.md`
- TwelveLabs — NEW `TWELVELABS.md`
- SendGrid — NEW `SENDGRID.md`

Non-integration operational subsystems:
- Workers + queues + drain control — covered by `WORKERS_QUEUES_RUNBOOK.md` (pre-existing)
- Queue drain controls — covered by `WORKERS_QUEUES_RUNBOOK.md`
- Backlog / starvation alerts — covered by `WORKERS_QUEUES_RUNBOOK.md` and per-alert rows in `audits/G-docs-findings.md` § 4
- Call analysis pipeline — covered by `CALL_ANALYSIS.md` (pre-existing)
- Call archive pipeline — covered by `TWILIO_RECORDING_ARCHIVE.md` (pre-existing)
- Front webhook normalize/apply pipeline — covered by `FRONT.md`
- Front historical recovery — intentionally folded into `FRONT.md` § Historical recovery (recovery engine is tightly coupled to the apply pipeline; splitting would create two runbooks that must always be read together)
- Zoom ingestion and review — covered by `ZOOM.md` + `ZOOM_REVIEW_QUEUE.md`
- Slack notifications console — intentionally folded (no own credential rotation or replay behavior beyond `slackIntegration.ts`; per-alert `*_slack_channel_id` rows live in `audits/G-docs-findings.md` § 4). Promote when Slack grows its own outbound queue or kill switch.
- Health sampler / health incidents — intentionally folded (covered today by `healthIncidents.ts`, `healthDegradedAlerts.ts`, `healthDegradedTracker.ts`, `healthRollups.ts` with per-alert settings in § 4). Promote when there's an incident playbook beyond the alert config.
- Background ingestion saturation alerts — intentionally folded (lives alongside `WORKERS_QUEUES_RUNBOOK.md` backlog alerts).
- Manual reserve alerts — covered by `MANUAL_RESERVE_RESEND_ATTRIBUTION.md` (backfill) + `manualReserveAlerts.ts` runtime config rows in § 4
- ATS transcription — covered by `TRANSCRIPTION_PROVIDERS.md`; ATS AI scoring covered by `OPENAI.md`
- Google Drive sync — retired with the Drive integration (Task #4084); history in `GOOGLE_DRIVE.md`
- Local dominance sync — covered by `SEMRUSH_HEATMAP_PIPELINE.md`
- SEMrush heatmap apply — covered by `SEMRUSH_HEATMAP_PIPELINE.md`
- Report generation / report sections — intentionally folded (no own credential, queue, or kill switch beyond OpenAI usage already in `OPENAI.md`).
- PDF importer — intentionally folded (`pdfImportParser.ts` is a stateless library call with no credential or queue of its own). Promote when it grows external dependencies.
- Object storage — intentionally folded (Replit-managed; env vars in `audits/G-docs-findings.md` § 4; no rotation procedure owned by NoBull OS). Promote if we self-manage a bucket.
- Public booking pages — intentionally folded into `BOOKING_RECURRENCE.md` and the booking sections of `ZOOM.md` / `GOOGLE_CALENDAR.md`.
- Billing / Stripe subscriptions — covered by `STRIPE.md`
- Outbound email / SendGrid — covered by `SENDGRID.md`
- Production remediation — covered by `PROD_REMEDIATION.md` (pre-existing)
- Testing & pre-deploy gate — covered by `TESTING.md` (pre-existing)
- Maintenance prod-action self-heal scheduler — NEW `PROD_ACTION_SELF_HEAL.md` (Task #2086; own queue `prod_action_self_heal`, master switch, per-action cadence/backoff)
- Daily app backup (DB dump + Object Storage file manifest/archive) — NEW `BACKUPS.md` (Task #2657; deployment-gated advisory-lock singleton, `/admin/backups` CEO console, `infra.backup.failed` alert, indefinite retention)

---

## Audit Surface Runbook: DB pool tenancy & external-call audit

Operator guide for the audit surfaces shipped by the
[DB Pool Stability Epic](./.local/tasks/api-pool-waste-reduction-and-pool-tenancy-epic.md).
These panels exist so a regression in pool tenancy or external-call waste is
visible without grepping logs.

### Pool tenancy rules (canonical home)

<!-- CANONICAL: This section is the single authoritative home for the DB pool
     tenant rules and shared-helper/exception policy. replit.md deliberately
     keeps only a one-line pointer bullet ("DB Pool Tenancy Rules") — do NOT
     re-add rule sub-bullets there (it will fail lint-replit-md). New pool
     exceptions and tenant-rule changes belong HERE. -->

**This section — not `replit.md` — is the canonical home for pool-tenant
rules.** `replit.md` § "DB Pool Tenancy Rules" is a one-line pointer back to
this section; add new exceptions or rule changes here, never there (the
`lint-replit-md` budgets will reject re-grown sub-bullets).

| Pool | Max conns | Who is allowed | Who is **not** allowed | Canonical import |
| --- | ---: | --- | --- | --- |
| `api` | 18 | Request handlers under `server/routes/*` | Periodic timers, schedulers, maintenance sweeps, worker-context `notifyUser`, SEMrush enrichment, rollups | `import { db } from "server/db"` |
| `worker` | 10 | Background workers, `setInterval` timers, maintenance, auto-heal, SEMrush, rollups, worker-context notifications | Per-request handlers (would steal worker capacity) | `import { workerDb } from "server/db"` or `runWithWorkerDb(...)` |
| `probe` | 1 | `healthProbe.ts` only; code that intentionally **measures** pool acquire latency | Everything else (including admin diagnostics — those use `workerPool`) | `import { probePool } from "server/db"` |

(Pool sizes mirror the Runtime Truth Table in `replit.md`; if they ever
disagree, the Truth Table wins and this table must be reconciled.)

**Shared helpers** must accept an explicit DB handle / context; the default
behavior must be documented (`getDb()` resolves via `runWithWorkerDb`
AsyncLocalStorage). **Exceptions** must document *why, hold duration, owner,
monitoring label, review date* — these are the tripwire for the Phase 4
`lint-db-pool-tenancy` guard.

**Mechanical enforcement (Task #3944):** `scripts/lint-periodic-pool-ownership.ts`
(gate lint phase) fails any periodic/background module — `setInterval`,
`node-cron`, supervised samplers, or services seeded by the boot registration
lists — that value-imports `db`/`apiPool` from `server/db.ts` (alias-aware AST;
`workerDb as db` passes, type-only imports exempt; barrel re-exports of the
request pool are banned outright). Sanctioned dual-use files carry a
`// @periodic-request-pool-exception: <justification>` marker in their first
80 lines; the exact marker set is pinned by
`tests/lint-periodic-pool-ownership.test.ts`, and a marker whose file no
longer trips the detector fails as stale — the exception list cannot rot.

Per-file ownership map: `audits/C-db-performance-findings.md` § 2.

### How to read the Health Dashboard pool panels

The Health Dashboard (`/admin/health`) surfaces four pool signals derived
from `pool_state_samples` and the per-sample `top_hold_labels`:

1. **Pool utilization distribution** — % of samples at ≥80%, ≥90%, =100%
   for each pool. Compare against
   [`docs/pool-epic-baseline.md`](./docs/pool-epic-baseline.md) § 1.
2. **Peak / avg waiter queue** — anything above single digits on the `api`
   pool during business hours is a regression. Baseline peak was **40**.
3. **Top hold labels** — sorted by count and by max duration. The label
   format is `<context>:<sub-label>` (e.g. `worker:semrush_background_refresh:enrich_campaigns`,
   `maintenance:health-metrics-sample`). A label that looks like worker
   work showing up on the `api` pool row is a tenancy regression.
4. **Max hold per label** — anything > 10 s under normal load violates the
   DB Hold Rules and should be triaged.

### Regression triage flow

1. **Pool tenancy regression** — a scheduler/timer/worker label is showing
   up in the `api` pool top-labels list.
   - Find the offending file (search for the label string in `server/`).
   - Confirm it imports `db` (api) rather than `workerDb`.
   - Fix by swapping to `workerDb`, or wrap the call site in
     `runWithWorkerDb(...)` and rely on `getDb()` inside shared helpers.
   - The Phase 4 `lint-db-pool-tenancy` workflow should catch any new
     instance at lint time once it's enforcing.
2. **DB hold > 10 s** — a label's max-hold spiked.
   - Inspect the label's call site. Look for external HTTP / AI / geocode
     / SSE / Slack work performed **inside** the hold scope.
   - Stage that work outside the hold; re-enter the DB only for the
     persistence step.
3. **External call regression** — same endpoint returning the same
   response repeatedly, cache-hit ratio dropping, or call-volume spike
   correlated with DB saturation.
   - Cross-reference the per-integration audit rollups against the SEMrush
     persistent enrichment cache hit rate (Phase 1.2) and the
     `front_recovery_*` backoff frequency.
   - Tune the cache TTL or fix the cache-bypass call site.

### Thresholds that matter

| Signal | Healthy | Watch | Page |
| --- | --- | --- | --- |
| `api` pool % samples ≥80% (business hours) | < 5% | 5–10% | > 10% |
| `api` pool peak waiter queue | < 5 | 5–10 | > 10 |
| `worker` pool % samples =100% | < 5% | 5–15% | > 15% |
| Any DB hold label max (normal load) | < 10 s | 10–30 s | > 30 s |
| Front recovery backoff frequency | rare | hourly | per-tick |
| SEMrush cache-hit ratio | > 90% | 75–90% | < 75% |

### Related files

- `pool_state_samples` table (per-sample utilization, waiters, top hold labels)
- `db_hold_label_rollups` (daily aggregated hold stats — Phase 1.5)
- `external_call_audit` + daily rollups (Phase 1.5.1)
- `server/services/healthMetrics.ts` (sampler — uses `workerDb`)
- `server/services/poolEpicKillSwitches.ts` (seven epic kill switches; see
  `audits/G-docs-findings.md` § 4c for the per-switch table)

### Phase verification notes

Every phase deploy is followed by a verification note in
[`docs/pool-epic-verifications/`](./docs/pool-epic-verifications/) using the
template at [`docs/pool-epic-verification-template.md`](./docs/pool-epic-verification-template.md).
**Phase 3 cannot start** until the Phase 1 and Phase 2 notes are committed and
show the required improvements.

The activation sequence for the six dormant Phase 0 kill switches is
documented separately in
[`docs/pool-epic-verifications/1768-operator-runbook.md`](./docs/pool-epic-verifications/1768-operator-runbook.md)
(Task #1768) with per-stage verification SQL and the rollback table below.
Baseline snapshot:
[`docs/pool-epic-verifications/1768-baseline.md`](./docs/pool-epic-verifications/1768-baseline.md).
Per-phase notes: `1768-phase-1.md` (observability), `1768-phase-1.5.md`
(210 s top-hold investigation), `1768-phase-2.md` (tenancy + SEMrush),
`1768-phase-3.md` (Front recovery tuning).

## Pool Epic — Switch Rollback Reference

Mirror of the rollback table in `1768-operator-runbook.md` so on-call
operators can find it without leaving `RUNBOOKS.md`.

| Switch | Intended state | What it enables | Symptom that triggers rollback | Where to flip | Follow-up |
| --- | --- | --- | --- | --- | --- |
| `notify_user_optimized_path_enabled` | `true` | `notifyUser()` combined-CTE optimized path (single DB roundtrip). | `notifyUser()` errors spike; user-notification inbox writes fail; combined-CTE returns unexpected `status='race'` rates. | Admin → System Settings, or `UPDATE system_settings SET value='false' WHERE key='notify_user_optimized_path_enabled'`. | File "notifyUser optimized path bug" with sample row ids + dedupe behaviour. |
| `db_hold_rollup_enabled` | `true` | Hourly aggregation into `db_hold_label_rollups` for trend dashboards. | Worker-pool write pressure traced to `maintenance:db-hold-label-rollup`; rollup table runaway growth; `/admin/db-attribution/trends` errors. | Admin → System Settings, or SQL UPDATE as above. | File "DB hold rollup writer bug" with sample rows and timing. |
| `external_call_audit_enabled` | `true` | Per-call audit rows in `external_call_audits` + daily rollups. | Sensitive payloads/PII detected in `external_call_audits`; flusher backlog growth; audit table grows >> projected (>~50 k rows/day per integration). | Admin → System Settings, or SQL UPDATE. | File "External call audit bug" with offending row IDs (NEVER copy the raw payload into the ticket). |
| `db_pool_tenancy_enforcement_enabled` | `true` | `notifyUser()` (and other tenancy-aware helpers) routes worker-context callers onto `workerDb`. | Worker pool sustained >80 % util; worker waiter queue >10; spike in `stale_lease_exhaustion` across non-Front queues; Front recovery slows; user-facing latency rises. | Admin → System Settings, or SQL UPDATE. | File "Pool tenancy routing bug" + which call sites starved. |
| `semrush_persistent_enrichment_cache_enabled` | `true` | Persistent enrichment cache used by `semrush_background_refresh`. | Stale SEMrush enrichment visible in client dashboards; SEMrush error spike; external-call audit shows a *paradoxical* call-count *increase*. | Admin → System Settings, or SQL UPDATE. | File "SEMrush enrichment cache bug" with affected client ids + observed vs expected. |
| `semrush_no_external_calls_inside_db_hold_enabled` | `true` | SEMrush apply/refresh stages external calls outside the DB-hold window. | `semrush_heatmap_apply` job failures; heatmap loses data; new dead-letter spike on SEMrush queues; pool holds *increase* (shouldn't happen). | Admin → System Settings, or SQL UPDATE. | File "SEMrush staged-call regression" with failing job ids and last error. |
| `front_recovery_pool_threshold_tuning_enabled` | `true` | New hysteresis-aware API-pool-pressure check + tighter inter-page sleep defaults in Front Historical Recovery worker (#1730). | Front API 429 rate spike; Front API 5xx spike; API-pool waiters >15 attributable to recovery worker; recovery dead-letter spike. | Admin → System Settings, or SQL UPDATE. | File "Front recovery tuning regression" with the offending `system_settings.front_recovery_*` values and 429/5xx rates. |

## Marketing Website Runbook

Task #3740. One deployment, two audiences: `nobullmarketing.com` + `www.` (env `MARKETING_SITE_HOSTS`, first entry = canonical apex) serve the static marketing site; every other host (`reports.nobullmarketing.com`, `*.replit.dev`) serves NoBull OS unchanged.

- **Bundle**: committed at `website/public/` (23 pages + `404.html` + `sitemap-pages.json` + assets). Regenerate HTML with `npx tsx website/generate.ts` after editing `website/src/**` or `website/content/**`; CSS/JS live directly under `website/public/assets/`. `script/build.ts` copies the bundle to `dist/website` for production.
- **Serving**: `server/website/marketingSite.ts`, registered in `server/index.ts` before helmet and all SPA layers. Marketing hosts get their own CSP (Calendly/Vimeo/Spotify frames), www→apex 301, `/sitemap.xml` + `/robots.txt`, and a marketing 404 — never the OS shell; `/api/*` passes through. All other hosts get the same bundle at `/website-preview` (noindexed) for pre-DNS design review.
- **OS canonical host**: `resolveOsCanonicalHostname()` in `server/services/publicUrl.ts` pins Twilio callbacks and the Zoom / Google Calendar / ClickUp / Front OAuth redirect builders to `OS_CANONICAL_HOSTNAME` env, else the `reports.*` entry of `REPLIT_DOMAINS`, else the first custom non-marketing entry — so adding the marketing domains to the deployment can never flip those URLs. (Google Ads no longer has an OAuth redirect — env-credential model, Task #4008.)
- **Demo-form intake**: `POST /api/website/inquiry` (rate-limited, honeypot-protected) → `website_inquiries` table (`0151_website_inquiries.sql`) + `notifyUser` to responsible admins. The redesigned homepage's contact form posts to the same endpoint (`kind: "contact"`).
- **Homepage (2026-08 redesign)**: `website/src/pages/home.ts` is self-chromed (`chrome: false` PageDef flag — ships its own header/footer, skips `site.css`/`site.js`). Page assets: `assets/css/home.css` + `assets/js/home.js` (esbuild-bundles `website/src/home-client/` inside `generate.ts`, GSAP compiled in) + imagery under `website/public/nobull-redesign/` (brand/press/systems/team/book/testimonials). The `#system` region is the normal-scrolling engine story (Task #4837 owner rebuild: warm handoff band → charcoal three-component overview → one focused section per component with static inline SVG diagrams beside a desktop-only CSS-sticky 01/02/03 index → dark complete-engine recap with the page's single dominant session CTA). Motion is the owner brief's allowed list only (`website/src/home-client/engineStory.ts`), reduced-motion gated; nothing on the page pins, and the section reads complete with JS off. Owner brief: `attached_assets/Pasted-I-would-remove-the-cinematic-entirely-and-rebuild-this-_1786976924006.txt`. Sweet Sans Pro loads from the Adobe Typekit kit (`use.typekit.net/hve0rhv.css`); the marketing CSP allows `use.typekit.net` + `p.typekit.net` for it, and the kit's domain allow-list must include the serving domain. Subpages still use the old shared chrome.
- **Deck-sourced proof figures**: every case-study number woven across the site (homepage proof panel, testimonials `#case-studies` section + quote wall, about First Lead Records strip, services proof stats, booking proof band) lives in `website/src/proof.ts`, slide-attributed to the July 13, 2026 Revenue Engine sales deck and mirrored in `docs/CONTENT_TRUTH_SOURCE.md` § 16. Pages import from that module — never hardcode a deck figure; edits require matching client sign-off.
- **Embeds**: the live site's Vimeo videos are domain-restricted — they render "Sorry" boxes on preview and only play once DNS points the real domain here. The Calendly inline widget needs its `widget.js` loader script on every embedding page.
- **Tests**: `tests/marketing-site-hosts.test.ts` (host routing) + `tests/canonical-host.test.ts` (resolver permutations), both in the smoke gate.
- **DNS go-live**: user links apex + www to the deployment in Replit (no code changes). Verify after: apex serves the marketing site at `/`, www 301s to apex, `reports.` behaves exactly as before, OAuth redirects still resolve to `reports.`.
