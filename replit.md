# NoBull OS

## Overview
Marketing analytics and presentation platform for client-facing business reviews (primarily legal marketing): report slides with seasonal demand, Google Trends, and AI market insights.

## User Preferences
Preferred communication style: Simple, everyday language.

These rules bind every agent — planning, main, task — on every relevant message, not just session start:

- Code-quality rule: before coding, read [CODE_QUALITY.md](./CODE_QUALITY.md); it supplements, and never overrides, this file, `docs/DO_NOT_BREAK.md`, canonical runbooks, or subsystem contracts.
- Public API documentation rule: before planning or implementing any third-party API/integration work (current or future), fetch and review current public docs for the specific endpoints/objects/fields/error codes/SDK methods involved and cite findings; training-data recall alone is unacceptable.
- Prior-task research rule: before producing a plan, search existing project tasks (including MERGED) for prior work on the same subsystem, integration, feature, file, or bug class; incorporate their decisions, gotchas, naming, and patterns. The plan must list the related tasks consulted.
- Per-task preflight & self-check rule: before coding, read [TASK_PREFLIGHT.md](./TASK_PREFLIGHT.md) sections for touched subsystems; before marking done, run `npm run gate` (related-only smoke by default, Task #3755; `--full-smoke` = all) and complete [TASK_SELFCHECK.md](./TASK_SELFCHECK.md), citing both in notes.
- Architecture Governor rule: before PLANNING (plan-only/analysis threads included) any DB/schema, integration, worker, API/auth, dependency, performance, or test add/delete/rename/control-plane change, load `.agents/skills/architecture-governor/SKILL.md`; never alter existing gates, selectors, baselines, or approved policy/budgets without owner approval.
- Task-sizing rule: oversized scope (≈3+ deliverable clusters, ≈800+ line/10+ file diff, rebuild/restructure phrasing) ⇒ a `dependsOn`-ordered epic — full scope, never trimmed: [TASK_PREFLIGHT.md § 13](./TASK_PREFLIGHT.md) + `.agents/skills/epic-decomposition/SKILL.md`.

## System Architecture

### Frontend
- **Stack**: React 18 + TypeScript; Tailwind v4 + shadcn/ui (New York); TanStack React Query; Recharts; Beige & Liberty Blue design system (crimson = scoped brand accent); app-wide dark mode (per-user light/dark/system; reports stay light); responsive 375/768/1024+; [DESIGN.md](./DESIGN.md).
- **Marketing website**: static nobullmarketing.com clone in `website/`, host-served with a pre-DNS preview at `/website-preview`; OS Twilio/OAuth URLs pin to `resolveOsCanonicalHostname()`. See [RUNBOOKS.md § Marketing Website Runbook](./RUNBOOKS.md#marketing-website-runbook).

### Backend
- **Runtime**: Node.js + Express + TypeScript (ESM); RESTful API; Clerk auth (closed admission, no auto-created rows), role-based; OpenAI for market analysis; gzip, immutable cached assets, in-memory client caches, per-endpoint rate limits with role multipliers; module boundaries & size budgets: [ARCHITECTURE_BOUNDARIES.md](./ARCHITECTURE_BOUNDARIES.md).
- **Worker Orchestration**: Fair multi-queue scheduler with staggered startup, in-memory locking, and webhook-first event-driven ingestion with reconciliation. See [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md).
- **Data Integrity**: Client `products` validated at the API boundary; Postgres array bindings use a shared helper; canonical product resolution normalizes all references.
- **OAuth concurrency & token keep-alive**: Rotating-token integrations route through `withSingleFlightOAuthRefresh` (per-process + cross-process Postgres lease); autoscale schedulers use `crossInstanceLock.ts` advisory-lock singletons; Zoom token rotated before expiry (kill-switched); Zoom can use S2S OAuth (`zoom_auth_mode=s2s`, no refresh tokens). See [ZOOM.md](./ZOOM.md).
- **AI Agent Systems**: Evidence-aware matching engine + unified agent memory (shared KB, structured facts, retrieval, learning).
- **Front Pipeline State Machine**: Canonical per-conversation state machine with versioning, dedupe, hydrate snapshot layer. See [FRONT.md](./FRONT.md).
- **DB Pool Tenancy Rules**: Three pools have non-overlapping tenants — `api` (max 18, request-scoped), `worker` (max 10, background), `probe` (max 1). See [Audit Surface Runbook](./RUNBOOKS.md#audit-surface-runbook-db-pool-tenancy--external-call-audit).
- **DB Hold Rules**: A hold window contains only DB work — never across external HTTP, AI, reverse-geocode, SSE broadcast, or Slack enqueue (stage outside, re-enter for persistence); keep holds under **10 s** (>10 s warns, >30 s raises high-severity); prefer batch transactions over per-row loops.
- **Native booking, Client Conversations & Notifications**: Conversation Hub = the `/comms` clients view (Task #4373); Calendly-style booking tool ([BOOKING_RECURRENCE.md](./BOOKING_RECURRENCE.md)); per-thread global read-state in `thread_read_states` ([TWILIO.md](./TWILIO.md)); per-user inbox + Slack DM forwarding via `notifyUser()` ([NOTIFICATIONS.md](./NOTIFICATIONS.md)).
- **Internal Comms**: Slack-class messaging — channels, DMs, group DMs, threads, reactions, presence (SSE), voice/video calls (LiveKit), custom emoji, scheduled delivery, incoming webhooks + slash commands, modifier-aware search. See [COMMS.md](./COMMS.md), [COMMS_PARITY.md](./COMMS_PARITY.md).

### Database
- **Stack**: Drizzle ORM + PostgreSQL, domain-driven schema modules (auth, clients, reporting, agent memory, comms); three pools (`api` / `worker` / `probe`) — sizing, provider, and config-file paths in the Runtime Truth Table.

### Core Features
- **Client Management + Reporting**: Client Command Center, CRM Dashboard, Integrations Hub; Deals kanban at `/deals`; tags & segments (`/admin/tags-segments`); deal scoring (`/admin/scoring`); stage automation (`/admin/deal-automation`); lead lifecycle & Leads view (`/leads`, forward-only) — see [LEADS.md](./LEADS.md); monthly reports, PDF import, custom terminology, edit audit trail.
- **Client Intelligence + Communication Analysis**: Four-layer insights; AI comm capture + analysis; daily account health judgments; Churn Command Center (director+): leaderboard, Risk Radar, save plays; Zoom Review Queue (non-deterministic recordings → `/admin/zoom/review`): [ZOOM_REVIEW_QUEUE.md](./ZOOM_REVIEW_QUEUE.md).
- **Market Analysis + Local SEO**: Demand categorization + MCU; GBP Heatmap, Local Dominance Dashboard; imports/syncs must not directly mutate authoritative client entities (SEMrush mapping is a documented exception). See [SEMRUSH_MAPPING.md](./SEMRUSH_MAPPING.md), [SEMRUSH_HEATMAP_PIPELINE.md](./SEMRUSH_HEATMAP_PIPELINE.md).
- **Front ingestion, recovery & analytics coverage**: Webhook-first pipeline + historical recovery; coverage is **message-grain only** (`messages_all`) with backlog drains, gap close/backfill, 100% sweeps, auto-upgrade, adoption floor + operational console. See [FRONT_ANALYTICS_COVERAGE.md](./FRONT_ANALYTICS_COVERAGE.md), [FRONT.md](./FRONT.md).
- **SEMrush Sync + cadence**: Keyword normalization, auto-retry + backfill, demand-driven refresh gate, `paused_auth` + stale-partial re-run prod-action. See [SEMRUSH_MAPPING.md](./SEMRUSH_MAPPING.md), [SEMRUSH_CADENCE.md](./SEMRUSH_CADENCE.md).
- **Observability**: Queue pause/rate-limit knobs (`queue_drain_state`), external-call audit, DB-hold rollups, table retention/size watchdog, regression sweep ([WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md)); request spine — `X-Request-Id` + `[api]` access log, per-route p50/p95 + regression alert in Health Console ([REQUEST_OBSERVABILITY.md](./REQUEST_OBSERVABILITY.md)).
- **Google Ads**: Single env-credential GAQL client (GOOGLE_ADS_* trio powers every surface; rotation = secrets edit + restart); daily campaign + keyword sync; Ads OS lives at `/ads-os` (legacy `/admin/ads-os` redirects). See [ADS_OS.md](./ADS_OS.md), [GOOGLE_ADS.md](./GOOGLE_ADS.md), [GOOGLE_ADS_AUDIT.md](./GOOGLE_ADS_AUDIT.md).
- **Maintenance schedulers & prod-action self-heal**: Default-OFF worker-pool schedulers (email cleanup, feedback Slack resend, video resume; orphaned-user heal retired) + prod-action self-heal (`enable_prod_action_self_heal`). See [PROD_ACTION_SELF_HEAL.md](./PROD_ACTION_SELF_HEAL.md), [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md).
- **Feedback attachments + video auto-analysis**: Feedback widget accepts images + short videos (admin-gated `/api/feedback/:id/attachment`); videos auto-process via TwelveLabs, landing a transcript + key-moment frames on `video_analysis`. See [WORKERS_QUEUES_RUNBOOK.md](./WORKERS_QUEUES_RUNBOOK.md#feedback-video-restart-resume-task-2414).
- **Revenue Integrity System (`/ris`)**: Reporting-role QA + Performance + Engagement layers — per-client/product/location checklist ledger and Product Health Cards, admin-editable catalog, default-OFF BigQuery auto-pull with per-client binding; degrades to Needs Review/gray, never silent Pass. See [RIS.md](./RIS.md).
- **Daily app backup**: Deployment-gated, once-per-fleet daily `pg_dump` + Object Storage file manifest/incremental archive into private `backups/`; CEO-only `/admin/backups` lists/downloads/triggers runs; `partial`/`failed` marked distinctly and alert via `infra.backup.failed`; retained indefinitely. See [BACKUPS.md](./BACKUPS.md).
- **Internal Service Desk**: ClickUp-backed service-desk interface — single "All Service Requests" List, department as a custom field, 15 statuses, 10 custom fields; CEO-only `/admin/service-desk` setup wizard; departments/members/request-types config; ticket read model from existing `clickup_tasks` mirror. See [SERVICE_DESK.md](./SERVICE_DESK.md).
- **Email templates + sequences**: Merge-field templates (previewable) + fixed-step sequences at `/admin/email-sequences` — approval-queue drafts by default, owner-gated auto-send, per-contact uniqueness + step claim ledger (duplicate alerts), cancel-on-reply/suppression/lifecycle-exit; kill switch `email_sequences_paused`.
- **Other**: [NoBull Sheets](./SHEETS.md) (kill switch `sheets_writes_disabled`); [Client Files](./CLIENT_FILES.md); Applicant Tracking System (ATS — JD parsing, screening, scoring); user activity logging; in-app feedback; domain verification harness; one-off backfill scripts; testing harness — see [TESTING.md](./TESTING.md).
## External Dependencies
- **Primary providers**: Runtime Truth Table row "Primary integrations"; capability detail in each provider's runbook ([OPENAI.md](./OPENAI.md), [FRONT.md](./FRONT.md), …).

## Runtime Truth Table

Authoritative runtime facts. If a long-form bullet above conflicts, **this table wins** — open a Track G doc-drift finding to reconcile.

| Concern | Value |
| --- | --- |
| Database provider (dev workspace) | Replit-managed **Helium Postgres** on `heliumdb` |
| Database provider (deployed prod) | **Neon Postgres** on `neondb` (role `neondb_owner`). History: finding **G-011** in `audits/G-docs-findings.md`. |
| Postgres version (dev) | 16.10 |
| Postgres version (prod) | 16.12 |
| Driver | `pg` (node-postgres) — used for both environments. **Not** `@neondatabase/serverless`; Neon's standard wire protocol is accepted by `pg`. |
| Pool `api` | max **18** connections (request-scoped) |
| Pool `worker` | max **10** connections (background jobs). Global scheduler slot cap = **9** (`RETROACTIVE_REPROCESS_CONCURRENCY` 6 + 3 reserve), leaving ≥1 spare connection for non-slot operations. |
| Pool `probe` | max **1** connection (health-probe only) |
| Pool config files | `server/perfConfig.ts`, `server/db.ts` |
| Read-only prod SQL tool target | Same `neondb` (`neondb_owner`) as the deployed app — queries reflect live primary state. |
| Per-query observability (prod) | `pg_stat_statements` is in `shared_preload_libraries` AND installed on `neondb` (via `create_pg_stat_statements_extension`). **Dev**: catalog row + two views mirrored on Helium to match the deploy-time schema differ (non-functional, unused). See [PG_STAT_STATEMENTS_REGRESSION.md](./PG_STAT_STATEMENTS_REGRESSION.md). |
| Worker model | Fair multi-queue scheduler, in-memory locking, staggered startup |
| Queue table | `work_queue` (FOR UPDATE SKIP LOCKED claim) |
| Auth | Clerk (session-cookie, closed admission — approved emails only), role-based. Dashboard Restricted sign-up: NOT enabled — CEO: `/admin/system-health?tab=auth`; see `server/middlewares/requireAuth.ts` header. |
| Object storage | Replit Object Storage (`PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR`) |
| Deployment target | `vm` (Reserved VM). Switched from `autoscale` in `.replit` on Jul 15 2026; confirmed Jul 20 2026 while fixing a publish failure. |
| Deploy build | `sh -c "./scripts/predeploy.sh && npm run build"` (`.replit`) |
| Server run | `node ./dist/index.cjs` |
| Dev startup | `BOOKING_FEATURE_FLAGS_CACHE_TTL_MS=200 npm run dev` (Configured Workflow: "Start application") |
| Primary integrations | OpenAI, Stripe, Twilio, Zoom, Front, Google (Calendar/Drive/Maps/Ads/BigQuery), Semrush, PandaDoc, HighLevel (GHL), Rev.ai/Rev.com, TwelveLabs, MapTiler, FCC Census, SendGrid |
| Front coverage grain | **Message-grain only** (`messages_all`, inbound + outbound). Conversations are not a NoBull metric/grain; Front's thread fetch is internal. One transitional conversation-grain overflow guard remains in the all-time accumulator (retirement: Task #2606). See [FRONT_ANALYTICS_COVERAGE.md](./FRONT_ANALYTICS_COVERAGE.md). |

## Env Var, System Setting & Kill Switch Index

The full index — env vars (secret? flag, runtime impact), `system_settings` keys, kill switches — lives in **`audits/G-docs-findings.md` § 4**: the canonical map; keep it in sync.

## Doc Hygiene

Where to put a new architectural note so it doesn't drift:

- **New runtime fact** (pool size, PG version, deploy target, driver, primary integration) → the **Runtime Truth Table** above.
- **New env var or `system_settings` key or kill switch** → add a row to `audits/G-docs-findings.md` § 4 in the same PR that introduces it.
- **New integration token keys** → `SETTINGS_CACHE_DENYLIST` (or `SETTINGS_CACHE_DENYLIST_PREFIXES`) in `server/storage/settingsStorage.ts`, same PR, before first production rotation; the runtime suffix safety net backstops forgotten keys, never substitutes for listing.
- **New cross-cutting subsystem** → a short **System Architecture** bullet *(Backend / Database / Core Features)* linking a dedicated runbook for operator detail.
- **New operator runbook** → top-level `<FEATURE>.md` (template: `BOOKING_RECURRENCE.md`), linked from the relevant System Architecture bullet, + a **Runbook Index** row in [RUNBOOKS.md](./RUNBOOKS.md).
- **New integration or operational subsystem** (own queue/credential/kill switch/alert/admin console/external provider) → same PR: create or extend an owning runbook **and** add the matching coverage-matrix row (Integration or Operational) in [RUNBOOKS.md](./RUNBOOKS.md).
- **Scratch/transient files** go only in `.local/scratch/` or `tmp/` (git-ignored, TTL-pruned); `npm run gate` self-cleans + enforces the root allow-list — see [WORKTREE_HYGIENE.md](./WORKTREE_HYGIENE.md).
- **One-off backfill scripts** belong in `scripts/`; a Core Features bullet *only* if operationally relevant — never External Dependencies.
- **Migration naming (Task #3786):** UTC timestamp prefix — `$(date -u +%Y%m%d%H%M%S)_description.sql`; the legacy `NNNN_*` namespace is frozen (collisions derive from the hash-pinned snapshot in `scripts/lint-migration-prefixes.ts`; no allow-list to grow). Cite migrations by **full filename**, never just "migration 0055".
- **Task # references** describe the behavior the task shipped, not its life-cycle status; the code is the source of truth.
- **Lint budgets**: enforced by `scripts/lint-replit-md.ts`; failure output lists every rule + lever.

## Audit Tracks

Multi-track engineering audit. Each track produces a finding report under `audits/`:

- **Track G — Documentation accuracy**: `audits/G-docs-findings.md`. Runtime Truth Table (above), Env Var / System Setting / Kill Switch Index (§ 4), and Task Reference Validation (§ 2 G-006).

## Runbooks

The full operator runbook index — **Runbook Index**, **Integration** and **Operational Coverage Matrices**, **Missing Runbook Discovery Results** — lives in **[RUNBOOKS.md](./RUNBOOKS.md)** (matrix-update rule: Doc Hygiene above).
