# Lead Intake & Lifecycle Stages

Canonical reference for the client lifecycle-stage subsystem (Task #4330): prospect (lead) records on the `clients` table, automatic forward-only stage advancement, intake wiring, and the Leads view.

## Stages

`clients.lifecycle_stage`: `lead → session_booked → opportunity → customer` (forward-only ladder). Existing rows backfilled as `customer`; new prospect records start at `lead`.

- **Automatic advancement is forward-only** — a row-locked compare-and-set (`advanceLifecycleStage`) refuses to move a client backwards; stale/duplicate events are no-ops.
- **Manual correction** (any direction, including backwards) is allowed for team_lead+ via `POST /api/leads/:id/lifecycle` and is always audited.
- Every transition appends to `client_lifecycle_history` (old/new stage, trigger — `inquiry | booking | deal_created | deal_won | manual`, actor user id for manual moves, timestamp). History is append-only; the Leads view shows it per record.

## Intake sources

- **Website inquiries** (contact kind): ingest match-or-creates a lead under a PG advisory lock — email/phone identity match against clients AND contacts; on miss a prospect `clients` row + contact row are minted, `lead_source` stamped, and the inquiry row links via `website_inquiries.lead_client_id`. The existing notification flow is unchanged.
- **Confirmed bookings** for non-clients: create/advance the lead to `session_booked` and stamp `lead_last_activity_at`. Optional auto-deal (default **OFF**): `leads_booking_auto_deal_enabled` + `leads_booking_auto_deal_stage` (default `discovery-call`) create a deal in the default pipeline, deduped against existing open deals. Booking links `meeting.clientId` only for prospects — customer bookings keep the pre-#4330 unlinked behavior. The separate booking deal-trigger (Task #4332, `deal_triggers_booking_*` via `/admin/deal-automation`) moves an existing single open deal to its configured stage on the same event; when the auto-deal above fired for the booking it records `deal_created` instead of double-acting.
- **Deal hooks** (post-commit, log-don't-throw): deal created/linked ⇒ `opportunity`; deal won ⇒ `customer`.

## Prospect gating (do not break)

Lead-stage rows are **gated OUT of paying-client surfaces**: all customer enumerators (reports, churn, service-desk sweeps, billing-ish views) filter to `lifecycle_stage = 'customer'` via the customer-gated storage accessors. Matching surfaces that must see prospects (Front hard-match, lead intake identity matching) use `getClientsIncludingProspects` explicitly. New enumerators must choose one deliberately — defaulting to customer-gated is correct for anything client-facing.

## Leads view

`/leads` (sales scoping applies): stage/source filters, activity-sorted table, promote-to-deal, detail dialog with lifecycle history timeline + manual stage correction. Route surface in `server/routes/leads.ts`; covered by `tests/lead-lifecycle.test.ts` (smoke-gated).

## Deals admin surfaces

- **Tags & segments** (`/admin/tags-segments`): rule/manual chips; segment sweep default **OFF**.
- **Deal scoring** (`/admin/scoring`): configurable scoring rules surfaced on deal cards.
- **Stage automation** (`/admin/deal-automation`): stage-entry rules → bounded actions (notify / ClickUp / set property / lifecycle), run log, `deal_automation_enabled` kill switch (indexed in `audits/G-docs-findings.md` § 4).
- **Native auto-move triggers** (same page, Task #4332): booking / PandaDoc-status / Front-reply events move deals via `deal_triggers_*` settings — per-hook toggles default **OFF**, replay-deduped on unique `event_key`, moves ride the standard stage-move path (history, required-fields policy, stage automations) stamped `moved_by_source`/`trigger_event_id`; PandaDoc moves only explicitly linked deals (unlinked mapped docs surface for manual linking, which auto-reprocesses the skip); Front replies only log `reply_logged` events (consumed later by sequences); ≥3 consecutive failures per hook alert via `workflow.deal_triggers.hook_failed`.

## Settings

| Key | Default | Effect |
| --- | --- | --- |
| `leads_booking_auto_deal_enabled` | `false` | Booking hook also creates a deal in the default pipeline for the advanced lead. |
| `leads_booking_auto_deal_stage` | `discovery-call` | Stage the auto-created deal lands in. |

No admin UI for these yet (follow-up task); flip via the settings surface.

## Deal stage automation

Admin-managed rules engine at `/admin/deal-automation` (storage `server/storage/dealAutomationStorage.ts`):

- **Trigger**: a deal entering a stage (optional from-stage filter), captured as durable `deal_stage_events` written in-tx with the stage-history write (ON CONFLICT DO NOTHING) + post-commit queue kick.
- **Actions**: 1–10 ordered bounded actions per rule — in-app notify (template tokens), ClickUp task (per-user connection, graceful skip when unconnected), set deal property, advance client lifecycle.
- **Exactly-once**: UNIQUE (rule, event) run claims — replays and duplicate events cannot double-fire.
- **Operations**: per-rule run history + enable/disable toggle; global `deal_automation_enabled` kill switch (skipped runs are recorded visibly, never silently dropped); requeue lever + deployment-gated boot catch-up; failures alert via `workflow.deal_automation.run_failed`.
