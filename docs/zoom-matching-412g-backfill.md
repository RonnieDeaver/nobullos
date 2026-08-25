# Zoom matching 412G — Re-evaluation & backfill of existing Zoom auto-claims

## Overview

After the 412B–F changes (safety guardrails, review queue, settings layer,
comparative evaluator), existing Zoom auto-claims need to be re-scored under
the new rules. Some prior attributions (notably Jake Davis → Rahlita on
April 15, 2026) were made by the old policy and should not silently survive.

This pass:

1. Scans **matched** Zoom raw communication records inside a recent window
   (default 90 days), then **filters down to prior auto-claims only**.

   - Eligible `matchMethod` prefixes: `agent:`, `agent_match`,
     `agent_retroactive`, `content:`, `content_match`, `contact_email:`,
     `contact_name:`, `owner:`.
   - Excluded: `manual_review`, `manual`, `released`, `operational_filter`,
     anything starting with `review_required:` or `backfill_412g`, and any
     comm whose `agent_match_decisions` rows include `reviewedByHuman=true`
     or `correctedByHuman=true` (a human already finalized that one).
   - The dry-run report includes `matchedZoomInWindow`,
     `excludedNonAutoClaim`, and `eligibleAutoClaims` counts plus a sample
     of excluded records (with reason) so operators can confirm scope
     before applying.
2. Re-runs `evaluateCommunication` with `skipPersist: true` to see what the
   new Zoom policy would do today.
3. Classifies each record as **still_auto_claim**, **move_to_review**, or
   **become_unmatched**.
4. (Apply mode only) writes a new `agent_match_decisions` row carrying:
   - `reviewReason = "backfill_412g"`
   - `priorClientId = <the prior auto-claimed client>`
   - `candidateShortlistJson` — the new top‑5 evaluations for review UI
   - explanation prefixed with `[backfill-412g:<outcome>]`
5. Demotes any previous `claimed` decisions for that comm to `not_claimed`
   with an annotated explanation. **Prior decisions are never deleted.**
6. Updates the raw record to `clientId = NULL`, `matchStatus = "unmatched"`,
   `matchMethod = "backfill_412g:<outcome>:<prior method>"`.
7. Marks any active `communication_client_links` to the prior client as
   `rejected` (rather than deleting them).

## Idempotency

The apply pass checks for a pre-existing `backfill_412g` decision row on the
target communication before doing anything. Re-running produces the same end
state — a no-op on the second pass.

## Trigger

Two equivalent entry points, both gated to account-manager+ users:

### CLI (one-shot script)

```bash
# always run dry-run first (default window: 90 days)
tsx scripts/zoom-backfill-reeval.ts --dry-run --window 90

# review the report — confirm Jake's April 15 call is highlighted

# then apply
tsx scripts/zoom-backfill-reeval.ts --apply --confirm --window 90

# repair a single known-bad record (bypasses window + auto-claim filter)
tsx scripts/zoom-backfill-reeval.ts --apply --confirm \
  --record-id f8e77741-4172-4596-a4aa-54612af90a9c

# verify the post-backfill state of a specific record
# (defaults to the Jake → Rahlita record id when --record-id is omitted)
tsx scripts/zoom-backfill-reeval.ts --verify
```

### Admin HTTP endpoints

```
POST /api/integrations/zoom/backfill-reeval/dry-run
  body: { windowDays?: number, recordLimit?: number, targetRecordId?: string }

POST /api/integrations/zoom/backfill-reeval/apply
  body: { confirm: true, windowDays?: number, recordLimit?: number, targetRecordId?: string }

GET  /api/integrations/zoom/backfill-reeval/verify/:recordId
```

The apply endpoint refuses without `confirm: true`. The dry-run report is
returned both as structured JSON and as a human-readable `summaryText`.

`targetRecordId` restricts the scan to that single
`raw_communication_records.id`, bypassing the time-window and
auto-claim/human-finalized filters. Use it to verify or repair a known-bad
record (e.g. the Jake → Rahlita misroute,
`f8e77741-4172-4596-a4aa-54612af90a9c`) at any time.

The verify endpoint returns the post-backfill state of a specific record:
its current `clientId` / `matchStatus` / `matchMethod`, its active and
rejected `communication_client_links`, any `backfill_412g`
`agent_match_decisions` rows, and an `isClean` boolean with reasons. It is
the recommended way to confirm the Jake → Rahlita record is no longer
mis-attributed.

## Jake Davis April 15 callout

The dry-run report explicitly surfaces the Zoom record where:
- `timestamp` falls on `2026-04-15`, **and**
- `title` or any participant name/email matches `/\bjake\s+davis\b/i`.

The `jakeApr15` field on the report includes the new top evaluation, the
shortlist, and the determined outcome. After apply, that record's raw
`clientId` is `NULL` and a `backfill_412g` decision row holds the shortlist
and `priorClientId` (the wrongly-attributed Rahlita).

## What downstream views should show

`agent_match_decisions` rows where `reviewReason = "backfill_412g"`:
- `priorClientId` — the auto-claimed client *before* the backfill.
- `candidateShortlistJson` — top-5 candidates from the new evaluator; render
  in the review queue exactly like a 412D review_required entry.
- `status = "review_required"` — show in the review queue.
- `status = "not_claimed"` — record went unmatched; reviewer can promote
  manually if they disagree.

The prior `claimed` decision rows are still in the table but with
`status = "not_claimed"` and an explanation prefixed
`[backfill-412g:demoted]`. They serve as the historical reference of what
the old policy said.

## Re-running safely

- The apply pass is idempotent (see above).
- It only touches records where the new evaluation no longer matches the
  prior auto-claim — strong-still-strong matches are left fully untouched
  (no decision row, no raw-record edit).
- It is bounded to a configurable recent window; older Zoom matches are
  not touched in this pass.
- It runs `evaluateCommunication` with `skipLearning: true` so memory
  weights are not perturbed.

## Out of scope (handled elsewhere or later)

- Non-Zoom sources.
- Slack/email notifications about backfill results.
- Auto-deletion of historical attribution data.
- Backfilling beyond the configured recent window.
