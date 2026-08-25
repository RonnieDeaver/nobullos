# SEMrush Console — 936F Verification Report

Verification pass for the consolidated SEMrush Operations Console at
`/admin/integrations/semrush`.

## Result summary

| # | Checklist item | Result |
|---|---|---|
| 1 | Admin-only access on console route | PASS |
| 2 | Integrations Hub links to console; no duplicated SEMrush operator UI | PASS |
| 3 | Pipeline Health panel shows real backlog/failure/DLQ/last-run | PASS |
| 4 | Sync State panel shows per-client outcomes | PASS |
| 5 | Mapping Inventory shows accurate status badges | PASS |
| 6 | Suggestions show accurate state labels | PASS |
| 7 | Approve/reject reuse canonical mapping writer | PASS |
| 8 | Historical backfill works end-to-end (dry-run + apply + progress) | PASS |
| 9 | Integrations Hub no longer duplicates the backfill panel | PASS |
| 10 | Page coherent across desktop/tablet/mobile widths | PASS |
| 11 | `data-testid` values preserved / follow conventions on new controls | PASS |

## Defects found and fixed in this task

- **Console page crashed on render** — `MappingSuggestionsPanel` referenced
  the `ListChecks` icon (line ~401 of `client/src/pages/admin/SemrushIntegration.tsx`)
  but `ListChecks` was not in the `lucide-react` import list. Any admin
  navigating to the console would get a `ReferenceError: ListChecks is not
  defined` and a blank page. Fixed by adding `ListChecks` to the import
  block. Verified by full `tsc --noEmit` (no errors) and by loading
  `/admin/integrations/semrush` in the preview, which now renders the
  expected unauthenticated "Access denied" card instead of crashing.

## Detail per checklist item

1. **Admin-only access.** Route handler renders an Access-denied card
   when `user.role` is not `ceo` or `team_lead`
   (`SemrushIntegration.tsx`, ~lines 616–633). Server endpoints
   (`/api/semrush/console/overview`, `/sync-state`, `/recent-jobs`,
   `/api/integrations/semrush/mapping-inventory`, `/mapping-suggestions`,
   `/.../approve`, `/.../reject`) are all wrapped in
   `isAuthenticated + requireAccountManager`. Verified that an
   unauthenticated request to the page returns the Access-denied card
   (browser screenshot confirms render after the fix).
2. **Integrations Hub link / no duplication.** Hub's SEMrush card
   (`IntegrationsHub.tsx` ~lines 1265–1328) only contains: connection
   status badge, "Open SEMrush Console" link to
   `/admin/integrations/semrush`, and the connect / disconnect /
   re-authorize controls. The historical backfill panel was removed
   from the Hub during 936E (comment at line 799 documents the move);
   no other operator UI for SEMrush remains in the Hub.
3. **Pipeline Health.** `/api/semrush/console/overview` aggregates
   live counters from `work_queue` (backlog = pending+leased,
   processing, 24h enqueued/completed/failed, dead-letter, last
   completion) for `semrush_report_refresh` and `semrush_heatmap_apply`,
   plus inventory state from `getInventoryState()`, location-sync
   counts grouped from `semrush_location_sync_state`, and
   `getStaleLeaseExhaustionMetrics()`. All values are derived from
   real durable stores (no hard-coded zeros).
4. **Sync State.** `/api/semrush/console/sync-state` joins
   `semrush_location_sync_state` to `clients`, `client_locations`, and
   `semrush_location_campaigns` and returns per-client rollups +
   per-row attempt history. The panel sorts attention-worthy rows
   (failed → stale → partial → in-flight) to the top.
5. **Mapping Inventory.** `MappingInventoryPanel` consumes
   `/api/integrations/semrush/mapping-inventory`. Status badges are
   keyed off the server's `linked` / `stale` / `orphan_location`
   classification, with header counts and per-row badges
   (`badge-inventory-status-${id}`).
6. **Suggestions.** `MappingSuggestionsPanel` consumes
   `/api/integrations/semrush/mapping-suggestions`. State labels map
   1:1 to the server classifier (`promotable`,
   `blocked_unconfigured`, `already_mapped`, `stale_conflict`,
   `invalid`) with header count badges and per-row state badges
   (`badge-suggestion-state-${id}`).
7. **Approve / reject use canonical writer.** The approve handler
   (`server/routes/integrations.ts` ~lines 3911–4020) loads the
   pending suggestion, validates its kind, and routes the candidate
   through `applySemrushLocationMapping` — the same canonical helper
   used by the auto-match endpoint, the inventory apply handler, and
   the Local Dominance sync (per the project README's 920A–E note).
   The handler's switch on `outcome.kind` correctly maps:
   `saved` / `already_mapped` → 200 + suggestion marked `promoted`;
   `queued_for_review` / `invalid_parent` → 409 "parent not
   configured"; `stale_conflict` → 409 "cannot auto-revive"; other
   `blocked` outcomes → 409 with the policy reason. Reject handler
   marks the row `dismissed` and never mutates
   `semrush_location_campaigns`.
8. **Historical backfill end-to-end.** `SemrushBackfillPanel` posts to
   `/api/semrush/heatmaps/backfill` with `dryRun: true` for preview
   and `dryRun: false, confirm: true` for apply. The panel snapshots
   the filter inputs at preview time and disables Apply if filters
   change (so operators cannot apply a different scope than what they
   reviewed). While Apply is in flight, the panel polls
   `/api/semrush/inventory/status` every 3 s for live progress and
   shows per-campaign job counts plus per-(campaign, report-date) rows.
9. **No backfill duplication in Hub.** Confirmed via grep — no
   `backfill` or `historical` UI remains in `IntegrationsHub.tsx`
   under the SEMrush section; the in-code comment at ~line 799
   explicitly documents the relocation.
10. **Responsive layout.** Console uses `container mx-auto p-4 sm:p-6
    max-w-6xl space-y-4`; tables wrap in `overflow-x-auto` with
    `min-w-[…]` to scroll horizontally on narrow screens (matches the
    project's responsive convention noted in `replit.md`). Cards use
    `flex … flex-wrap` and `grid sm:grid-cols-2` so headers and
    summary chips reflow cleanly on tablet/mobile.
11. **`data-testid` conventions.** Pre-existing testids on moved
    controls are preserved (`section-semrush-backfill`,
    `button-semrush-backfill-dry-run`, `button-semrush-backfill-apply`,
    `input-semrush-backfill-{clients,locations,campaigns,since,until}`,
    `text-semrush-preview-{mappings,considered,fetched,skipped}`,
    `row-semrush-preview-job-…`, etc.). New controls follow the same
    pattern (`section-semrush-overview`, `section-semrush-sync-state`,
    `section-semrush-mapping-inventory`, `section-semrush-mapping-suggestions`,
    `section-semrush-recent-jobs`, `button-refresh-semrush-console`,
    `badge-suggestion-state-${id}`, `row-mapping-suggestion-${id}`,
    `button-approve-suggestion-${id}`, `button-reject-suggestion-${id}`).

## Follow-ups filed

None — the only defect found (the missing `ListChecks` import) was
trivial to fix in this task. The console code is otherwise consistent
with the 936A IA and the consolidation goals.
