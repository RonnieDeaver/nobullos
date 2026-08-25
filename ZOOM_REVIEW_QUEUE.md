# Zoom Review Queue

Operator runbook for the manual review queue that catches every non-deterministic Zoom recording. Shipped under **Task #993**; bulk-actions and trend snapshot under **Task #996**.

## Overview

After Task #993 disabled AI-driven dismissal, every non-deterministic Zoom recording lands in `/admin/zoom/review` as `review_required` instead of being silently dismissed. Re-enabling AI-driven dismissal is **not** on the roadmap — operator triage is the source of truth.

## Architecture

| Concern | Location |
|---|---|
| Operator UI | `client/src/pages/admin/ZoomReviewQueue.tsx` |
| Service | `server/services/zoomReviewQueue.ts` |
| Alerts | `server/services/zoomReviewQueueAlerts.ts` (count + age threshold, Slack/email/in-app, cooldowns, event history) |

## Trend snapshot (Task #996)

- Backlog trend snapshot card at the top of `/admin/zoom/review`.
- `+N` / `-N` 24h delta arrow next to the Review Queue badge on `/admin/zoom`.
- Both fed by `GET /api/admin/zoom/review-queue/trend` returning: `pendingCount`, `pendingCount{24hAgo,7dAgo}`, `created{Last24h,Last7d}`, `resolved{Last24h,Last7d}`.

## Bulk-action controls (Task #996)

- Checkboxes per unresolved row.
- Select-all only ticks visible-unresolved rows.
- Toolbar buttons:
  - `POST /api/admin/zoom/review-queue/bulk-dismiss` — shared `DismissReasonDialog`, stamps each row `dismissed:<reason>` via the existing single-row helper.
  - `POST /api/admin/zoom/review-queue/bulk-approve` — shared `ClientPicker`, stamps each row `manual_review:approved` or `manual_review:reassigned:<priorClientId>`.

**Semantics.** Bulk endpoints loop the existing per-row helpers, so each row keeps its own DB transaction and audit-trail stamp; per-row failures don't abort the batch and are returned in `{ succeeded, failed }`. **Capped at 200 IDs per call.**

## Alerts and observability

Existing alert plumbing in `server/services/zoomReviewQueueAlerts.ts` covers count + age thresholds, Slack / email / in-app channels, cooldowns, and an event-history table. The Review Queue badge on `/admin/zoom` shows the live `pendingCount` plus the `+N` / `-N` 24h delta arrow from the trend endpoint.

## Verification

- Open `/admin/zoom/review` — the trend snapshot card should render at the top with non-null `pendingCount`, `created`, and `resolved` counters.
- `GET /api/admin/zoom/review-queue/trend` should return all eight counters listed above.
- Tick two unresolved rows and use bulk-dismiss → both rows stamp `dismissed:<reason>` in the audit trail and one-row failures should not abort the batch.

## Keywords / grep anchors

`zoom_review_queue`, `review_required`, `manual_review:approved`, `manual_review:reassigned`, `dismissed:`, `/api/admin/zoom/review-queue/trend`, `/api/admin/zoom/review-queue/bulk-dismiss`, `/api/admin/zoom/review-queue/bulk-approve`, `DismissReasonDialog`, `ClientPicker`.

## Related Task # history

- **Task #993** — disabled AI-driven dismissal; routed all non-deterministic recordings to manual review.
- **Task #996** — added trend snapshot + bulk dismiss/approve controls.
